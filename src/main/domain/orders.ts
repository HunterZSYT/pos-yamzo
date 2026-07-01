import type Database from "better-sqlite3";
import type { OrderBatch, OrderDetail, OrderItemInput, OrderLine, OrderSource, OrderSummary, PaymentMethod, ReceiptPaymentInfo } from "../../shared/types.js";
import { calculateOrderTotals } from "./pricing.js";
import { enqueuePrintJob } from "../services/printQueue.js";
import { buildAuditCopy, buildKitchenTicket, buildReceipt } from "../services/receipts.js";
import { getBrandingSettings, getMenuTypes, getPrinterName } from "../services/settings.js";
import { createOrderCostSnapshot, reverseOrderCostSnapshot } from "./inventory.js";

export function createOrder(
  db: Database.Database,
  input: { source: OrderSource; tableNumber?: string; note?: string }
): OrderSummary {
  const orderNumber = nextOrderNumber(db);
  const result = db
    .prepare("INSERT INTO orders (order_number, source, table_number, note) VALUES (?, ?, ?, ?)")
    .run(orderNumber, input.source, input.tableNumber ?? null, input.note ?? null);
  return getOrderSummary(db, Number(result.lastInsertRowid));
}

export function addOrderItem(db: Database.Database, orderId: number, input: OrderItemInput): number {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error("Quantity must be a positive whole number.");
  }
  const order = db.prepare("SELECT status, source FROM orders WHERE id = ?").get(orderId) as { status: string; source: string } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (order.status === "settled" || order.status === "cancelled") {
    throw new Error("Cannot add items to a closed order.");
  }
  const item = db.prepare("SELECT id, name, price FROM menu_items WHERE id = ? AND archived = 0").get(input.menuItemId) as
    | { id: number; name: string; price: number }
    | undefined;
  if (!item) {
    throw new Error("Menu item not found.");
  }

  const sourcePrice = db.prepare("SELECT price FROM menu_item_prices WHERE menu_item_id = ? AND menu_type_key = ?").get(item.id, order.source) as { price: number } | undefined;
  const result = db
    .prepare(
      `INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price, note, parcel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(orderId, item.id, item.name, input.quantity, sourcePrice?.price ?? item.price, input.note ?? null, input.parcel ? 1 : 0);
  touchOrder(db, orderId);
  return Number(result.lastInsertRowid);
}

export function sendNewItemsToKitchen(db: Database.Database, orderId: number, allowExternal = false): number | null {
  const order = db.prepare("SELECT source FROM orders WHERE id = ?").get(orderId) as { source: OrderSource } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (!allowExternal && ["foodpanda", "foodie", "other"].includes(order.source)) {
    return null;
  }

  const unsentItems = db
    .prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'active' AND kitchen_sent_at IS NULL")
    .all(orderId) as Array<{ id: number }>;
  if (unsentItems.length === 0) {
    return null;
  }

  const ticketType = hasKitchenTicket(db, orderId) ? "addition_kot" : "kot";
  const itemIds = unsentItems.map((item) => item.id);

  const tx = db.transaction(() => {
    const ticket = db
      .prepare("INSERT INTO kitchen_tickets (order_id, type) VALUES (?, ?)")
      .run(orderId, ticketType);
    const ticketItem = db.prepare(
      "INSERT INTO kitchen_ticket_items (ticket_id, order_item_id, quantity, note) SELECT ?, id, quantity, note FROM order_items WHERE id = ?"
    );
    for (const id of itemIds) {
      ticketItem.run(Number(ticket.lastInsertRowid), id);
    }
    db.prepare("UPDATE order_items SET kitchen_sent_at = CURRENT_TIMESTAMP WHERE id IN (" + itemIds.map(() => "?").join(",") + ")").run(
      ...itemIds
    );
    db.prepare("UPDATE orders SET status = 'kitchen_sent', first_kitchen_sent_at = COALESCE(first_kitchen_sent_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
    const content = buildKitchenTicket(db, orderId, itemIds, ticketType === "addition_kot" ? "Yamzo Addition KOT" : "Yamzo Kitchen Order");
    return enqueuePrintJob(db, ticketType, content, getPrinterName(db) || null);
  });

  return tx();
}

export function voidOrderItem(db: Database.Database, orderItemId: number, reason: string): void {
  if (!reason.trim()) {
    throw new Error("Void reason is required.");
  }
  const item = db.prepare("SELECT order_id FROM order_items WHERE id = ?").get(orderItemId) as { order_id: number } | undefined;
  if (!item) {
    throw new Error("Order item not found.");
  }
  db.prepare("UPDATE order_items SET status = 'voided', void_reason = ? WHERE id = ?").run(reason, orderItemId);
  const content = buildKitchenTicket(db, item.order_id, [orderItemId], `Yamzo Void KOT - ${reason}`);
  enqueuePrintJob(db, "void_kot", content, getPrinterName(db) || null);
  touchOrder(db, item.order_id);
}

export function applyDiscount(db: Database.Database, orderId: number, discount: number): OrderSummary {
  if (!Number.isFinite(discount) || discount < 0) {
    throw new Error("Discount cannot be negative.");
  }
  db.prepare("UPDATE orders SET discount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Math.max(0, discount), orderId);
  return getOrderSummary(db, orderId);
}

export function updateOrderNote(db: Database.Database, orderId: number, note: string): OrderSummary {
  db.prepare("UPDATE orders SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(note.trim() || null, orderId);
  return getOrderSummary(db, orderId);
}

export function updateOrderInfo(
  db: Database.Database,
  orderId: number,
  input: { source: OrderSource; tableNumber?: string | null; note?: string | null }
): OrderSummary {
  assertEditableOrder(db, orderId);
  const menuType = getMenuTypes(db).find((type) => type.key === input.source);
  const tablesEnabled = menuType?.tablesEnabled ?? input.source === "in_house";
  db.prepare("UPDATE orders SET source = ?, table_number = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    input.source,
    tablesEnabled ? input.tableNumber?.trim() || null : null,
    input.note?.trim() || null,
    orderId
  );
  return getOrderSummary(db, orderId);
}

export function updateOrderItem(
  db: Database.Database,
  orderItemId: number,
  input: { quantity: number; note?: string | null; parcel?: boolean }
): OrderDetail {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error("Quantity must be a positive whole number.");
  }
  const item = db.prepare("SELECT order_id FROM order_items WHERE id = ? AND status = 'active'").get(orderItemId) as { order_id: number } | undefined;
  if (!item) {
    throw new Error("Order item not found.");
  }
  assertEditableOrder(db, item.order_id);
  db.prepare("UPDATE order_items SET quantity = ?, note = ?, parcel = ? WHERE id = ?").run(input.quantity, input.note?.trim() || null, input.parcel ? 1 : 0, orderItemId);
  touchOrder(db, item.order_id);
  return getOrderDetail(db, item.order_id);
}

export function removeOrderItem(db: Database.Database, orderItemId: number, reason = "Removed by cashier"): OrderDetail {
  const item = db.prepare("SELECT order_id FROM order_items WHERE id = ? AND status = 'active'").get(orderItemId) as { order_id: number } | undefined;
  if (!item) {
    throw new Error("Order item not found.");
  }
  assertEditableOrder(db, item.order_id);
  db.prepare("UPDATE order_items SET status = 'voided', void_reason = ? WHERE id = ?").run(reason.trim() || "Removed by cashier", orderItemId);
  touchOrder(db, item.order_id);
  return getOrderDetail(db, item.order_id);
}

export function deleteOrder(db: Database.Database, orderId: number, reason = ""): OrderSummary {
  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  const tx = db.transaction(() => {
    if (order.status === "settled") {
      db.prepare("DELETE FROM payments WHERE order_id = ?").run(orderId);
      reverseOrderCostSnapshot(db, orderId);
    }
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('delete_order', 'order', ?, ?)"
    ).run(String(orderId), JSON.stringify({ reason: reason.trim() || null, fromStatus: order.status }));
    db.prepare("UPDATE orders SET status = 'cancelled', settled_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
  });
  tx();
  return getOrderSummary(db, orderId);
}

export function reopenOrder(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (order.status === "open" || order.status === "kitchen_sent") {
    return getOrderSummary(db, orderId);
  }
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payments WHERE order_id = ?").run(orderId);
    reverseOrderCostSnapshot(db, orderId);
    const kitchenStatus = orderHasKitchenPrintedItems(db, orderId) ? "kitchen_sent" : "open";
    db.prepare("UPDATE orders SET status = ?, settled_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(kitchenStatus, orderId);
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('reopen_order', 'order', ?, ?)"
    ).run(String(orderId), JSON.stringify({ fromStatus: order.status }));
  });
  tx();
  return getOrderSummary(db, orderId);
}

export function orderHasKitchenPrintedItems(db: Database.Database, orderId: number): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ? AND kitchen_sent_at IS NOT NULL").get(orderId) as { count: number };
  return row.count > 0;
}

export function markKitchenDelivered(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT first_kitchen_sent_at FROM orders WHERE id = ?").get(orderId) as { first_kitchen_sent_at: string | null } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (!order.first_kitchen_sent_at) {
    throw new Error("Kitchen Copy has not been sent yet.");
  }
  db.prepare("UPDATE kitchen_tickets SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE order_id = ? AND completed_at IS NULL").run(orderId);
  db.prepare("UPDATE orders SET kitchen_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
  return getOrderSummary(db, orderId);
}

export function restartKitchenTimer(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT first_kitchen_sent_at FROM orders WHERE id = ?").get(orderId) as { first_kitchen_sent_at: string | null } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (!order.first_kitchen_sent_at) {
    throw new Error("Kitchen Copy has not been sent yet.");
  }
  db.prepare("UPDATE kitchen_tickets SET completed_at = NULL WHERE order_id = ?").run(orderId);
  db.prepare("UPDATE orders SET kitchen_completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
  return getOrderSummary(db, orderId);
}

export function markKitchenBatchDelivered(db: Database.Database, ticketId: number): OrderSummary {
  const ticket = db.prepare("SELECT order_id FROM kitchen_tickets WHERE id = ?").get(ticketId) as { order_id: number } | undefined;
  if (!ticket) {
    throw new Error("Kitchen batch not found.");
  }
  db.prepare("UPDATE kitchen_tickets SET completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticketId);
  const remaining = db.prepare("SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id = ? AND completed_at IS NULL").get(ticket.order_id) as { count: number };
  if (remaining.count === 0) {
    db.prepare("UPDATE orders SET kitchen_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticket.order_id);
  } else {
    touchOrder(db, ticket.order_id);
  }
  return getOrderSummary(db, ticket.order_id);
}

export function restartKitchenBatchTimer(db: Database.Database, ticketId: number): OrderSummary {
  const ticket = db.prepare("SELECT order_id FROM kitchen_tickets WHERE id = ?").get(ticketId) as { order_id: number } | undefined;
  if (!ticket) {
    throw new Error("Kitchen batch not found.");
  }
  db.prepare("UPDATE kitchen_tickets SET completed_at = NULL WHERE id = ?").run(ticketId);
  db.prepare("UPDATE orders SET kitchen_completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticket.order_id);
  return getOrderSummary(db, ticket.order_id);
}

export function settleOrder(db: Database.Database, orderId: number, method: PaymentMethod, amount?: number, reference?: string, host?: string): OrderSummary {
  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (order.status === "settled" || order.status === "cancelled") {
    throw new Error("Order is already closed.");
  }
  const totals = calculateOrderTotals(db, orderId);
  if (totals.total <= 0) {
    throw new Error("Cannot settle an empty order.");
  }
  const paidAmount = amount ?? totals.total;
  const branding = getBrandingSettings(db);
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO payments (order_id, method, amount) VALUES (?, ?, ?)").run(orderId, method, paidAmount);
    createOrderCostSnapshot(db, orderId);
    db.prepare("UPDATE orders SET status = 'settled', settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
    enqueuePrintJob(db, "receipt", buildReceipt(db, orderId, branding, "RECEIPT", { paid: true, method, amount: paidAmount, reference, host }), getPrinterName(db) || null);
  });
  tx();
  return getOrderSummary(db, orderId);
}

export function getOrderSummary(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as {
    id: number;
    order_number: string;
    source: OrderSource;
    table_number: string | null;
    status: OrderSummary["status"];
    created_at: string;
    updated_at: string;
    first_kitchen_sent_at: string | null;
    kitchen_completed_at: string | null;
  };
  const totals = calculateOrderTotals(db, orderId);
  const itemCount = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS count FROM order_items WHERE order_id = ? AND status = 'active'")
    .get(orderId) as { count: number };
  const itemPreview = db
    .prepare("SELECT name FROM order_items WHERE order_id = ? AND status = 'active' ORDER BY id LIMIT 4")
    .all(orderId)
    .map((row) => (row as { name: string }).name);
  return {
    id: order.id,
    orderNumber: order.order_number,
    source: order.source,
    tableNumber: order.table_number,
    status: order.status,
    subtotal: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    kitchenStartedAt: order.first_kitchen_sent_at,
    kitchenCompletedAt: order.kitchen_completed_at,
    itemCount: itemCount.count,
    itemPreview,
    batches: listOrderBatches(db, orderId)
  };
}

export function getOrderDetail(db: Database.Database, orderId: number): OrderDetail {
  const order = db.prepare("SELECT note FROM orders WHERE id = ?").get(orderId) as { note: string | null } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  return {
    ...getOrderSummary(db, orderId),
    note: order.note,
    items: listOrderItems(db, orderId)
  };
}

export function listOpenOrders(db: Database.Database): OrderSummary[] {
  const rows = db.prepare("SELECT id FROM orders WHERE status IN ('open', 'kitchen_sent') ORDER BY created_at DESC").all() as Array<{ id: number }>;
  return rows.map((row) => getOrderSummary(db, row.id));
}

export function listOrderHistory(db: Database.Database): OrderSummary[] {
  const rows = db.prepare("SELECT id FROM orders WHERE status IN ('settled', 'cancelled') ORDER BY updated_at DESC LIMIT 200").all() as Array<{ id: number }>;
  return rows.map((row) => getOrderSummary(db, row.id));
}

export function clearOrderHistory(db: Database.Database): number {
  const tx = db.transaction(() => {
    const closedOrders = db.prepare("SELECT id FROM orders WHERE status IN ('settled', 'cancelled')").all() as Array<{ id: number }>;
    const orderIds = closedOrders.map((order) => order.id);
    if (orderIds.length === 0) {
      return 0;
    }
    const placeholders = orderIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM payments WHERE order_id IN (${placeholders})`).run(...orderIds);
    db.prepare(`DELETE FROM kitchen_ticket_items WHERE ticket_id IN (SELECT id FROM kitchen_tickets WHERE order_id IN (${placeholders}))`).run(...orderIds);
    db.prepare(`DELETE FROM kitchen_tickets WHERE order_id IN (${placeholders})`).run(...orderIds);
    db.prepare(`DELETE FROM order_items WHERE order_id IN (${placeholders})`).run(...orderIds);
    db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).run(...orderIds);
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('clear_order_history', 'orders', 'closed', ?)"
    ).run(JSON.stringify({ deletedOrders: orderIds.length }));
    return orderIds.length;
  });
  return tx();
}

export function deleteClosedOrderRecord(db: Database.Database, orderId: number): number {
  const row = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!row) {
    return 0;
  }
  if (row.status !== "settled" && row.status !== "cancelled") {
    throw new Error("Only completed or cancelled order history can be deleted.");
  }
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payments WHERE order_id = ?").run(orderId);
    db.prepare("DELETE FROM kitchen_ticket_items WHERE ticket_id IN (SELECT id FROM kitchen_tickets WHERE order_id = ?)").run(orderId);
    db.prepare("DELETE FROM kitchen_tickets WHERE order_id = ?").run(orderId);
    db.prepare("DELETE FROM order_item_cost_snapshots WHERE order_id = ?").run(orderId);
    db.prepare("DELETE FROM order_cost_snapshots WHERE order_id = ?").run(orderId);
    db.prepare("DELETE FROM order_items WHERE order_id = ?").run(orderId);
    const result = db.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('delete_order_history_record', 'order', ?, ?)"
    ).run(String(orderId), JSON.stringify({ fromStatus: row.status }));
    return result.changes;
  });
  return tx();
}

export function reprintReceipt(db: Database.Database, orderId: number): number {
  const branding = getBrandingSettings(db);
  return enqueuePrintJob(db, "receipt_reprint", buildReceipt(db, orderId, branding, "RECEIPT REPRINT"), getPrinterName(db) || null);
}

export function printBillCopy(db: Database.Database, orderId: number, paymentInfo?: ReceiptPaymentInfo): number {
  const branding = getBrandingSettings(db);
  return enqueuePrintJob(db, "bill", buildReceipt(db, orderId, branding, "BILL COPY", paymentInfo, { consolidateUnmodifiedItems: true }), getPrinterName(db) || null);
}

export function printAuditCopy(db: Database.Database, orderId: number): number {
  return enqueuePrintJob(db, "audit", buildAuditCopy(db, orderId), getPrinterName(db) || null);
}

export function reprintKitchenCopy(db: Database.Database, orderId: number): number | null {
  const items = db
    .prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'active' ORDER BY id")
    .all(orderId) as Array<{ id: number }>;
  if (items.length === 0) {
    return null;
  }
  return enqueuePrintJob(
    db,
    "kot_reprint",
    buildKitchenTicket(db, orderId, items.map((item) => item.id), "Yamzo Kitchen Copy Reprint"),
    getPrinterName(db) || null
  );
}

function listOrderItems(db: Database.Database, orderId: number): OrderLine[] {
  return db
    .prepare(
      `SELECT id, menu_item_id, name, quantity, unit_price, note, parcel, status, kitchen_sent_at
       FROM order_items
       WHERE order_id = ?
       ORDER BY id`
    )
    .all(orderId)
    .map((row) => {
      const item = row as {
        id: number;
        menu_item_id: number;
        name: string;
        quantity: number;
        unit_price: number;
        note: string | null;
        parcel: number;
        status: "active" | "voided";
        kitchen_sent_at: string | null;
      };
      return {
        id: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        note: item.note,
        status: item.status,
        kitchenPrinted: Boolean(item.kitchen_sent_at),
        parcel: item.parcel === 1
      };
    });
}

function listOrderBatches(db: Database.Database, orderId: number): OrderBatch[] {
  const tickets = db
    .prepare("SELECT id, type, created_at, completed_at FROM kitchen_tickets WHERE order_id = ? ORDER BY id")
    .all(orderId) as Array<{ id: number; type: string; created_at: string; completed_at: string | null }>;
  if (tickets.length === 0) return [];
  const itemRows = db
    .prepare(
      `SELECT kti.ticket_id, oi.name
       FROM kitchen_ticket_items kti
       JOIN order_items oi ON oi.id = kti.order_item_id
       WHERE kti.ticket_id IN (${tickets.map(() => "?").join(",")})
       ORDER BY kti.id`
    )
    .all(...tickets.map((ticket) => ticket.id)) as Array<{ ticket_id: number; name: string }>;
  return tickets.map((ticket, index) => ({
    id: ticket.id,
    label: `Batch ${index + 1}`,
    type: ticket.type,
    createdAt: ticket.created_at,
    completedAt: ticket.completed_at,
    items: itemRows.filter((item) => item.ticket_id === ticket.id).map((item) => item.name)
  }));
}

function assertEditableOrder(db: Database.Database, orderId: number): void {
  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (order.status === "settled" || order.status === "cancelled") {
    throw new Error("Order is already closed.");
  }
}

function hasKitchenTicket(db: Database.Database, orderId: number): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id = ?").get(orderId) as { count: number };
  return row.count > 0;
}

function touchOrder(db: Database.Database, orderId: number): void {
  db.prepare("UPDATE orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
}

function nextOrderNumber(db: Database.Database): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = String(now.getDate()).padStart(2, "0");
  const prefix = `yamzo-${year}-${month}-${day}`;
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM orders WHERE order_number LIKE ?")
    .get(`${prefix}-%`) as { count: number };
  return `${prefix}-${String(row.count + 111).padStart(3, "0")}`;
}
