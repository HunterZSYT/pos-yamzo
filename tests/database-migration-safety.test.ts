import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/main/database/connection";
import { DATABASE_SCHEMA_VERSION } from "../src/main/database/schema";

let temporaryDirectory: string | null = null;

afterEach(() => {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

describe("database migration safety", () => {
  it("backs up an existing WAL database once before upgrading and leaves fresh databases alone", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yamzo-migration-"));
    const legacyPath = path.join(temporaryDirectory, "yamzo-pos.sqlite3");
    const legacy = new BetterSqlite3(legacyPath);
    legacy.pragma("journal_mode = WAL");
    legacy.exec("CREATE TABLE legacy_recovery_marker (value TEXT NOT NULL)");
    legacy.prepare("INSERT INTO legacy_recovery_marker (value) VALUES (?)").run("preserve-me");
    legacy.pragma("user_version = 0");
    legacy.close();

    const upgraded = openDatabase(legacyPath);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    expect(upgraded.pragma("quick_check", { simple: true })).toBe("ok");
    upgraded.close();

    const backupDirectory = path.join(temporaryDirectory, "backups");
    const backups = fs.readdirSync(backupDirectory).filter((name) => name.endsWith(".sqlite3"));
    expect(backups).toHaveLength(1);
    const backup = new BetterSqlite3(path.join(backupDirectory, backups[0]), { readonly: true });
    expect(backup.prepare("SELECT value FROM legacy_recovery_marker").get()).toEqual({ value: "preserve-me" });
    expect(backup.pragma("quick_check", { simple: true })).toBe("ok");
    backup.close();

    openDatabase(legacyPath).close();
    expect(fs.readdirSync(backupDirectory).filter((name) => name.endsWith(".sqlite3"))).toHaveLength(1);

    const freshPath = path.join(temporaryDirectory, "fresh.sqlite3");
    openDatabase(freshPath).close();
    expect(fs.readdirSync(backupDirectory).filter((name) => name.endsWith(".sqlite3"))).toHaveLength(1);
  });
});
