import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../src/main/database/connection";
import {
  buildDailySalesEmail,
  getEmailSettings,
  runScheduledDailyEmail,
  saveEmailSettings
} from "../src/main/services/email";
import { addOrderItem, createOrder, sendNewItemsToKitchen, settleOrder } from "../src/main/domain/orders";
import { markPrintJobPrinted } from "../src/main/services/printQueue";
import { setMenuTypes } from "../src/main/services/settings";
import { migrate } from "../src/main/database/schema";

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("Google-backed daily email scheduling", () => {
  it("upgrades legacy email settings in place without losing the recipient", () => {
    db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE email_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        recipient_email TEXT,
        send_daily_summary INTEGER NOT NULL DEFAULT 0,
        send_each_settled_order INTEGER NOT NULL DEFAULT 0,
        credential_path TEXT,
        token_path TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO email_settings
        (id, enabled, recipient_email, send_daily_summary, send_each_settled_order)
      VALUES (1, 1, 'owner@example.com', 1, 0);
    `);
    migrate(db);
    expect(getEmailSettings(db)).toMatchObject({
      enabled: true,
      recipientEmail: "owner@example.com",
      sendDailySummary: true,
      sendTime: "22:00",
      lastDailySummaryDate: null
    });
  });

  it("uses configured menu-type labels instead of raw generated source keys", () => {
    db = openMemoryDatabase();
    const source = "type_1782979170006";
    setMenuTypes(db, [{
      key: source,
      label: "Corporate Catering",
      menuDataKey: source,
      tablesEnabled: false,
      commissionPercent: 0,
      active: true
    }]);
    const menuItemId = Number(db.prepare("INSERT INTO menu_items (name, price) VALUES ('Lunch Box', 250)").run().lastInsertRowid);
    const order = createOrder(db, { source, orderDate: "2026-07-13" });
    addOrderItem(db, order.id, { menuItemId, quantity: 1 });
    markPrintJobPrinted(db, sendNewItemsToKitchen(db, order.id)!);
    settleOrder(db, order.id, "cash", 250);
    const email = buildDailySalesEmail(db, "2026-07-13");
    expect(email).toContain("Corporate Catering");
    expect(email).not.toContain(source);
  });

  it("validates a local HH:mm schedule and never exposes legacy auth paths", () => {
    db = openMemoryDatabase();
    const saved = saveEmailSettings(db, {
      enabled: true,
      recipientEmail: "OWNER@EXAMPLE.COM",
      sendDailySummary: true,
      sendTime: "21:30"
    });
    expect(saved).toMatchObject({
      enabled: true,
      recipientEmail: "owner@example.com",
      sendDailySummary: true,
      sendTime: "21:30"
    });
    expect(saved).not.toHaveProperty("credentialPath");
    expect(saved).not.toHaveProperty("tokenPath");
    expect(() => saveEmailSettings(db!, { sendTime: "25:80" })).toThrow("valid daily summary time");
  });

  it("sends at or after the configured local time and persists a once-per-day guard", async () => {
    db = openMemoryDatabase();
    saveEmailSettings(db, {
      enabled: true,
      recipientEmail: "owner@example.com",
      sendDailySummary: true,
      sendTime: "22:00"
    });
    const send = vi.fn(async (_database: Database.Database, dateLabel: string) => ({
      recipientEmail: "owner@example.com",
      connectedEmail: "yamzo@example.com",
      sentAt: `${dateLabel}T16:00:05.000Z`
    }));

    expect(await runScheduledDailyEmail(db, { now: new Date(2026, 6, 13, 21, 59), send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(await runScheduledDailyEmail(db, { now: new Date(2026, 6, 13, 22, 0), send })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getEmailSettings(db)).toMatchObject({
      lastDailySummaryDate: "2026-07-13",
      lastDailySummarySentAt: "2026-07-13T16:00:05.000Z"
    });
    expect(await runScheduledDailyEmail(db, { now: new Date(2026, 6, 13, 23, 30), send })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not consume the daily guard when delivery fails", async () => {
    db = openMemoryDatabase();
    saveEmailSettings(db, {
      enabled: true,
      recipientEmail: "owner@example.com",
      sendDailySummary: true,
      sendTime: "08:00"
    });
    const send = vi.fn(async () => {
      throw new Error("temporary provider failure");
    });
    await expect(runScheduledDailyEmail(db, { now: new Date(2026, 6, 13, 8, 0), send })).rejects.toThrow(
      "temporary provider failure"
    );
    expect(getEmailSettings(db)).toMatchObject({
      lastDailySummaryDate: null,
      lastError: "temporary provider failure"
    });
  });
});
