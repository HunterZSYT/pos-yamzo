import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_RECIPE_TEXT = "C:\\Users\\acer\\.codex\\attachments\\2c785854-ab95-4227-bb21-b14775dda3c5\\pasted-text.txt";
const appData = process.env.YAMZO_APP_DATA_DIR
  ? process.env.YAMZO_APP_DATA_DIR
  : path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Yamzo POS");
const databasePath = path.join(appData, "local-data", "yamzo-pos.sqlite3");
const recipePath = process.argv[2] ?? DEFAULT_RECIPE_TEXT;

const menuCategories = ["Seafood", "Momo", "Fish & Chips", "Pasta", "Rice", "Soup", "Snacks", "Sauce", "Drinks", "Other"];
const drinks = [
  "Water Kinle Bottle",
  "Pepsi Glass Bottle",
  "Mirinda Glass Bottle",
  "Mountain Dew Glass Bottle",
  "Pepsi Plastic Bottle",
  "7 Up Plastic Bottle"
];
const directSauces = ["Chili Oil", "Masala Base", "Green Sauce"];

const aliasMap = new Map([
  ["bbq octopus", ["BBQ Octopus Masala"]],
  ["chicken chow mein", ["Chicken Chowmin"]],
  ["signature seafood soup", ["Signature Sea Food Soup"]],
  ["chicken shingara", ["Chicken Singara - Single Package (5Pcs)", "Chicken Singara - Family Package (10Pcs)", "Chicken Singara - Party Package (20Pcs)"]],
  ["mutton shingara", ["Mutton Singara - Single Package (5Pcs)", "Mutton Singara - Family Package (10Pcs)", "Mutton Singara - Party Package (20Pcs)"]],
  ["naga shingara", ["Naga Singara - Single Package (5Pcs)", "Naga Singara - Family Package (10Pcs)", "Naga Singara - Party Package (20Pcs)"]]
]);

const shingaraScale = new Map([
  ["single package (5pcs)", 5],
  ["family package (10pcs)", 10],
  ["party package (20pcs)", 20]
]);

function parseRecipes(text) {
  const recipes = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const recipeMatch = line.match(/^Recipe\s+\d+:\s*(.+)$/i);
    if (recipeMatch) {
      current = { name: cleanName(recipeMatch[1]), ingredients: [] };
      recipes.push(current);
      continue;
    }
    const ingredientMatch = line.match(/^-\s*([^:]+):\s*([0-9.]+)\s*([a-zA-Z]+)$/);
    if (ingredientMatch && current) {
      const quantity = Number(ingredientMatch[2]);
      const unit = normalizeUnit(ingredientMatch[3]);
      current.ingredients.push({
        name: cleanName(ingredientMatch[1]),
        quantity,
        baseQuantity: quantity,
        unitLabel: unit === "pc" ? "piece" : "g",
        unitShortName: unit
      });
    }
  }
  return recipes;
}

function normalizeUnit(unit) {
  const lower = unit.toLowerCase();
  if (lower === "piece" || lower === "pieces" || lower === "pc") return "pc";
  return "g";
}

function cleanName(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanName(value).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function categoryForMenuItem(name) {
  const lower = normalize(name);
  if (directSauces.some((sauce) => normalize(sauce) === lower) || lower.includes("sauce") || lower.includes("oil") || lower.includes("base")) return "Sauce";
  if (drinks.some((drink) => normalize(drink) === lower)) return "Drinks";
  if (lower.includes("momo") || lower.includes("dumpling")) return "Momo";
  if (lower.includes("fish and chips") || lower.includes("fish chips")) return "Fish & Chips";
  if (lower.includes("pasta")) return "Pasta";
  if (lower.includes("rice")) return "Rice";
  if (lower.includes("soup")) return "Soup";
  if (lower.includes("singara") || lower.includes("shingara") || lower.includes("fries") || lower.includes("popcorn") || lower.includes("tempura")) return "Snacks";
  return "Seafood";
}

function priceForMenuItem(name) {
  const lower = normalize(name);
  if (categoryForMenuItem(name) === "Sauce") return 10;
  if (categoryForMenuItem(name) === "Drinks") return 30;
  if (lower.includes("fish and chips") || lower.includes("fish chips")) return 380;
  if (lower.includes("soup")) return 250;
  if (lower.includes("singara") || lower.includes("shingara")) return lower.includes("20pcs") ? 240 : lower.includes("10pcs") ? 130 : 70;
  if (lower.includes("momo")) return 190;
  if (lower.includes("rice") || lower.includes("pasta")) return 290;
  return 190;
}

function getUnitId(db, shortName) {
  const existing = db.prepare("SELECT id FROM inventory_units WHERE short_name = ?").get(shortName);
  if (existing) return existing.id;
  const name = shortName === "pc" ? "Piece" : shortName === "kg" ? "Kilogram" : shortName === "l" ? "Liter" : "Gram";
  return Number(db.prepare("INSERT INTO inventory_units (name, short_name, active) VALUES (?, ?, 1)").run(name, shortName).lastInsertRowid);
}

function getInventoryCategoryId(db, name) {
  const existing = db.prepare("SELECT id FROM inventory_categories WHERE lower(name) = lower(?)").get(name);
  if (existing) return existing.id;
  return Number(db.prepare("INSERT INTO inventory_categories (name, active) VALUES (?, 1)").run(name).lastInsertRowid);
}

function ensureInventoryItem(db, name, unitShortName) {
  const existing = db.prepare("SELECT id FROM inventory_items WHERE lower(name) = lower(?)").get(name);
  if (existing) return { id: existing.id, created: false };
  const unitId = getUnitId(db, unitShortName);
  const categoryId = getInventoryCategoryId(db, unitShortName === "pc" ? "Countable" : "Raw Material");
  const id = Number(
    db.prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold, active) VALUES (?, ?, ?, ?, 1)")
      .run(name, categoryId, unitId, unitShortName === "pc" ? 10 : 1000)
      .lastInsertRowid
  );
  return { id, created: true };
}

function ensureTestStock(db, itemId, unitShortName) {
  const hasRestock = db.prepare("SELECT id FROM inventory_restock_entries WHERE inventory_item_id = ? LIMIT 1").get(itemId);
  if (hasRestock) return false;
  const quantity = unitShortName === "pc" ? 500 : 100000;
  const totalCost = unitShortName === "pc" ? 2500 : 8000;
  const pricePerBase = totalCost / quantity;
  db.prepare(
    `INSERT INTO inventory_restock_entries
     (inventory_item_id, quantity_base, unit_label, total_cost, price_per_base, supplier_name, responsible_person, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(itemId, quantity, unitShortName, totalCost, pricePerBase, "Test stock", "admin", "Seeded for testing");
  db.prepare("INSERT INTO inventory_price_history (inventory_item_id, price_per_base, responsible_person, note) VALUES (?, ?, ?, ?)")
    .run(itemId, pricePerBase, "admin", "Seeded test price");
  return true;
}

function ensureMenuItem(db, name, price = priceForMenuItem(name), category = categoryForMenuItem(name)) {
  const existing = db.prepare("SELECT id, name FROM menu_items WHERE lower(name) = lower(?)").get(name);
  if (existing) {
    db.prepare("UPDATE menu_items SET category = COALESCE(NULLIF(category, ''), ?), available = 1, archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(category, existing.id);
    return { id: existing.id, name: existing.name, created: false };
  }
  const id = Number(db.prepare("INSERT INTO menu_items (name, price, category, available, archived) VALUES (?, ?, ?, 1, 0)").run(name, price, category).lastInsertRowid);
  return { id, name, created: true };
}

function getAllMenu(db) {
  return db.prepare("SELECT id, name FROM menu_items WHERE archived = 0").all();
}

function findMenuTargets(db, recipeName) {
  const normalizedRecipe = normalize(recipeName);
  const aliases = aliasMap.get(normalizedRecipe) ?? [];
  const targets = [];
  for (const alias of aliases) {
    const existing = db.prepare("SELECT id, name FROM menu_items WHERE lower(name) = lower(?) AND archived = 0").get(alias);
    targets.push(existing ?? ensureMenuItem(db, alias));
  }
  if (targets.length) return targets;

  const allMenu = getAllMenu(db);
  const exact = allMenu.find((item) => normalize(item.name) === normalizedRecipe);
  if (exact) return [exact];
  const fuzzy = allMenu.find((item) => {
    const normalizedItem = normalize(item.name);
    return normalizedItem.includes(normalizedRecipe) || normalizedRecipe.includes(normalizedItem);
  });
  if (fuzzy) return [fuzzy];
  return [ensureMenuItem(db, recipeName)];
}

function scaleForMenuName(name) {
  const normalizedName = normalize(name);
  for (const [needle, scale] of shingaraScale.entries()) {
    if (normalizedName.includes(normalize(needle))) return scale;
  }
  return 1;
}

function upsertRecipe(db, menuItem, ingredients) {
  const existing = db.prepare("SELECT id FROM menu_item_recipes WHERE menu_item_id = ?").get(menuItem.id);
  const recipeId = existing
    ? existing.id
    : Number(db.prepare("INSERT INTO menu_item_recipes (menu_item_id, active) VALUES (?, 1)").run(menuItem.id).lastInsertRowid);
  db.prepare("UPDATE menu_item_recipes SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recipeId);
  db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
  const insert = db.prepare("INSERT INTO recipe_ingredients (recipe_id, inventory_item_id, quantity_base, unit_label) VALUES (?, ?, ?, ?)");
  const scale = scaleForMenuName(menuItem.name);
  for (const ingredient of ingredients) {
    const item = ensureInventoryItem(db, ingredient.name, ingredient.unitShortName);
    ensureTestStock(db, item.id, ingredient.unitShortName);
    insert.run(recipeId, item.id, ingredient.baseQuantity * scale, ingredient.unitLabel);
  }
  return existing ? "updated" : "created";
}

function setJsonSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, JSON.stringify(value));
}

if (!fs.existsSync(recipePath)) {
  throw new Error(`Recipe text file not found: ${recipePath}`);
}

const connectionModule = await import(pathToFileURL(path.join(process.cwd(), "dist-electron", "main", "database", "connection.js")));
const db = connectionModule.openDatabase(databasePath);
try {
  const recipes = parseRecipes(fs.readFileSync(recipePath, "utf8"));
  const counters = { recipes: recipes.length, recipesCreated: 0, recipesUpdated: 0, menuCreated: 0, drinksCreated: 0, saucesCreated: 0 };
  const tx = db.transaction(() => {
    setJsonSetting(db, "menuCategories", menuCategories);
    for (const drink of drinks) {
      if (ensureMenuItem(db, drink, 30, "Drinks").created) counters.drinksCreated += 1;
    }
    for (const sauce of directSauces) {
      if (ensureMenuItem(db, sauce, 10, "Sauce").created) counters.saucesCreated += 1;
    }
    for (const recipe of recipes) {
      const targets = findMenuTargets(db, recipe.name);
      for (const target of targets) {
        if (target.created) counters.menuCreated += 1;
        const result = upsertRecipe(db, target, recipe.ingredients);
        if (result === "created") counters.recipesCreated += 1;
        else counters.recipesUpdated += 1;
      }
    }
    db.prepare("UPDATE menu_items SET price = 10, category = 'Sauce', available = 1, archived = 0, updated_at = CURRENT_TIMESTAMP WHERE lower(name) LIKE '%sauce%' OR lower(name) IN ('chili oil', 'masala base', 'green sauce')").run();
    db.prepare("UPDATE menu_items SET price = 30, category = 'Drinks', available = 1, archived = 0, updated_at = CURRENT_TIMESTAMP WHERE lower(name) IN (?, ?, ?, ?, ?, ?)")
      .run(...drinks.map((drink) => drink.toLowerCase()));
    db.prepare("INSERT INTO audit_logs (actor, action, details) VALUES (?, ?, ?)").run("admin", "yamzo_recipe_seeded", JSON.stringify(counters));
  });
  tx();
  console.log(JSON.stringify({ databasePath, recipePath, counters }, null, 2));
} finally {
  db.close();
}
