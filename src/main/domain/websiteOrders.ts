import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WebsiteOrderAcceptance,
  WebsiteOrderDetail,
  WebsiteOrderItem,
  WebsiteOrderSnapshot,
  WebsiteOrderStatus,
  WebsiteOrderSummary,
  WebsiteOutboxEvent
} from "../../shared/types.js";
import {
  addOrderItem,
  applyDiscount,
  createOrder,
  deleteOrder,
  getOrderSummary,
  markKitchenDelivered,
  settleOrder,
  sendNewItemsToKitchen
} from "./orders.js";
import { enqueuePrintJob } from "../services/printQueue.js";
import { buildReceipt } from "../services/receipts.js";
import { getBrandingSettings, getPrinterName } from "../services/settings.js";
import {
  getActiveWebsiteMenuMappings,
  resolveWebsiteMenuItemId
} from "./websiteMenuContract.js";

const MAX_BATCH_SIZE = 100;
const REMOTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHONE_PATTERN = /^\+?\d{10,15}$/;

const ALLOWED_TRANSITIONS: Record<WebsiteOrderStatus, readonly WebsiteOrderStatus[]> = {
  pending: ["rejected", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["out_for_delivery", "delivered", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  delivered: [],
  rejected: [],
  cancelled: []
};

interface WebsiteOrderRow {
  remote_id: string;
  order_code: string;
  remote_version: number;
  payload_hash: string;
  status: WebsiteOrderStatus;
  customer_name: string;
  customer_phone: string;
  sector: string;
  road: string;
  house: string;
  flat: string;
  delivery_note: string | null;
  subtotal: number;
  delivery_fee: number;
  discount: number;
  total: number;
  is_test: number;
  pos_order_id: number | null;
  kitchen_print_job_id: number | null;
  delivery_print_job_id: number | null;
  rejection_reason: string | null;
  remote_created_at: string;
  received_at: string;
  updated_at: string;
}

export interface WebsiteOrderImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
  ignoredStale: number;
}

export function importWebsiteOrderSnapshots(
  db: Database.Database,
  snapshots: WebsiteOrderSnapshot[]
): WebsiteOrderImportResult {
  if (!Array.isArray(snapshots) || snapshots.length > MAX_BATCH_SIZE) {
    throw new Error(`Website order sync accepts at most ${MAX_BATCH_SIZE} orders per batch.`);
  }
  const normalized = snapshots.map(normalizeSnapshot);
  const duplicateIds = normalized.filter((order, index) => normalized.findIndex((candidate) => candidate.remoteId === order.remoteId) !== index);
  if (duplicateIds.length > 0) throw new Error("A website order sync batch cannot contain duplicate order IDs.");

  const result: WebsiteOrderImportResult = { inserted: 0, updated: 0, unchanged: 0, ignoredStale: 0 };
  const tx = db.transaction(() => {
    for (const snapshot of normalized) {
      const payloadHash = snapshotHash(snapshot);
      const existing = db.prepare(
        "SELECT remote_version, payload_hash, status, pos_order_id FROM website_orders WHERE remote_id = ?"
      ).get(snapshot.remoteId) as {
        remote_version: number;
        payload_hash: string;
        status: WebsiteOrderStatus;
        pos_order_id: number | null;
      } | undefined;

      if (existing && snapshot.remoteVersion < existing.remote_version) {
        result.ignoredStale += 1;
        continue;
      }
      if (existing && snapshot.remoteVersion === existing.remote_version) {
        if (payloadHash !== existing.payload_hash) {
          throw new Error(`Website order ${snapshot.orderCode} reused version ${snapshot.remoteVersion} with different data.`);
        }
        result.unchanged += 1;
        continue;
      }
      if (existing && (existing.pos_order_id || existing.status !== "pending")) {
        result.ignoredStale += 1;
        continue;
      }

      if (existing) {
        updateWebsiteOrderSnapshot(db, snapshot, payloadHash);
        db.prepare("DELETE FROM website_order_items WHERE website_order_id = ?").run(snapshot.remoteId);
        result.updated += 1;
      } else {
        insertWebsiteOrderSnapshot(db, snapshot, payloadHash);
        result.inserted += 1;
      }
      insertWebsiteOrderItems(db, snapshot);
    }
  });
  tx();
  return result;
}

export function listWebsiteOrders(
  db: Database.Database,
  statuses?: WebsiteOrderStatus[]
): WebsiteOrderSummary[] {
  const cleanStatuses = Array.from(new Set(statuses ?? [])).filter(isWebsiteOrderStatus);
  const rows = cleanStatuses.length > 0
    ? db.prepare(
        `SELECT * FROM website_orders WHERE status IN (${cleanStatuses.map(() => "?").join(",")})
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 WHEN 'preparing' THEN 2 ELSE 3 END,
                  datetime(received_at) DESC, remote_id`
      ).all(...cleanStatuses) as WebsiteOrderRow[]
    : db.prepare(
        `SELECT * FROM website_orders
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 WHEN 'preparing' THEN 2 ELSE 3 END,
                  datetime(received_at) DESC, remote_id LIMIT 250`
      ).all() as WebsiteOrderRow[];
  return rows.map((row) => toWebsiteOrderSummary(db, row));
}

export function getWebsiteOrderDetail(db: Database.Database, remoteId: string): WebsiteOrderDetail {
  const row = db.prepare("SELECT * FROM website_orders WHERE remote_id = ?").get(cleanRemoteId(remoteId)) as WebsiteOrderRow | undefined;
  if (!row) throw new Error("Website order not found.");
  const items = db.prepare(
    `SELECT id, remote_item_id, menu_item_public_id, menu_item_id, name, quantity, unit_price, note
     FROM website_order_items WHERE website_order_id = ? ORDER BY sort_order, id`
  ).all(row.remote_id).map((value) => {
    const item = value as {
      id: number;
      remote_item_id: string;
      menu_item_public_id: string;
      menu_item_id: number | null;
      name: string;
      quantity: number;
      unit_price: number;
      note: string | null;
    };
    return {
      id: item.id,
      remoteItemId: item.remote_item_id,
      menuItemPublicId: item.menu_item_public_id,
      menuItemId: item.menu_item_id,
      mapped: item.menu_item_id !== null,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      note: item.note
    } satisfies WebsiteOrderItem;
  });
  return {
    ...toWebsiteOrderSummary(db, row, items),
    address: { sector: row.sector, road: row.road, house: row.house, flat: row.flat },
    deliveryNote: row.delivery_note,
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    discount: row.discount,
    rejectionReason: row.rejection_reason,
    items
  };
}

export function acceptWebsiteOrder(db: Database.Database, remoteId: string): WebsiteOrderAcceptance {
  const cleanId = cleanRemoteId(remoteId);
  const tx = db.transaction((): WebsiteOrderAcceptance => {
    reconcileWebsiteOrderItemMappings(db, cleanId);
    const existing = getWebsiteOrderDetail(db, cleanId);
    if (existing.posOrderId) {
      const row = db.prepare(
        "SELECT kitchen_print_job_id, delivery_print_job_id FROM website_orders WHERE remote_id = ?"
      ).get(cleanId) as { kitchen_print_job_id: number | null; delivery_print_job_id: number | null };
      if (!row.kitchen_print_job_id || !row.delivery_print_job_id) {
        throw new Error("Accepted website order is missing its durable print jobs. Review the order before retrying.");
      }
      return {
        websiteOrder: existing,
        posOrder: getOrderSummary(db, existing.posOrderId),
        kitchenPrintJobId: row.kitchen_print_job_id,
        deliveryPrintJobId: row.delivery_print_job_id,
        alreadyAccepted: true
      };
    }
    if (existing.status !== "pending") throw new Error("Only pending website orders can be accepted.");
    if (existing.items.some((item) => !item.mapped || !item.menuItemId)) {
      throw new Error("Map every website item to an active POS menu item before accepting this order.");
    }
    const availableItems = db.prepare(
      `SELECT id FROM menu_items
       WHERE id IN (${existing.items.map(() => "?").join(",")}) AND available = 1 AND archived = 0`
    ).all(...existing.items.map((item) => item.menuItemId)) as Array<{ id: number }>;
    const availableItemIds = new Set(availableItems.map((item) => item.id));
    if (existing.items.some((item) => !item.menuItemId || !availableItemIds.has(item.menuItemId))) {
      throw new Error("One or more website items are unavailable in the POS menu.");
    }

    const order = createOrder(db, {
      source: "website",
      externalOrderId: existing.remoteId,
      note: websiteOrderNote(existing),
      deliveryFee: existing.deliveryFee,
      isTest: existing.isTest
    });
    for (const item of existing.items) {
      const orderItemId = addOrderItem(db, order.id, {
        menuItemId: item.menuItemId!,
        quantity: item.quantity,
        note: item.note ?? undefined,
        parcel: true
      });
      db.prepare("UPDATE order_items SET unit_price = ? WHERE id = ?").run(item.unitPrice, orderItemId);
    }
    applyDiscount(db, order.id, existing.discount);
    const kitchenPrintJobId = sendNewItemsToKitchen(db, order.id, true);
    if (!kitchenPrintJobId) throw new Error("Website order did not create a kitchen print job.");
    const slip = buildWebsiteDeliverySlip(db, order.id, existing);
    const deliveryPrintJobId = enqueuePrintJob(db, "parcel_slip", slip, getPrinterName(db) || null);

    const updated = db.prepare(
      `UPDATE website_orders
       SET status = 'accepted', pos_order_id = ?, kitchen_print_job_id = ?, delivery_print_job_id = ?,
           remote_version = remote_version + 1, accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE remote_id = ? AND status = 'pending' AND pos_order_id IS NULL AND remote_version = ?`
    ).run(order.id, kitchenPrintJobId, deliveryPrintJobId, cleanId, existing.remoteVersion);
    if (updated.changes !== 1) throw new Error("Website order changed while it was being accepted. Refresh and try again.");
    enqueueOutbox(db, cleanId, "order.accepted", {
      fromStatus: "pending_acceptance",
      status: "accepted",
      expectedVersion: existing.remoteVersion,
      posOrderNumber: order.orderNumber,
      isTest: existing.isTest
    });
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('website_order_accepted', 'website_order', ?, ?)"
    ).run(cleanId, JSON.stringify({ orderCode: existing.orderCode, posOrderId: order.id, isTest: existing.isTest }));

    return {
      websiteOrder: getWebsiteOrderDetail(db, cleanId),
      posOrder: getOrderSummary(db, order.id),
      kitchenPrintJobId,
      deliveryPrintJobId,
      alreadyAccepted: false
    };
  });
  return tx();
}

export function rejectWebsiteOrder(db: Database.Database, remoteId: string, reason: string): WebsiteOrderDetail {
  const cleanId = cleanRemoteId(remoteId);
  const cleanReason = cleanRequired("Rejection reason", reason, 300);
  const order = getWebsiteOrderDetail(db, cleanId);
  if (order.status === "rejected") return order;
  if (order.status !== "pending") throw new Error("Only pending website orders can be rejected.");
  const tx = db.transaction(() => {
    const updated = db.prepare(
      `UPDATE website_orders
       SET status = 'rejected', rejection_reason = ?, remote_version = remote_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE remote_id = ? AND status = 'pending' AND remote_version = ?`
    ).run(cleanReason, cleanId, order.remoteVersion);
    if (updated.changes !== 1) throw new Error("Website order changed while it was being rejected. Refresh and try again.");
    enqueueOutbox(db, cleanId, "order.rejected", {
      fromStatus: "pending_acceptance",
      status: "rejected",
      expectedVersion: order.remoteVersion,
      reason: cleanReason,
      isTest: order.isTest
    });
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('website_order_rejected', 'website_order', ?, ?)"
    ).run(cleanId, JSON.stringify({ orderCode: order.orderCode, reason: cleanReason, isTest: order.isTest }));
  });
  tx();
  return getWebsiteOrderDetail(db, cleanId);
}

export function transitionWebsiteOrder(
  db: Database.Database,
  remoteId: string,
  status: Exclude<WebsiteOrderStatus, "pending" | "accepted" | "rejected">
): WebsiteOrderDetail {
  const cleanId = cleanRemoteId(remoteId);
  const order = getWebsiteOrderDetail(db, cleanId);
  if (order.status === status) return order;
  if (!ALLOWED_TRANSITIONS[order.status].includes(status)) {
    throw new Error(`Website order cannot move from ${formatStatus(order.status)} to ${formatStatus(status)}.`);
  }
  const tx = db.transaction(() => {
    applyPosOrderStatus(db, order, status);
    const updated = db.prepare(
      `UPDATE website_orders
       SET status = ?, remote_version = remote_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE remote_id = ? AND status = ? AND remote_version = ?`
    ).run(status, cleanId, order.status, order.remoteVersion);
    if (updated.changes !== 1) throw new Error("Website order changed while its status was updating. Refresh and try again.");
    enqueueOutbox(db, cleanId, `order.${status}`, {
      fromStatus: order.status,
      status,
      expectedVersion: order.remoteVersion,
      isTest: order.isTest
    });
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('website_order_status_changed', 'website_order', ?, ?)"
    ).run(cleanId, JSON.stringify({ orderCode: order.orderCode, from: order.status, to: status, isTest: order.isTest }));
  });
  tx();
  return getWebsiteOrderDetail(db, cleanId);
}

export function hardDeleteTestWebsiteOrder(db: Database.Database, remoteId: string): boolean {
  const cleanId = cleanRemoteId(remoteId);
  const row = db.prepare(
    `SELECT wo.is_test, wo.pos_order_id, wo.kitchen_print_job_id, wo.delivery_print_job_id, wo.order_code,
            o.order_number, o.is_test AS pos_is_test
     FROM website_orders wo LEFT JOIN orders o ON o.id = wo.pos_order_id WHERE wo.remote_id = ?`
  ).get(cleanId) as {
    is_test: number;
    pos_order_id: number | null;
    kitchen_print_job_id: number | null;
    delivery_print_job_id: number | null;
    order_code: string;
    order_number: string | null;
    pos_is_test: number | null;
  } | undefined;
  if (!row) return false;
  if (row.is_test !== 1) throw new Error("Only test website orders can be permanently deleted.");
  if (row.pos_order_id && row.pos_is_test !== 1) {
    throw new Error("Test order safety check failed because the linked POS order is not marked as test data.");
  }

  const tx = db.transaction(() => {
    if (row.pos_order_id) {
      db.prepare("DELETE FROM inventory_adjustments WHERE order_id = ?").run(row.pos_order_id);
      db.prepare("DELETE FROM order_item_cost_snapshots WHERE order_id = ?").run(row.pos_order_id);
      db.prepare("DELETE FROM order_cost_snapshots WHERE order_id = ?").run(row.pos_order_id);
      db.prepare("DELETE FROM payments WHERE order_id = ?").run(row.pos_order_id);
      db.prepare("DELETE FROM kitchen_ticket_items WHERE ticket_id IN (SELECT id FROM kitchen_tickets WHERE order_id = ?)").run(row.pos_order_id);
      db.prepare("DELETE FROM kitchen_tickets WHERE order_id = ?").run(row.pos_order_id);
      db.prepare("DELETE FROM order_items WHERE order_id = ?").run(row.pos_order_id);
    }
    db.prepare("DELETE FROM website_sync_outbox WHERE remote_order_id = ?").run(cleanId);
    db.prepare("DELETE FROM website_orders WHERE remote_id = ?").run(cleanId);
    if (row.pos_order_id) db.prepare("DELETE FROM orders WHERE id = ? AND is_test = 1").run(row.pos_order_id);
    for (const printJobId of [row.kitchen_print_job_id, row.delivery_print_job_id]) {
      if (printJobId) db.prepare("DELETE FROM print_jobs WHERE id = ?").run(printJobId);
    }
    if (row.order_number) {
      const relatedPrintJobIds = (db.prepare("SELECT id, content FROM print_jobs").all() as Array<{ id: number; content: string }>)
        .filter((job) => printContentBelongsToOrder(job.content, row.order_number!))
        .map((job) => job.id);
      if (relatedPrintJobIds.length > 0) {
        db.prepare(`DELETE FROM print_jobs WHERE id IN (${relatedPrintJobIds.map(() => "?").join(",")})`).run(...relatedPrintJobIds);
      }
    }
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('website_test_order_hard_deleted', 'website_order', ?, ?)"
    ).run(cleanId, JSON.stringify({ orderCode: row.order_code, posOrderId: row.pos_order_id }));
  });
  tx();
  return true;
}

export function listPendingWebsiteOutbox(db: Database.Database, limit = 50): WebsiteOutboxEvent[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return (db.prepare(
    `SELECT id, event_key, remote_order_id, event_type, payload_json, attempts, created_at
     FROM website_sync_outbox
     WHERE status IN ('pending', 'failed') AND datetime(available_at) <= CURRENT_TIMESTAMP
     ORDER BY id LIMIT ?`
  ).all(safeLimit) as Array<{
    id: number;
    event_key: string;
    remote_order_id: string;
    event_type: string;
    payload_json: string;
    attempts: number;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    eventKey: row.event_key,
    remoteOrderId: row.remote_order_id,
    eventType: row.event_type,
    payload: parsePayload(row.payload_json),
    attempts: row.attempts,
    createdAt: row.created_at
  }));
}

export function markWebsiteOutboxSent(db: Database.Database, ids: number[]): void {
  const cleanIds = cleanPositiveIds(ids);
  if (cleanIds.length === 0) return;
  db.prepare(
    `UPDATE website_sync_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = NULL,
     updated_at = CURRENT_TIMESTAMP WHERE id IN (${cleanIds.map(() => "?").join(",")})`
  ).run(...cleanIds);
}

export function markWebsiteOutboxFailed(db: Database.Database, ids: number[], error: string): void {
  const cleanIds = cleanPositiveIds(ids);
  if (cleanIds.length === 0) return;
  const message = cleanRequired("Sync error", error, 500);
  db.prepare(
    `UPDATE website_sync_outbox
     SET status = 'failed', attempts = attempts + 1, last_error = ?,
         available_at = datetime(CURRENT_TIMESTAMP, '+' || min(300, (attempts + 1) * 15) || ' seconds'),
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (${cleanIds.map(() => "?").join(",")})`
  ).run(message, ...cleanIds);
}

export function getWebsiteSyncCursor(db: Database.Database, stream = "orders"): string | null {
  const row = db.prepare("SELECT cursor FROM website_sync_cursors WHERE stream = ?").get(cleanStream(stream)) as { cursor: string | null } | undefined;
  return row?.cursor ?? null;
}

export function setWebsiteSyncCursor(db: Database.Database, cursor: string | null, stream = "orders", lastError: string | null = null): void {
  db.prepare(
    `INSERT INTO website_sync_cursors (stream, cursor, last_synced_at, last_error, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(stream) DO UPDATE SET cursor = excluded.cursor, last_synced_at = CURRENT_TIMESTAMP,
       last_error = excluded.last_error, updated_at = CURRENT_TIMESTAMP`
  ).run(cleanStream(stream), cursor?.trim() || null, lastError?.slice(0, 500) || null);
}

function applyPosOrderStatus(
  db: Database.Database,
  order: WebsiteOrderDetail,
  status: Exclude<WebsiteOrderStatus, "pending" | "accepted" | "rejected">
): void {
  if (!order.posOrderId) return;
  const posOrder = getOrderSummary(db, order.posOrderId);
  if (status === "ready") {
    if (posOrder.kitchenStartedAt && !posOrder.kitchenCompletedAt) {
      markKitchenDelivered(db, posOrder.id);
    }
    return;
  }
  if (status === "delivered") {
    if (posOrder.status === "cancelled") {
      throw new Error("A cancelled POS order cannot be marked delivered.");
    }
    if (posOrder.status !== "settled") {
      settleOrder(db, posOrder.id, "cash", posOrder.total);
    }
    return;
  }
  if (status === "cancelled" && posOrder.status !== "cancelled") {
    deleteOrder(db, posOrder.id, `Website order ${order.orderCode} cancelled`);
  }
}

function insertWebsiteOrderSnapshot(db: Database.Database, order: WebsiteOrderSnapshot, payloadHash: string): void {
  db.prepare(
    `INSERT INTO website_orders
      (remote_id, order_code, remote_version, payload_hash, status, customer_name, customer_phone,
       sector, road, house, flat, delivery_note, subtotal, delivery_fee, discount, total, is_test,
       remote_created_at, remote_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    order.remoteId, order.orderCode, order.remoteVersion, payloadHash, order.status, order.customerName,
    order.customerPhone, order.address.sector, order.address.road, order.address.house, order.address.flat,
    order.deliveryNote ?? null, order.subtotal, order.deliveryFee, order.discount, order.total,
    order.isTest ? 1 : 0, order.remoteCreatedAt, order.remoteUpdatedAt
  );
}

function updateWebsiteOrderSnapshot(db: Database.Database, order: WebsiteOrderSnapshot, payloadHash: string): void {
  db.prepare(
    `UPDATE website_orders SET order_code = ?, remote_version = ?, payload_hash = ?, status = ?,
       customer_name = ?, customer_phone = ?, sector = ?, road = ?, house = ?, flat = ?, delivery_note = ?,
       subtotal = ?, delivery_fee = ?, discount = ?, total = ?, is_test = ?, remote_created_at = ?,
       remote_updated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE remote_id = ?`
  ).run(
    order.orderCode, order.remoteVersion, payloadHash, order.status, order.customerName, order.customerPhone,
    order.address.sector, order.address.road, order.address.house, order.address.flat, order.deliveryNote ?? null,
    order.subtotal, order.deliveryFee, order.discount, order.total, order.isTest ? 1 : 0,
    order.remoteCreatedAt, order.remoteUpdatedAt, order.remoteId
  );
}

function insertWebsiteOrderItems(db: Database.Database, order: WebsiteOrderSnapshot): void {
  const mappings = getActiveWebsiteMenuMappings(db);
  const insert = db.prepare(
    `INSERT INTO website_order_items
      (website_order_id, remote_item_id, menu_item_public_id, menu_item_id, name, quantity, unit_price, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  order.items.forEach((item, index) => {
    insert.run(
      order.remoteId, item.remoteItemId, item.menuItemPublicId,
      resolveWebsiteMenuItemId(mappings, item.menuItemPublicId, item.unitPrice), item.name,
      item.quantity, item.unitPrice, item.note ?? null, index
    );
  });
}

function reconcileWebsiteOrderItemMappings(db: Database.Database, remoteId: string): void {
  const mappings = getActiveWebsiteMenuMappings(db);
  const rows = db.prepare(
    `SELECT id, menu_item_public_id, unit_price
     FROM website_order_items
     WHERE website_order_id = ?`
  ).all(remoteId) as Array<{
    id: number;
    menu_item_public_id: string;
    unit_price: number;
  }>;
  const update = db.prepare("UPDATE website_order_items SET menu_item_id = ? WHERE id = ?");
  for (const row of rows) {
    update.run(
      resolveWebsiteMenuItemId(
        mappings,
        row.menu_item_public_id,
        row.unit_price
      ),
      row.id
    );
  }
}

function toWebsiteOrderSummary(
  db: Database.Database,
  row: WebsiteOrderRow,
  loadedItems?: WebsiteOrderItem[]
): WebsiteOrderSummary {
  const items = loadedItems ?? (db.prepare(
    "SELECT name, quantity FROM website_order_items WHERE website_order_id = ? ORDER BY sort_order, id"
  ).all(row.remote_id) as Array<{ name: string; quantity: number }>);
  return {
    remoteId: row.remote_id,
    orderCode: row.order_code,
    remoteVersion: row.remote_version,
    status: row.status,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    total: row.total,
    isTest: row.is_test === 1,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    itemPreview: items.slice(0, 4).map((item) => item.name),
    posOrderId: row.pos_order_id,
    receivedAt: row.received_at,
    remoteCreatedAt: row.remote_created_at,
    updatedAt: row.updated_at
  };
}

function normalizeSnapshot(value: WebsiteOrderSnapshot): WebsiteOrderSnapshot {
  if (!value || typeof value !== "object") throw new Error("Website order payload is invalid.");
  const remoteId = cleanRemoteId(value.remoteId);
  const orderCode = cleanRequired("Order code", value.orderCode, 80);
  const remoteVersion = cleanPositiveInteger("Remote version", value.remoteVersion, 2_147_483_647);
  if (value.status !== "pending" && value.status !== "cancelled") throw new Error(`Website order ${orderCode} has an invalid incoming status.`);
  const customerName = cleanRequired("Customer name", value.customerName, 120);
  const customerPhone = normalizePhone(value.customerPhone);
  const address = {
    sector: cleanRequired("Sector", value.address?.sector, 20),
    road: cleanRequired("Road", value.address?.road, 80),
    house: cleanRequired("House", value.address?.house, 80),
    flat: cleanRequired("Flat", value.address?.flat, 80)
  };
  if (!/^\d+$/.test(address.sector)) throw new Error("Sector must contain numbers only.");
  const items = value.items?.map((item, index) => ({
    remoteItemId: cleanRemoteId(item.remoteItemId),
    menuItemPublicId: cleanRemoteId(item.menuItemPublicId),
    name: cleanRequired(`Item ${index + 1} name`, item.name, 160),
    quantity: cleanPositiveInteger(`Item ${index + 1} quantity`, item.quantity, 99),
    unitPrice: cleanMoney(`Item ${index + 1} price`, item.unitPrice),
    note: cleanOptional(item.note, 300)
  })) ?? [];
  if (items.length === 0 || items.length > 100) throw new Error(`Website order ${orderCode} must contain between 1 and 100 items.`);
  if (new Set(items.map((item) => item.remoteItemId)).size !== items.length) {
    throw new Error(`Website order ${orderCode} contains duplicate item IDs.`);
  }
  const subtotal = cleanMoney("Subtotal", value.subtotal);
  const deliveryFee = cleanMoney("Delivery fee", value.deliveryFee);
  const discount = cleanMoney("Discount", value.discount);
  const total = cleanMoney("Total", value.total);
  const computedSubtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  if (subtotal !== computedSubtotal) throw new Error(`Website order ${orderCode} subtotal does not match its items.`);
  if (discount > subtotal + deliveryFee || total !== subtotal + deliveryFee - discount) {
    throw new Error(`Website order ${orderCode} total is invalid.`);
  }
  return {
    remoteId,
    orderCode,
    remoteVersion,
    status: value.status,
    customerName,
    customerPhone,
    address,
    deliveryNote: cleanOptional(value.deliveryNote, 500),
    subtotal,
    deliveryFee,
    discount,
    total,
    isTest: Boolean(value.isTest),
    remoteCreatedAt: cleanTimestamp("Created time", value.remoteCreatedAt),
    remoteUpdatedAt: cleanTimestamp("Updated time", value.remoteUpdatedAt),
    items
  };
}

function buildWebsiteDeliverySlip(db: Database.Database, orderId: number, order: WebsiteOrderDetail): string {
  const receipt = buildReceipt(db, orderId, getBrandingSettings(db), order.isTest ? "TEST WEBSITE ORDER" : "WEBSITE DELIVERY");
  return [
    receipt,
    "",
    "DELIVERY DETAILS",
    "----------------------------------------",
    `Customer: ${order.customerName}`,
    `Phone: ${order.customerPhone}`,
    `Address: Flat ${order.address.flat}, House ${order.address.house}, Road ${order.address.road}, Sector ${order.address.sector}`,
    order.deliveryNote ? `Note: ${order.deliveryNote}` : "",
    order.deliveryFee > 0 ? `Delivery fee: ${order.deliveryFee} TK` : "",
    order.isTest ? "*** TEST ORDER - EXCLUDED FROM REPORTS ***" : ""
  ].filter(Boolean).join("\n");
}

function websiteOrderNote(order: WebsiteOrderDetail): string {
  const address = `Flat ${order.address.flat}, House ${order.address.house}, Road ${order.address.road}, Sector ${order.address.sector}`;
  return [`Website ${order.orderCode}`, order.customerName, order.customerPhone, address, order.deliveryNote].filter(Boolean).join(" | ");
}

function printContentBelongsToOrder(content: string, orderNumber: string): boolean {
  const marker = `ORDER: ${orderNumber}`;
  return content.split(/\r?\n/).some((line) => {
    const normalizedLine = line.trimStart();
    if (!normalizedLine.startsWith(marker)) return false;
    const boundary = normalizedLine.slice(marker.length, marker.length + 1);
    return boundary === "" || /\s/.test(boundary);
  });
}

export function enqueueWebsitePrintAck(
  db: Database.Database,
  printJobId: number,
  succeeded: boolean
): void {
  if (!Number.isInteger(printJobId) || printJobId < 1) return;
  const owner = db.prepare(
    `SELECT remote_id,
            CASE
              WHEN kitchen_print_job_id = ? THEN 'kitchen_copy'
              WHEN delivery_print_job_id = ? THEN 'customer_receipt'
              ELSE NULL
            END AS kind
     FROM website_orders
     WHERE kitchen_print_job_id = ? OR delivery_print_job_id = ?
     LIMIT 1`
  ).get(printJobId, printJobId, printJobId, printJobId) as {
    remote_id: string;
    kind: "kitchen_copy" | "customer_receipt" | null;
  } | undefined;
  if (!owner?.kind) return;

  enqueueOutbox(
    db,
    owner.remote_id,
    "print.ack",
    {
      kind: owner.kind,
      succeeded,
      errorCode: succeeded ? null : "LOCAL_PRINT_FAILED"
    },
    `${owner.remote_id}:print.ack:${owner.kind}:${succeeded ? "completed" : "failed"}`
  );
}

function enqueueOutbox(
  db: Database.Database,
  remoteOrderId: string,
  eventType: string,
  payload: Record<string, unknown>,
  dedupeKey = `${remoteOrderId}:${eventType}`
): void {
  db.prepare(
    `INSERT OR IGNORE INTO website_sync_outbox
      (event_key, remote_order_id, event_type, payload_json, dedupe_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), remoteOrderId, eventType, JSON.stringify(payload), dedupeKey);
}

function snapshotHash(snapshot: WebsiteOrderSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function cleanRemoteId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!REMOTE_ID_PATTERN.test(id)) throw new Error("Website order ID is invalid.");
  return id;
}

function cleanRequired(label: string, value: unknown, maxLength: number): string {
  const text = normalizeHumanText(value);
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} is too long.`);
  return text;
}

function cleanOptional(value: unknown, maxLength: number): string | null {
  const text = normalizeHumanText(value);
  if (!text) return null;
  if (text.length > maxLength) throw new Error("Website order note is too long.");
  return text;
}

function normalizeHumanText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value: unknown): string {
  const phone = String(value ?? "").trim().replace(/[\s()-]/g, "");
  if (!PHONE_PATTERN.test(phone)) throw new Error("Customer phone number is invalid.");
  return phone;
}

function cleanPositiveInteger(label: string, value: unknown, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${label} is invalid.`);
  return number;
}

function cleanMoney(label: string, value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10_000_000) throw new Error(`${label} is invalid.`);
  return number;
}

function cleanTimestamp(label: string, value: unknown): string {
  const timestamp = String(value ?? "").trim();
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid.`);
  return timestamp;
}

function cleanStream(value: string): string {
  const stream = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,49}$/.test(stream)) throw new Error("Website sync stream is invalid.");
  return stream;
}

function cleanPositiveIds(ids: number[]): number[] {
  return Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0))).slice(0, 100);
}

function isWebsiteOrderStatus(value: string): value is WebsiteOrderStatus {
  return Object.hasOwn(ALLOWED_TRANSITIONS, value);
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(value) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatStatus(value: WebsiteOrderStatus): string {
  return value.replaceAll("_", " ");
}
