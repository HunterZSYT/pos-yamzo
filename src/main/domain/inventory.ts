import type Database from "better-sqlite3";
import fs from "node:fs";
import Papa from "papaparse";
import type {
  CostCategory,
  CostRecord,
  InventoryBackfillPreview,
  InventoryBindingPreview,
  InventoryCategory,
  InventoryImportResult,
  InventoryItemImportResult,
  InventoryItem,
  InventoryOrderUsageSnapshot,
  InventorySnapshot,
  InventoryStatusSummary,
  InventoryUnitInput,
  InventoryUnit,
  HistoricalScope,
  MenuInventoryBinding,
  MenuRecipe,
  PhysicalCountEntry,
  PhysicalCountInput,
  PhysicalCountUpdateInput,
  PriceHistoryRecord,
  RecipeIngredientInput,
  RecipeSaveInput,
  RestockEntry,
  RestockEntryInput,
  RestockEntryUpdateInput,
  SalesProfitSummary
} from "../../shared/types.js";
import { recordActivity } from "../services/audit.js";

type RecipeCsvRow = {
  "recipe number"?: string;
  "recipe name"?: string;
  "item serial no"?: string;
  "item name"?: string;
  "item names"?: string;
  "item quantity"?: string;
  "item quantity GM"?: string;
  "item quantity needed GM"?: string;
  "recipe unit"?: string;
};

type InventoryItemCsvRow = {
  "Item Name"?: string;
  "Unit / Type"?: string;
  "Item Category"?: string;
};

type ParsedQuantity = {
  quantity: number;
  unit: string;
  baseQuantity: number;
  baseUnitShortName: string;
};

const MENU_PRICE_FALLBACK = 1;

type HistoricalChangeOptions = {
  snapshotMode?: boolean;
  historicalScope?: HistoricalScope;
  start?: string | null;
  end?: string | null;
  reason?: string | null;
};

type MenuBindingInput = {
  menuItemId: number;
  bindingType: "recipe" | "item";
  recipeId?: number | null;
  inventoryItemId?: number | null;
  quantityBase?: number;
  unitLabel?: string;
  historicalScope?: HistoricalScope;
  start?: string | null;
  end?: string | null;
  reason?: string | null;
};

export function listInventorySnapshot(db: Database.Database): InventorySnapshot {
  const items = listInventoryItems(db);
  const recipes = listMenuRecipes(db);
  const restocks = listRestockEntries(db, 120);
  const physicalCounts = listPhysicalCounts(db, 10000);
  const priceHistory = listPriceHistory(db, 160);
  const costRecords = listCostRecords(db, 10000);
  return {
    categories: listInventoryCategories(db),
    units: listInventoryUnits(db),
    items,
    recipes,
    bindings: listMenuInventoryBindings(db),
    restocks,
    physicalCounts,
    priceHistory,
    costCategories: listCostCategories(db),
    costRecords,
    orderUsage: listInventoryOrderUsage(db),
    status: getInventoryStatus(db, items, recipes, restocks),
    profit: getSalesProfitSummary(db)
  };
}

export function importRecipeInventoryCsv(
  db: Database.Database,
  csvPath: string,
  options: HistoricalChangeOptions = {},
  actor = "admin"
): InventoryImportResult {
  validateHistoricalChangeOptions(options);
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
    const ingredientName = cleanText(row["item name"] ?? row["item names"] ?? "");
    if (!recipeName || !ingredientName) {
      result.rowsSkipped += 1;
      continue;
    }
    const rawQuantity = cleanText(row["item quantity"] ?? row["item quantity GM"] ?? row["item quantity needed GM"] ?? "");
    const recipeUnit = cleanText(row["recipe unit"] ?? "");
    const quantity = recipeUnit ? parseRecipeQuantity(`${rawQuantity} ${recipeUnit}`) : parseRecipeQuantity(rawQuantity);
    if (!quantity) {
      result.rowsSkipped += 1;
      result.errors.push(`Could not read quantity for ${recipeName}: ${ingredientName}`);
      continue;
    }
    const list = grouped.get(recipeName) ?? [];
    list.push({ ingredientName, quantity, unitLabel: recipeUnit || rawQuantity || quantity.unit });
    grouped.set(recipeName, list);
  }

  const changedMenuItemIds = new Set<number>();
  const changedVersionIds = new Map<number, number>();
  const tx = db.transaction(() => {
    for (const [recipeName, ingredients] of grouped.entries()) {
      const menuItems = ensureRecipeHolders(db, recipeName);
      if (menuItems.length === 0) {
        result.rowsSkipped += ingredients.length;
        result.errors.push(`Menu item not found for recipe: ${recipeName}`);
        continue;
      }
      result.menuItemsCreated += menuItems.filter((item) => item.created).length;

      for (const menuItem of menuItems) {
        const existingRecipe = db.prepare("SELECT id, current_version_id FROM menu_item_recipes WHERE menu_item_id = ?").get(menuItem.id) as { id: number; current_version_id: number | null } | undefined;
        const recipeId = existingRecipe
          ? existingRecipe.id
          : Number(db.prepare("INSERT INTO menu_item_recipes (menu_item_id) VALUES (?)").run(menuItem.id).lastInsertRowid);
        const versionId = prepareRecipeVersion(db, recipeId, Boolean(options.snapshotMode), "bulk_csv", options.reason ?? null);
        if (existingRecipe) {
          db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
          db.prepare("DELETE FROM recipe_child_ingredients WHERE recipe_id = ?").run(recipeId);
          db.prepare("UPDATE menu_item_recipes SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recipeId);
          result.recipesUpdated += 1;
        } else {
          result.recipesImported += 1;
        }

        db.prepare("DELETE FROM recipe_version_ingredients WHERE version_id = ?").run(versionId);
        db.prepare("DELETE FROM recipe_version_child_ingredients WHERE version_id = ?").run(versionId);

        for (const ingredient of ingredients) {
          const item = findInventoryItemForRecipe(db, ingredient.ingredientName);
          if (!item) {
            result.rowsSkipped += 1;
            result.errors.push(`Inventory item not found for ${recipeName}: ${ingredient.ingredientName}`);
            continue;
          }
          if (item.unitShortName !== ingredient.quantity.baseUnitShortName) {
            result.rowsSkipped += 1;
            result.errors.push(`Unit mismatch for ${recipeName}: ${ingredient.ingredientName} uses ${ingredient.quantity.baseUnitShortName}, item base unit is ${item.unitShortName}`);
            continue;
          }
          db.prepare(
            `INSERT INTO recipe_ingredients (recipe_id, inventory_item_id, quantity_base, unit_label)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(recipe_id, inventory_item_id)
             DO UPDATE SET quantity_base = excluded.quantity_base, unit_label = excluded.unit_label`
          ).run(recipeId, item.id, ingredient.quantity.baseQuantity, item.unitShortName);
          db.prepare(
            `INSERT INTO recipe_version_ingredients (version_id, inventory_item_id, quantity_base, unit_label)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(version_id, inventory_item_id)
             DO UPDATE SET quantity_base = excluded.quantity_base, unit_label = excluded.unit_label`
          ).run(versionId, item.id, ingredient.quantity.baseQuantity, item.unitShortName);
        }
        db.prepare(
          `INSERT INTO menu_item_inventory_bindings
           (menu_item_id, binding_type, recipe_id, inventory_item_id, quantity_base, unit_label, updated_at)
           VALUES (?, 'recipe', ?, NULL, 1, 'portion', CURRENT_TIMESTAMP)
           ON CONFLICT(menu_item_id) DO UPDATE SET binding_type = 'recipe', recipe_id = excluded.recipe_id,
             inventory_item_id = NULL, quantity_base = 1, unit_label = 'portion', updated_at = CURRENT_TIMESTAMP`
        ).run(menuItem.id, recipeId);
        changedMenuItemIds.add(menuItem.id);
        changedVersionIds.set(menuItem.id, versionId);
      }
    }
  });
  tx();
  const historicalOrdersUpdated = recalculateHistoricalOrdersForMenuItems(
    db,
    Array.from(changedMenuItemIds),
    options,
    actor,
    options.snapshotMode ? undefined : changedVersionIds
  );
  result.versionsCreated = options.snapshotMode ? changedMenuItemIds.size : 0;
  result.versionsUpdated = options.snapshotMode ? 0 : changedMenuItemIds.size;
  result.historicalOrdersUpdated = historicalOrdersUpdated;
  recordActivity(db, "inventory_csv_imported", { ...result, snapshotMode: Boolean(options.snapshotMode), historicalScope: options.historicalScope ?? "future" }, actor);
  return result;
}

export function importInventoryItemsCsv(db: Database.Database, csvPath: string, actor = "admin"): InventoryItemImportResult {
  const csv = fs.readFileSync(csvPath, "utf8");
  const parsed = Papa.parse<InventoryItemCsvRow>(csv, { header: true, skipEmptyLines: true });
  const result: InventoryItemImportResult = { imported: 0, updated: 0, skipped: 0, deleted: 0, errors: [] };
  const tx = db.transaction(() => {
    result.deleted = (db.prepare("SELECT COUNT(*) AS count FROM inventory_items").get() as { count: number }).count;
    db.prepare("DELETE FROM menu_item_inventory_bindings").run();
    db.prepare("DELETE FROM recipe_version_child_ingredients").run();
    db.prepare("DELETE FROM recipe_version_ingredients").run();
    db.prepare("DELETE FROM recipe_versions").run();
    db.prepare("DELETE FROM recipe_child_ingredients").run();
    db.prepare("DELETE FROM recipe_ingredients").run();
    db.prepare("DELETE FROM menu_item_recipes").run();
    db.prepare("DELETE FROM inventory_adjustments").run();
    db.prepare("DELETE FROM inventory_physical_counts").run();
    db.prepare("DELETE FROM inventory_price_history").run();
    db.prepare("DELETE FROM inventory_restock_entries").run();
    db.prepare("DELETE FROM inventory_items").run();

    for (const row of parsed.data) {
      const name = cleanText(row["Item Name"] ?? "");
      const unit = cleanText(row["Unit / Type"] ?? "g") || "g";
      const categoryName = cleanText(row["Item Category"] ?? "Other") || "Other";
      if (!name) {
        result.skipped += 1;
        continue;
      }
      const unitId = ensureInventoryUnit(db, unit);
      const categoryId = ensureInventoryCategory(db, categoryName);
      db.prepare(
        `INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold, active)
         VALUES (?, ?, ?, 1000, 1)
         ON CONFLICT(name) DO UPDATE SET category_id = excluded.category_id, base_unit_id = excluded.base_unit_id,
           low_stock_threshold = 1000, active = 1, updated_at = CURRENT_TIMESTAMP`
      ).run(name, categoryId, unitId);
      result.imported += 1;
    }
  });
  tx();
  recordActivity(db, "inventory_items_csv_imported", { ...result }, actor);
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
  input: RecipeSaveInput,
  options: HistoricalChangeOptions = {},
  actor = "admin"
): MenuRecipe {
  validateHistoricalChangeOptions(options);
  const standalone = input.standalone === true || !input.menuItemId;
  const createStandalone = !input.menuItemId;
  const recipeName = cleanText(input.recipeName ?? "");
  let menuItem = input.menuItemId
    ? db.prepare("SELECT id, name, category, archived FROM menu_items WHERE id = ?").get(input.menuItemId) as { id: number; name: string; category: string | null; archived: number } | undefined
    : undefined;
  if (input.menuItemId && !menuItem) throw new Error("Menu item not found.");
  if (standalone && !recipeName) throw new Error("Standalone recipe name is required.");
  if (standalone && menuItem && (menuItem.archived !== 1 || menuItem.category !== "Recipe Material")) {
    throw new Error("Menu-backed recipe names must be changed from the Menu tab.");
  }
  const cleanIngredients = input.ingredients
    .map((ingredient) => ({
      kind: ingredient.kind === "recipe" ? "recipe" : "raw",
      inventoryItemId: Number(ingredient.inventoryItemId ?? 0),
      childRecipeId: Number(ingredient.childRecipeId ?? 0),
      quantityBase: Math.max(0, Number(ingredient.quantityBase)),
      unitLabel: cleanText(ingredient.unitLabel || (ingredient.kind === "recipe" ? "portion" : "g"))
    }))
    .filter((ingredient) => {
      if (ingredient.quantityBase <= 0) return false;
      return ingredient.kind === "recipe"
        ? Number.isInteger(ingredient.childRecipeId) && ingredient.childRecipeId > 0
        : Number.isInteger(ingredient.inventoryItemId) && ingredient.inventoryItemId > 0;
    });
  if (standalone && cleanIngredients.length === 0) throw new Error("Standalone recipes need at least one ingredient.");
  let savedVersionId = 0;
  const tx = db.transaction(() => {
    if (createStandalone) {
      const duplicate = db.prepare("SELECT id FROM menu_items WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1").get(recipeName) as { id: number } | undefined;
      if (duplicate) throw new Error("A menu item or recipe with this name already exists.");
      const menuItemId = Number(
        db.prepare(
          `INSERT INTO menu_items (name, price, category, track_recipe, available, archived)
           VALUES (?, 0, 'Recipe Material', 1, 0, 1)`
        ).run(recipeName).lastInsertRowid
      );
      menuItem = { id: menuItemId, name: recipeName, category: "Recipe Material", archived: 1 };
    } else if (standalone && menuItem) {
      const duplicate = db.prepare(
        "SELECT id FROM menu_items WHERE lower(trim(name)) = lower(trim(?)) AND id <> ? LIMIT 1"
      ).get(recipeName, menuItem.id) as { id: number } | undefined;
      if (duplicate) throw new Error("A menu item or recipe with this name already exists.");
      db.prepare("UPDATE menu_items SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recipeName, menuItem.id);
      menuItem = { ...menuItem, name: recipeName };
    }
    if (!menuItem) throw new Error("Menu item not found.");
    const existing = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ?").get(menuItem.id) as { id: number } | undefined;
    const recipeId = existing
      ? existing.id
      : Number(db.prepare("INSERT INTO menu_item_recipes (menu_item_id) VALUES (?)").run(menuItem.id).lastInsertRowid);
    const versionId = prepareRecipeVersion(db, recipeId, Boolean(options.snapshotMode), "manual", options.reason ?? null);
    savedVersionId = versionId;
    if (cleanIngredients.length === 0) {
      db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
      db.prepare("DELETE FROM recipe_child_ingredients WHERE recipe_id = ?").run(recipeId);
      db.prepare("DELETE FROM recipe_version_ingredients WHERE version_id = ?").run(versionId);
      db.prepare("DELETE FROM recipe_version_child_ingredients WHERE version_id = ?").run(versionId);
      db.prepare(
        "DELETE FROM menu_item_inventory_bindings WHERE menu_item_id = ? AND binding_type = 'recipe' AND recipe_id = ?"
      ).run(menuItem.id, recipeId);
      db.prepare("UPDATE menu_item_recipes SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recipeId);
      return;
    }
    db.prepare("UPDATE menu_item_recipes SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recipeId);
    db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
    db.prepare("DELETE FROM recipe_child_ingredients WHERE recipe_id = ?").run(recipeId);
    db.prepare("DELETE FROM recipe_version_ingredients WHERE version_id = ?").run(versionId);
    db.prepare("DELETE FROM recipe_version_child_ingredients WHERE version_id = ?").run(versionId);
    const insertRaw = db.prepare("INSERT INTO recipe_ingredients (recipe_id, inventory_item_id, quantity_base, unit_label) VALUES (?, ?, ?, ?)");
    const insertChild = db.prepare("INSERT INTO recipe_child_ingredients (recipe_id, child_recipe_id, quantity_base, unit_label) VALUES (?, ?, ?, ?)");
    const insertVersionRaw = db.prepare("INSERT INTO recipe_version_ingredients (version_id, inventory_item_id, quantity_base, unit_label) VALUES (?, ?, ?, ?)");
    const insertVersionChild = db.prepare("INSERT INTO recipe_version_child_ingredients (version_id, child_recipe_id, child_version_id, quantity_base, unit_label) VALUES (?, ?, ?, ?, ?)");
    for (const ingredient of cleanIngredients) {
      if (ingredient.kind === "recipe") {
        if (ingredient.childRecipeId === recipeId) throw new Error("A recipe cannot include itself.");
        const child = db.prepare("SELECT id, current_version_id FROM menu_item_recipes WHERE id = ? AND active = 1").get(ingredient.childRecipeId) as { id: number; current_version_id: number | null } | undefined;
        if (!child?.current_version_id) throw new Error("Linked recipe does not have an active version.");
        if (recipeDependsOn(db, ingredient.childRecipeId, recipeId)) throw new Error("This recipe link would create a circular recipe.");
        insertChild.run(recipeId, ingredient.childRecipeId, ingredient.quantityBase, ingredient.unitLabel || "portion");
        insertVersionChild.run(versionId, ingredient.childRecipeId, child.current_version_id, ingredient.quantityBase, ingredient.unitLabel || "portion");
      } else {
        insertRaw.run(recipeId, ingredient.inventoryItemId, ingredient.quantityBase, ingredient.unitLabel);
        insertVersionRaw.run(versionId, ingredient.inventoryItemId, ingredient.quantityBase, ingredient.unitLabel);
      }
    }
    if (!standalone) {
      db.prepare(
        `INSERT INTO menu_item_inventory_bindings
         (menu_item_id, binding_type, recipe_id, inventory_item_id, quantity_base, unit_label, updated_at)
         VALUES (?, 'recipe', ?, NULL, 1, 'portion', CURRENT_TIMESTAMP)
         ON CONFLICT(menu_item_id) DO UPDATE SET binding_type = 'recipe', recipe_id = excluded.recipe_id,
           inventory_item_id = NULL, quantity_base = 1, unit_label = 'portion', updated_at = CURRENT_TIMESTAMP`
      ).run(menuItem.id, recipeId);
    }
  });
  tx();
  if (!menuItem) throw new Error("Recipe could not be saved.");
  const savedMenuItemId = menuItem.id;
  const historicalOrdersUpdated = standalone
    ? 0
    : recalculateHistoricalOrdersForMenuItems(
      db,
      [menuItem.id],
      options,
      actor,
      options.snapshotMode ? undefined : new Map([[menuItem.id, savedVersionId]])
    );
  recordActivity(db, createStandalone ? "standalone_recipe_created" : cleanIngredients.length === 0 ? "recipe_removed" : options.snapshotMode ? "recipe_version_created" : "recipe_updated", {
    entityType: "menu_item",
    entityId: String(menuItem.id),
    itemName: menuItem.name,
    ingredientCount: cleanIngredients.length,
    recipeVersionId: savedVersionId,
    snapshotMode: Boolean(options.snapshotMode),
    standalone,
    historicalScope: options.historicalScope ?? "future",
    historicalOrdersUpdated
  }, actor);
  return listMenuRecipes(db).find((recipe) => recipe.menuItemId === savedMenuItemId)!;
}

export function setRecipeRestockEnabled(db: Database.Database, menuItemId: number, enabled: boolean, actor = "admin"): MenuRecipe {
  const menuItem = db.prepare("SELECT id, name FROM menu_items WHERE id = ?").get(menuItemId) as { id: number; name: string } | undefined;
  if (!menuItem) throw new Error("Menu item not found.");
  const existing = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ?").get(menuItem.id) as { id: number } | undefined;
  const recipeId = existing?.id ?? Number(db.prepare("INSERT INTO menu_item_recipes (menu_item_id, active, restock_enabled) VALUES (?, 0, ?)").run(menuItem.id, enabled ? 1 : 0).lastInsertRowid);
  db.prepare("UPDATE menu_item_recipes SET restock_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(enabled ? 1 : 0, recipeId);
  recordActivity(db, "recipe_restock_option_updated", { entityType: "menu_item", entityId: String(menuItem.id), itemName: menuItem.name, enabled }, actor);
  return listMenuRecipes(db).find((recipe) => recipe.menuItemId === menuItem.id)!;
}

export function setRecipeUseInRecipeEnabled(db: Database.Database, menuItemId: number, enabled: boolean, actor = "admin"): MenuRecipe {
  const menuItem = db.prepare("SELECT id, name FROM menu_items WHERE id = ?").get(menuItemId) as { id: number; name: string } | undefined;
  if (!menuItem) throw new Error("Menu item not found.");
  const existing = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ?").get(menuItem.id) as { id: number } | undefined;
  const recipeId = existing?.id ?? Number(db.prepare("INSERT INTO menu_item_recipes (menu_item_id, active, use_in_recipe_enabled) VALUES (?, 0, ?)").run(menuItem.id, enabled ? 1 : 0).lastInsertRowid);
  db.prepare("UPDATE menu_item_recipes SET use_in_recipe_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(enabled ? 1 : 0, recipeId);
  recordActivity(db, "recipe_use_in_recipe_option_updated", { entityType: "menu_item", entityId: String(menuItem.id), itemName: menuItem.name, enabled }, actor);
  return listMenuRecipes(db).find((recipe) => recipe.menuItemId === menuItem.id)!;
}

export function listMenuInventoryBindings(db: Database.Database): MenuInventoryBinding[] {
  return db.prepare(
    `SELECT b.id, b.menu_item_id, mi.name AS menu_item_name, b.binding_type, b.recipe_id,
            recipe_item.name AS recipe_name, b.inventory_item_id, ii.name AS inventory_item_name,
            b.quantity_base, b.unit_label, b.updated_at
     FROM menu_item_inventory_bindings b
     JOIN menu_items mi ON mi.id = b.menu_item_id
     LEFT JOIN menu_item_recipes mr ON mr.id = b.recipe_id
     LEFT JOIN menu_items recipe_item ON recipe_item.id = mr.menu_item_id
     LEFT JOIN inventory_items ii ON ii.id = b.inventory_item_id
     ORDER BY mi.name`
  ).all().map((row) => {
    const item = row as {
      id: number;
      menu_item_id: number;
      menu_item_name: string;
      binding_type: "recipe" | "item";
      recipe_id: number | null;
      recipe_name: string | null;
      inventory_item_id: number | null;
      inventory_item_name: string | null;
      quantity_base: number;
      unit_label: string;
      updated_at: string;
    };
    return {
      id: item.id,
      menuItemId: item.menu_item_id,
      menuItemName: item.menu_item_name,
      bindingType: item.binding_type,
      recipeId: item.recipe_id,
      recipeName: item.recipe_name,
      inventoryItemId: item.inventory_item_id,
      inventoryItemName: item.inventory_item_name,
      quantityBase: item.quantity_base,
      unitLabel: item.unit_label,
      updatedAt: item.updated_at
    };
  });
}

export function saveMenuInventoryBinding(db: Database.Database, input: MenuBindingInput, actor = "admin"): MenuInventoryBinding {
  validateHistoricalChangeOptions(input);
  const menuItem = db.prepare("SELECT id, name FROM menu_items WHERE id = ?").get(input.menuItemId) as { id: number; name: string } | undefined;
  if (!menuItem) throw new Error("Menu item not found.");
  const quantityBase = Number(input.quantityBase ?? 1);
  if (!Number.isFinite(quantityBase) || quantityBase <= 0) throw new Error("Usage quantity must be greater than zero.");
  let recipeId: number | null = null;
  let inventoryItemId: number | null = null;
  let unitLabel = cleanText(input.unitLabel ?? "") || "portion";
  if (input.bindingType === "recipe") {
    const recipe = db.prepare("SELECT id FROM menu_item_recipes WHERE id = ? AND active = 1 AND current_version_id IS NOT NULL").get(Number(input.recipeId)) as { id: number } | undefined;
    if (!recipe) throw new Error("Choose an active recipe with a saved version.");
    recipeId = recipe.id;
    unitLabel = unitLabel || "portion";
  } else {
    const item = db.prepare(
      `SELECT ii.id, iu.short_name
       FROM inventory_items ii JOIN inventory_units iu ON iu.id = ii.base_unit_id
       WHERE ii.id = ? AND ii.active = 1`
    ).get(Number(input.inventoryItemId)) as { id: number; short_name: string } | undefined;
    if (!item) throw new Error("Choose an active inventory item.");
    inventoryItemId = item.id;
    unitLabel = item.short_name;
  }
  db.prepare(
    `INSERT INTO menu_item_inventory_bindings
     (menu_item_id, binding_type, recipe_id, inventory_item_id, quantity_base, unit_label, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(menu_item_id) DO UPDATE SET binding_type = excluded.binding_type, recipe_id = excluded.recipe_id,
       inventory_item_id = excluded.inventory_item_id, quantity_base = excluded.quantity_base,
       unit_label = excluded.unit_label, updated_at = CURRENT_TIMESTAMP`
  ).run(menuItem.id, input.bindingType, recipeId, inventoryItemId, quantityBase, unitLabel);
  db.prepare("UPDATE menu_items SET track_recipe = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(input.bindingType === "recipe" ? 1 : 0, menuItem.id);
  const historicalOrdersUpdated = recalculateHistoricalOrdersForMenuItems(db, [menuItem.id], input, actor);
  recordActivity(db, "menu_inventory_binding_updated", {
    entityType: "menu_item",
    entityId: String(menuItem.id),
    itemName: menuItem.name,
    bindingType: input.bindingType,
    recipeId,
    inventoryItemId,
    quantityBase,
    historicalScope: input.historicalScope ?? "future",
    historicalOrdersUpdated,
    reason: cleanText(input.reason ?? "") || "Manager binding correction"
  }, actor);
  return listMenuInventoryBindings(db).find((binding) => binding.menuItemId === menuItem.id)!;
}

export function removeMenuInventoryBinding(
  db: Database.Database,
  menuItemId: number,
  options: Omit<MenuBindingInput, "menuItemId" | "bindingType"> = {},
  actor = "admin"
): void {
  validateHistoricalChangeOptions(options);
  const menuItem = db.prepare("SELECT id, name FROM menu_items WHERE id = ?").get(menuItemId) as { id: number; name: string } | undefined;
  if (!menuItem) throw new Error("Menu item not found.");
  db.prepare("DELETE FROM menu_item_inventory_bindings WHERE menu_item_id = ?").run(menuItemId);
  db.prepare("UPDATE menu_items SET track_recipe = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(menuItemId);
  const historicalOrdersUpdated = recalculateHistoricalOrdersForMenuItems(db, [menuItemId], options, actor);
  recordActivity(db, "menu_inventory_binding_removed", {
    entityType: "menu_item",
    entityId: String(menuItemId),
    itemName: menuItem.name,
    historicalScope: options.historicalScope ?? "future",
    historicalOrdersUpdated,
    reason: cleanText(options.reason ?? "") || "Manager removed inventory binding"
  }, actor);
}

export function previewMenuBindingImpact(
  db: Database.Database,
  input: Pick<MenuBindingInput, "menuItemId" | "start" | "end">
): InventoryBindingPreview {
  validateDateRange(input, false);
  const menuItem = db.prepare("SELECT id, name FROM menu_items WHERE id = ?").get(input.menuItemId) as { id: number; name: string } | undefined;
  if (!menuItem) throw new Error("Menu item not found.");
  const orders = listSettledOrdersForMenuItems(db, [menuItem.id], input);
  let estimatedRevenue = 0;
  let estimatedRawCost = 0;
  let currentSnapshotRawCost = 0;
  let estimatedMissingRecipeCount = 0;
  let missingSnapshotCount = 0;
  let existingSnapshotCount = 0;
  for (const order of orders) {
    const lines = db.prepare(
      `SELECT oi.id, oi.quantity, oi.unit_price, oics.raw_cost
       FROM order_items oi
       LEFT JOIN order_item_cost_snapshots oics ON oics.order_item_id = oi.id
       WHERE oi.order_id = ? AND oi.menu_item_id = ? AND oi.status = 'active'`
    ).all(order.id, menuItem.id) as Array<{ id: number; quantity: number; unit_price: number; raw_cost: number | null }>;
    for (const line of lines) {
      const bindingCost = getMenuItemBindingCost(db, menuItem.id);
      estimatedRevenue += line.quantity * line.unit_price;
      estimatedRawCost += bindingCost.rawCost * line.quantity;
      currentSnapshotRawCost += Number(line.raw_cost ?? 0);
      if (!bindingCost.hasBinding || bindingCost.ingredients.length === 0) estimatedMissingRecipeCount += 1;
      if (line.raw_cost == null) missingSnapshotCount += 1;
      else existingSnapshotCount += 1;
    }
  }
  return {
    menuItemId: menuItem.id,
    menuItemName: menuItem.name,
    orderCount: orders.length,
    missingSnapshotCount,
    existingSnapshotCount,
    estimatedRevenue: roundMoney(estimatedRevenue),
    estimatedRawCost: roundMoney(estimatedRawCost),
    currentSnapshotRawCost: roundMoney(currentSnapshotRawCost),
    rawCostDelta: roundMoney(estimatedRawCost - currentSnapshotRawCost),
    estimatedMissingRecipeCount
  };
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

export function saveCostCategory(db: Database.Database, input: { id?: number; name: string; active?: boolean; sortOrder?: number }, actor = "admin"): CostCategory {
  const name = cleanText(input.name);
  if (!name) throw new Error("Cost category name is required.");
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0;
  if (input.id) {
    db.prepare("UPDATE cost_categories SET name = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(name, input.active === false ? 0 : 1, sortOrder, input.id);
    recordActivity(db, "cost_category_updated", { entityType: "cost_category", entityId: String(input.id), name }, actor);
    return listCostCategories(db).find((category) => category.id === input.id)!;
  }
  const id = Number(db.prepare("INSERT INTO cost_categories (name, active, sort_order) VALUES (?, ?, ?)").run(name, input.active === false ? 0 : 1, sortOrder).lastInsertRowid);
  recordActivity(db, "cost_category_created", { entityType: "cost_category", entityId: String(id), name }, actor);
  return listCostCategories(db).find((category) => category.id === id)!;
}

export function removeCostCategory(db: Database.Database, id: number, actor = "admin"): void {
  db.prepare("UPDATE cost_categories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  recordActivity(db, "cost_category_removed", { entityType: "cost_category", entityId: String(id) }, actor);
}

export function addRestockEntry(
  db: Database.Database,
  input: RestockEntryInput,
  actor = "admin"
): RestockEntry {
  const item = getInventoryItem(db, input.inventoryItemId);
  const entryType = input.entryType ?? "purchase";
  const quantity = entryType === "adjustment" ? Number(input.quantity) : Math.max(0, Number(input.quantity));
  if (!Number.isFinite(quantity) || quantity === 0) throw new Error(entryType === "adjustment" ? "Adjustment quantity cannot be zero." : "Restock quantity must be greater than zero.");
  const adjustmentReason = cleanText(input.adjustmentReason ?? "");
  if (entryType === "adjustment" && !adjustmentReason) throw new Error("Adjustment reason is required.");
  const totalCost = Math.max(0, Number(input.totalCost ?? 0));
  const pricePerBase = entryType === "purchase" && quantity > 0 ? totalCost / quantity : 0;
  const entryDate = normalizeOptionalInventoryTimestamp(input.entryDate, "Restock time");
  let id = 0;
  const tx = db.transaction(() => {
    id = Number(db.prepare(
      `INSERT INTO inventory_restock_entries
       (inventory_item_id, item_type, entry_type, recipe_id, quantity_base, unit_label, total_cost, price_per_base, supplier_name, responsible_person, note, adjustment_reason, entry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).run(input.inventoryItemId, input.itemType ?? "raw", entryType, input.recipeId ?? null, quantity, item.unitShortName, totalCost, pricePerBase, input.supplierName ?? null, input.responsiblePerson ?? null, input.note ?? null, adjustmentReason || null, entryDate).lastInsertRowid);
    const savedTime = (db.prepare("SELECT entry_date FROM inventory_restock_entries WHERE id = ?").get(id) as { entry_date: string }).entry_date;
    if (entryType === "adjustment") {
      db.prepare(
        `INSERT INTO inventory_adjustments (inventory_item_id, quantity_delta, reason, note, restock_entry_id, created_at)
         VALUES (?, ?, 'Stock adjustment', ?, ?, ?)`
      ).run(input.inventoryItemId, quantity, adjustmentReason, id, savedTime);
    }
    recalculatePhysicalCountDeltas(db, [input.inventoryItemId]);
  });
  tx();
  const saved = listRestockEntries(db, 10000).find((entry) => entry.id === id);
  if (!saved) throw new Error("Restock entry could not be saved.");
  if (pricePerBase > 0) {
    addPriceRecord(db, { inventoryItemId: input.inventoryItemId, pricePerBase, effectiveAt: saved.entryDate, responsiblePerson: input.responsiblePerson ?? null, note: "Updated from restock entry" }, actor);
  }
  recordActivity(db, entryType === "adjustment" ? "inventory_stock_adjustment_created" : "inventory_restock_created", { entityType: "inventory_item", entityId: String(input.inventoryItemId), itemName: item.name, quantity, reason: adjustmentReason || null }, actor);
  return saved;
}

export function updateRestockEntry(
  db: Database.Database,
  input: RestockEntryUpdateInput,
  actor = "admin"
): RestockEntry {
  const existing = db.prepare("SELECT id, inventory_item_id, entry_date FROM inventory_restock_entries WHERE id = ?").get(input.id) as { id: number; inventory_item_id: number; entry_date: string } | undefined;
  if (!existing) throw new Error("Restock entry not found.");
  const item = getInventoryItem(db, input.inventoryItemId);
  const entryType = input.entryType ?? "purchase";
  const quantity = entryType === "adjustment" ? Number(input.quantity) : Math.max(0, Number(input.quantity));
  if (!Number.isFinite(quantity) || quantity === 0) throw new Error(entryType === "adjustment" ? "Adjustment quantity cannot be zero." : "Restock quantity must be greater than zero.");
  const adjustmentReason = cleanText(input.adjustmentReason ?? "");
  if (entryType === "adjustment" && !adjustmentReason) throw new Error("Adjustment reason is required.");
  const totalCost = Math.max(0, Number(input.totalCost ?? 0));
  const pricePerBase = entryType === "purchase" && quantity > 0 ? totalCost / quantity : 0;
  const entryDate = input.entryDate?.trim()
    ? normalizeOptionalInventoryTimestamp(input.entryDate, "Restock time")!
    : existing.entry_date;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE inventory_restock_entries
       SET inventory_item_id = ?, item_type = ?, entry_type = ?, recipe_id = ?, quantity_base = ?, unit_label = ?, total_cost = ?, price_per_base = ?,
           supplier_name = ?, responsible_person = ?, note = ?, adjustment_reason = ?, entry_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(input.inventoryItemId, input.itemType ?? "raw", entryType, input.recipeId ?? null, quantity, item.unitShortName, totalCost, pricePerBase, input.supplierName ?? null, input.responsiblePerson ?? null, input.note ?? null, adjustmentReason || null, entryDate, input.id);
    db.prepare("DELETE FROM inventory_adjustments WHERE restock_entry_id = ?").run(input.id);
    if (entryType === "adjustment") {
      db.prepare(
        `INSERT INTO inventory_adjustments (inventory_item_id, quantity_delta, reason, note, restock_entry_id, created_at)
         VALUES (?, ?, 'Stock adjustment', ?, ?, ?)`
      ).run(input.inventoryItemId, quantity, adjustmentReason, input.id, entryDate);
    }
    recalculatePhysicalCountDeltas(db, [existing.inventory_item_id, input.inventoryItemId]);
  });
  tx();
  if (pricePerBase > 0) {
    addPriceRecord(db, { inventoryItemId: input.inventoryItemId, pricePerBase, effectiveAt: entryDate, responsiblePerson: input.responsiblePerson ?? null, note: "Updated from restock edit" }, actor);
  }
  recordActivity(db, entryType === "adjustment" ? "inventory_stock_adjustment_updated" : "inventory_restock_updated", { entityType: "inventory_restock", entityId: String(input.id), itemName: item.name, quantity, reason: adjustmentReason || null }, actor);
  return listRestockEntries(db, 10000).find((entry) => entry.id === input.id)!;
}

export function deleteRestockEntry(db: Database.Database, id: number, actor = "admin"): void {
  const existing = db.prepare(
    `SELECT re.id, re.inventory_item_id, re.quantity_base, ii.name AS item_name
     FROM inventory_restock_entries re
     JOIN inventory_items ii ON ii.id = re.inventory_item_id
     WHERE re.id = ?`
  ).get(id) as { id: number; inventory_item_id: number; quantity_base: number; item_name: string } | undefined;
  if (!existing) throw new Error("Restock entry not found.");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM inventory_adjustments WHERE restock_entry_id = ?").run(id);
    db.prepare("DELETE FROM inventory_restock_entries WHERE id = ?").run(id);
    recalculatePhysicalCountDeltas(db, [existing.inventory_item_id]);
  });
  tx();
  recordActivity(db, "inventory_restock_deleted", {
    entityType: "inventory_restock",
    entityId: String(id),
    inventoryItemId: existing.inventory_item_id,
    itemName: existing.item_name,
    quantity: existing.quantity_base
  }, actor);
}

export function addPhysicalCount(
  db: Database.Database,
  input: PhysicalCountInput,
  actor = "admin"
): PhysicalCountEntry {
  const item = getInventoryItem(db, input.inventoryItemId);
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Physical count must be zero or greater.");
  const countDate = normalizeOptionalInventoryTimestamp(input.countDate, "Count time");
  let id = 0;
  const tx = db.transaction(() => {
    id = Number(db.prepare(
      `INSERT INTO inventory_physical_counts
       (inventory_item_id, quantity_base, reduction_delta, unit_label, responsible_person, note, count_date, source)
       VALUES (?, ?, 0, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`
    ).run(input.inventoryItemId, quantity, item.unitShortName, input.responsiblePerson ?? null, input.note ?? null, countDate, input.source ?? "manual").lastInsertRowid);
    recalculatePhysicalCountDeltas(db, [input.inventoryItemId]);
  });
  tx();
  const saved = listPhysicalCounts(db, 10000).find((entry) => entry.id === id);
  if (!saved) throw new Error("Physical count could not be saved.");
  recordActivity(db, "inventory_physical_count_saved", { entityType: "inventory_item", entityId: String(input.inventoryItemId), itemName: item.name, quantity, reductionDelta: saved.reductionDelta }, actor);
  return saved;
}

export function updatePhysicalCount(
  db: Database.Database,
  input: PhysicalCountUpdateInput,
  actor = "admin"
): PhysicalCountEntry {
  const existing = db.prepare(
    `SELECT pc.id, pc.inventory_item_id, pc.quantity_base, pc.unit_label, pc.responsible_person, pc.note, pc.count_date, ii.name AS item_name
     FROM inventory_physical_counts pc
     JOIN inventory_items ii ON ii.id = pc.inventory_item_id
     WHERE pc.id = ?`
  ).get(input.id) as { id: number; inventory_item_id: number; quantity_base: number; unit_label: string; responsible_person: string | null; note: string | null; count_date: string; item_name: string } | undefined;
  if (!existing) throw new Error("Physical count entry not found.");
  const reason = cleanText(input.reason ?? "") || "Manager corrected physical count";
  const item = getInventoryItem(db, input.inventoryItemId);
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Physical count must be zero or greater.");
  const countDate = input.countDate?.trim()
    ? normalizeOptionalInventoryTimestamp(input.countDate, "Count time")!
    : existing.count_date;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE inventory_physical_counts
       SET inventory_item_id = ?, quantity_base = ?, reduction_delta = 0, unit_label = ?, responsible_person = ?, note = ?,
           count_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(input.inventoryItemId, quantity, item.unitShortName, input.responsiblePerson ?? null, input.note ?? null, countDate, input.id);
    recalculatePhysicalCountDeltas(db, [existing.inventory_item_id, input.inventoryItemId]);
  });
  tx();
  recordActivity(db, "inventory_physical_count_updated", {
    entityType: "inventory_physical_count",
    entityId: String(input.id),
    itemName: item.name,
    oldItemName: existing.item_name,
    oldQuantity: existing.quantity_base,
    newQuantity: quantity,
    oldUnit: existing.unit_label,
    newUnit: item.unitShortName,
    reason
  }, actor);
  const saved = listPhysicalCounts(db, 10000).find((entry) => entry.id === input.id)!;
  return saved;
}

export function deletePhysicalCount(db: Database.Database, id: number, reason = "Manager deleted incorrect physical count", actor = "admin"): void {
  const existing = db.prepare(
    `SELECT pc.id, pc.inventory_item_id, pc.quantity_base, pc.unit_label, ii.name AS item_name
     FROM inventory_physical_counts pc
     JOIN inventory_items ii ON ii.id = pc.inventory_item_id
     WHERE pc.id = ?`
  ).get(id) as { id: number; inventory_item_id: number; quantity_base: number; unit_label: string; item_name: string } | undefined;
  if (!existing) throw new Error("Physical count entry not found.");
  const cleanReason = cleanText(reason) || "Manager deleted incorrect physical count";
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM inventory_physical_counts WHERE id = ?").run(id);
    recalculatePhysicalCountDeltas(db, [existing.inventory_item_id]);
  });
  tx();
  recordActivity(db, "inventory_physical_count_deleted", {
    entityType: "inventory_physical_count",
    entityId: String(id),
    inventoryItemId: existing.inventory_item_id,
    itemName: existing.item_name,
    oldQuantity: existing.quantity_base,
    oldUnit: existing.unit_label,
    reason: cleanReason
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
  const costDate = normalizeOptionalBusinessDate(input.costDate, "Cost date");
  const id = Number(
    db.prepare(
      `INSERT INTO cost_records (cost_category_id, cost_name, quantity, amount, payment_method, responsible_person, note, cost_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
    ).run(input.categoryId ?? null, costName, 1, amount, input.paymentMethod ?? null, input.responsiblePerson ?? null, input.note ?? null, costDate).lastInsertRowid
  );
  recordActivity(db, "cost_record_created", { entityType: "cost_record", entityId: String(id), costName, amount }, actor);
  return listCostRecords(db, 10000).find((entry) => entry.id === id)!;
}

export function updateCostRecord(
  db: Database.Database,
  input: {
    id: number;
    categoryId?: number | null;
    costName: string;
    amount: number;
    paymentMethod?: string | null;
    responsiblePerson?: string | null;
    note?: string | null;
    costDate?: string | null;
    reason?: string | null;
  },
  actor = "admin"
): CostRecord {
  const existing = db.prepare("SELECT id, cost_name, amount FROM cost_records WHERE id = ?").get(input.id) as { id: number; cost_name: string; amount: number } | undefined;
  if (!existing) throw new Error("Cost record not found.");
  const reason = cleanText(input.reason ?? "") || "Manager corrected cost record";
  const costName = cleanText(input.costName);
  if (!costName) throw new Error("Cost name is required.");
  const amount = Math.max(0, Number(input.amount));
  if (amount <= 0) throw new Error("Cost amount must be greater than zero.");
  const costDate = normalizeOptionalBusinessDate(input.costDate, "Cost date");
  db.prepare(
    `UPDATE cost_records
     SET cost_category_id = ?, cost_name = ?, quantity = 1, amount = ?, payment_method = ?, responsible_person = ?, note = ?,
         cost_date = COALESCE(?, cost_date), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(input.categoryId ?? null, costName, amount, input.paymentMethod ?? null, input.responsiblePerson ?? null, input.note ?? null, costDate, input.id);
  recordActivity(db, "cost_record_updated", {
    entityType: "cost_record",
    entityId: String(input.id),
    costName,
    oldCostName: existing.cost_name,
    oldAmount: existing.amount,
    newAmount: amount,
    reason
  }, actor);
  return listCostRecords(db, 10000).find((entry) => entry.id === input.id)!;
}

export function deleteCostRecord(db: Database.Database, id: number, reason = "Manager deleted incorrect cost record", actor = "admin"): void {
  const existing = db.prepare("SELECT id, cost_name, amount FROM cost_records WHERE id = ?").get(id) as { id: number; cost_name: string; amount: number } | undefined;
  if (!existing) throw new Error("Cost record not found.");
  const cleanReason = cleanText(reason) || "Manager deleted incorrect cost record";
  db.prepare("DELETE FROM cost_records WHERE id = ?").run(id);
  recordActivity(db, "cost_record_deleted", {
    entityType: "cost_record",
    entityId: String(id),
    costName: existing.cost_name,
    oldAmount: existing.amount,
    reason: cleanReason
  }, actor);
}

export function createOrderCostSnapshot(db: Database.Database, orderId: number, actor = "system"): void {
  const orderFlags = db.prepare("SELECT is_test, delivery_fee FROM orders WHERE id = ?").get(orderId) as { is_test: number; delivery_fee: number } | undefined;
  if (!orderFlags) throw new Error("Order not found.");
  if (orderFlags.is_test === 1) return;
  const existing = db.prepare("SELECT id FROM order_cost_snapshots WHERE order_id = ?").get(orderId) as { id: number } | undefined;
  if (existing) return;
  const orderTiming = db.prepare(
    "SELECT COALESCE(settled_at, CURRENT_TIMESTAMP) AS effective_at FROM orders WHERE id = ?"
  ).get(orderId) as { effective_at: string } | undefined;
  if (!orderTiming) throw new Error("Order not found.");
  const rows = db.prepare(
    `SELECT oi.id, oi.menu_item_id, oi.quantity, oi.unit_price, oi.name
     FROM order_items oi
     WHERE oi.order_id = ? AND oi.status = 'active'`
  ).all(orderId) as Array<{ id: number; menu_item_id: number; quantity: number; unit_price: number; name: string }>;
  let revenue = Math.max(0, orderFlags.delivery_fee ?? 0);
  let rawCost = 0;
  let missingRecipeCount = 0;
  const affectedInventoryItems = new Set<number>();
  const tx = db.transaction(() => {
    for (const row of rows) {
      const itemRevenue = row.quantity * row.unit_price;
      const bindingCost = getMenuItemBindingCost(db, row.menu_item_id);
      if (!bindingCost.hasBinding || bindingCost.ingredients.length === 0) missingRecipeCount += 1;
      const itemRawCost = bindingCost.rawCost * row.quantity;
      revenue += itemRevenue;
      rawCost += itemRawCost;
      db.prepare(
        `INSERT INTO order_item_cost_snapshots
         (order_id, order_item_id, menu_item_id, quantity, revenue, raw_cost, profit, details_json,
          recipe_version_id, binding_type, binding_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        orderId,
        row.id,
        row.menu_item_id,
        row.quantity,
        itemRevenue,
        itemRawCost,
        itemRevenue - itemRawCost,
        JSON.stringify(bindingCost.ingredients),
        bindingCost.recipeVersionId,
        bindingCost.bindingType,
        bindingCost.bindingId
      );
      const adjustment = db.prepare(
        `INSERT INTO inventory_adjustments (inventory_item_id, quantity_delta, reason, order_id, order_item_id, note, created_at)
         VALUES (?, ?, 'Order usage', ?, ?, ?, ?)`
      );
      for (const ingredient of bindingCost.ingredients) {
        adjustment.run(
          ingredient.inventoryItemId,
          -roundQuantity(ingredient.quantityBase * row.quantity),
          orderId,
          row.id,
          `${row.name} x ${row.quantity}`,
          orderTiming.effective_at
        );
        affectedInventoryItems.add(ingredient.inventoryItemId);
      }
    }
    const grossProfit = revenue - rawCost;
    db.prepare(
      `INSERT INTO order_cost_snapshots
       (order_id, revenue, raw_cost, other_cost, gross_profit, net_profit, missing_recipe_count)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    ).run(orderId, revenue, rawCost, grossProfit, grossProfit, missingRecipeCount);
    recalculatePhysicalCountDeltas(db, Array.from(affectedInventoryItems));
  });
  tx();
  recordActivity(db, "order_cost_snapshot_created", { entityType: "order", entityId: String(orderId), revenue, rawCost, missingRecipeCount }, actor);
}

export function reverseOrderCostSnapshot(db: Database.Database, orderId: number, actor = "system"): void {
  const existing = db.prepare("SELECT id FROM order_cost_snapshots WHERE order_id = ?").get(orderId) as { id: number } | undefined;
  if (!existing) return;
  const affectedInventoryItems = (db.prepare(
    "SELECT DISTINCT inventory_item_id FROM inventory_adjustments WHERE order_id = ? AND reason = 'Order usage'"
  ).all(orderId) as Array<{ inventory_item_id: number }>).map((row) => row.inventory_item_id);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM inventory_adjustments WHERE order_id = ? AND reason = 'Order usage'").run(orderId);
    db.prepare("DELETE FROM order_item_cost_snapshots WHERE order_id = ?").run(orderId);
    db.prepare("DELETE FROM order_cost_snapshots WHERE order_id = ?").run(orderId);
    recalculatePhysicalCountDeltas(db, affectedInventoryItems);
  });
  tx();
  recordActivity(db, "order_cost_snapshot_reversed", { entityType: "order", entityId: String(orderId) }, actor);
}

export function previewInventoryBackfill(
  db: Database.Database,
  input: { start?: string | null; end?: string | null } = {}
): InventoryBackfillPreview {
  const orders = listSettledOrdersForBackfill(db, input);
  let estimatedRevenue = 0;
  let estimatedRawCost = 0;
  let estimatedMissingRecipeCount = 0;
  let currentSnapshotRawCost = 0;
  let missingSnapshotCount = 0;
  let existingSnapshotCount = 0;

  for (const order of orders) {
    const existing = db.prepare("SELECT raw_cost FROM order_cost_snapshots WHERE order_id = ?").get(order.id) as { raw_cost: number } | undefined;
    if (existing) {
      existingSnapshotCount += 1;
      currentSnapshotRawCost += Number(existing.raw_cost ?? 0);
    } else {
      missingSnapshotCount += 1;
    }
    const rows = db.prepare(
      `SELECT menu_item_id, quantity, unit_price
       FROM order_items
       WHERE order_id = ? AND status = 'active'`
    ).all(order.id) as Array<{ menu_item_id: number; quantity: number; unit_price: number }>;
    for (const row of rows) {
      const recipeCost = getMenuItemBindingCost(db, row.menu_item_id);
      if (!recipeCost.hasBinding || recipeCost.ingredients.length === 0) estimatedMissingRecipeCount += 1;
      estimatedRevenue += row.quantity * row.unit_price;
      estimatedRawCost += recipeCost.rawCost * row.quantity;
    }
  }

  return {
    orderCount: orders.length,
    missingSnapshotCount,
    existingSnapshotCount,
    estimatedRevenue: roundMoney(estimatedRevenue),
    estimatedRawCost: roundMoney(estimatedRawCost),
    currentSnapshotRawCost: roundMoney(currentSnapshotRawCost),
    rawCostDelta: roundMoney(estimatedRawCost - currentSnapshotRawCost),
    estimatedMissingRecipeCount
  };
}

export function applyInventoryBackfill(
  db: Database.Database,
  input: { start?: string | null; end?: string | null; mode?: "missing" | "replace"; reason?: string | null } = {},
  actor = "admin"
): InventoryBackfillPreview {
  const orders = listSettledOrdersForBackfill(db, input);
  const mode = input.mode === "replace" ? "replace" : "missing";
  let applied = 0;
  const tx = db.transaction(() => {
    for (const order of orders) {
      const existing = db.prepare("SELECT id FROM order_cost_snapshots WHERE order_id = ?").get(order.id) as { id: number } | undefined;
      if (mode === "missing" && existing) continue;
      if (existing) reverseOrderCostSnapshot(db, order.id, actor);
      createOrderCostSnapshot(db, order.id, actor);
      applied += 1;
    }
  });
  tx();
  const preview = previewInventoryBackfill(db, input);
  recordActivity(db, mode === "replace" ? "inventory_usage_recalculated" : "inventory_usage_backfilled", { mode, applied, reason: cleanText(input.reason ?? ""), ...preview }, actor);
  return preview;
}

export function recalculateOrderUsage(db: Database.Database, orderId: number, actor = "admin"): void {
  const order = db.prepare("SELECT id, status, is_test FROM orders WHERE id = ?").get(orderId) as { id: number; status: string; is_test: number } | undefined;
  if (!order) throw new Error("Order not found.");
  if (order.is_test === 1) throw new Error("Test orders are excluded from inventory usage.");
  if (order.status !== "settled") throw new Error("Only completed orders can be recalculated.");
  reverseOrderCostSnapshot(db, orderId, actor);
  createOrderCostSnapshot(db, orderId, actor);
  recordActivity(db, "inventory_order_usage_recalculated", { entityType: "order", entityId: String(orderId) }, actor);
}

function listSettledOrdersForBackfill(db: Database.Database, input: { start?: string | null; end?: string | null }): Array<{ id: number }> {
  const clauses = ["status = 'settled'", "is_test = 0"];
  const params: string[] = [];
  if (input.start) {
    clauses.push("datetime(COALESCE(settled_at, updated_at, created_at)) >= datetime(?)");
    params.push(input.start);
  }
  if (input.end) {
    clauses.push("datetime(COALESCE(settled_at, updated_at, created_at)) <= datetime(?)");
    params.push(input.end);
  }
  return db.prepare(`SELECT id FROM orders WHERE ${clauses.join(" AND ")} ORDER BY datetime(COALESCE(settled_at, updated_at, created_at)) ASC, id ASC`).all(...params) as Array<{ id: number }>;
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
    latest_price: number;
  }>;
  return rows.map((row) => {
    const stats = getInventoryMovementStats(db, row.id);
    return toInventoryItem({ ...row, ...stats });
  });
}

export function listMenuRecipes(db: Database.Database): MenuRecipe[] {
  const menuRows = db.prepare("SELECT id, name, price, category, available, archived, track_recipe FROM menu_items WHERE (archived = 0 AND track_recipe = 1) OR id IN (SELECT menu_item_id FROM menu_item_recipes WHERE active = 1) ORDER BY archived, name").all() as Array<{ id: number; name: string; price: number; category: string | null; available: number; archived: number; track_recipe: number }>;
  return menuRows.map((menuItem) => {
    const standalone = menuItem.archived === 1
      && menuItem.available === 0
      && menuItem.category?.trim().toLowerCase() === "recipe material";
    const recipe = db.prepare("SELECT id, restock_enabled, use_in_recipe_enabled, current_version_id FROM menu_item_recipes WHERE menu_item_id = ? AND active = 1").get(menuItem.id) as { id: number; restock_enabled: number; use_in_recipe_enabled: number; current_version_id: number | null } | undefined;
    if (!recipe) {
      return {
        id: 0,
        menuItemId: menuItem.id,
        menuItemName: menuItem.name,
        sellingPrice: menuItem.price,
        status: "missing",
        standalone,
        restockEnabled: false,
        useInRecipeEnabled: false,
        currentVersionId: null,
        versionNumber: 0,
        versions: [],
        rawCost: 0,
        estimatedProfit: menuItem.price,
        profitMargin: 100,
        ingredients: [],
        childIngredients: []
      };
    }
    const cost = getMenuItemRawCost(db, menuItem.id);
    const childIngredients = listRecipeChildIngredients(db, recipe.id);
    const versions = db.prepare(
      `SELECT id, version_number, change_note, source, created_at, updated_at
       FROM recipe_versions WHERE recipe_id = ? ORDER BY version_number DESC`
    ).all(recipe.id).map((row) => {
      const version = row as { id: number; version_number: number; change_note: string | null; source: string; created_at: string; updated_at: string };
      return {
        id: version.id,
        versionNumber: version.version_number,
        changeNote: version.change_note,
        source: version.source,
        createdAt: version.created_at,
        updatedAt: version.updated_at,
        current: version.id === recipe.current_version_id
      };
    });
    const profit = menuItem.price - cost.rawCost;
    const hasIngredients = cost.ingredients.length > 0;
    return {
      id: recipe.id,
      menuItemId: menuItem.id,
      menuItemName: menuItem.name,
      sellingPrice: menuItem.price,
      status: hasIngredients ? "available" : "missing",
      standalone,
      restockEnabled: recipe.restock_enabled === 1,
      useInRecipeEnabled: recipe.use_in_recipe_enabled === 1,
      currentVersionId: recipe.current_version_id,
      versionNumber: versions.find((version) => version.current)?.versionNumber ?? 0,
      versions,
      rawCost: roundMoney(cost.rawCost),
      estimatedProfit: roundMoney(profit),
      profitMargin: menuItem.price > 0 ? Math.round((profit / menuItem.price) * 100) : 0,
      ingredients: cost.ingredients,
      childIngredients
    };
  });
}

export function listRestockEntries(db: Database.Database, limit = 100): RestockEntry[] {
  return db.prepare(
    `SELECT re.id, re.inventory_item_id, ii.name AS item_name, re.item_type, COALESCE(re.entry_type, 'purchase') AS entry_type, re.recipe_id, mi.name AS recipe_name,
            re.quantity_base, re.unit_label, re.total_cost, re.price_per_base,
            re.supplier_name, re.responsible_person, re.note, re.adjustment_reason, re.entry_date, COALESCE(re.updated_at, re.entry_date) AS updated_at
     FROM inventory_restock_entries re
     JOIN inventory_items ii ON ii.id = re.inventory_item_id
     LEFT JOIN menu_item_recipes mr ON mr.id = re.recipe_id
     LEFT JOIN menu_items mi ON mi.id = mr.menu_item_id
     ORDER BY datetime(re.entry_date) DESC, re.id DESC
     LIMIT ?`
  ).all(limit).map((row) => {
    const entry = row as {
      id: number;
      inventory_item_id: number;
      item_name: string;
      item_type: "raw" | "recipe";
      entry_type: "purchase" | "adjustment";
      recipe_id: number | null;
      recipe_name: string | null;
      quantity_base: number;
      unit_label: string;
      total_cost: number;
      price_per_base: number;
      supplier_name: string | null;
      responsible_person: string | null;
      note: string | null;
      adjustment_reason: string | null;
      entry_date: string;
      updated_at: string;
    };
    return {
      id: entry.id,
      inventoryItemId: entry.inventory_item_id,
      itemName: entry.item_name,
      itemType: entry.item_type || "raw",
      entryType: entry.entry_type || "purchase",
      recipeId: entry.recipe_id,
      recipeName: entry.recipe_name,
      quantityBase: entry.quantity_base,
      unitLabel: entry.unit_label,
      totalCost: roundMoney(entry.total_cost),
      pricePerBase: entry.price_per_base,
      supplierName: entry.supplier_name,
      responsiblePerson: entry.responsible_person,
      note: entry.note,
      adjustmentReason: entry.adjustment_reason,
      entryDate: entry.entry_date,
      updatedAt: entry.updated_at
    };
  });
}

export function listPhysicalCounts(db: Database.Database, limit = 200): PhysicalCountEntry[] {
  return db.prepare(
    `SELECT pc.id, pc.inventory_item_id, ii.name AS item_name, pc.quantity_base, pc.reduction_delta, pc.unit_label,
            pc.responsible_person, pc.note, pc.count_date, pc.source, COALESCE(pc.updated_at, pc.created_at) AS updated_at
     FROM inventory_physical_counts pc
     JOIN inventory_items ii ON ii.id = pc.inventory_item_id
     ORDER BY datetime(pc.count_date) DESC, pc.id DESC
     LIMIT ?`
  ).all(limit).map((row) => {
    const entry = row as {
      id: number;
      inventory_item_id: number;
      item_name: string;
      quantity_base: number;
      reduction_delta: number | null;
      unit_label: string;
      responsible_person: string | null;
      note: string | null;
      count_date: string;
      source: "manual" | "restock";
      updated_at: string;
    };
    return {
      id: entry.id,
      inventoryItemId: entry.inventory_item_id,
      itemName: entry.item_name,
      quantityBase: entry.quantity_base,
      reductionDelta: entry.reduction_delta === null ? null : roundQuantity(entry.reduction_delta),
      unitLabel: entry.unit_label,
      responsiblePerson: entry.responsible_person,
      note: entry.note,
      countDate: entry.count_date,
      updatedAt: entry.updated_at,
      source: entry.source
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
  return db.prepare("SELECT id, name, active, sort_order FROM cost_categories WHERE active = 1 ORDER BY sort_order ASC, name ASC, id ASC").all().map((row) => {
    const item = row as { id: number; name: string; active: number; sort_order: number };
    return { id: item.id, name: item.name, active: item.active === 1, sortOrder: item.sort_order };
  });
}

export function listCostRecords(db: Database.Database, limit = 120): CostRecord[] {
  return db.prepare(
    `SELECT cr.id, cr.cost_category_id, cc.name AS category_name, cr.cost_name, cr.amount, cr.payment_method,
            cr.responsible_person, cr.note, cr.cost_date, cr.created_at, cr.updated_at
     FROM cost_records cr
     LEFT JOIN cost_categories cc ON cc.id = cr.cost_category_id
     ORDER BY datetime(cr.cost_date) DESC, cr.id DESC
     LIMIT ?`
  ).all(limit).map((row) => {
    const entry = row as { id: number; cost_category_id: number | null; category_name: string | null; cost_name: string; amount: number; payment_method: string | null; responsible_person: string | null; note: string | null; cost_date: string; created_at: string; updated_at: string };
    return {
      id: entry.id,
      categoryId: entry.cost_category_id,
      categoryName: entry.category_name,
      costName: entry.cost_name,
      amount: roundMoney(entry.amount),
      paymentMethod: entry.payment_method,
      responsiblePerson: entry.responsible_person,
      note: entry.note,
      costDate: entry.cost_date,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at
    };
  });
}

export function listInventoryOrderUsage(db: Database.Database, limit = 120): InventoryOrderUsageSnapshot {
  const rows = db.prepare(
    `SELECT o.id AS order_id, o.order_number, o.order_date, o.source, o.table_number, o.settled_at, COALESCE(ocs.revenue, 0) AS order_total,
            oi.id AS order_item_id, oi.name AS menu_item_name, oics.quantity, oics.revenue, oics.raw_cost, oics.details_json
     FROM order_item_cost_snapshots oics
     JOIN orders o ON o.id = oics.order_id
     JOIN order_items oi ON oi.id = oics.order_item_id
     LEFT JOIN order_cost_snapshots ocs ON ocs.order_id = o.id
     WHERE o.status = 'settled' AND o.is_test = 0
     ORDER BY datetime(o.settled_at) DESC, o.id DESC, oi.id ASC
     LIMIT ?`
  ).all(limit) as Array<{
    order_id: number;
    order_number: string;
    order_date: string;
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
      orderDate: row.order_date,
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
  const where = start && end ? "WHERE o.is_test = 0 AND o.settled_at BETWEEN ? AND ?" : "WHERE o.status = 'settled' AND o.is_test = 0";
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

function getMenuItemRawCost(db: Database.Database, menuItemId: number, visited = new Set<number>()): { hasRecipe: boolean; rawCost: number; ingredients: MenuRecipe["ingredients"] } {
  const recipe = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ? AND active = 1").get(menuItemId) as { id: number } | undefined;
  if (!recipe) {
    return { hasRecipe: false, rawCost: 0, ingredients: [] };
  }
  return getRecipeRawCost(db, recipe.id, visited);
}

function prepareRecipeVersion(
  db: Database.Database,
  recipeId: number,
  snapshotMode: boolean,
  source: string,
  changeNote?: string | null
): number {
  const recipe = db.prepare("SELECT current_version_id FROM menu_item_recipes WHERE id = ?").get(recipeId) as { current_version_id: number | null } | undefined;
  if (!recipe) throw new Error("Recipe not found.");
  if (!snapshotMode && recipe.current_version_id) {
    db.prepare(
      `UPDATE recipe_versions SET change_note = COALESCE(?, change_note), source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(cleanText(changeNote ?? "") || null, source, recipe.current_version_id);
    return recipe.current_version_id;
  }
  const next = db.prepare("SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM recipe_versions WHERE recipe_id = ?").get(recipeId) as { version_number: number };
  const versionId = Number(
    db.prepare(
      `INSERT INTO recipe_versions (recipe_id, version_number, change_note, source)
       VALUES (?, ?, ?, ?)`
    ).run(recipeId, next.version_number, cleanText(changeNote ?? "") || null, source).lastInsertRowid
  );
  db.prepare("UPDATE menu_item_recipes SET current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(versionId, recipeId);
  return versionId;
}

function recipeDependsOn(db: Database.Database, recipeId: number, targetRecipeId: number, visited = new Set<number>()): boolean {
  if (recipeId === targetRecipeId) return true;
  if (visited.has(recipeId)) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(recipeId);
  const children = db.prepare("SELECT child_recipe_id FROM recipe_child_ingredients WHERE recipe_id = ?").all(recipeId) as Array<{ child_recipe_id: number }>;
  return children.some((child) => recipeDependsOn(db, child.child_recipe_id, targetRecipeId, nextVisited));
}

function listSettledOrdersForMenuItems(
  db: Database.Database,
  menuItemIds: number[],
  input: { start?: string | null; end?: string | null }
): Array<{ id: number }> {
  if (menuItemIds.length === 0) return [];
  const clauses = ["o.status = 'settled'", "o.is_test = 0", `oi.menu_item_id IN (${menuItemIds.map(() => "?").join(",")})`, "oi.status = 'active'"];
  const params: Array<number | string> = [...menuItemIds];
  if (input.start) {
    clauses.push("date(COALESCE(o.order_date, o.created_at)) >= date(?)");
    params.push(input.start);
  }
  if (input.end) {
    clauses.push("date(COALESCE(o.order_date, o.created_at)) <= date(?)");
    params.push(input.end);
  }
  return db.prepare(
    `SELECT DISTINCT o.id
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE ${clauses.join(" AND ")}
     ORDER BY date(COALESCE(o.order_date, o.created_at)), o.id`
  ).all(...params) as Array<{ id: number }>;
}

function recalculateHistoricalOrdersForMenuItems(
  db: Database.Database,
  menuItemIds: number[],
  options: { historicalScope?: HistoricalScope; start?: string | null; end?: string | null; reason?: string | null },
  actor = "admin",
  recipeVersionFilterByMenu?: Map<number, number>
): number {
  const scope = options.historicalScope ?? "future";
  if (scope === "future" || menuItemIds.length === 0) return 0;
  const range: { start?: string | null; end?: string | null } = scope === "all" ? {} : { start: options.start ?? null, end: options.end ?? null };
  if (scope === "range" && !range.start && !range.end) throw new Error("Choose at least one date for a custom historical range.");
  const orders = listSettledOrdersForMenuItems(db, Array.from(new Set(menuItemIds)), range);
  let changedOrders = 0;
  const tx = db.transaction(() => {
    for (const order of orders) {
      if (recalculateOrderItemsForMenuItems(db, order.id, menuItemIds, recipeVersionFilterByMenu)) changedOrders += 1;
    }
  });
  tx();
  if (changedOrders > 0) {
    recordActivity(db, "inventory_historical_usage_recalculated", {
      entityType: "orders",
      entityId: orders.map((order) => order.id).join(","),
      orderCount: changedOrders,
      menuItemIds,
      historicalScope: scope,
      start: range.start ?? null,
      end: range.end ?? null,
      reason: cleanText(options.reason ?? "") || "Manager historical correction"
    }, actor);
  }
  return changedOrders;
}

function recalculateOrderItemsForMenuItems(
  db: Database.Database,
  orderId: number,
  menuItemIds: number[],
  recipeVersionFilterByMenu?: Map<number, number>
): boolean {
  const orderFlags = db.prepare("SELECT is_test FROM orders WHERE id = ?").get(orderId) as { is_test: number } | undefined;
  if (!orderFlags) throw new Error("Order not found.");
  if (orderFlags.is_test === 1) return false;
  const orderTiming = db.prepare(
    "SELECT COALESCE(settled_at, updated_at, created_at) AS effective_at FROM orders WHERE id = ?"
  ).get(orderId) as { effective_at: string } | undefined;
  if (!orderTiming) throw new Error("Order not found.");
  const existingOrderSnapshot = db.prepare("SELECT id FROM order_cost_snapshots WHERE order_id = ?").get(orderId) as { id: number } | undefined;
  if (!existingOrderSnapshot) {
    if (recipeVersionFilterByMenu) return false;
    createOrderCostSnapshot(db, orderId, "system");
    return true;
  }
  const rows = db.prepare(
    `SELECT oi.id, oi.menu_item_id, oi.quantity, oi.unit_price, oi.name, oics.recipe_version_id
     FROM order_items oi
     LEFT JOIN order_item_cost_snapshots oics ON oics.order_item_id = oi.id
     WHERE oi.order_id = ? AND oi.status = 'active'
       AND oi.menu_item_id IN (${menuItemIds.map(() => "?").join(",")})`
  ).all(orderId, ...menuItemIds) as Array<{
    id: number;
    menu_item_id: number;
    quantity: number;
    unit_price: number;
    name: string;
    recipe_version_id: number | null;
  }>;
  const eligible = rows.filter((row) => {
    const requiredVersion = recipeVersionFilterByMenu?.get(row.menu_item_id);
    return requiredVersion === undefined || row.recipe_version_id === requiredVersion;
  });
  if (eligible.length === 0) return false;
  const insertSnapshot = db.prepare(
    `INSERT INTO order_item_cost_snapshots
     (order_id, order_item_id, menu_item_id, quantity, revenue, raw_cost, profit, details_json,
      recipe_version_id, binding_type, binding_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAdjustment = db.prepare(
    `INSERT INTO inventory_adjustments (inventory_item_id, quantity_delta, reason, order_id, order_item_id, note, created_at)
     VALUES (?, ?, 'Order usage', ?, ?, ?, ?)`
  );
  const affectedInventoryItems = new Set<number>();
  for (const row of eligible) {
    for (const old of db.prepare(
      "SELECT DISTINCT inventory_item_id FROM inventory_adjustments WHERE order_id = ? AND order_item_id = ? AND reason = 'Order usage'"
    ).all(orderId, row.id) as Array<{ inventory_item_id: number }>) {
      affectedInventoryItems.add(old.inventory_item_id);
    }
    db.prepare("DELETE FROM inventory_adjustments WHERE order_id = ? AND order_item_id = ? AND reason = 'Order usage'").run(orderId, row.id);
    db.prepare("DELETE FROM order_item_cost_snapshots WHERE order_item_id = ?").run(row.id);
    const bindingCost = getMenuItemBindingCost(db, row.menu_item_id);
    const revenue = row.quantity * row.unit_price;
    const rawCost = bindingCost.rawCost * row.quantity;
    insertSnapshot.run(
      orderId,
      row.id,
      row.menu_item_id,
      row.quantity,
      revenue,
      rawCost,
      revenue - rawCost,
      JSON.stringify(bindingCost.ingredients),
      bindingCost.recipeVersionId,
      bindingCost.bindingType,
      bindingCost.bindingId
    );
    for (const ingredient of bindingCost.ingredients) {
      insertAdjustment.run(
        ingredient.inventoryItemId,
        -roundQuantity(ingredient.quantityBase * row.quantity),
        orderId,
        row.id,
        `${row.name} x ${row.quantity}`,
        orderTiming.effective_at
      );
      affectedInventoryItems.add(ingredient.inventoryItemId);
    }
  }
  const totals = db.prepare(
    `SELECT COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(raw_cost), 0) AS raw_cost,
            COALESCE(SUM(profit), 0) AS gross_profit,
            COALESCE(SUM(CASE WHEN details_json IS NULL OR details_json = '[]' THEN 1 ELSE 0 END), 0) AS missing_recipe_count
     FROM order_item_cost_snapshots WHERE order_id = ?`
  ).get(orderId) as { revenue: number; raw_cost: number; gross_profit: number; missing_recipe_count: number };
  db.prepare(
    `UPDATE order_cost_snapshots
     SET revenue = ?, raw_cost = ?, gross_profit = ?, net_profit = ? - other_cost,
         missing_recipe_count = ?, created_at = CURRENT_TIMESTAMP
     WHERE order_id = ?`
  ).run(totals.revenue, totals.raw_cost, totals.gross_profit, totals.gross_profit, totals.missing_recipe_count, orderId);
  recalculatePhysicalCountDeltas(db, Array.from(affectedInventoryItems));
  return true;
}

function getRecipeRawCost(db: Database.Database, recipeId: number, visited = new Set<number>()): { hasRecipe: boolean; rawCost: number; ingredients: MenuRecipe["ingredients"] } {
  const recipe = db.prepare("SELECT current_version_id FROM menu_item_recipes WHERE id = ? AND active = 1").get(recipeId) as { current_version_id: number | null } | undefined;
  if (!recipe?.current_version_id) return { hasRecipe: false, rawCost: 0, ingredients: [] };
  return getRecipeVersionRawCost(db, recipe.current_version_id, visited);
}

function getRecipeVersionRawCost(db: Database.Database, versionId: number, visited = new Set<number>()): { hasRecipe: boolean; rawCost: number; ingredients: MenuRecipe["ingredients"] } {
  if (visited.has(versionId)) {
    return { hasRecipe: true, rawCost: 0, ingredients: [] };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(versionId);
  const rows = db.prepare(
    `SELECT ri.id, ri.inventory_item_id, ii.name AS item_name, ri.quantity_base, ri.unit_label,
            COALESCE((SELECT price_per_base FROM inventory_price_history WHERE inventory_item_id = ii.id AND active = 1 ORDER BY datetime(effective_at) DESC, id DESC LIMIT 1), 0) AS latest_price
     FROM recipe_version_ingredients ri
     JOIN inventory_items ii ON ii.id = ri.inventory_item_id
     WHERE ri.version_id = ? AND ri.quantity_base > 0
     ORDER BY ii.name`
  ).all(versionId) as Array<{ id: number; inventory_item_id: number; item_name: string; quantity_base: number; unit_label: string; latest_price: number }>;
  const ingredients = rows.map((row) => ({
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.item_name,
    quantityBase: row.quantity_base,
    unitLabel: row.unit_label,
    latestPrice: row.latest_price,
    rawCost: roundMoney(row.quantity_base * row.latest_price)
  }));
  const childRows = db.prepare(
    `SELECT rci.id, rci.child_recipe_id, COALESCE(rci.child_version_id, child.current_version_id) AS child_version_id,
            rci.quantity_base, rci.unit_label
     FROM recipe_version_child_ingredients rci
     JOIN menu_item_recipes child ON child.id = rci.child_recipe_id
     WHERE rci.version_id = ? AND rci.quantity_base > 0
     ORDER BY rci.id`
  ).all(versionId) as Array<{ id: number; child_recipe_id: number; child_version_id: number | null; quantity_base: number; unit_label: string }>;
  for (const child of childRows) {
    if (!child.child_version_id) continue;
    const childCost = getRecipeVersionRawCost(db, child.child_version_id, nextVisited);
    for (const ingredient of childCost.ingredients) {
      const existing = ingredients.find((item) => item.inventoryItemId === ingredient.inventoryItemId && item.unitLabel === ingredient.unitLabel);
      const quantityBase = roundQuantity(ingredient.quantityBase * child.quantity_base);
      const rawCost = roundMoney(ingredient.rawCost * child.quantity_base);
      if (existing) {
        existing.quantityBase = roundQuantity(existing.quantityBase + quantityBase);
        existing.rawCost = roundMoney(existing.rawCost + rawCost);
      } else {
        ingredients.push({
          id: ingredient.id,
          inventoryItemId: ingredient.inventoryItemId,
          itemName: ingredient.itemName,
          quantityBase,
          unitLabel: ingredient.unitLabel,
          latestPrice: ingredient.latestPrice,
          rawCost
        });
      }
    }
  }
  return { hasRecipe: true, rawCost: roundMoney(ingredients.reduce((sum, item) => sum + item.rawCost, 0)), ingredients };
}

function getMenuItemBindingCost(db: Database.Database, menuItemId: number): {
  hasBinding: boolean;
  rawCost: number;
  ingredients: MenuRecipe["ingredients"];
  recipeVersionId: number | null;
  bindingType: "recipe" | "item" | null;
  bindingId: number | null;
} {
  const binding = db.prepare(
    `SELECT id, binding_type, recipe_id, inventory_item_id, quantity_base, unit_label
     FROM menu_item_inventory_bindings WHERE menu_item_id = ?`
  ).get(menuItemId) as {
    id: number;
    binding_type: "recipe" | "item";
    recipe_id: number | null;
    inventory_item_id: number | null;
    quantity_base: number;
    unit_label: string;
  } | undefined;
  if (!binding) {
    return { hasBinding: false, rawCost: 0, ingredients: [], recipeVersionId: null, bindingType: null, bindingId: null };
  }
  if (binding.binding_type === "recipe" && binding.recipe_id) {
    const recipe = db.prepare("SELECT current_version_id FROM menu_item_recipes WHERE id = ? AND active = 1").get(binding.recipe_id) as { current_version_id: number | null } | undefined;
    if (!recipe?.current_version_id) return { hasBinding: false, rawCost: 0, ingredients: [], recipeVersionId: null, bindingType: "recipe", bindingId: binding.id };
    const cost = getRecipeVersionRawCost(db, recipe.current_version_id);
    const multiplier = binding.quantity_base || 1;
    const ingredients = cost.ingredients.map((ingredient) => ({
      ...ingredient,
      quantityBase: roundQuantity(ingredient.quantityBase * multiplier),
      rawCost: roundMoney(ingredient.rawCost * multiplier)
    }));
    return { hasBinding: true, rawCost: roundMoney(cost.rawCost * multiplier), ingredients, recipeVersionId: recipe.current_version_id, bindingType: "recipe", bindingId: binding.id };
  }
  if (binding.binding_type === "item" && binding.inventory_item_id) {
    const item = db.prepare(
      `SELECT ii.id, ii.name, iu.short_name,
              COALESCE((SELECT price_per_base FROM inventory_price_history WHERE inventory_item_id = ii.id AND active = 1 ORDER BY datetime(effective_at) DESC, id DESC LIMIT 1), 0) AS latest_price
       FROM inventory_items ii JOIN inventory_units iu ON iu.id = ii.base_unit_id WHERE ii.id = ?`
    ).get(binding.inventory_item_id) as { id: number; name: string; short_name: string; latest_price: number } | undefined;
    if (!item) return { hasBinding: false, rawCost: 0, ingredients: [], recipeVersionId: null, bindingType: "item", bindingId: binding.id };
    const rawCost = roundMoney(item.latest_price * binding.quantity_base);
    return {
      hasBinding: true,
      rawCost,
      ingredients: [{ id: item.id, inventoryItemId: item.id, itemName: item.name, quantityBase: binding.quantity_base, unitLabel: item.short_name, latestPrice: item.latest_price, rawCost }],
      recipeVersionId: null,
      bindingType: "item",
      bindingId: binding.id
    };
  }
  return { hasBinding: false, rawCost: 0, ingredients: [], recipeVersionId: null, bindingType: binding.binding_type, bindingId: binding.id };
}

function listRecipeChildIngredients(db: Database.Database, recipeId: number): MenuRecipe["childIngredients"] {
  return db.prepare(
    `SELECT rci.id, rci.child_recipe_id, mi.name AS menu_item_name, rci.quantity_base, rci.unit_label
     FROM recipe_child_ingredients rci
     JOIN menu_item_recipes mr ON mr.id = rci.child_recipe_id
     JOIN menu_items mi ON mi.id = mr.menu_item_id
     WHERE rci.recipe_id = ?
     ORDER BY mi.name`
  ).all(recipeId).map((row) => {
    const item = row as { id: number; child_recipe_id: number; menu_item_name: string; quantity_base: number; unit_label: string };
    const childCost = getRecipeRawCost(db, item.child_recipe_id);
    return {
      id: item.id,
      childRecipeId: item.child_recipe_id,
      menuItemName: item.menu_item_name,
      quantityBase: item.quantity_base,
      unitLabel: item.unit_label,
      rawCost: roundMoney(childCost.rawCost * item.quantity_base)
    };
  });
}

function ensureRecipeHolders(db: Database.Database, recipeName: string): Array<{ id: number; created: boolean }> {
  const existing = db.prepare("SELECT id, archived FROM menu_items WHERE name = ?").get(recipeName) as { id: number; archived: number } | undefined;
  if (existing) {
    db.prepare("UPDATE menu_items SET track_recipe = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
    return [{ id: existing.id, created: false }];
  }
  const id = Number(
    db.prepare("INSERT INTO menu_items (name, price, category, track_recipe, available, archived) VALUES (?, ?, 'Recipe Material', 1, 0, 1)").run(recipeName, MENU_PRICE_FALLBACK).lastInsertRowid
  );
  return [{ id, created: true }];
}

function findInventoryItemForRecipe(db: Database.Database, name: string): { id: number; unitShortName: string } | null {
  const existing = db.prepare("SELECT id FROM inventory_items WHERE lower(name) = lower(?)").get(name) as { id: number } | undefined;
  if (!existing) return null;
  const item = db.prepare(
    `SELECT ii.id, iu.short_name AS unit_short_name
     FROM inventory_items ii
     JOIN inventory_units iu ON iu.id = ii.base_unit_id
     WHERE ii.id = ?`
  ).get(existing.id) as { id: number; unit_short_name: string } | undefined;
  return item ? { id: item.id, unitShortName: item.unit_short_name } : null;
}

function ensureInventoryItem(db: Database.Database, name: string, unitShortName: string): { id: number; created: boolean } {
  const matched = findInventoryItemForRecipe(db, name);
  if (matched) return { id: matched.id, created: false };
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

function ensureInventoryUnit(db: Database.Database, shortName: string): number {
  const normalized = normalizeUnit(shortName);
  const existing = db.prepare("SELECT id FROM inventory_units WHERE short_name = ?").get(normalized) as { id: number } | undefined;
  if (existing) return existing.id;
  const name = normalized === "g" ? "Gram" : normalized === "kg" ? "Kilogram" : normalized === "ml" ? "Milliliter" : normalized === "l" ? "Liter" : normalized === "pc" ? "Piece" : normalized.toUpperCase();
  return Number(db.prepare("INSERT INTO inventory_units (name, short_name, active) VALUES (?, ?, 1)").run(name, normalized).lastInsertRowid);
}

function ensureInventoryCategory(db: Database.Database, name: string): number {
  return getCategoryByName(db, name).id;
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

type InventoryTimelineEvent = {
  event_kind: "restock" | "adjustment" | "count";
  event_time: string;
  event_priority: number;
  event_id: number;
  quantity_delta: number;
  counted_quantity: number | null;
  reduction_delta: number | null;
};

function listInventoryTimeline(db: Database.Database, inventoryItemId: number): InventoryTimelineEvent[] {
  return db.prepare(
    `SELECT * FROM (
       SELECT 'restock' AS event_kind, entry_date AS event_time, 10 AS event_priority, id AS event_id,
              quantity_base AS quantity_delta, NULL AS counted_quantity, NULL AS reduction_delta
       FROM inventory_restock_entries
       WHERE inventory_item_id = ? AND COALESCE(entry_type, 'purchase') = 'purchase'
       UNION ALL
       SELECT 'adjustment', created_at, 20, id, quantity_delta, NULL, NULL
       FROM inventory_adjustments
       WHERE inventory_item_id = ?
       UNION ALL
       SELECT 'count', count_date, 30, id, 0, quantity_base, reduction_delta
       FROM inventory_physical_counts
       WHERE inventory_item_id = ?
     )
     ORDER BY datetime(event_time) ASC, event_priority ASC, event_id ASC`
  ).all(inventoryItemId, inventoryItemId, inventoryItemId) as InventoryTimelineEvent[];
}

function replayInventoryTimeline(
  db: Database.Database,
  inventoryItemId: number,
  recalculateCounts: boolean
): { currentStock: number; physicalReduction: number } {
  let stock = 0;
  let physicalReduction = 0;
  const updateDelta = recalculateCounts
    ? db.prepare("UPDATE inventory_physical_counts SET reduction_delta = ? WHERE id = ?")
    : null;
  for (const event of listInventoryTimeline(db, inventoryItemId)) {
    if (event.event_kind !== "count") {
      stock = roundQuantity(stock + Number(event.quantity_delta ?? 0));
      continue;
    }
    const counted = roundQuantity(Number(event.counted_quantity ?? 0));
    if (event.reduction_delta === null) {
      // Existing installations may contain pre-v3 absolute counts. They remain a baseline
      // until a manager edits them, which converts them to a validated reduction event.
      physicalReduction += Math.max(0, stock - counted);
      stock = counted;
      continue;
    }
    let delta = roundQuantity(Number(event.reduction_delta ?? 0));
    if (recalculateCounts) {
      if (counted > stock + 0.0005) {
        throw new Error(
          `Physical count cannot increase stock. Calculated stock immediately before this count is ${roundQuantity(stock)}; enter that amount or less, or use Restock for increases.`
        );
      }
      delta = roundQuantity(counted - stock);
      if (Math.abs(delta) < 0.0005) delta = 0;
      updateDelta!.run(delta, event.event_id);
    }
    if (delta > 0) {
      throw new Error("Physical count cannot increase stock. Use Restock for increases.");
    }
    physicalReduction += Math.abs(Math.min(0, delta));
    stock = roundQuantity(stock + delta);
  }
  return { currentStock: roundQuantity(stock), physicalReduction: roundQuantity(physicalReduction) };
}

function recalculatePhysicalCountDeltas(db: Database.Database, inventoryItemIds: number[]): void {
  for (const inventoryItemId of Array.from(new Set(inventoryItemIds.filter((id) => Number.isInteger(id) && id > 0)))) {
    replayInventoryTimeline(db, inventoryItemId, true);
  }
}

function getInventoryMovementStats(db: Database.Database, inventoryItemId: number): {
  current_stock: number;
  stock_used: number;
  expected_left: number;
  last_count_at: string | null;
  last_restock_at: string | null;
  latest_restock_quantity: number;
  estimated_wastage: number;
  count_required: number;
} {
  const latestManualCount = db.prepare(
    `SELECT quantity_base, count_date
     FROM inventory_physical_counts
     WHERE inventory_item_id = ? AND source = 'manual'
     ORDER BY datetime(count_date) DESC, id DESC
     LIMIT 1`
  ).get(inventoryItemId) as { quantity_base: number; count_date: string } | undefined;
  const stockUsed = db.prepare(
    `SELECT COALESCE(SUM(ABS(quantity_delta)), 0) AS quantity
     FROM inventory_adjustments
     WHERE inventory_item_id = ? AND reason = 'Order usage'`
  ).get(inventoryItemId) as { quantity: number };
  const latestRestock = db.prepare(
    `SELECT quantity_base, entry_date
     FROM inventory_restock_entries
     WHERE inventory_item_id = ? AND COALESCE(entry_type, 'purchase') = 'purchase'
     ORDER BY datetime(entry_date) DESC, id DESC
     LIMIT 1`
  ).get(inventoryItemId) as { quantity_base: number; entry_date: string } | undefined;
  const timeline = replayInventoryTimeline(db, inventoryItemId, false);
  const currentStock = timeline.currentStock;
  const hasRecentManualCount = latestManualCount ? Date.now() - new Date(latestManualCount.count_date).getTime() <= 6 * 60 * 60 * 1000 : false;
  return {
    current_stock: roundQuantity(currentStock),
    stock_used: roundQuantity(Number(stockUsed.quantity ?? 0)),
    expected_left: roundQuantity(currentStock),
    last_count_at: latestManualCount?.count_date ?? null,
    last_restock_at: latestRestock?.entry_date ?? null,
    latest_restock_quantity: roundQuantity(Number(latestRestock?.quantity_base ?? 0)),
    estimated_wastage: timeline.physicalReduction,
    count_required: hasRecentManualCount ? 0 : 1
  };
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
  stock_used?: number;
  expected_left?: number;
  last_count_at?: string | null;
  last_restock_at?: string | null;
  latest_restock_quantity?: number;
  estimated_wastage?: number;
  count_required?: number;
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
    stockUsed: roundQuantity(Number(row.stock_used ?? 0)),
    expectedLeft: roundQuantity(Number(row.expected_left ?? stock)),
    lastCountAt: row.last_count_at ?? null,
    lastRestockAt: row.last_restock_at ?? null,
    latestRestockQuantity: roundQuantity(Number(row.latest_restock_quantity ?? 0)),
    estimatedWastage: roundQuantity(Number(row.estimated_wastage ?? 0)),
    countRequired: row.count_required === 1,
    active: row.active === 1
  };
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function validateHistoricalChangeOptions(options: HistoricalChangeOptions): void {
  const scope = options.historicalScope ?? "future";
  if (!(["future", "all", "range"] as const).includes(scope)) {
    throw new Error("Historical scope must be future, all, or range.");
  }
  if (scope === "range") {
    validateDateRange(options, true);
  }
}

function validateDateRange(
  input: { start?: string | null; end?: string | null },
  requireBoundary: boolean
): void {
  const start = input.start?.trim() || null;
  const end = input.end?.trim() || null;
  if (requireBoundary && !start && !end) {
    throw new Error("Choose at least one date for a custom historical range.");
  }
  if (start) validateBusinessDate(start, "Start date");
  if (end) validateBusinessDate(end, "End date");
  if (start && end && start > end) {
    throw new Error("Start date cannot be after end date.");
  }
}

function validateBusinessDate(value: string, label: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`${label} is invalid.`);
  }
}

function normalizeOptionalBusinessDate(value: string | null | undefined, label: string): string | null {
  const date = value?.trim() || null;
  if (!date) return null;
  validateBusinessDate(date, label);
  return date;
}

function normalizeOptionalInventoryTimestamp(value: string | null | undefined, label: string): string | null {
  const timestamp = value?.trim() || null;
  if (!timestamp) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) {
    validateBusinessDate(timestamp, label);
    return `${timestamp} 00:00:00`;
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/.exec(timestamp);
  if (!match) throw new Error(`${label} must use YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss.`);
  validateBusinessDate(match[1], label);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`${label} is invalid.`);
  return `${match[1]} ${match[2]}:${match[3]}:${String(second).padStart(2, "0")}${match[5] ?? ""}`;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
