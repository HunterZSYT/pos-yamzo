import type Database from "better-sqlite3";
import fs from "node:fs";
import Papa from "papaparse";
import type { MenuImportResult, MenuItem, MenuItemInput } from "../../shared/types.js";
import { setMenuCategories, setMenuTypes, slugMenuType, normalizeMenuType } from "./settings.js";

const IGNORED_ROW_NAMES = new Set(["front page", "1st page", "2nd page", "sauce list"]);

export function parsePrice(raw: string): number {
  const match = raw.replace(/,/g, "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

export function importMenuCsv(db: Database.Database, csvPath: string): MenuImportResult {
  const csv = fs.readFileSync(csvPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const priceColumns = headers.filter((field) => !["Item Name", "Category"].includes(field));
  const typeColumns = priceColumns.length ? priceColumns : ["Price"];
  const menuTypes = typeColumns.map((column) =>
    normalizeMenuType({
      key: slugMenuType(column),
      label: column.toLowerCase() === "price" ? "Dine-in" : column,
      tablesEnabled: slugMenuType(column) === "in_house",
      commissionPercent: 0,
      active: true
    })
  );
  const find = db.prepare("SELECT id, price, category, archived FROM menu_items WHERE name = ?");
  const insert = db.prepare("INSERT INTO menu_items (name, price, category, available, archived) VALUES (?, ?, ?, 1, 0)");
  const update = db.prepare(
    `UPDATE menu_items
     SET price = ?, category = ?, archived = 0, available = 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );
  const upsertPrice = db.prepare(
    `INSERT INTO menu_item_prices (menu_item_id, menu_type_key, price, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(menu_item_id, menu_type_key)
     DO UPDATE SET price = excluded.price, updated_at = CURRENT_TIMESTAMP`
  );

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let replaced = 0;
  const categories: string[] = [];

  const tx = db.transaction(() => {
    replaced = (db.prepare("SELECT COUNT(*) AS count FROM menu_items WHERE archived = 0").get() as { count: number }).count;
    db.prepare("UPDATE menu_items SET archived = 1, available = 0, updated_at = CURRENT_TIMESTAMP").run();
    db.prepare("DELETE FROM menu_item_prices").run();
    setMenuTypes(db, menuTypes);
    for (const row of parsed.data) {
      const name = (row["Item Name"] ?? "").trim();
      const price = parsePrice(row.Price ?? row["Dine In"] ?? row["Dine-in"] ?? "");
      const category = (row.Category ?? row.category ?? "").trim() || null;
      if (!name || IGNORED_ROW_NAMES.has(name.toLowerCase()) || price <= 0) {
        skipped += 1;
        continue;
      }
      if (category && !categories.includes(category)) categories.push(category);

      const existing = find.get(name) as { id: number; price: number; category: string | null; archived: number } | undefined;
      let menuItemId = existing?.id ?? 0;
      if (!existing) {
        menuItemId = Number(insert.run(name, price, category).lastInsertRowid);
        imported += 1;
      } else if (existing.price !== price || existing.category !== category || existing.archived === 1) {
        update.run(price, category, existing.id);
        menuItemId = existing.id;
        updated += 1;
      } else {
        db.prepare("UPDATE menu_items SET archived = 0, available = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
        menuItemId = existing.id;
        skipped += 1;
      }

      for (const column of typeColumns) {
        const type = normalizeMenuType({ key: slugMenuType(column), label: column });
        const columnPrice = parsePrice(row[column] ?? "");
        if (columnPrice > 0) upsertPrice.run(menuItemId, type.key, columnPrice);
      }
    }
    if (categories.length) setMenuCategories(db, categories);
  });

  tx();
  return { imported, updated, skipped, replaced, menuTypes: menuTypes.map((type) => type.label) };
}

export function listMenuItems(db: Database.Database): MenuItem[] {
  const items = db
    .prepare("SELECT id, name, price, category, available, archived FROM menu_items WHERE archived = 0 ORDER BY name")
    .all()
    .map(toMenuItem);
  const prices = db.prepare("SELECT menu_item_id, menu_type_key, price FROM menu_item_prices").all() as Array<{ menu_item_id: number; menu_type_key: string; price: number }>;
  const priceMap = new Map<number, Record<string, number>>();
  for (const price of prices) {
    const entry = priceMap.get(price.menu_item_id) ?? {};
    entry[price.menu_type_key] = price.price;
    priceMap.set(price.menu_item_id, entry);
  }
  return items.map((item) => ({ ...item, menuPrices: priceMap.get(item.id) ?? { in_house: item.price } }));
}

export function saveMenuItem(db: Database.Database, input: MenuItemInput & { id?: number }): MenuItem {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Menu item name is required.");
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    throw new Error("Menu item price must be greater than zero.");
  }
  const category = input.category?.trim() || null;
  const available = input.available === false ? 0 : 1;

  if (input.id) {
    db.prepare(
      `UPDATE menu_items
       SET name = ?, price = ?, category = ?, available = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(name, Math.round(input.price), category, available, input.id);
    return getMenuItem(db, input.id);
  }

  const result = db
    .prepare("INSERT INTO menu_items (name, price, category, available, archived) VALUES (?, ?, ?, ?, 0)")
    .run(name, Math.round(input.price), category, available);
  return getMenuItem(db, Number(result.lastInsertRowid));
}

export function archiveMenuItem(db: Database.Database, id: number): void {
  db.prepare("UPDATE menu_items SET archived = 1, available = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
}

export function deleteMenuItem(db: Database.Database, id: number): void {
  const used = db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE menu_item_id = ?").get(id) as { count: number };
  if (used.count > 0) {
    archiveMenuItem(db, id);
    return;
  }
  db.prepare("DELETE FROM menu_items WHERE id = ?").run(id);
}

function getMenuItem(db: Database.Database, id: number): MenuItem {
  const row = db.prepare("SELECT id, name, price, category, available, archived FROM menu_items WHERE id = ?").get(id);
  if (!row) {
    throw new Error("Menu item not found.");
  }
  return toMenuItem(row);
}

function toMenuItem(row: unknown): MenuItem {
  const item = row as { id: number; name: string; price: number; category: string | null; available: number; archived: number };
  return {
    id: item.id,
    name: item.name,
    price: item.price,
    category: item.category,
    available: item.available === 1,
    archived: item.archived === 1
  };
}
