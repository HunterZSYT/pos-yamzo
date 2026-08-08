import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../src/main/database/connection";
import {
  acceptWebsiteOrder,
  enqueueWebsitePrintAck,
  getWebsiteOrderDetail,
  hardDeleteTestWebsiteOrder,
  importWebsiteOrderSnapshots,
  listPendingWebsiteOutbox,
  listWebsiteOrders,
  rejectWebsiteOrder,
  transitionWebsiteOrder
} from "../src/main/domain/websiteOrders";
import { getSalesSummary } from "../src/main/domain/reports";
import { applyWebsiteMenuContract } from "../src/main/domain/websiteMenuContract";
import { buildGoogleSheetsSnapshot } from "../src/main/services/googleSheets";
import { WebsiteOrderSyncService, type WebsiteOrderSyncTransport } from "../src/main/services/websiteOrderSync";
import type { WebsiteOrderSnapshot } from "../src/shared/types";

let db: Database.Database;
let publicMenuId: string;

beforeEach(() => {
  db = openMemoryDatabase();
  const menuItemId = Number(db.prepare(
    "INSERT INTO menu_items (name, price, category, track_recipe, available, archived) VALUES ('Website Momo', 250, 'Momo', 1, 1, 0)"
  ).run().lastInsertRowid);
  expect(menuItemId).toBeGreaterThan(0);
  publicMenuId = "menu_item_website_momo";
  applyWebsiteMenuContract(db, contract([{
    websitePublicId: publicMenuId,
    effectiveUnitPrice: 250,
    websiteName: "Website Momo",
    expectedPosName: "Website Momo"
  }]));
});

describe("website order inbox", () => {
  it("imports versioned snapshots idempotently and rejects same-version data conflicts", () => {
    const order = snapshot();
    expect(importWebsiteOrderSnapshots(db, [order])).toEqual({ inserted: 1, updated: 0, unchanged: 0, ignoredStale: 0 });
    expect(importWebsiteOrderSnapshots(db, [order])).toEqual({ inserted: 0, updated: 0, unchanged: 1, ignoredStale: 0 });
    expect(listWebsiteOrders(db, ["pending"])).toHaveLength(1);
    expect(getWebsiteOrderDetail(db, order.remoteId).items[0]).toMatchObject({ mapped: true, menuItemPublicId: publicMenuId });

    expect(() => importWebsiteOrderSnapshots(db, [{ ...order, customerName: "Changed without version" }])).toThrow(/reused version/i);
    expect(importWebsiteOrderSnapshots(db, [{ ...order, remoteVersion: 2, deliveryNote: "Gate is on the left" }])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
      ignoredStale: 0
    });
  });

  it("accepts once, creates exactly one POS order and two durable print jobs, and emits state changes", () => {
    const order = snapshot({ isTest: false });
    importWebsiteOrderSnapshots(db, [order]);

    const accepted = acceptWebsiteOrder(db, order.remoteId);
    expect(accepted.alreadyAccepted).toBe(false);
    expect(accepted.posOrder).toMatchObject({ source: "website", externalOrderId: order.remoteId, total: 275, isTest: false });
    expect(db.prepare("SELECT type, COUNT(*) AS count FROM print_jobs GROUP BY type ORDER BY type").all()).toEqual([
      { type: "kot", count: 1 },
      { type: "parcel_slip", count: 1 }
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1 });

    const repeated = acceptWebsiteOrder(db, order.remoteId);
    expect(repeated.alreadyAccepted).toBe(true);
    expect(repeated.kitchenPrintJobId).toBe(accepted.kitchenPrintJobId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1 });

    expect(transitionWebsiteOrder(db, order.remoteId, "preparing").status).toBe("preparing");
    expect(transitionWebsiteOrder(db, order.remoteId, "ready").status).toBe("ready");
    expect(() => transitionWebsiteOrder(db, order.remoteId, "preparing")).toThrow(/cannot move/i);
    expect(transitionWebsiteOrder(db, order.remoteId, "out_for_delivery").status).toBe("out_for_delivery");
    expect(transitionWebsiteOrder(db, order.remoteId, "delivered").status).toBe("delivered");
    expect(db.prepare("SELECT status FROM orders WHERE id = ?").get(accepted.posOrder.id)).toEqual({ status: "settled" });
    expect(db.prepare("SELECT method, amount FROM payments WHERE order_id = ?").get(accepted.posOrder.id)).toEqual({ method: "cash", amount: 275 });
    expect(db.prepare("SELECT type, COUNT(*) AS count FROM print_jobs GROUP BY type ORDER BY type").all()).toEqual([
      { type: "kot", count: 1 },
      { type: "parcel_slip", count: 1 },
      { type: "receipt", count: 1 }
    ]);
    expect(getSalesSummary(db)).toMatchObject({ totalOrders: 1, totalSales: 275, openOrders: 0 });
    expect(listPendingWebsiteOutbox(db).map((event) => event.eventType)).toEqual([
      "order.accepted",
      "order.preparing",
      "order.ready",
      "order.out_for_delivery",
      "order.delivered"
    ]);
    expect(listPendingWebsiteOutbox(db).map((event) => event.payload.expectedVersion)).toEqual([1, 2, 3, 4, 5]);
  });

  it("requires a reason to reject and never creates a POS order for rejected orders", () => {
    const order = snapshot({ remoteId: "web-reject-1", orderCode: "WEB-REJECT-1", isTest: false });
    importWebsiteOrderSnapshots(db, [order]);
    expect(() => rejectWebsiteOrder(db, order.remoteId, " ")).toThrow(/required/i);
    expect(rejectWebsiteOrder(db, order.remoteId, "Outside delivery hours").status).toBe("rejected");
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
  });

  it("cancels an accepted website order and its linked POS order atomically", () => {
    const order = snapshot({ remoteId: "web-cancel-1", orderCode: "WEB-CANCEL-1", isTest: false });
    importWebsiteOrderSnapshots(db, [order]);
    const accepted = acceptWebsiteOrder(db, order.remoteId);

    expect(transitionWebsiteOrder(db, order.remoteId, "cancelled").status).toBe("cancelled");
    expect(db.prepare("SELECT status FROM orders WHERE id = ?").get(accepted.posOrder.id)).toEqual({ status: "cancelled" });
    expect(getSalesSummary(db)).toMatchObject({ totalOrders: 0, totalSales: 0, openOrders: 0 });
    expect(listPendingWebsiteOutbox(db).map((event) => event.eventType)).toEqual(["order.accepted", "order.cancelled"]);
  });

  it("excludes test orders from sales, Google Sheets, and inventory, then permanently deletes their local data", () => {
    const order = snapshot({ remoteId: "web-test-1", orderCode: "WEB-TEST-1", isTest: true });
    importWebsiteOrderSnapshots(db, [order]);
    const accepted = acceptWebsiteOrder(db, order.remoteId);
    transitionWebsiteOrder(db, order.remoteId, "preparing");
    transitionWebsiteOrder(db, order.remoteId, "ready");
    transitionWebsiteOrder(db, order.remoteId, "delivered");

    expect(getSalesSummary(db)).toMatchObject({ totalOrders: 0, totalSales: 0, openOrders: 0 });
    expect(buildGoogleSheetsSnapshot(db).orders.rows).toHaveLength(0);
    expect(buildGoogleSheetsSnapshot(db).orderItems.rows).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments WHERE order_id = ?").get(accepted.posOrder.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM order_cost_snapshots WHERE order_id = ?").get(accepted.posOrder.id)).toEqual({ count: 0 });

    const unrelatedPrintJobId = Number(db.prepare(
      "INSERT INTO print_jobs (type, content, status) VALUES ('receipt', ?, 'printed')"
    ).run(`ORDER: ${accepted.posOrder.orderNumber}0\nUnrelated live order`).lastInsertRowid);
    const testPrintJobIds = (db.prepare("SELECT id FROM print_jobs WHERE id <> ? ORDER BY id").all(unrelatedPrintJobId) as Array<{ id: number }>).map((row) => row.id);

    expect(hardDeleteTestWebsiteOrder(db, order.remoteId)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM website_orders").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM print_jobs WHERE id IN (${testPrintJobIds.map(() => "?").join(",")})`).get(...testPrintJobIds)).toEqual({ count: 0 });
    expect(db.prepare("SELECT content FROM print_jobs WHERE id = ?").get(unrelatedPrintJobId)).toEqual({
      content: `ORDER: ${accepted.posOrder.orderNumber}0\nUnrelated live order`
    });
    expect(hardDeleteTestWebsiteOrder(db, order.remoteId)).toBe(false);
  });

  it("never permanently deletes a live website order", () => {
    const order = snapshot({ remoteId: "web-live-1", orderCode: "WEB-LIVE-1", isTest: false });
    importWebsiteOrderSnapshots(db, [order]);
    expect(() => hardDeleteTestWebsiteOrder(db, order.remoteId)).toThrow(/only test/i);
    expect(getWebsiteOrderDetail(db, order.remoteId).status).toBe("pending");
  });

  it("refuses destructive cleanup when the linked POS test flag is inconsistent", () => {
    const order = snapshot({ remoteId: "web-test-mismatch", orderCode: "WEB-TEST-MISMATCH", isTest: true });
    importWebsiteOrderSnapshots(db, [order]);
    const accepted = acceptWebsiteOrder(db, order.remoteId);
    db.prepare("UPDATE orders SET is_test = 0 WHERE id = ?").run(accepted.posOrder.id);

    expect(() => hardDeleteTestWebsiteOrder(db, order.remoteId)).toThrow(/safety check/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM website_orders WHERE remote_id = ?").get(order.remoteId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = ?").get(accepted.posOrder.id)).toEqual({ count: 1 });
  });

  it("refuses an unknown public ID even when its display name matches", () => {
    const order = snapshot({
      remoteId: "web-name-map",
      orderCode: "WEB-NAME-MAP",
      items: [{
        remoteItemId: "web-name-item",
        menuItemPublicId: "menu_item_remote_key",
        name: "Website Momo",
        quantity: 1,
        unitPrice: 250,
        note: null
      }]
    });
    importWebsiteOrderSnapshots(db, [order]);
    expect(getWebsiteOrderDetail(db, order.remoteId).items[0]).toMatchObject({ mapped: false });
    expect(() => acceptWebsiteOrder(db, order.remoteId)).toThrow(/map every website item/i);
  });

  it("normalizes remote control characters before they reach durable print content", () => {
    const order = snapshot({
      remoteId: "web-safe-print",
      orderCode: "WEB-SAFE-PRINT",
      customerName: "Test\u001b Customer\nName",
      deliveryNote: "Ring\tthe bell\u0000 twice"
    });
    importWebsiteOrderSnapshots(db, [order]);
    const accepted = acceptWebsiteOrder(db, order.remoteId);
    const content = (db.prepare("SELECT content FROM print_jobs WHERE id = ?").get(accepted.deliveryPrintJobId) as { content: string }).content;
    expect(content).toContain("Customer: Test Customer Name");
    expect(content).toContain("Note: Ring the bell twice");
    expect([...content].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x1b || code === 0;
    })).toBe(false);
  });

  it("keeps transport work behind a mockable main-process sync boundary", async () => {
    const order = snapshot({ remoteId: "web-sync-1", orderCode: "WEB-SYNC-1", isTest: false });
    const pushedIds: number[][] = [];
    const transport: WebsiteOrderSyncTransport = {
      pullOrders: async () => ({ orders: [order], nextCursor: "cursor-1" }),
      pushEvents: async (events) => {
        const ids = events.map((event) => event.id);
        pushedIds.push(ids);
        return { acceptedEventIds: ids };
      }
    };
    const service = new WebsiteOrderSyncService(db, transport);
    expect(await service.syncOnce()).toMatchObject({ inserted: 1, pushed: 0, cursor: "cursor-1" });
    acceptWebsiteOrder(db, order.remoteId);
    expect(await service.syncOnce()).toMatchObject({ ignoredStale: 1, pushed: 1, cursor: "cursor-1" });
    expect(pushedIds).toHaveLength(1);
    expect(db.prepare("SELECT status FROM website_sync_outbox").all()).toEqual([{ status: "sent" }]);
  });

  it("queues durable, independently retryable acknowledgements for website print jobs", () => {
    const order = snapshot({ remoteId: "c7a3c315-5381-4676-97b7-75c57294198f", orderCode: "WEB-PRINT-ACK", isTest: false });
    importWebsiteOrderSnapshots(db, [order]);
    const accepted = acceptWebsiteOrder(db, order.remoteId);

    enqueueWebsitePrintAck(db, accepted.kitchenPrintJobId, false);
    enqueueWebsitePrintAck(db, accepted.kitchenPrintJobId, true);
    enqueueWebsitePrintAck(db, accepted.deliveryPrintJobId, true);

    const events = listPendingWebsiteOutbox(db);
    expect(events.every((event) => /^[0-9a-f-]{36}$/i.test(event.eventKey))).toBe(true);
    expect(events.map((event) => event.eventType)).toEqual([
      "order.accepted",
      "print.ack",
      "print.ack",
      "print.ack"
    ]);
    expect(events.slice(1).map((event) => event.payload)).toEqual([
      { kind: "kitchen_copy", succeeded: false, errorCode: "LOCAL_PRINT_FAILED" },
      { kind: "kitchen_copy", succeeded: true, errorCode: null },
      { kind: "customer_receipt", succeeded: true, errorCode: null }
    ]);
  });
});

function snapshot(overrides: Partial<WebsiteOrderSnapshot> = {}): WebsiteOrderSnapshot {
  return {
    remoteId: "web-order-1",
    orderCode: "WEB-1001",
    remoteVersion: 1,
    status: "pending",
    customerName: "Test Customer",
    customerPhone: "+8801712345678",
    address: { sector: "11", road: "20", house: "80", flat: "4B" },
    deliveryNote: null,
    subtotal: 250,
    deliveryFee: 25,
    discount: 0,
    total: 275,
    isTest: true,
    remoteCreatedAt: "2026-08-05T05:00:00.000Z",
    remoteUpdatedAt: "2026-08-05T05:00:00.000Z",
    items: [{
      remoteItemId: "web-item-1",
      menuItemPublicId: publicMenuId,
      name: "Website Momo",
      quantity: 1,
      unitPrice: 250,
      note: "No chilli"
    }],
    ...overrides
  };
}

function contract(entries: Array<{
  websitePublicId: string;
  effectiveUnitPrice: number;
  websiteName: string;
  expectedPosName: string;
}>) {
  return {
    schemaVersion: 1 as const,
    catalogDigest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries
  };
}
