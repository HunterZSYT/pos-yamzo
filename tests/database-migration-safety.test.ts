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

  it("repairs legacy closed timers and backfills tender allocations during the version 10 upgrade", () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yamzo-migration-v10-"));
    const databasePath = path.join(temporaryDirectory, "yamzo-pos.sqlite3");
    const legacy = openDatabase(databasePath);
    const orderId = Number(
      legacy.prepare(
        `INSERT INTO orders
          (order_number, order_date, source, status, first_kitchen_sent_at, kitchen_completed_at, settled_at, updated_at)
         VALUES ('yamzo-migration-v10-111', '2026-08-16', 'parcel', 'settled', '2026-08-16 10:00:00', NULL, '2026-08-16 10:30:00', '2026-08-16 10:30:00')`
      ).run().lastInsertRowid
    );
    const ticketId = Number(legacy.prepare("INSERT INTO kitchen_tickets (order_id, type, completed_at) VALUES (?, 'kot', NULL)").run(orderId).lastInsertRowid);
    legacy.prepare(
      `INSERT INTO order_payment_sessions
        (order_id, method, payable_amount, cash_amount, bkash_amount, cash_received, change_given, host_name)
       VALUES (?, 'cash', 500, 0, 0, 500, 0, 'Cashier')`
    ).run(orderId);
    legacy.pragma("user_version = 9");
    legacy.close();

    const upgraded = openDatabase(databasePath);
    expect(upgraded.prepare("SELECT kitchen_completed_at FROM orders WHERE id = ?").get(orderId)).toEqual({ kitchen_completed_at: "2026-08-16 10:30:00" });
    expect(upgraded.prepare("SELECT completed_at FROM kitchen_tickets WHERE id = ?").get(ticketId)).toEqual({ completed_at: "2026-08-16 10:30:00" });
    expect(upgraded.prepare("SELECT cash_amount, bkash_amount FROM order_payment_sessions WHERE order_id = ?").get(orderId)).toEqual({ cash_amount: 500, bkash_amount: 0 });
    expect(upgraded.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    expect(upgraded.pragma("quick_check", { simple: true })).toBe("ok");
    upgraded.close();
  });
});
