import type Database from "better-sqlite3";
import fs from "node:fs";
import Papa from "papaparse";
import type { MenuImportResult, MenuItem, MenuItemInput } from "../../shared/types.js";

const IGNORED_ROW_NAMES = new Set(["front page", "1st page", "2nd page", "sauce list"]);

export function parsePrice(raw: string): number {
  const match = raw.replace(/,/g, "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

export function importMenuCsv(db: Database.Database, csvPath: string): MenuImportResult {
  const csv = fs.readFileSync(csvPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const find = db.prepare("SELECT id, price, category, archived FROM menu_items WHERE name = ?");
  const insert = db.prepare("INSERT INTO menu_items (name, price, category, available, archived) VALUES (?, ?, ?, 1, 0)");
  const update = db.prepare(
    `UPDATE menu_items
     SET price = ?, category = ?, archived = 0, available = 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const row of parsed.data) {
      const name = (row["Item Name"] ?? "").trim();
      const price = parsePrice(row.Price ?? "");
      const category = (row.Category ?? row.category ?? "").trim() || null;
      if (!name || IGNORED_ROW_NAMES.has(name.toLowerCase()) || price <= 0) {
        skipped += 1;
        continue;
      }

      const existing = find.get(name) as { id: number; price: number; category: string | null; archived: number } | undefined;
      if (!existing) {
        insert.run(name, price, category);
        imported += 1;
        continue;
      }

      if (existing.price !== price || existing.category !== category || existing.archived === 1) {
        update.run(price, category, existing.id);
        updated += 1;
      } else {
        skipped += 1;
      }
    }
  });

  tx();
  return { imported, updated, skipped };
}

export function listMenuItems(db: Database.Database): MenuItem[] {
  return db
    .prepare("SELECT id, name, price, category, available, archived FROM menu_items WHERE archived = 0 ORDER BY name")
    .all()
    .map(toMenuItem);
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
