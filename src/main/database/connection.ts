import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATABASE_SCHEMA_VERSION, migrate } from "./schema.js";

const AUTOMATIC_BACKUP_RETENTION = 5;

export function openDatabase(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const existingFile = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
  const db = new Database(databasePath);
  try {
    if (existingFile) {
      const currentVersion = Number(db.pragma("user_version", { simple: true }));
      if (currentVersion > DATABASE_SCHEMA_VERSION) {
        throw new Error(
          `This database uses schema version ${currentVersion}, but this Yamzo POS build supports version ${DATABASE_SCHEMA_VERSION}.`
        );
      }
      if (currentVersion < DATABASE_SCHEMA_VERSION) {
        createPreMigrationBackup(db, databasePath, currentVersion, DATABASE_SCHEMA_VERSION);
      }
    }
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function createPreMigrationBackup(
  db: Database.Database,
  databasePath: string,
  fromVersion: number,
  toVersion: number
): string {
  const backupDirectory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const databaseName = path.parse(databasePath).name;
  const prefix = `${databaseName}-pre-migration-v${fromVersion}-to-v${toVersion}-`;
  const timestamp = new Date().toISOString().replace(/[-:.Z]/g, "").replace("T", "-");
  let backupPath = path.join(backupDirectory, `${prefix}${timestamp}.sqlite3`);
  let suffix = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(backupDirectory, `${prefix}${timestamp}-${suffix}.sqlite3`);
    suffix += 1;
  }

  // VACUUM INTO produces a transactionally consistent copy and includes data
  // committed in the source database's WAL before any migration statement runs.
  db.exec(`VACUUM INTO '${escapeSqlString(backupPath)}'`);
  pruneAutomaticBackups(backupDirectory, `${databaseName}-pre-migration-v`);
  return backupPath;
}

function pruneAutomaticBackups(backupDirectory: string, prefix: string): void {
  const backups = fs
    .readdirSync(backupDirectory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite3"))
    .sort((left, right) => left.localeCompare(right));
  for (const name of backups.slice(0, Math.max(0, backups.length - AUTOMATIC_BACKUP_RETENTION))) {
    try {
      fs.unlinkSync(path.join(backupDirectory, name));
    } catch {
      // A retained recovery copy already exists; cleanup failure must not block startup.
    }
  }
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
