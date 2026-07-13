import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../src/main/database/connection";
import { migrate } from "../src/main/database/schema";
import {
  addPhysicalCount,
  addRestockEntry,
  deletePhysicalCount,
  deleteRestockEntry,
  listInventorySnapshot,
  listMenuInventoryBindings,
  saveMenuRecipe,
  updatePhysicalCount,
  updateRestockEntry
} from "../src/main/domain/inventory";
import { listMenuItems, saveMenuItem } from "../src/main/services/menuImport";

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function freshDb(): Database.Database {
  db = openMemoryDatabase();
  return db;
}

function createInventoryItem(database: Database.Database, name: string): number {
  const unit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
  const category = database.prepare("SELECT id FROM inventory_categories ORDER BY id LIMIT 1").get() as { id: number };
  return Number(database.prepare(
    "INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES (?, ?, ?, 100)"
  ).run(name, category.id, unit.id).lastInsertRowid);
}

describe("chronological inventory events", () => {
  it("preserves timestamps and recalculates reduction-only counts deterministically", () => {
    const database = freshDb();
    const itemId = createInventoryItem(database, "Timeline Flour");
    const opening = addRestockEntry(database, {
      inventoryItemId: itemId,
      quantity: 1000,
      totalCost: 1000,
      entryDate: "2026-07-01T09:00:15"
    });
    expect(opening.entryDate).toBe("2026-07-01 09:00:15");

    const firstCount = addPhysicalCount(database, {
      inventoryItemId: itemId,
      quantity: 800,
      countDate: "2026-07-01T10:00:30"
    });
    expect(firstCount).toMatchObject({ countDate: "2026-07-01 10:00:30", reductionDelta: -200 });

    const topUp = addRestockEntry(database, {
      inventoryItemId: itemId,
      quantity: 100,
      totalCost: 100,
      entryDate: "2026-07-01T11:00:45"
    });
    const secondCount = addPhysicalCount(database, {
      inventoryItemId: itemId,
      quantity: 850,
      countDate: "2026-07-01T12:00:50"
    });
    expect(secondCount.reductionDelta).toBe(-50);
    let snapshot = listInventorySnapshot(database);
    expect(snapshot.items.find((item) => item.id === itemId)).toMatchObject({
      currentStock: 850,
      estimatedWastage: 250,
      lastCountAt: "2026-07-01 12:00:50"
    });

    expect(() => addPhysicalCount(database, {
      inventoryItemId: itemId,
      quantity: 900,
      countDate: "2026-07-01T13:00:00"
    })).toThrow("use Restock for increases");
    expect(listInventorySnapshot(database).physicalCounts).toHaveLength(2);

    updatePhysicalCount(database, {
      id: firstCount.id,
      inventoryItemId: itemId,
      quantity: 750,
      countDate: "2026-07-01T10:00:30"
    });
    snapshot = listInventorySnapshot(database);
    expect(snapshot.physicalCounts.find((count) => count.id === secondCount.id)?.reductionDelta).toBe(0);
    expect(snapshot.items.find((item) => item.id === itemId)?.currentStock).toBe(850);

    deletePhysicalCount(database, firstCount.id);
    snapshot = listInventorySnapshot(database);
    expect(snapshot.physicalCounts.find((count) => count.id === secondCount.id)?.reductionDelta).toBe(-250);
    expect(snapshot.items.find((item) => item.id === itemId)?.currentStock).toBe(850);

    expect(() => updateRestockEntry(database, {
      id: opening.id,
      inventoryItemId: itemId,
      quantity: 1000,
      totalCost: 1000,
      entryDate: "2026-07-01T14:00:00"
    })).toThrow("use Restock for increases");
    expect(listInventorySnapshot(database).restocks.find((entry) => entry.id === opening.id)?.entryDate)
      .toBe("2026-07-01 09:00:15");
    expect(() => deleteRestockEntry(database, opening.id)).toThrow("use Restock for increases");
    expect(listInventorySnapshot(database).restocks.some((entry) => entry.id === opening.id)).toBe(true);

    const nowEntry = addRestockEntry(database, { inventoryItemId: itemId, quantity: 5, totalCost: 5 });
    expect(nowEntry.entryDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(topUp.entryDate).toBe("2026-07-01 11:00:45");
  });
});

describe("standalone reusable recipes", () => {
  it("creates and renames hidden recipe materials without menu binding", () => {
    const database = freshDb();
    const ingredientId = createInventoryItem(database, "Standalone Lemon");

    expect(() => saveMenuRecipe(database, {
      standalone: true,
      recipeName: "   ",
      ingredients: [{ inventoryItemId: ingredientId, quantityBase: 10, unitLabel: "g" }]
    })).toThrow("name is required");

    const standalone = saveMenuRecipe(database, {
      standalone: true,
      recipeName: "House Sauce Base",
      ingredients: [{ inventoryItemId: ingredientId, quantityBase: 10, unitLabel: "g" }]
    });
    expect(standalone).toMatchObject({ menuItemName: "House Sauce Base", status: "available" });
    expect(listMenuItems(database).some((item) => item.id === standalone.menuItemId)).toBe(false);
    expect(listMenuInventoryBindings(database).some((binding) => binding.menuItemId === standalone.menuItemId)).toBe(false);
    expect(database.prepare(
      "SELECT price, category, track_recipe, available, archived FROM menu_items WHERE id = ?"
    ).get(standalone.menuItemId)).toEqual({
      price: 0,
      category: "Recipe Material",
      track_recipe: 1,
      available: 0,
      archived: 1
    });

    const standaloneFromSnapshot = listInventorySnapshot(database).recipes.find((recipe) => recipe.id === standalone.id)!;
    expect(standaloneFromSnapshot.standalone).toBe(true);
    const missingMenuRecipe = saveMenuItem(database, {
      name: "Missing Normal Recipe",
      price: 90,
      category: "Mains",
      available: true,
      trackRecipe: true
    });
    expect(listInventorySnapshot(database).recipes.find((recipe) => recipe.menuItemId === missingMenuRecipe.id)?.standalone).toBe(false);

    const renamed = saveMenuRecipe(database, {
      menuItemId: standaloneFromSnapshot.menuItemId,
      standalone: standaloneFromSnapshot.standalone,
      recipeName: "House Sauce Concentrate",
      ingredients: standaloneFromSnapshot.ingredients.map((ingredient) => ({
        inventoryItemId: ingredient.inventoryItemId,
        quantityBase: ingredient.quantityBase + 2,
        unitLabel: ingredient.unitLabel
      }))
    });
    expect(renamed).toMatchObject({ menuItemName: "House Sauce Concentrate", standalone: true });
    expect(listMenuInventoryBindings(database).some((binding) => binding.menuItemId === standalone.menuItemId)).toBe(false);

    const plated = saveMenuItem(database, {
      name: "Sauce Plate",
      price: 150,
      category: "Mains",
      available: true,
      trackRecipe: true
    });
    const platedRecipe = saveMenuRecipe(database, {
      menuItemId: plated.id,
      ingredients: [{ kind: "recipe", childRecipeId: renamed.id, quantityBase: 1, unitLabel: "portion" }]
    });
    expect(platedRecipe.childIngredients).toHaveLength(1);
    expect(listMenuInventoryBindings(database).some((binding) => binding.menuItemId === plated.id)).toBe(true);

    database.prepare(
      `INSERT INTO menu_item_inventory_bindings
       (menu_item_id, binding_type, recipe_id, inventory_item_id, quantity_base, unit_label)
       VALUES (?, 'recipe', ?, NULL, 1, 'portion')`
    ).run(standalone.menuItemId, standalone.id);
    migrate(database);
    migrate(database);
    expect(listMenuInventoryBindings(database).some((binding) => binding.menuItemId === standalone.menuItemId)).toBe(false);
    expect(listMenuInventoryBindings(database).some((binding) => binding.menuItemId === plated.id)).toBe(true);

    expect(() => saveMenuRecipe(database, {
      menuItemId: standalone.menuItemId,
      standalone: true,
      recipeName: "Sauce Plate",
      ingredients: [{ inventoryItemId: ingredientId, quantityBase: 12, unitLabel: "g" }]
    })).toThrow("already exists");
    expect(database.prepare("SELECT name FROM menu_items WHERE id = ?").get(standalone.menuItemId))
      .toEqual({ name: "House Sauce Concentrate" });

    expect(() => saveMenuRecipe(database, {
      menuItemId: plated.id,
      standalone: true,
      recipeName: "Renamed Outside Menu",
      ingredients: [{ inventoryItemId: ingredientId, quantityBase: 1, unitLabel: "g" }]
    })).toThrow("Menu tab");
  });
});
