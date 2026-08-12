import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../src/main/database/connection";
import {
  enqueueWebsitePrintAck,
  applyWebsiteTransitionResults,
  claimWebsiteInitialKotPrint,
  finishWebsiteInitialKotPrint,
  getWebsiteOrderDetail,
  importClaimedWebsiteOrderSnapshot,
  importWebsiteOrderSnapshots,
  listPendingWebsiteOutbox,
  listWebsiteOrders,
  queueWebsiteOrderLifecycleForPosOrder,
  queueWebsiteOrderPrint
} from "../src/main/domain/websiteOrders";
import { settleOrder } from "../src/main/domain/orders";
import { markPrintJobFailed, markPrintJobPrinted } from "../src/main/services/printQueue";
import { applyWebsiteMenuContract } from "../src/main/domain/websiteMenuContract";
import { WebsiteOrderSyncService, type WebsiteOrderSyncTransport } from "../src/main/services/websiteOrderSync";
import { mapSyncedWebsiteOrder } from "../src/main/services/websiteOrderHttpTransport";
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

describe("website order mirror", () => {
  it("maps the authoritative website sync payload into a print-only local projection", () => {
    const mapped = mapSyncedWebsiteOrder(rawSyncedOrder(publicMenuId));
    expect(mapped).toMatchObject({
      status: "accepted",
      isTest: true,
      subtotal: 250,
      total: 275,
      items: [{
        menuItemPublicId: publicMenuId,
        unitPrice: 250,
        note: "No chilli | Options: Sauce: Tartar"
      }]
    });

    expect(importWebsiteOrderSnapshots(db, [mapped])).toMatchObject({ inserted: 1 });
    const batch = queueWebsiteOrderPrint(db, mapped.remoteId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    const kitchen = batch.jobs.find((job) => job.kind === "kitchen_copy");
    expect(kitchen).toBeTruthy();
    const content = db.prepare("SELECT content FROM print_jobs WHERE id = ?").get(kitchen!.id) as { content: string };
    expect(content.content).toContain("Options: Sauce: Tartar");
  });

  it("keeps a website-admin manual line printable without creating a POS menu mapping", () => {
    const raw = rawSyncedOrder(publicMenuId);
    const manual = {
      ...raw,
      items: raw.items.map((item) => ({
        ...item,
        source_item_id: null,
        source_item_public_key: null,
        source_item_slug: null,
        name_en: "Manager-added sauce",
        name_bn: "Manager-added sauce",
        modifiers: []
      }))
    };
    const mapped = mapSyncedWebsiteOrder(manual);

    expect(mapped.items[0].menuItemPublicId).toMatch(/^manual_/);
    expect(importWebsiteOrderSnapshots(db, [mapped])).toMatchObject({ inserted: 1 });
    expect(getWebsiteOrderDetail(db, mapped.remoteId).items[0]).toMatchObject({
      mapped: false,
      name: "Manager-added sauce"
    });
    expect(() => queueWebsiteOrderPrint(db, mapped.remoteId)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
  });

  it("imports full, versioned website snapshots idempotently and updates a local projection after acceptance", () => {
    const pending = snapshot();
    expect(importWebsiteOrderSnapshots(db, [pending])).toEqual({ inserted: 1, updated: 0, unchanged: 0, ignoredStale: 0 });
    expect(importWebsiteOrderSnapshots(db, [pending])).toEqual({ inserted: 0, updated: 0, unchanged: 1, ignoredStale: 0 });

    const accepted = {
      ...pending,
      remoteVersion: 2,
      status: "accepted" as const,
      deliveryNote: "Gate is on the left",
      remoteUpdatedAt: "2026-08-05T05:05:00.000Z"
    };
    expect(importWebsiteOrderSnapshots(db, [accepted])).toEqual({ inserted: 0, updated: 1, unchanged: 0, ignoredStale: 0 });
    expect(getWebsiteOrderDetail(db, accepted.remoteId)).toMatchObject({
      status: "accepted",
      remoteVersion: 2,
      deliveryNote: "Gate is on the left"
    });
    expect(listWebsiteOrders(db, ["accepted"])).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
  });

  it("transactionally imports an accepted website order into normal Open Orders exactly once", () => {
    const accepted = snapshot({ status: "accepted", remoteVersion: 2 });

    const first = importClaimedWebsiteOrderSnapshot(db, accepted);
    const second = importClaimedWebsiteOrderSnapshot(db, accepted);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      source: "website",
      externalOrderId: accepted.orderCode,
      status: "kitchen_sent",
      subtotal: 250,
      deliveryFee: 25,
      discount: 0,
      total: 275,
      isTest: true,
      websiteInitialKotState: "queued"
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE source = 'website'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id = ?").get(first.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM website_initial_kots WHERE pos_order_id = ?").get(first.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE type = 'kot'").get()).toEqual({ count: 1 });
    expect(getWebsiteOrderDetail(db, accepted.remoteId).posOrderId).toBe(first.id);
  });

  it("locks workflow after an initial KOT failure and unlocks only after the same job succeeds", () => {
    const accepted = snapshot({ status: "accepted", remoteVersion: 2 });
    const order = importClaimedWebsiteOrderSnapshot(db, accepted);

    const firstClaim = claimWebsiteInitialKotPrint(db, accepted.remoteId);
    expect(firstClaim).toMatchObject({ orderId: order.id, state: "printing" });
    expect(claimWebsiteInitialKotPrint(db, accepted.remoteId)).toBeNull();
    markPrintJobFailed(db, firstClaim!.printJobId, "PRINTER_OFFLINE");
    expect(finishWebsiteInitialKotPrint(db, firstClaim!.printJobId, false)).toMatchObject({
      state: "awaiting_retry",
      printJobId: firstClaim!.printJobId
    });
    expect(() => settleOrder(db, order.id, "cash")).toThrow(/Awaiting KOT/i);

    const retryClaim = claimWebsiteInitialKotPrint(db, accepted.remoteId, true);
    expect(retryClaim?.printJobId).toBe(firstClaim!.printJobId);
    markPrintJobPrinted(db, retryClaim!.printJobId);
    expect(finishWebsiteInitialKotPrint(db, retryClaim!.printJobId, true)).toMatchObject({
      state: "confirmed",
      printJobId: firstClaim!.printJobId
    });
    expect(settleOrder(db, order.id, "cash")).toMatchObject({ status: "settled" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM website_initial_kots").get()).toEqual({ count: 1 });
  });

  it("rolls back local acceptance when any website item is not reconciled", () => {
    const accepted = snapshot({
      status: "accepted",
      remoteVersion: 2,
      items: [{
        remoteItemId: "web-item-unmapped",
        menuItemPublicId: "menu_item_not_mapped",
        name: "Unknown item",
        quantity: 1,
        unitPrice: 250,
        note: null
      }]
    });

    expect(() => importClaimedWebsiteOrderSnapshot(db, accepted)).toThrow(/reconciled/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE source = 'website'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM website_orders WHERE remote_id = ?").get(accepted.remoteId)).toEqual({ count: 0 });
  });

  it("retains synced website order records and refuses direct deletion", () => {
    const order = snapshot();
    importWebsiteOrderSnapshots(db, [order]);

    expect(() => db.prepare("DELETE FROM website_orders WHERE remote_id = ?").run(order.remoteId)).toThrow(
      "Orders cannot be deleted",
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM website_orders WHERE remote_id = ?").get(order.remoteId)).toEqual({ count: 1 });
  });

  it("creates local KOT and delivery-copy jobs from an approved snapshot without creating or mutating a POS order", () => {
    const order = snapshot({ status: "accepted", isTest: false });
    importWebsiteOrderSnapshots(db, [order]);

    const batch = queueWebsiteOrderPrint(db, order.remoteId);
    expect(batch.jobs).toHaveLength(2);
    expect(batch.jobs.map((job) => job.kind).sort()).toEqual(["customer_receipt", "kitchen_copy"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT type, COUNT(*) AS count FROM print_jobs GROUP BY type ORDER BY type").all()).toEqual([
      { type: "kot", count: 1 },
      { type: "parcel_slip", count: 1 }
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM website_order_prints").get()).toEqual({ count: 2 });

    const kitchen = batch.jobs.find((job) => job.kind === "kitchen_copy");
    const receipt = batch.jobs.find((job) => job.kind === "customer_receipt");
    expect(kitchen).toBeTruthy();
    expect(receipt).toBeTruthy();
    const kitchenContent = db.prepare("SELECT content FROM print_jobs WHERE id = ?").get(kitchen!.id) as { content: string };
    const receiptContent = db.prepare("SELECT content FROM print_jobs WHERE id = ?").get(receipt!.id) as { content: string };
    expect(kitchenContent.content).toContain("KITCHEN COPY");
    expect(kitchenContent.content).not.toContain(order.customerPhone);
    expect(receiptContent.content).toContain("DELIVERY DETAILS");
    expect(receiptContent.content).toContain(order.customerPhone);

    enqueueWebsitePrintAck(db, kitchen!.id, true);
    enqueueWebsitePrintAck(db, receipt!.id, false);
    expect(listPendingWebsiteOutbox(db).map((event) => event.eventType)).toEqual(["print.ack", "print.ack"]);
    expect(listPendingWebsiteOutbox(db).map((event) => event.payload)).toEqual([
      { kind: "kitchen_copy", succeeded: true, errorCode: null },
      { kind: "customer_receipt", succeeded: false, errorCode: "LOCAL_PRINT_FAILED" }
    ]);
  });

  it("allows a delivered order to be reprinted from the newest website version", () => {
    const accepted = snapshot({ status: "accepted", remoteVersion: 1 });
    importWebsiteOrderSnapshots(db, [accepted]);
    queueWebsiteOrderPrint(db, accepted.remoteId, "customer_receipt");

    const delivered = {
      ...accepted,
      remoteVersion: 2,
      status: "delivered" as const,
      discount: 20,
      total: 255,
      remoteUpdatedAt: "2026-08-05T05:30:00.000Z"
    };
    expect(importWebsiteOrderSnapshots(db, [delivered])).toEqual({ inserted: 0, updated: 1, unchanged: 0, ignoredStale: 0 });
    const batch = queueWebsiteOrderPrint(db, delivered.remoteId, "customer_receipt");
    const content = db.prepare("SELECT content FROM print_jobs WHERE id = ?").get(batch.jobs[0].id) as { content: string };
    expect(getWebsiteOrderDetail(db, delivered.remoteId)).toMatchObject({ status: "delivered", remoteVersion: 2, total: 255 });
    expect(listWebsiteOrders(db, ["delivered"])).toMatchObject([{ remoteId: delivered.remoteId, status: "delivered", total: 255 }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    expect(content.content).toContain("DISCOUNT: -20 TK");
    expect(content.content).toContain("TOTAL: 255 TK");
  });

  it("never prints an order that Website Admin has not approved or has closed without delivery", () => {
    for (const status of ["pending", "rejected", "cancelled"] as const) {
      const order = snapshot({ remoteId: `web-${status}`, orderCode: `WEB-${status}`, status });
      importWebsiteOrderSnapshots(db, [order]);
      expect(() => queueWebsiteOrderPrint(db, order.remoteId)).toThrow(/not approved/i);
    }
  });

  it("keeps transport work behind a mockable, read-only main-process sync boundary", async () => {
    const accepted = snapshot({ remoteId: "web-sync-1", orderCode: "WEB-SYNC-1", status: "accepted", isTest: false });
    const delivered = {
      ...accepted,
      remoteVersion: 2,
      status: "delivered" as const,
      remoteUpdatedAt: "2026-08-05T05:35:00.000Z"
    };
    let pullCount = 0;
    const transport: WebsiteOrderSyncTransport = {
      pullOrders: async () => ({ orders: pullCount++ === 0 ? [accepted] : [delivered], nextCursor: "cursor-1" }),
      acceptOrder: async () => accepted,
      pushEvents: async (events) => ({ acceptedEventIds: events.map((event) => event.id) })
    };
    const service = new WebsiteOrderSyncService(db, transport);
    expect(await service.syncOnce()).toMatchObject({ inserted: 1, pushed: 0, cursor: "cursor-1" });
    expect(await service.syncOnce()).toMatchObject({ updated: 1, pushed: 0, cursor: "cursor-1" });
    expect(getWebsiteOrderDetail(db, accepted.remoteId)).toMatchObject({ status: "delivered", remoteVersion: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE source = 'website'").get()).toEqual({ count: 1 });
    expect(listPendingWebsiteOutbox(db)).toHaveLength(0);
  });

  it("queues offline lifecycle steps monotonically, de-duplicates them, and applies signed acknowledgements", () => {
    const accepted = snapshot({
      remoteId: "web-lifecycle-1",
      orderCode: "WEB-LIFECYCLE-1",
      status: "accepted",
      remoteVersion: 2
    });
    const local = importClaimedWebsiteOrderSnapshot(db, accepted);

    expect(queueWebsiteOrderLifecycleForPosOrder(
      db,
      local.id,
      "ready",
      "Kitchen workflow advanced"
    )).toBe(2);
    expect(queueWebsiteOrderLifecycleForPosOrder(
      db,
      local.id,
      "ready",
      "Duplicate click"
    )).toBe(0);

    const events = listPendingWebsiteOutbox(db).filter(
      (event) => event.eventType === "order.transition"
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload)).toEqual([
      { toStatus: "preparing", expectedVersion: 2, note: "Kitchen workflow advanced" },
      { toStatus: "ready", expectedVersion: 3, note: "Kitchen workflow advanced" }
    ]);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(2);

    applyWebsiteTransitionResults(db, events.map((event, index) => ({
      eventId: event.id,
      remoteOrderId: event.remoteOrderId,
      status: index === 0 ? "preparing" : "ready",
      remoteVersion: index + 3
    })));
    expect(getWebsiteOrderDetail(db, accepted.remoteId)).toMatchObject({
      status: "accepted",
      remoteVersion: 2
    });

    expect(queueWebsiteOrderLifecycleForPosOrder(
      db,
      local.id,
      "cancelled",
      "Customer cancellation confirmed"
    )).toBe(1);
    const cancellation = listPendingWebsiteOutbox(db).at(-1);
    expect(cancellation?.payload).toEqual({
      toStatus: "cancelled",
      expectedVersion: 4,
      note: "Customer cancellation confirmed"
    });

    const ready = {
      ...accepted,
      status: "ready" as const,
      remoteVersion: 4,
      remoteUpdatedAt: "2026-08-05T05:10:00.000Z"
    };
    expect(importWebsiteOrderSnapshots(db, [ready])).toMatchObject({ updated: 1 });
    expect(getWebsiteOrderDetail(db, accepted.remoteId)).toMatchObject({
      status: "ready",
      remoteVersion: 4
    });
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

function rawSyncedOrder(sourceItemPublicKey: string) {
  return {
    order_id: "5c22a034-5ca7-4f2c-9127-4b1ddde4f3c9",
    order_reference: "YZ-20260809-00000001",
    mode: "test",
    status: "accepted",
    version: 2,
    locale: "en",
    subtotal_minor: 25_000,
    discount_minor: 0,
    delivery_fee_minor: 2_500,
    grand_total_minor: 27_500,
    currency_code: "BDT",
    customer_note: "Gate is on the left",
    placed_at: "2026-08-09T04:00:00.000Z",
    accepted_at: "2026-08-09T04:01:00.000Z",
    completed_at: null,
    cancelled_at: null,
    archived_at: null,
    updated_at: "2026-08-09T04:01:00.000Z",
    contact: {
      full_name: "Test Customer",
      phone_e164: "+8801712345678",
      sector_number: 11,
      road_number: "20",
      house_number: "80",
      flat_number: "4B"
    },
    items: [{
      id: "268b3bd9-9ac0-4980-ae9b-9b493319fc66",
      source_item_id: "6b27a59c-d64a-4f50-a37e-346ad947099f",
      source_item_public_key: sourceItemPublicKey,
      source_item_slug: "website-momo",
      name_en: "Website Momo",
      name_bn: "Website Momo",
      quantity: 1,
      unit_price_minor: 25_000,
      modifier_unit_total_minor: 0,
      effective_unit_price_minor: 25_000,
      line_total_minor: 25_000,
      customer_note: "No chilli",
      modifiers: [{
        source_option_id: null,
        group_name_en: "Sauce",
        group_name_bn: "Sauce",
        option_name_en: "Tartar",
        option_name_bn: "Tartar",
        price_delta_minor: 0
      }]
    }]
  };
}
