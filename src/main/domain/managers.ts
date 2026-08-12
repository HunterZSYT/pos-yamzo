import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";
import type { Manager, ManagerInput } from "../../shared/types.js";

export function listManagers(db: Database.Database, includeInactive = false): Manager[] {
  const rows = db.prepare(
    `SELECT id, manager_code, name, active, created_at, updated_at
     FROM managers
     ${includeInactive ? "" : "WHERE active = 1"}
     ORDER BY active DESC, name COLLATE NOCASE, id`
  ).all() as Array<{
    id: number;
    manager_code: string;
    name: string;
    active: number;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    managerCode: row.manager_code,
    name: row.name,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function saveManager(db: Database.Database, input: ManagerInput): Manager {
  const managerCode = cleanManagerCode(input.managerCode);
  const name = cleanName(input.name);
  const active = input.active === false ? 0 : 1;
  const pin = input.pin?.trim() ?? "";
  if (input.id) {
    const existing = db.prepare("SELECT id FROM managers WHERE id = ?").get(input.id);
    if (!existing) throw new Error("Manager not found.");
    if (pin) {
      assertPin(pin);
      db.prepare(
        `UPDATE managers
         SET manager_code = ?, name = ?, pin_hash = ?, active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(managerCode, name, bcrypt.hashSync(pin, 12), active, input.id);
    } else {
      db.prepare(
        `UPDATE managers
         SET manager_code = ?, name = ?, active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(managerCode, name, active, input.id);
    }
    return getManager(db, input.id);
  }
  assertPin(pin);
  const result = db.prepare(
    "INSERT INTO managers (manager_code, name, pin_hash, active) VALUES (?, ?, ?, ?)"
  ).run(managerCode, name, bcrypt.hashSync(pin, 12), active);
  return getManager(db, Number(result.lastInsertRowid));
}

export function verifyManagerPin(db: Database.Database, managerId: number, pin: string): Manager {
  const row = db.prepare(
    `SELECT id, manager_code, name, pin_hash, active, created_at, updated_at
     FROM managers WHERE id = ?`
  ).get(managerId) as {
    id: number;
    manager_code: string;
    name: string;
    pin_hash: string;
    active: number;
    created_at: string;
    updated_at: string;
  } | undefined;
  if (!row || row.active !== 1 || !bcrypt.compareSync(pin, row.pin_hash)) {
    throw new Error("Manager authorization failed.");
  }
  return {
    id: row.id,
    managerCode: row.manager_code,
    name: row.name,
    active: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getManager(db: Database.Database, id: number): Manager {
  const manager = listManagers(db, true).find((entry) => entry.id === id);
  if (!manager) throw new Error("Manager not found.");
  return manager;
}

function cleanManagerCode(value: string): string {
  const managerCode = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,23}$/.test(managerCode)) {
    throw new Error("Manager ID must be 3-24 letters, numbers, dashes, or underscores.");
  }
  return managerCode;
}

function cleanName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw new Error("Manager name must be 2-80 characters.");
  return name;
}

function assertPin(pin: string): void {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("Manager PIN must be 4-8 digits.");
}
