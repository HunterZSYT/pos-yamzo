import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "./schema.js";

export function openDatabase(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  migrate(db);
  return db;
}

export function openMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}
