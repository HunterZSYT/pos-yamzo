import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WebsiteOrderDetail,
  WebsiteOrderItem,
  WebsiteOrderPrintBatch,
  WebsiteOrderPrintJob,
  WebsiteOrderPrintKind,
  WebsiteOrderSnapshot,
  WebsiteOrderStatus,
  WebsiteOrderSummary,
  WebsiteOutboxEvent
} from "../../shared/types.js";
import { enqueuePrintJob } from "../services/printQueue.js";
import { getPrinterName } from "../services/settings.js";
import {
  getActiveWebsiteMenuMappings,
  resolveWebsiteMenuItemId
} from "./websiteMenuContract.js";

const MAX_BATCH_SIZE = 100;
const REMOTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHONE_PATTERN = /^\+?\d{10,15}$/;

const WEBSITE_ORDER_STATUSES: readonly WebsiteOrderStatus[] = [
  "pending",
  "accepted",
  "preparing",
  "ready",
  "out_for_delivery",
  "delivered",
  "rejected",
  "cancelled"
];

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

/**
 * Queues local, printable snapshots only. Status and item data remain owned by
 * Website Admin; no POS order, inventory movement, payment, or remote status
 * event is created here.
 */
export function queueWebsiteOrderPrint(
  db: Database.Database,
  remoteId: string,
  kind: WebsiteOrderPrintKind | "both" = "both"
): WebsiteOrderPrintBatch {
  const cleanId = cleanRemoteId(remoteId);
  if (kind !== "both" && kind !== "kitchen_copy" && kind !== "customer_receipt") {
    throw new Error("Website print copy is invalid.");
  }

  const tx = db.transaction((): WebsiteOrderPrintBatch => {
    const order = getWebsiteOrderDetail(db, cleanId);
    if (!isPrintableWebsiteOrderStatus(order.status)) {
      throw new Error("This website order is not approved for printing yet.");
    }

    const printer = getPrinterName(db) || null;
    const jobs: WebsiteOrderPrintJob[] = [];
    const create = (copy: WebsiteOrderPrintKind, type: "kot" | "parcel_slip", content: string): void => {
      const id = enqueuePrintJob(db, type, content, printer);
      db.prepare(
        `INSERT INTO website_order_prints (website_order_id, print_job_id, kind, remote_version)
         VALUES (?, ?, ?, ?)`
      ).run(cleanId, id, copy, order.remoteVersion);
      db.prepare(
        `UPDATE website_orders
         SET ${copy === "kitchen_copy" ? "kitchen_print_job_id" : "delivery_print_job_id"} = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE remote_id = ?`
      ).run(id, cleanId);
      jobs.push({ id, kind: copy });
    };

    if (kind === "both" || kind === "kitchen_copy") {
      create("kitchen_copy", "kot", buildWebsiteKitchenCopy(order));
    }
    if (kind === "both" || kind === "customer_receipt") {
      create("customer_receipt", "parcel_slip", buildWebsiteCustomerReceipt(order));
    }

    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('website_order_print_queued', 'website_order', ?, ?)"
    ).run(cleanId, JSON.stringify({ orderCode: order.orderCode, copies: jobs.map((job) => job.kind), remoteVersion: order.remoteVersion }));

    return { websiteOrder: order, jobs };
  });
  return tx();
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
  if (!isWebsiteOrderStatus(value.status)) throw new Error(`Website order ${orderCode} has an invalid incoming status.`);
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
    // Website-admin edits can carry a compact modifier summary for printing.
    // It never changes POS inventory/menu data, and stays bounded before being
    // written to the local mirror.
    note: cleanOptional(item.note, 12_000)
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

function buildWebsiteKitchenCopy(order: WebsiteOrderDetail): string {
  return [
    "YAMZO UTTARA",
    order.isTest ? "TEST WEBSITE ORDER" : "WEBSITE ORDER",
    "KITCHEN COPY",
    "----------------------------------------",
    `ORDER: ${order.orderCode}`,
    `STATUS: ${formatStatus(order.status).toUpperCase()}`,
    `PLACED: ${formatPrintTimestamp(order.remoteCreatedAt)}`,
    "----------------------------------------",
    ...order.items.flatMap((item) => [
      `${item.quantity} x ${item.name}`,
      item.note ? `  Note: ${item.note}` : ""
    ]),
    "----------------------------------------",
    order.isTest ? "*** TEST ORDER - DO NOT COUNT ***" : ""
  ].filter(Boolean).join("\n");
}

function buildWebsiteCustomerReceipt(order: WebsiteOrderDetail): string {
  return [
    "YAMZO UTTARA",
    order.isTest ? "TEST WEBSITE DELIVERY" : "WEBSITE DELIVERY",
    "----------------------------------------",
    `ORDER: ${order.orderCode}`,
    `STATUS: ${formatStatus(order.status).toUpperCase()}`,
    `PLACED: ${formatPrintTimestamp(order.remoteCreatedAt)}`,
    "----------------------------------------",
    ...order.items.flatMap((item) => [
      `${item.quantity} x ${item.name}`,
      `${formatTaka(item.quantity * item.unitPrice)}${item.note ? `  (${item.note})` : ""}`
    ]),
    "----------------------------------------",
    `SUBTOTAL: ${formatTaka(order.subtotal)}`,
    order.deliveryFee > 0 ? `DELIVERY: ${formatTaka(order.deliveryFee)}` : "",
    order.discount > 0 ? `DISCOUNT: -${formatTaka(order.discount)}` : "",
    `TOTAL: ${formatTaka(order.total)}`,
    "----------------------------------------",
    "DELIVERY DETAILS",
    `Customer: ${order.customerName}`,
    `Phone: ${order.customerPhone}`,
    `Address: Flat ${order.address.flat}, House ${order.address.house}, Road ${order.address.road}, Sector ${order.address.sector}`,
    order.deliveryNote ? `Note: ${order.deliveryNote}` : "",
    order.isTest ? "*** TEST ORDER - DO NOT COUNT ***" : ""
  ].filter(Boolean).join("\n");
}

export function enqueueWebsitePrintAck(
  db: Database.Database,
  printJobId: number,
  succeeded: boolean
): void {
  if (!Number.isInteger(printJobId) || printJobId < 1) return;
  const projectionOwner = db.prepare(
    `SELECT website_order_id AS remote_id, kind
     FROM website_order_prints
     WHERE print_job_id = ?
     LIMIT 1`
  ).get(printJobId) as {
    remote_id: string;
    kind: WebsiteOrderPrintKind;
  } | undefined;
  const legacyOwner = projectionOwner ? undefined : db.prepare(
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
    kind: WebsiteOrderPrintKind | null;
  } | undefined;
  const owner = projectionOwner ?? legacyOwner;
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
  return WEBSITE_ORDER_STATUSES.includes(value as WebsiteOrderStatus);
}

function isPrintableWebsiteOrderStatus(status: WebsiteOrderStatus): boolean {
  return status === "accepted"
    || status === "preparing"
    || status === "ready"
    || status === "out_for_delivery"
    || status === "delivered";
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

function formatTaka(value: number): string {
  return `${value.toLocaleString("en-BD")} TK`;
}

function formatPrintTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("en-BD", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" }).format(timestamp)
    : value;
}
