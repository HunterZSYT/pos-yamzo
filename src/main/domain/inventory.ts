import type Database from "better-sqlite3";
import fs from "node:fs";
import Papa from "papaparse";
import type {
  CostCategory,
  CostRecord,
  InventoryCategory,
  InventoryImportResult,
  InventoryItem,
  InventoryOrderUsageSnapshot,
  InventorySnapshot,
  InventoryStatusSummary,
  InventoryUnitInput,
  InventoryUnit,
  MenuRecipe,
  PriceHistoryRecord,
  RecipeIngredientInput,
  RestockEntry,
  SalesProfitSummary
} from "../../shared/types.js";
import { recordActivity } from "../services/audit.js";

type RecipeCsvRow = {
  "recipe number"?: string;
  "recipe name"?: string;
  "item serial no"?: string;
  "item names"?: string;
  "item quantity GM"?: string;
};

type ParsedQuantity = {
  quantity: number;
  unit: string;
  baseQuantity: number;
  baseUnitShortName: string;
};

const MENU_PRICE_FALLBACK = 1;

export function listInventorySnapshot(db: Database.Database): InventorySnapshot {
  const items = listInventoryItems(db);
  const recipes = listMenuRecipes(db);
  const restocks = listRestockEntries(db, 120);
  const priceHistory = listPriceHistory(db, 160);
  const costRecords = listCostRecords(db, 160);
  return {
    categories: listInventoryCategories(db),
    units: listInventoryUnits(db),
    items,
    recipes,
    restocks,
    priceHistory,
    costCategories: listCostCategories(db),
    costRecords,
    orderUsage: listInventoryOrderUsage(db),
    status: getInventoryStatus(db, items, recipes, restocks),
    profit: getSalesProfitSummary(db)
  };
}

export function importRecipeInventoryCsv(db: Database.Database, csvPath: string, actor = "admin"): InventoryImportResult {
  const csv = fs.readFileSync(csvPath, "utf8");
  const parsed = Papa.parse<RecipeCsvRow>(csv, { header: true, skipEmptyLines: true });
  const result: InventoryImportResult = {
    recipesImported: 0,
    recipesUpdated: 0,
    inventoryItemsCreated: 0,
    menuItemsCreated: 0,
    rowsSkipped: 0,
    errors: []
  };
  let currentRecipeName = "";
  const grouped = new Map<string, Array<{ ingredientName: string; quantity: ParsedQuantity; unitLabel: string }>>();

  for (const row of parsed.data) {
    const recipeName = cleanText(row["recipe name"] ?? "") || currentRecipeName;
    if (cleanText(row["recipe name"] ?? "")) {
      currentRecipeName = cleanText(row["recipe name"] ?? "");
    }
    const ingredientName = cleanText(row["item names"] ?? "");
    if (!recipeName || !ingredientName) {
      result.rowsSkipped += 1;
      continue;
    }
    const rawQuantity = cleanText(row["item quantity GM"] ?? "");
    const quantity = parseRecipeQuantity(rawQuantity);
    if (!quantity) {
      result.rowsSkipped += 1;
      result.errors.push(`Could not read quantity for ${recipeName}: ${ingredientName}`);
      continue;
    }
    const list = grouped.get(recipeName) ?? [];
    list.push({ ingredientName, quantity, unitLabel: rawQuantity || quantity.unit });
    grouped.set(recipeName, list);
  }

  const tx = db.transaction(() => {
    for (const [recipeName, ingredients] of grouped.entries()) {
      const menuItems = ensureMenuItemsForRecipe(db, recipeName);
      if (menuItems.length === 0) {
        result.rowsSkipped += ingredients.length;
        result.errors.push(`Menu item not found for recipe: ${recipeName}`);
        continue;
      }
      result.menuItemsCreated += menuItems.filter((item) => item.created).length;

      for (const menuItem of menuItems) {
        const existingRecipe = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ?").get(menuItem.id) as { id: number } | undefined;
        const recipeId = existingRecipe
          ? existingRecipe.id
          : Number(db.prepare("INSERT INTO menu_item_recipes (menu_item_id) VALUES (?)").run(menuItem.id).lastInsertRowid);
        if (existingRecipe) {
          db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
          db.prepare("UPDATE menu_item_recipes SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recipeId);
          result.recipesUpdated += 1;
        } else {
          result.recipesImported += 1;
        }

        for (const ingredient of ingredients) {
          const item = ensureInventoryItem(db, ingredient.ingredientName, ingredient.quantity.baseUnitShortName);
          if (item.created) result.inventoryItemsCreated += 1;
          db.prepare(
            `INSERT INTO recipe_ingredients (recipe_id, inventory_item_id, quantity_base, unit_label)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(recipe_id, inventory_item_id)
             DO UPDATE SET quantity_base = excluded.quantity_base, unit_label = excluded.unit_label`
          ).run(recipeId, item.id, ingredient.quantity.baseQuantity, ingredient.unitLabel);
          ensureTestRestockAndPrice(db, item.id, ingredient.quantity.baseUnitShortName);
        }
      }
    }
  });
  tx();
  recordActivity(db, "inventory_csv_imported", { ...result }, actor);
  return result;
}

export function saveInventoryItem(
  db: Database.Database,
  input: { id?: number; name: string; categoryId?: number | null; baseUnitId: number; lowStockThreshold?: number; active?: boolean },
  actor = "admin"
): InventoryItem {
  const name = cleanText(input.name);
  if (!name) throw new Error("Inventory item name is required.");
  const threshold = Math.max(0, Number(input.lowStockThreshold ?? 0));
  if (input.id) {
    db.prepare(
      `UPDATE inventory_items
       SET name = ?, category_id = ?, base_unit_id = ?, low_stock_threshold = ?, active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(name, input.categoryId ?? null, input.baseUnitId, threshold, input.active === false ? 0 : 1, input.id);
    recordActivity(db, "inventory_item_updated", { entityType: "inventory_item", entityId: String(input.id), itemName: name }, actor);
    return getInventoryItem(db, input.id);
  }
  const id = Number(
    db.prepare(
      `INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold, active)
       VALUES (?, ?, ?, ?, ?)`
    ).run(name, input.categoryId ?? null, input.baseUnitId, threshold, input.active === false ? 0 : 1).lastInsertRowid
  );
  recordActivity(db, "inventory_item_created", { entityType: "inventory_item", entityId: String(id), itemName: name }, actor);
  return getInventoryItem(db, id);
}

export function deleteInventoryItem(db: Database.Database, id: number, actor = "admin"): void {
  const item = getInventoryItem(db, id);
  db.prepare("UPDATE inventory_items SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  recordActivity(db, "inventory_item_removed", { entityType: "inventory_item", entityId: String(id), itemName: item.name }, actor);
}

export function saveMenuRecipe(
  db: Database.Database,
  input: { menuItemId: number; ingredients: RecipeIngredientInput[] },
  actor = "admin"
): MenuRecipe {
  const menuItem = db.prepare("SELECT id, name FROM menu_items WHERE id = ? AND archived = 0").get(input.menuItemId) as { id: number; name: string } | undefined;
  if (!menuItem) throw new Error("Menu item not found.");
  const cleanIngredients = input.ingredients
    .map((ingredient) => ({
      inventoryItemId: Number(ingredient.inventoryItemId),
      quantityBase: Math.max(0, Number(ingredient.quantityBase)),
      unitLabel: cleanText(ingredient.unitLabel || "g")
    }))
    .filter((ingredient) => Number.isInteger(ingredient.inventoryItemId) && ingredient.inventoryItemId > 0 && ingredient.quantityBase > 0);
  if (cleanIngredients.length === 0) {
    throw new Error("Add at least one ingredient with an amount greater than zero.");
  }
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ?").get(menuItem.id) as { id: number } | undefined;
    const recipeId = existing
      ? existing.id
      : Number(db.prepare("INSERT INTO menu_item_recipes (menu_item_id) VALUES (?)").run(menuItem.id).lastInsertRowid);
    db.prepare("UPDATE menu_item_recipes SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recipeId);
    db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
    const insert = db.prepare("INSERT INTO recipe_ingredients (recipe_id, inventory_item_id, quantity_base, unit_label) VALUES (?, ?, ?, ?)");
    for (const ingredient of cleanIngredients) {
      insert.run(recipeId, ingredient.inventoryItemId, ingredient.quantityBase, ingredient.unitLabel);
    }
  });
  tx();
  recordActivity(db, "recipe_updated", { entityType: "menu_item", entityId: String(menuItem.id), itemName: menuItem.name, ingredientCount: cleanIngredients.length }, actor);
  return listMenuRecipes(db).find((recipe) => recipe.menuItemId === menuItem.id)!;
}

export function saveInventoryCategory(db: Database.Database, input: { id?: number; name: string; active?: boolean }, actor = "admin"): InventoryCategory {
  const name = cleanText(input.name);
  if (!name) throw new Error("Category name is required.");
  if (input.id) {
    db.prepare("UPDATE inventory_categories SET name = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(name, input.active === false ? 0 : 1, input.id);
    recordActivity(db, "inventory_category_updated", { entityType: "inventory_category", entityId: String(input.id), name }, actor);
    return listInventoryCategories(db).find((category) => category.id === input.id)!;
  }
  const id = Number(db.prepare("INSERT INTO inventory_categories (name, active) VALUES (?, ?)").run(name, input.active === false ? 0 : 1).lastInsertRowid);
  recordActivity(db, "inventory_category_created", { entityType: "inventory_category", entityId: String(id), name }, actor);
  return listInventoryCategories(db).find((category) => category.id === id)!;
}

export function removeInventoryCategory(db: Database.Database, id: number, actor = "admin"): void {
  db.prepare("UPDATE inventory_categories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  recordActivity(db, "inventory_category_removed", { entityType: "inventory_category", entityId: String(id) }, actor);
}

export function saveInventoryUnit(db: Database.Database, input: InventoryUnitInput, actor = "admin"): InventoryUnit {
  const name = cleanText(input.name);
  const shortName = cleanText(input.shortName).toLowerCase();
  if (!name || !shortName) throw new Error("Unit name and short name are required.");
  if (input.id) {
    db.prepare("UPDATE inventory_units SET name = ?, short_name = ?, active = ? WHERE id = ?").run(name, shortName, input.active === false ? 0 : 1, input.id);
    recordActivity(db, "inventory_unit_updated", { entityType: "inventory_unit", entityId: String(input.id), name, shortName }, actor);
    return listInventoryUnits(db).find((unit) => unit.id === input.id)!;
  }
  const id = Number(db.prepare("INSERT INTO inventory_units (name, short_name, active) VALUES (?, ?, ?)").run(name, shortName, input.active === false ? 0 : 1).lastInsertRowid);
  recordActivity(db, "inventory_unit_created", { entityType: "inventory_unit", entityId: String(id), name, shortName }, actor);
  return listInventoryUnits(db).find((unit) => unit.id === id)!;
}

export function removeInventoryUnit(db: Database.Database, id: number, actor = "admin"): void {
  db.prepare("UPDATE inventory_units SET active = 0 WHERE id = ?").run(id);
  recordActivity(db, "inventory_unit_removed", { entityType: "inventory_unit", entityId: String(id) }, actor);
}

export function saveCostCategory(db: Database.Database, input: { id?: number; name: string; active?: boolean }, actor = "admin"): CostCategory {
  const name = cleanText(input.name);
  if (!name) throw new Error("Cost category name is required.");
  if (input.id) {
    db.prepare("UPDATE cost_categories SET name = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(name, input.active === false ? 0 : 1, input.id);
    recordActivity(db, "cost_category_updated", { entityType: "cost_category", entityId: String(input.id), name }, actor);
    return listCostCategories(db).find((category) => category.id === input.id)!;
  }
  const id = Number(db.prepare("INSERT INTO cost_categories (name, active) VALUES (?, ?)").run(name, input.active === false ? 0 : 1).lastInsertRowid);
  recordActivity(db, "cost_category_created", { entityType: "cost_category", entityId: String(id), name }, actor);
  return listCostCategories(db).find((category) => category.id === id)!;
}

export function removeCostCategory(db: Database.Database, id: number, actor = "admin"): void {
  db.prepare("UPDATE cost_categories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  recordActivity(db, "cost_category_removed", { entityType: "cost_category", entityId: String(id) }, actor);
}

export function addRestockEntry(
  db: Database.Database,
  input: {
    inventoryItemId: number;
    quantity: number;
    unitLabel?: string;
    totalCost?: number;
    supplierName?: string | null;
    responsiblePerson?: string | null;
    note?: string | null;
    entryDate?: string | null;
  },
  actor = "admin"
): RestockEntry {
  const item = getInventoryItem(db, input.inventoryItemId);
  const quantity = Math.max(0, Number(input.quantity));
  if (quantity <= 0) throw new Error("Restock quantity must be greater than zero.");
  const totalCost = Math.max(0, Number(input.totalCost ?? 0));
  const pricePerBase = quantity > 0 ? totalCost / quantity : 0;
  const id = Number(
    db.prepare(
      `INSERT INTO inventory_restock_entries
       (inventory_item_id, quantity_base, unit_label, total_cost, price_per_base, supplier_name, responsible_person, note, entry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).run(input.inventoryItemId, quantity, input.unitLabel || item.unitShortName, totalCost, pricePerBase, input.supplierName ?? null, input.responsiblePerson ?? null, input.note ?? null, input.entryDate ?? null).lastInsertRowid
  );
  if (pricePerBase > 0) {
    addPriceRecord(db, { inventoryItemId: input.inventoryItemId, pricePerBase, responsiblePerson: input.responsiblePerson ?? null, note: "Updated from restock entry" }, actor);
  }
  recordActivity(db, "inventory_restock_created", { entityType: "inventory_item", entityId: String(input.inventoryItemId), itemName: item.name, quantity }, actor);
  return listRestockEntries(db, 1).find((entry) => entry.id === id) ?? listRestockEntries(db, 1)[0];
}

export function updateRestockEntry(
  db: Database.Database,
  input: {
    id: number;
    inventoryItemId: number;
    quantity: number;
    unitLabel?: string;
    totalCost?: number;
    supplierName?: string | null;
    responsiblePerson?: string | null;
    note?: string | null;
  },
  actor = "admin"
): RestockEntry {
  const existing = db.prepare("SELECT id FROM inventory_restock_entries WHERE id = ?").get(input.id) as { id: number } | undefined;
  if (!existing) throw new Error("Restock entry not found.");
  const item = getInventoryItem(db, input.inventoryItemId);
  const quantity = Math.max(0, Number(input.quantity));
  if (quantity <= 0) throw new Error("Restock quantity must be greater than zero.");
  const totalCost = Math.max(0, Number(input.totalCost ?? 0));
  const pricePerBase = quantity > 0 ? totalCost / quantity : 0;
  db.prepare(
    `UPDATE inventory_restock_entries
     SET inventory_item_id = ?, quantity_base = ?, unit_label = ?, total_cost = ?, price_per_base = ?,
         supplier_name = ?, responsible_person = ?, note = ?, entry_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(input.inventoryItemId, quantity, input.unitLabel || item.unitShortName, totalCost, pricePerBase, input.supplierName ?? null, input.responsiblePerson ?? null, input.note ?? null, input.id);
  if (pricePerBase > 0) {
    addPriceRecord(db, { inventoryItemId: input.inventoryItemId, pricePerBase, responsiblePerson: input.responsiblePerson ?? null, note: "Updated from restock edit" }, actor);
  }
  recordActivity(db, "inventory_restock_updated", { entityType: "inventory_restock", entityId: String(input.id), itemName: item.name, quantity }, actor);
  return listRestockEntries(db, 200).find((entry) => entry.id === input.id)!;
}

export function deleteRestockEntry(db: Database.Database, id: number, actor = "admin"): void {
  const existing = db.prepare(
    `SELECT re.id, re.inventory_item_id, re.quantity_base, ii.name AS item_name
     FROM inventory_restock_entries re
     JOIN inventory_items ii ON ii.id = re.inventory_item_id
     WHERE re.id = ?`
  ).get(id) as { id: number; inventory_item_id: number; quantity_base: number; item_name: string } | undefined;
  if (!existing) throw new Error("Restock entry not found.");
  db.prepare("DELETE FROM inventory_restock_entries WHERE id = ?").run(id);
  recordActivity(db, "inventory_restock_deleted", {
    entityType: "inventory_restock",
    entityId: String(id),
    inventoryItemId: existing.inventory_item_id,
    itemName: existing.item_name,
    quantity: existing.quantity_base
  }, actor);
}

export function addPriceRecord(
  db: Database.Database,
  input: { inventoryItemId: number; pricePerBase: number; effectiveAt?: string | null; responsiblePerson?: string | null; note?: string | null },
  actor = "admin"
): PriceHistoryRecord {
  const item = getInventoryItem(db, input.inventoryItemId);
  const price = Math.max(0, Number(input.pricePerBase));
  if (price <= 0) throw new Error("Price must be greater than zero.");
  const id = Number(
    db.prepare(
      `INSERT INTO inventory_price_history (inventory_item_id, price_per_base, effective_at, responsible_person, note)
       VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)`
    ).run(input.inventoryItemId, price, input.effectiveAt ?? null, input.responsiblePerson ?? null, input.note ?? null).lastInsertRowid
  );
  recordActivity(db, "inventory_price_record_created", { entityType: "inventory_item", entityId: String(input.inventoryItemId), itemName: item.name, pricePerBase: price }, actor);
  return listPriceHistory(db, 1).find((entry) => entry.id === id) ?? listPriceHistory(db, 1)[0];
}

export function addCostRecord(
  db: Database.Database,
  input: {
    categoryId?: number | null;
    costName: string;
    amount: number;
    paymentMethod?: string | null;
    responsiblePerson?: string | null;
    note?: string | null;
    costDate?: string | null;
  },
  actor = "admin"
): CostRecord {
  const costName = cleanText(input.costName);
  if (!costName) throw new Error("Cost name is required.");
  const amount = Math.max(0, Number(input.amount));
  if (amount <= 0) throw new Error("Cost amount must be greater than zero.");
  const id = Number(
    db.prepare(
      `INSERT INTO cost_records (cost_category_id, cost_name, amount, payment_method, responsible_person, note, cost_date)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).run(input.categoryId ?? null, costName, amount, input.paymentMethod ?? null, input.responsiblePerson ?? null, input.note ?? null, input.costDate ?? null).lastInsertRowid
  );
  recordActivity(db, "cost_record_created", { entityType: "cost_record", entityId: String(id), costName, amount }, actor);
  return listCostRecords(db, 1).find((entry) => entry.id === id) ?? listCostRecords(db, 1)[0];
}

export function createOrderCostSnapshot(db: Database.Database, orderId: number, actor = "system"): void {
  const existing = db.prepare("SELECT id FROM order_cost_snapshots WHERE order_id = ?").get(orderId) as { id: number } | undefined;
  if (existing) return;
  const rows = db.prepare(
    `SELECT oi.id, oi.menu_item_id, oi.quantity, oi.unit_price, oi.name
     FROM order_items oi
     WHERE oi.order_id = ? AND oi.status = 'active'`
  ).all(orderId) as Array<{ id: number; menu_item_id: number; quantity: number; unit_price: number; name: string }>;
  let revenue = 0;
  let rawCost = 0;
  let missingRecipeCount = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const itemRevenue = row.quantity * row.unit_price;
      const recipeCost = getMenuItemRawCost(db, row.menu_item_id);
      if (!recipeCost.hasRecipe) missingRecipeCount += 1;
      const itemRawCost = recipeCost.rawCost * row.quantity;
      revenue += itemRevenue;
      rawCost += itemRawCost;
      db.prepare(
        `INSERT INTO order_item_cost_snapshots
         (order_id, order_item_id, menu_item_id, quantity, revenue, raw_cost, profit, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(orderId, row.id, row.menu_item_id, row.quantity, itemRevenue, itemRawCost, itemRevenue - itemRawCost, JSON.stringify(recipeCost.ingredients));
      for (const ingredient of recipeCost.ingredients) {
        db.prepare(
          `INSERT INTO inventory_adjustments (inventory_item_id, quantity_delta, reason, order_id, order_item_id, note)
           VALUES (?, ?, 'Order usage', ?, ?, ?)`
        ).run(ingredient.inventoryItemId, -(ingredient.quantityBase * row.quantity), orderId, row.id, row.name);
      }
    }
    const grossProfit = revenue - rawCost;
    db.prepare(
      `INSERT INTO order_cost_snapshots
       (order_id, revenue, raw_cost, other_cost, gross_profit, net_profit, missing_recipe_count)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    ).run(orderId, revenue, rawCost, grossProfit, grossProfit, missingRecipeCount);
  });
  tx();
  recordActivity(db, "order_cost_snapshot_created", { entityType: "order", entityId: String(orderId), revenue, rawCost, missingRecipeCount }, actor);
}

export function reverseOrderCostSnapshot(db: Database.Database, orderId: number, actor = "system"): void {
  const existing = db.prepare("SELECT id FROM order_cost_snapshots WHERE order_id = ?").get(orderId) as { id: number } | undefined;
  if (!existing) return;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM inventory_adjustments WHERE order_id = ? AND reason = 'Order usage'").run(orderId);
    db.prepare("DELETE FROM order_item_cost_snapshots WHERE order_id = ?").run(orderId);
    db.prepare("DELETE FROM order_cost_snapshots WHERE order_id = ?").run(orderId);
  });
  tx();
  recordActivity(db, "order_cost_snapshot_reversed", { entityType: "order", entityId: String(orderId) }, actor);
}

export function listInventoryCategories(db: Database.Database): InventoryCategory[] {
  return db.prepare("SELECT id, name, active FROM inventory_categories WHERE active = 1 ORDER BY name").all().map((row) => {
    const item = row as { id: number; name: string; active: number };
    return { id: item.id, name: item.name, active: item.active === 1 };
  });
}

export function listInventoryUnits(db: Database.Database): InventoryUnit[] {
  return db.prepare("SELECT id, name, short_name, active FROM inventory_units WHERE active = 1 ORDER BY id").all().map((row) => {
    const item = row as { id: number; name: string; short_name: string; active: number };
    return { id: item.id, name: item.name, shortName: item.short_name, active: item.active === 1 };
  });
}

export function listInventoryItems(db: Database.Database): InventoryItem[] {
  const rows = db.prepare(
    `SELECT ii.id, ii.name, ii.category_id, ic.name AS category_name, ii.base_unit_id, iu.name AS unit_name,
            iu.short_name AS unit_short_name, ii.low_stock_threshold, ii.active,
            COALESCE((SELECT SUM(quantity_base) FROM inventory_restock_entries WHERE inventory_item_id = ii.id), 0)
            + COALESCE((SELECT SUM(quantity_delta) FROM inventory_adjustments WHERE inventory_item_id = ii.id), 0) AS current_stock,
            COALESCE((SELECT price_per_base FROM inventory_price_history WHERE inventory_item_id = ii.id AND active = 1 ORDER BY datetime(effective_at) DESC, id DESC LIMIT 1), 0) AS latest_price
     FROM inventory_items ii
     JOIN inventory_units iu ON iu.id = ii.base_unit_id
     LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
     WHERE ii.active = 1
     ORDER BY ii.name`
  ).all() as Array<{
    id: number;
    name: string;
    category_id: number | null;
    category_name: string | null;
    base_unit_id: number;
    unit_name: string;
    unit_short_name: string;
    low_stock_threshold: number;
    active: number;
    current_stock: number;
    latest_price: number;
  }>;
  return rows.map((row) => toInventoryItem(row));
}

export function listMenuRecipes(db: Database.Database): MenuRecipe[] {
  const menuRows = db.prepare("SELECT id, name, price FROM menu_items WHERE archived = 0 ORDER BY name").all() as Array<{ id: number; name: string; price: number }>;
  return menuRows.map((menuItem) => {
    const recipe = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ? AND active = 1").get(menuItem.id) as { id: number } | undefined;
    if (!recipe) {
      return {
        id: 0,
        menuItemId: menuItem.id,
        menuItemName: menuItem.name,
        sellingPrice: menuItem.price,
        status: "missing",
        rawCost: 0,
        estimatedProfit: menuItem.price,
        profitMargin: 100,
        ingredients: []
      };
    }
    const cost = getMenuItemRawCost(db, menuItem.id);
    const profit = menuItem.price - cost.rawCost;
    const hasIngredients = cost.ingredients.length > 0;
    return {
      id: recipe.id,
      menuItemId: menuItem.id,
      menuItemName: menuItem.name,
      sellingPrice: menuItem.price,
      status: hasIngredients ? "available" : "missing",
      rawCost: roundMoney(cost.rawCost),
      estimatedProfit: roundMoney(profit),
      profitMargin: menuItem.price > 0 ? Math.round((profit / menuItem.price) * 100) : 0,
      ingredients: cost.ingredients
    };
  });
}

export function listRestockEntries(db: Database.Database, limit = 100): RestockEntry[] {
  return db.prepare(
    `SELECT re.id, re.inventory_item_id, ii.name AS item_name, re.quantity_base, re.unit_label, re.total_cost, re.price_per_base,
            re.supplier_name, re.responsible_person, re.note, re.entry_date, COALESCE(re.updated_at, re.entry_date) AS updated_at
     FROM inventory_restock_entries re
     JOIN inventory_items ii ON ii.id = re.inventory_item_id
     ORDER BY datetime(re.entry_date) DESC, re.id DESC
     LIMIT ?`
  ).all(limit).map((row) => {
    const entry = row as {
      id: number;
      inventory_item_id: number;
      item_name: string;
      quantity_base: number;
      unit_label: string;
      total_cost: number;
      price_per_base: number;
      supplier_name: string | null;
      responsible_person: string | null;
      note: string | null;
      entry_date: string;
      updated_at: string;
    };
    return {
      id: entry.id,
      inventoryItemId: entry.inventory_item_id,
      itemName: entry.item_name,
      quantityBase: entry.quantity_base,
      unitLabel: entry.unit_label,
      totalCost: roundMoney(entry.total_cost),
      pricePerBase: entry.price_per_base,
      supplierName: entry.supplier_name,
      responsiblePerson: entry.responsible_person,
      note: entry.note,
      entryDate: entry.entry_date,
      updatedAt: entry.updated_at
    };
  });
}

export function listPriceHistory(db: Database.Database, limit = 120): PriceHistoryRecord[] {
  return db.prepare(
    `SELECT ph.id, ph.inventory_item_id, ii.name AS item_name, ph.price_per_base, ph.effective_at, ph.responsible_person, ph.note
     FROM inventory_price_history ph
     JOIN inventory_items ii ON ii.id = ph.inventory_item_id
     WHERE ph.active = 1
     ORDER BY datetime(ph.effective_at) DESC, ph.id DESC
     LIMIT ?`
  ).all(limit).map((row) => {
    const entry = row as { id: number; inventory_item_id: number; item_name: string; price_per_base: number; effective_at: string; responsible_person: string | null; note: string | null };
    return {
      id: entry.id,
      inventoryItemId: entry.inventory_item_id,
      itemName: entry.item_name,
      pricePerBase: entry.price_per_base,
      effectiveAt: entry.effective_at,
      responsiblePerson: entry.responsible_person,
      note: entry.note
    };
  });
}

export function listCostCategories(db: Database.Database): CostCategory[] {
  return db.prepare("SELECT id, name, active FROM cost_categories WHERE active = 1 ORDER BY name").all().map((row) => {
    const item = row as { id: number; name: string; active: number };
    return { id: item.id, name: item.name, active: item.active === 1 };
  });
}

export function listCostRecords(db: Database.Database, limit = 120): CostRecord[] {
  return db.prepare(
    `SELECT cr.id, cr.cost_category_id, cc.name AS category_name, cr.cost_name, cr.amount, cr.payment_method,
            cr.responsible_person, cr.note, cr.cost_date
     FROM cost_records cr
     LEFT JOIN cost_categories cc ON cc.id = cr.cost_category_id
     ORDER BY datetime(cr.cost_date) DESC, cr.id DESC
     LIMIT ?`
  ).all(limit).map((row) => {
    const entry = row as { id: number; cost_category_id: number | null; category_name: string | null; cost_name: string; amount: number; payment_method: string | null; responsible_person: string | null; note: string | null; cost_date: string };
    return {
      id: entry.id,
      categoryId: entry.cost_category_id,
      categoryName: entry.category_name,
      costName: entry.cost_name,
      amount: roundMoney(entry.amount),
      paymentMethod: entry.payment_method,
      responsiblePerson: entry.responsible_person,
      note: entry.note,
      costDate: entry.cost_date
    };
  });
}

export function listInventoryOrderUsage(db: Database.Database, limit = 120): InventoryOrderUsageSnapshot {
  const rows = db.prepare(
    `SELECT o.id AS order_id, o.order_number, o.source, o.table_number, o.settled_at, COALESCE(ocs.revenue, 0) AS order_total,
            oi.id AS order_item_id, oi.name AS menu_item_name, oics.quantity, oics.revenue, oics.raw_cost, oics.details_json
     FROM order_item_cost_snapshots oics
     JOIN orders o ON o.id = oics.order_id
     JOIN order_items oi ON oi.id = oics.order_item_id
     LEFT JOIN order_cost_snapshots ocs ON ocs.order_id = o.id
     WHERE o.status = 'settled'
     ORDER BY datetime(o.settled_at) DESC, o.id DESC, oi.id ASC
     LIMIT ?`
  ).all(limit) as Array<{
    order_id: number;
    order_number: string;
    source: InventoryOrderUsageSnapshot["orders"][number]["source"];
    table_number: string | null;
    settled_at: string | null;
    order_total: number;
    order_item_id: number;
    menu_item_name: string;
    quantity: number;
    revenue: number;
    raw_cost: number;
    details_json: string | null;
  }>;
  const orders = new Map<number, InventoryOrderUsageSnapshot["orders"][number]>();
  const totals = new Map<string, InventoryOrderUsageSnapshot["totals"][number]>();

  for (const row of rows) {
    const order = orders.get(row.order_id) ?? {
      orderId: row.order_id,
      orderNumber: row.order_number,
      source: row.source,
      tableNumber: row.table_number,
      settledAt: row.settled_at,
      total: roundMoney(row.order_total),
      items: []
    };
    const parsed = parseIngredientSnapshot(row.details_json);
    const ingredients = parsed.map((ingredient) => {
      const quantityBase = ingredient.quantityBase * row.quantity;
      const rawCost = ingredient.rawCost * row.quantity;
      const key = `${ingredient.inventoryItemId}:${ingredient.unitLabel}`;
      const existing = totals.get(key);
      if (existing) {
        existing.quantityBase = roundQuantity(existing.quantityBase + quantityBase);
        existing.rawCost = roundMoney(existing.rawCost + rawCost);
      } else {
        totals.set(key, {
          inventoryItemId: ingredient.inventoryItemId,
          itemName: ingredient.itemName,
          quantityBase: roundQuantity(quantityBase),
          unitLabel: ingredient.unitLabel,
          rawCost: roundMoney(rawCost)
        });
      }
      return {
        inventoryItemId: ingredient.inventoryItemId,
        itemName: ingredient.itemName,
        quantityBase: roundQuantity(quantityBase),
        unitLabel: ingredient.unitLabel,
        rawCost: roundMoney(rawCost)
      };
    });
    order.items.push({
      orderItemId: row.order_item_id,
      menuItemName: row.menu_item_name,
      quantity: row.quantity,
      revenue: roundMoney(row.revenue),
      rawCost: roundMoney(row.raw_cost),
      ingredients
    });
    orders.set(row.order_id, order);
  }

  return {
    orders: Array.from(orders.values()),
    totals: Array.from(totals.values()).sort((left, right) => left.itemName.localeCompare(right.itemName))
  };
}

function getInventoryStatus(db: Database.Database, items: InventoryItem[], recipes: MenuRecipe[], restocks: RestockEntry[]): InventoryStatusSummary {
  const missingRecipes = recipes
    .filter((recipe) => recipe.status === "missing")
    .map((recipe) => ({ menuItemId: recipe.menuItemId, name: recipe.menuItemName, price: recipe.sellingPrice }));
  return {
    totalInventoryValue: roundMoney(items.reduce((sum, item) => sum + item.estimatedValue, 0)),
    lowStockCount: items.filter((item) => item.status === "low").length,
    outOfStockCount: items.filter((item) => item.status === "out").length,
    missingRecipeCount: missingRecipes.length,
    recipeAvailableCount: recipes.filter((recipe) => recipe.status === "available").length,
    inventoryItemCount: items.length,
    recentRestocks: restocks.slice(0, 8),
    lowStockItems: items.filter((item) => item.status !== "ok").slice(0, 20),
    missingRecipes: missingRecipes.slice(0, 30)
  };
}

function parseIngredientSnapshot(value: string | null): Array<{ inventoryItemId: number; itemName: string; quantityBase: number; unitLabel: string; rawCost: number }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Array<{ inventoryItemId?: number; itemName?: string; quantityBase?: number; unitLabel?: string; rawCost?: number }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        inventoryItemId: Number(item.inventoryItemId ?? 0),
        itemName: cleanText(item.itemName ?? ""),
        quantityBase: Number(item.quantityBase ?? 0),
        unitLabel: cleanText(item.unitLabel ?? "g") || "g",
        rawCost: Number(item.rawCost ?? 0)
      }))
      .filter((item) => item.inventoryItemId > 0 && item.itemName && item.quantityBase > 0);
  } catch {
    return [];
  }
}

export function getSalesProfitSummary(db: Database.Database, start?: string, end?: string): SalesProfitSummary {
  const where = start && end ? "WHERE o.settled_at BETWEEN ? AND ?" : "WHERE o.status = 'settled'";
  const params = start && end ? [start, end] : [];
  const totals = db.prepare(
    `SELECT COALESCE(SUM(ocs.revenue), 0) AS revenue,
            COALESCE(SUM(ocs.raw_cost), 0) AS raw_cost,
            COALESCE(SUM(ocs.gross_profit), 0) AS gross_profit,
            COALESCE(SUM(ocs.missing_recipe_count), 0) AS missing_recipe_count
     FROM order_cost_snapshots ocs
     JOIN orders o ON o.id = ocs.order_id
     ${where}`
  ).get(...params) as { revenue: number; raw_cost: number; gross_profit: number; missing_recipe_count: number };
  const otherCostRow = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM cost_records
     ${start && end ? "WHERE cost_date BETWEEN ? AND ?" : ""}`
  ).get(...params) as { total: number };
  const topProfitItems = db.prepare(
    `SELECT oi.name, COALESCE(SUM(oics.revenue), 0) AS revenue, COALESCE(SUM(oics.raw_cost), 0) AS raw_cost,
            COALESCE(SUM(oics.profit), 0) AS profit
     FROM order_item_cost_snapshots oics
     JOIN order_items oi ON oi.id = oics.order_item_id
     JOIN orders o ON o.id = oics.order_id
     ${where}
     GROUP BY oi.name
     ORDER BY profit DESC
     LIMIT 10`
  ).all(...params) as Array<{ name: string; revenue: number; raw_cost: number; profit: number }>;
  const otherCost = otherCostRow.total ?? 0;
  return {
    revenue: roundMoney(totals.revenue),
    rawCost: roundMoney(totals.raw_cost),
    otherCost: roundMoney(otherCost),
    grossProfit: roundMoney(totals.gross_profit),
    netProfit: roundMoney(totals.gross_profit - otherCost),
    missingRecipeCount: Number(totals.missing_recipe_count ?? 0),
    topProfitItems: topProfitItems.map((item) => ({
      name: item.name,
      revenue: roundMoney(item.revenue),
      rawCost: roundMoney(item.raw_cost),
      profit: roundMoney(item.profit)
    }))
  };
}

function getInventoryItem(db: Database.Database, id: number): InventoryItem {
  const item = listInventoryItems(db).find((row) => row.id === id);
  if (!item) throw new Error("Inventory item not found.");
  return item;
}

function getMenuItemRawCost(db: Database.Database, menuItemId: number): { hasRecipe: boolean; rawCost: number; ingredients: MenuRecipe["ingredients"] } {
  const recipe = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ? AND active = 1").get(menuItemId) as { id: number } | undefined;
  if (!recipe) {
    return { hasRecipe: false, rawCost: 0, ingredients: [] };
  }
  const rows = db.prepare(
    `SELECT ri.id, ri.inventory_item_id, ii.name AS item_name, ri.quantity_base, ri.unit_label,
            COALESCE((SELECT price_per_base FROM inventory_price_history WHERE inventory_item_id = ii.id AND active = 1 ORDER BY datetime(effective_at) DESC, id DESC LIMIT 1), 0) AS latest_price
     FROM recipe_ingredients ri
     JOIN inventory_items ii ON ii.id = ri.inventory_item_id
     WHERE ri.recipe_id = ? AND ri.quantity_base > 0
     ORDER BY ii.name`
  ).all(recipe.id) as Array<{ id: number; inventory_item_id: number; item_name: string; quantity_base: number; unit_label: string; latest_price: number }>;
  const ingredients = rows.map((row) => ({
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.item_name,
    quantityBase: row.quantity_base,
    unitLabel: row.unit_label,
    latestPrice: row.latest_price,
    rawCost: roundMoney(row.quantity_base * row.latest_price)
  }));
  return { hasRecipe: true, rawCost: ingredients.reduce((sum, item) => sum + item.rawCost, 0), ingredients };
}

function ensureMenuItemsForRecipe(db: Database.Database, recipeName: string): Array<{ id: number; created: boolean }> {
  const menuItems = db.prepare("SELECT id, name FROM menu_items WHERE archived = 0").all() as Array<{ id: number; name: string }>;
  const normalizedRecipeName = normalizeName(recipeName);
  const alias = recipeAlias(normalizedRecipeName);
  const exact = menuItems.filter((item) => normalizeName(item.name) === normalizedRecipeName || normalizeName(item.name) === alias);
  if (exact.length > 0) return exact.map((item) => ({ id: item.id, created: false }));
  const packageMatches = menuItems.filter((item) => normalizeName(item.name).startsWith(alias));
  if (packageMatches.length > 0) return packageMatches.map((item) => ({ id: item.id, created: false }));
  if (!isSauceLike(recipeName)) {
    return [];
  }
  const category = recipeName.toLowerCase().includes("sauce") ? "Sauce" : "Imported";
  const id = Number(
    db.prepare("INSERT INTO menu_items (name, price, category, available, archived) VALUES (?, ?, ?, 1, 0)").run(recipeName, MENU_PRICE_FALLBACK, category).lastInsertRowid
  );
  return [{ id, created: true }];
}

function isSauceLike(name: string): boolean {
  return /(sauce|chili oil|masala base)/i.test(name);
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

function recipeAlias(normalizedRecipeName: string): string {
  const aliases: Record<string, string> = {
    bbqoctopus: "bbqoctopusmasala",
    loitta: "loittafry",
    dumplingwithchilisoup: "dumplingwithchillisoup",
    chickenchowmein: "chickenchowmin",
    creamandmushroomsoup: "creamofmushroomsoup"
  };
  return aliases[normalizedRecipeName] ?? normalizedRecipeName;
}

function ensureInventoryItem(db: Database.Database, name: string, unitShortName: string): { id: number; created: boolean } {
  const existing = db.prepare("SELECT id FROM inventory_items WHERE lower(name) = lower(?)").get(name) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const unit = getUnitByShortName(db, unitShortName);
  const category = getCategoryByName(db, inferCategory(name));
  const id = Number(
    db.prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES (?, ?, ?, ?)").run(
      name,
      category.id,
      unit.id,
      unitShortName === "pc" ? 10 : 1000
    ).lastInsertRowid
  );
  return { id, created: true };
}

function ensureTestRestockAndPrice(db: Database.Database, inventoryItemId: number, unitShortName: string): void {
  const restockCount = db.prepare("SELECT COUNT(*) AS count FROM inventory_restock_entries WHERE inventory_item_id = ?").get(inventoryItemId) as { count: number };
  if (restockCount.count > 0) return;
  const quantity = unitShortName === "pc" ? 500 : unitShortName === "packet" ? 100 : 100000;
  const pricePerBase = unitShortName === "pc" ? 12 : unitShortName === "packet" ? 40 : 0.8;
  db.prepare(
    `INSERT INTO inventory_restock_entries
     (inventory_item_id, quantity_base, unit_label, total_cost, price_per_base, supplier_name, responsible_person, note)
     VALUES (?, ?, ?, ?, ?, 'Opening test stock', 'System', 'Temporary inventory for testing')`
  ).run(inventoryItemId, quantity, unitShortName, quantity * pricePerBase, pricePerBase);
  db.prepare(
    `INSERT INTO inventory_price_history (inventory_item_id, price_per_base, responsible_person, note)
     VALUES (?, ?, 'System', 'Opening test price')`
  ).run(inventoryItemId, pricePerBase);
}

function getUnitByShortName(db: Database.Database, shortName: string): { id: number; short_name: string } {
  const normalized = normalizeUnit(shortName);
  const unit = db.prepare("SELECT id, short_name FROM inventory_units WHERE short_name = ?").get(normalized) as { id: number; short_name: string } | undefined;
  if (!unit) {
    return db.prepare("SELECT id, short_name FROM inventory_units WHERE short_name = 'g'").get() as { id: number; short_name: string };
  }
  return unit;
}

function getCategoryByName(db: Database.Database, name: string): { id: number } {
  const existing = db.prepare("SELECT id FROM inventory_categories WHERE name = ?").get(name) as { id: number } | undefined;
  if (existing) return existing;
  return { id: Number(db.prepare("INSERT INTO inventory_categories (name) VALUES (?)").run(name).lastInsertRowid) };
}

function parseRecipeQuantity(value: string): ParsedQuantity | null {
  const cleaned = cleanText(value).toLowerCase();
  if (!cleaned) return null;
  if (cleaned === "as needed" || cleaned === "to taste") {
    return { quantity: 0, unit: "g", baseQuantity: 0, baseUnitShortName: "g" };
  }
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?|[0-9]+\/[0-9]+)\s*([a-zA-Z]+)?/);
  if (!match) return null;
  const quantity = parseFraction(match[1]);
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  const unit = normalizeUnit(match[2] || "g");
  const baseQuantity = unit === "kg" ? quantity * 1000 : unit === "l" ? quantity * 1000 : quantity;
  const baseUnitShortName = unit === "kg" ? "g" : unit === "l" ? "ml" : unit;
  return { quantity, unit, baseQuantity, baseUnitShortName };
}

function parseFraction(value: string): number {
  if (value.includes("/")) {
    const [left, right] = value.split("/").map(Number);
    return right ? left / right : 0;
  }
  return Number(value);
}

function normalizeUnit(value: string): string {
  const unit = cleanText(value).toLowerCase();
  if (["gm", "gms", "gram", "grams"].includes(unit)) return "g";
  if (["kgs", "kilogram", "kilograms"].includes(unit)) return "kg";
  if (["milliliter", "milliliters"].includes(unit)) return "ml";
  if (["liter", "liters", "ltr"].includes(unit)) return "l";
  if (["pcs", "piece", "pieces"].includes(unit)) return "pc";
  return unit || "g";
}

function inferCategory(name: string): string {
  const lower = name.toLowerCase();
  if (/(sauce|mayo|ketchup|paste|mustard|vinegar)/.test(lower)) return "Sauce";
  if (/(fish|squid|octopus|prawn|shrimp|calamari|dory)/.test(lower)) return "Seafood";
  if (/(chicken|mutton|beef|meat)/.test(lower)) return "Meat";
  if (/(onion|garlic|ginger|chilli|chili|lemon|potato|mushroom|vegetable|capsicum|tomato)/.test(lower)) return "Vegetable";
  if (/(spice|salt|pepper|masala|cumin|coriander|turmeric)/.test(lower)) return "Spice";
  if (/(cheese|cream|milk|egg)/.test(lower)) return "Dairy";
  if (/(flour|maida|rice|noodle|breadcrumbs|bread|pasta|oil)/.test(lower)) return "Dry Goods";
  if (/(box|bag|packet|cup|straw|foil)/.test(lower)) return "Packaging";
  return "Other";
}

function toInventoryItem(row: {
  id: number;
  name: string;
  category_id: number | null;
  category_name: string | null;
  base_unit_id: number;
  unit_name: string;
  unit_short_name: string;
  low_stock_threshold: number;
  active: number;
  current_stock: number;
  latest_price: number;
}): InventoryItem {
  const stock = Number(row.current_stock ?? 0);
  const threshold = Number(row.low_stock_threshold ?? 0);
  const status = stock <= 0 ? "out" : threshold > 0 && stock <= threshold ? "low" : "ok";
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    baseUnitId: row.base_unit_id,
    unitName: row.unit_name,
    unitShortName: row.unit_short_name,
    currentStock: roundQuantity(stock),
    latestPrice: row.latest_price,
    estimatedValue: roundMoney(stock * Number(row.latest_price ?? 0)),
    lowStockThreshold: threshold,
    status,
    active: row.active === 1
  };
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
