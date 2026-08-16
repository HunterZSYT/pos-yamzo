import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../src/main/database/connection";
import { migrate } from "../src/main/database/schema";
import { addOrderItem, createOrder, sendNewItemsToKitchen, settleOrder } from "../src/main/domain/orders";
import { markPrintJobPrinted } from "../src/main/services/printQueue";
import {
  addCostRecord,
  addPhysicalCount,
  addRestockEntry,
  deleteCostRecord,
  deletePhysicalCount,
  listInventorySnapshot,
  listMenuInventoryBindings,
  previewMenuBindingImpact,
  removeMenuInventoryBinding,
  saveMenuInventoryBinding,
  saveMenuRecipe,
  updateCostRecord,
  updatePhysicalCount
} from "../src/main/domain/inventory";
import { listActivityLogs } from "../src/main/services/audit";
import { saveMenuItem } from "../src/main/services/menuImport";

let db: Database.Database | null = null;

function freshDb(): Database.Database {
  db = openMemoryDatabase();
  return db;
}

function createInventoryItem(database: Database.Database, name: string, unit = "g"): number {
  const unitRow = database.prepare("SELECT id FROM inventory_units WHERE short_name = ?").get(unit) as { id: number };
  const category = database.prepare("SELECT id FROM inventory_categories ORDER BY id LIMIT 1").get() as { id: number };
  return Number(
    database
      .prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES (?, ?, ?, 0)")
      .run(name, category.id, unitRow.id).lastInsertRowid
  );
}

function completeOrder(database: Database.Database, menuItemId: number, orderDate: string, quantity = 1): number {
  const order = createOrder(database, { source: "parcel", orderDate });
  addOrderItem(database, order.id, { menuItemId, quantity });
  markPrintJobPrinted(database, sendNewItemsToKitchen(database, order.id)!);
  settleOrder(database, order.id, "cash");
  return order.id;
}

function itemCost(database: Database.Database, orderId: number): {
  raw_cost: number;
  recipe_version_id: number | null;
  binding_type: string | null;
} {
  return database
    .prepare("SELECT raw_cost, recipe_version_id, binding_type FROM order_item_cost_snapshots WHERE order_id = ?")
    .get(orderId) as { raw_cost: number; recipe_version_id: number | null; binding_type: string | null };
}

function usedQuantity(database: Database.Database, orderId: number, inventoryItemId: number): number {
  const row = database
    .prepare(
      "SELECT COALESCE(-SUM(quantity_delta), 0) AS quantity FROM inventory_adjustments WHERE order_id = ? AND inventory_item_id = ? AND reason = 'Order usage'"
    )
    .get(orderId, inventoryItemId) as { quantity: number };
  return row.quantity;
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("inventory release workflows", () => {
  it("keeps recipe versions stable for corrections and creates snapshots for future changes", () => {
    const database = freshDb();
    const chickenId = createInventoryItem(database, "QA Chicken");
    addRestockEntry(database, { inventoryItemId: chickenId, quantity: 5000, totalCost: 5000 });
    const bowl = saveMenuItem(database, {
      name: "QA Chicken Bowl",
      price: 300,
      category: "Rice",
      available: true,
      trackRecipe: true
    });

    let recipe = saveMenuRecipe(database, {
      menuItemId: bowl.id,
      ingredients: [{ inventoryItemId: chickenId, quantityBase: 100, unitLabel: "g" }]
    });
    expect(recipe.versionNumber).toBe(1);
    const versionOne = recipe.currentVersionId;

    const first = completeOrder(database, bowl.id, "2026-07-01");
    const second = completeOrder(database, bowl.id, "2026-07-02");
    expect([itemCost(database, first).raw_cost, itemCost(database, second).raw_cost]).toEqual([100, 100]);

    recipe = saveMenuRecipe(
      database,
      { menuItemId: bowl.id, ingredients: [{ inventoryItemId: chickenId, quantityBase: 120, unitLabel: "g" }] },
      { snapshotMode: false, historicalScope: "range", start: "2026-07-02", end: "2026-07-02", reason: "Correct one business day" }
    );
    expect(recipe.currentVersionId).toBe(versionOne);
    expect(recipe.versions).toHaveLength(1);
    expect([itemCost(database, first).raw_cost, itemCost(database, second).raw_cost]).toEqual([100, 120]);
    expect([usedQuantity(database, first, chickenId), usedQuantity(database, second, chickenId)]).toEqual([100, 120]);

    recipe = saveMenuRecipe(
      database,
      { menuItemId: bowl.id, ingredients: [{ inventoryItemId: chickenId, quantityBase: 150, unitLabel: "g" }] },
      { snapshotMode: true, historicalScope: "future", reason: "New serving size" }
    );
    expect(recipe.versionNumber).toBe(2);
    expect(recipe.currentVersionId).not.toBe(versionOne);
    expect([itemCost(database, first).raw_cost, itemCost(database, second).raw_cost]).toEqual([100, 120]);

    const third = completeOrder(database, bowl.id, "2026-07-03");
    expect(itemCost(database, third)).toMatchObject({ raw_cost: 150, recipe_version_id: recipe.currentVersionId, binding_type: "recipe" });

    recipe = saveMenuRecipe(
      database,
      { menuItemId: bowl.id, ingredients: [{ inventoryItemId: chickenId, quantityBase: 200, unitLabel: "g" }] },
      { snapshotMode: true, historicalScope: "all", reason: "Approved full correction" }
    );
    expect(recipe.versionNumber).toBe(3);
    expect([first, second, third].map((orderId) => itemCost(database, orderId).raw_cost)).toEqual([200, 200, 200]);
    expect([first, second, third].map((orderId) => usedQuantity(database, orderId, chickenId))).toEqual([200, 200, 200]);
  });

  it("backfills direct-item bindings by range or all and truly unlinks them", () => {
    const database = freshDb();
    const bottleId = createInventoryItem(database, "QA 7 Up Bottle", "pc");
    addRestockEntry(database, { inventoryItemId: bottleId, quantity: 20, totalCost: 600 });
    const drink = saveMenuItem(database, {
      name: "QA 7 Up",
      price: 60,
      category: "Drinks",
      available: true,
      trackRecipe: false
    });
    const first = completeOrder(database, drink.id, "2026-07-01", 2);
    const second = completeOrder(database, drink.id, "2026-07-02", 1);
    expect([usedQuantity(database, first, bottleId), usedQuantity(database, second, bottleId)]).toEqual([0, 0]);

    expect(() =>
      saveMenuInventoryBinding(database, {
        menuItemId: drink.id,
        bindingType: "item",
        inventoryItemId: bottleId,
        historicalScope: "range"
      })
    ).toThrow("at least one date");
    expect(listMenuInventoryBindings(database)).toHaveLength(0);

    saveMenuInventoryBinding(database, {
      menuItemId: drink.id,
      bindingType: "item",
      inventoryItemId: bottleId,
      quantityBase: 1,
      historicalScope: "range",
      start: "2026-07-01",
      end: "2026-07-01"
    });
    expect(previewMenuBindingImpact(database, { menuItemId: drink.id }).orderCount).toBe(2);
    expect([usedQuantity(database, first, bottleId), usedQuantity(database, second, bottleId)]).toEqual([2, 0]);

    saveMenuInventoryBinding(database, {
      menuItemId: drink.id,
      bindingType: "item",
      inventoryItemId: bottleId,
      quantityBase: 2,
      historicalScope: "all"
    });
    expect([usedQuantity(database, first, bottleId), usedQuantity(database, second, bottleId)]).toEqual([4, 2]);
    expect(itemCost(database, first)).toMatchObject({ raw_cost: 120, recipe_version_id: null, binding_type: "item" });

    removeMenuInventoryBinding(database, drink.id, { historicalScope: "all", reason: "Wrong item link" });
    expect(listMenuInventoryBindings(database)).toHaveLength(0);
    expect([usedQuantity(database, first, bottleId), usedQuantity(database, second, bottleId)]).toEqual([0, 0]);
    expect([itemCost(database, first).raw_cost, itemCost(database, second).raw_cost]).toEqual([0, 0]);
    const future = completeOrder(database, drink.id, "2026-07-03");
    expect(usedQuantity(database, future, bottleId)).toBe(0);
  });

  it("clears stale recipe bindings and supports date-preserving count and cost CRUD without passwords", () => {
    const database = freshDb();
    const flourId = createInventoryItem(database, "QA Flour");
    addRestockEntry(database, { inventoryItemId: flourId, quantity: 1000, totalCost: 1000, entryDate: "2026-07-04T08:00:00" });
    const bread = saveMenuItem(database, {
      name: "QA Bread",
      price: 100,
      category: "Bakery",
      available: true,
      trackRecipe: true
    });
    saveMenuRecipe(database, {
      menuItemId: bread.id,
      ingredients: [{ inventoryItemId: flourId, quantityBase: 50, unitLabel: "g" }]
    });
    expect(listMenuInventoryBindings(database).some((binding) => binding.menuItemId === bread.id)).toBe(true);
    saveMenuRecipe(database, { menuItemId: bread.id, ingredients: [] });
    expect(listMenuInventoryBindings(database).some((binding) => binding.menuItemId === bread.id)).toBe(false);
    const order = completeOrder(database, bread.id, "2026-07-04");
    expect(usedQuantity(database, order, flourId)).toBe(0);

    const count = addPhysicalCount(database, {
      inventoryItemId: flourId,
      quantity: 800,
      responsiblePerson: "Cashier",
      countDate: "2026-07-05T09:30:00"
    });
    const updatedCount = updatePhysicalCount(database, {
      id: count.id,
      inventoryItemId: flourId,
      quantity: 780,
      responsiblePerson: "Manager",
      countDate: "2026-07-06T10:45:00"
    });
    expect(updatedCount).toMatchObject({ quantityBase: 780, countDate: "2026-07-06 10:45:00" });
    expect(() =>
      updatePhysicalCount(database, {
        id: count.id,
        inventoryItemId: flourId,
        quantity: 780,
        countDate: "2026-02-30"
      })
    ).toThrow("invalid");
    deletePhysicalCount(database, count.id);

    const categoryId = listInventorySnapshot(database).costCategories[0].id;
    const cost = addCostRecord(database, { categoryId, costName: "QA Gas", amount: 500, costDate: "2026-07-05" });
    const updatedCost = updateCostRecord(database, {
      id: cost.id,
      categoryId,
      costName: "QA Gas refill",
      amount: 550,
      costDate: "2026-07-06"
    });
    expect(updatedCost).toMatchObject({ costName: "QA Gas refill", amount: 550, costDate: "2026-07-06" });
    expect(() =>
      updateCostRecord(database, {
        id: cost.id,
        categoryId,
        costName: "QA Gas refill",
        amount: 550,
        costDate: "not-a-date"
      })
    ).toThrow("YYYY-MM-DD");
    deleteCostRecord(database, cost.id);

    const actions = listActivityLogs(database, 20).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining([
      "inventory_physical_count_updated",
      "inventory_physical_count_deleted",
      "cost_record_updated",
      "cost_record_deleted"
    ]));
    expect(listInventorySnapshot(database).physicalCounts).toHaveLength(0);
    expect(listInventorySnapshot(database).costRecords).toHaveLength(0);
  });

  it("keeps the new schema and version migration idempotent", () => {
    const database = freshDb();
    const ingredientId = createInventoryItem(database, "QA Migration Ingredient");
    const menuItem = saveMenuItem(database, { name: "QA Migration Dish", price: 100, trackRecipe: true });
    saveMenuRecipe(database, {
      menuItemId: menuItem.id,
      ingredients: [{ inventoryItemId: ingredientId, quantityBase: 10, unitLabel: "g" }]
    });
    migrate(database);
    migrate(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM recipe_versions").get()).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM menu_item_inventory_bindings").get()).toMatchObject({ count: 1 });
    const indexes = database.prepare("PRAGMA index_list(orders)").all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === "idx_orders_date_status")).toBe(true);
  });
});
