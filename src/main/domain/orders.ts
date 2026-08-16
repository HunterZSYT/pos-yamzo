import type Database from "better-sqlite3";
import type { DiscountInputState, HistoryRange, ManagerAuthorization, OrderBatch, OrderDetail, OrderItemInput, OrderLine, OrderSource, OrderSummary, PaymentMethod, ReceiptPaymentInfo, RecordPaymentResult } from "../../shared/types.js";
import { calculateOrderTotals } from "./pricing.js";
import { enqueuePrintJob } from "../services/printQueue.js";
import { buildAuditCopy, buildKitchenTicket, buildReceipt } from "../services/receipts.js";
import { getBrandingSettings, getMenuTypes, getPrinterName } from "../services/settings.js";
import { createOrderCostSnapshot } from "./inventory.js";
import { verifyManagerPin } from "./managers.js";

export function createOrder(
  db: Database.Database,
  input: { source: OrderSource; tableNumber?: string; guestCount?: number; hostName?: string; requiresKot?: boolean; note?: string; externalOrderId?: string | null; orderDate?: string; deliveryFee?: number; isTest?: boolean }
): OrderSummary {
  const orderDate = normalizeBusinessDate(input.orderDate ?? localBusinessDate());
  const deliveryFee = Math.round(Number(input.deliveryFee ?? 0));
  if (!Number.isSafeInteger(deliveryFee) || deliveryFee < 0) throw new Error("Delivery fee cannot be negative.");
  const tableNumber = input.tableNumber?.trim() || null;
  assertTableAvailable(db, tableNumber);
  const create = db.transaction(() => {
    const orderNumber = nextOrderNumber(db, orderDate);
    return Number(
      db
        .prepare("INSERT INTO orders (order_number, source, table_number, guest_count, host_name, requires_kot, note, external_order_id, order_date, delivery_fee, is_test) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(orderNumber, input.source, tableNumber, normalizeGuestCount(input.guestCount), cleanHostName(input.hostName), 1, input.note ?? null, cleanExternalOrderId(input.externalOrderId), orderDate, deliveryFee, input.isTest ? 1 : 0).lastInsertRowid
    );
  });
  return getOrderSummary(db, create());
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
  assertNoRecordedPayment(db, orderId);
  const item = db.prepare("SELECT id, name, price FROM menu_items WHERE id = ? AND archived = 0").get(input.menuItemId) as
    | { id: number; name: string; price: number }
    | undefined;
  if (!item) {
    throw new Error("Menu item not found.");
  }

  const menuType = getMenuTypes(db).find((type) => type.key === order.source);
  const menuDataKey = menuType?.menuDataKey || order.source;
  const sourcePrice = db.prepare("SELECT price FROM menu_item_prices WHERE menu_item_id = ? AND menu_type_key = ?").get(item.id, menuDataKey) as { price: number } | undefined;
  const result = db
    .prepare(
      `INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price, note, parcel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(orderId, item.id, item.name, input.quantity, sourcePrice?.price ?? item.price, input.note ?? null, input.parcel ? 1 : 0);
  touchOrder(db, orderId);
  refreshUnconfirmedInitialKot(db, orderId);
  return Number(result.lastInsertRowid);
}

export function sendNewItemsToKitchen(db: Database.Database, orderId: number): number | null {
  const order = db.prepare("SELECT source, requires_kot, host_name FROM orders WHERE id = ?").get(orderId) as { source: OrderSource; requires_kot: number; host_name: string } | undefined;
  if (!order) {
    throw new Error("Order not found.");
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
    const printJobId = enqueuePrintJob(db, ticketType, content, getPrinterName(db) || null, { orderId, operator: order.host_name });
    if (ticketType === "kot") {
      db.prepare("UPDATE orders SET initial_kot_print_job_id = COALESCE(initial_kot_print_job_id, ?) WHERE id = ?").run(printJobId, orderId);
    }
    if (order.requires_kot === 1) {
      db.prepare(
        "INSERT OR IGNORE INTO order_print_requirements (order_id, print_job_id, kind) VALUES (?, ?, ?)"
      ).run(orderId, printJobId, ticketType === "kot" ? "initial_kot" : "addition_kot");
    }
    return printJobId;
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

export function applyDiscount(db: Database.Database, orderId: number, discount: number, input?: DiscountInputState): OrderSummary {
  if (!Number.isSafeInteger(discount) || discount < 0) {
    throw new Error("Discount must be a non-negative whole TK amount.");
  }
  assertEditableOrder(db, orderId);
  const normalizedDiscount = Math.max(0, discount);
  const current = db.prepare(
    "SELECT discount, discount_mode, discount_input, manual_total_input FROM orders WHERE id = ?"
  ).get(orderId) as {
    discount: number;
    discount_mode: string;
    discount_input: number;
    manual_total_input: number | null;
  } | undefined;
  const normalizedInput = !input && current?.discount === normalizedDiscount
    ? {
        mode: current.discount_mode === "percent" ? "percent" as const : "tk" as const,
        value: current.discount_input,
        manualTotal: current.manual_total_input
      }
    : normalizeDiscountInput(normalizedDiscount, input);
  if (
    current?.discount === normalizedDiscount &&
    current.discount_mode === normalizedInput.mode &&
    current.discount_input === normalizedInput.value &&
    current.manual_total_input === normalizedInput.manualTotal
  ) return getOrderSummary(db, orderId);
  invalidateCurrentBill(db, orderId);
  db.prepare(
    `UPDATE orders
     SET discount = ?, discount_mode = ?, discount_input = ?, manual_total_input = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(normalizedDiscount, normalizedInput.mode, normalizedInput.value, normalizedInput.manualTotal, orderId);
  return getOrderSummary(db, orderId);
}

function normalizeDiscountInput(discount: number, input?: DiscountInputState): DiscountInputState {
  if (!input) return { mode: "tk", value: discount, manualTotal: null };
  if (input.mode !== "tk" && input.mode !== "percent") {
    throw new Error("Discount mode is invalid.");
  }
  if (!Number.isFinite(input.value) || input.value < 0 || (input.mode === "percent" && input.value > 100)) {
    throw new Error("Discount entry is invalid.");
  }
  if (input.manualTotal !== null && (!Number.isSafeInteger(input.manualTotal) || input.manualTotal < 0)) {
    throw new Error("Manual total is invalid.");
  }
  return { mode: input.mode, value: input.value, manualTotal: input.manualTotal };
}

export function updateOrderNote(db: Database.Database, orderId: number, note: string): OrderSummary {
  assertEditableOrder(db, orderId);
  const normalizedNote = note.trim() || null;
  const current = db.prepare("SELECT note FROM orders WHERE id = ?").get(orderId) as { note: string | null } | undefined;
  if (current?.note === normalizedNote) return getOrderSummary(db, orderId);
  invalidateCurrentBill(db, orderId);
  db.prepare("UPDATE orders SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(normalizedNote, orderId);
  return getOrderSummary(db, orderId);
}

export function updateOrderDate(db: Database.Database, orderId: number, value: string): OrderSummary {
  const orderDate = normalizeBusinessDate(value);
  assertEditableOrder(db, orderId);
  const update = db.transaction(() => {
    const order = db
      .prepare("SELECT order_number, order_date, external_order_id FROM orders WHERE id = ?")
      .get(orderId) as { order_number: string; order_date: string; external_order_id: string | null } | undefined;
    if (!order) {
      throw new Error("Order not found.");
    }
    if (order.order_date === orderDate) {
      return;
    }

    invalidateCurrentBill(db, orderId);
    const orderNumber = nextOrderNumber(db, orderDate);
    db.prepare("UPDATE orders SET order_number = ?, order_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderNumber, orderDate, orderId);
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('update_order_date', 'order', ?, ?)"
    ).run(
      String(orderId),
      JSON.stringify({
        reason: "Manager date correction",
        before: { orderDate: order.order_date, orderNumber: order.order_number },
        after: { orderDate, orderNumber },
        externalOrderId: order.external_order_id
      })
    );
  });
  update();
  return getOrderSummary(db, orderId);
}

export function updateOrderInfo(
  db: Database.Database,
  orderId: number,
  input: { source: OrderSource; tableNumber?: string | null; guestCount?: number; hostName?: string | null; note?: string | null; externalOrderId?: string | null }
): OrderSummary {
  assertEditableOrder(db, orderId);
  const menuType = getMenuTypes(db).find((type) => type.key === input.source);
  const tablesEnabled = menuType?.tablesEnabled ?? input.source === "in_house";
  const tableNumber = tablesEnabled ? input.tableNumber?.trim() || null : null;
  assertTableAvailable(db, tableNumber, orderId);
  const existing = db.prepare(
    "SELECT source, table_number, external_order_id, guest_count, host_name, note FROM orders WHERE id = ?"
  ).get(orderId) as { source: OrderSource; table_number: string | null; external_order_id: string | null; guest_count: number; host_name: string; note: string | null } | undefined;
  if (!existing) throw new Error("Order not found.");
  const guestCount = normalizeGuestCount(input.guestCount ?? existing.guest_count);
  const hostName = cleanHostName(input.hostName ?? existing.host_name);
  const note = input.note?.trim() || null;
  const externalOrderId = input.externalOrderId === undefined ? existing.external_order_id : cleanExternalOrderId(input.externalOrderId);
  if (existing.source === input.source && existing.table_number === tableNumber && existing.guest_count === guestCount && existing.host_name === hostName && existing.note === note && existing.external_order_id === externalOrderId) {
    return getOrderSummary(db, orderId);
  }
  invalidateCurrentBill(db, orderId);
  db.prepare("UPDATE orders SET source = ?, table_number = ?, guest_count = ?, host_name = ?, note = ?, external_order_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    input.source,
    tableNumber,
    guestCount,
    hostName,
    note,
    externalOrderId,
    orderId
  );
  return getOrderSummary(db, orderId);
}

export function changeOrderTable(db: Database.Database, orderId: number, tableNumber: string): OrderSummary {
  assertEditableOrder(db, orderId);
  const nextTable = tableNumber.trim();
  if (!nextTable) throw new Error("Choose a table before confirming the change.");
  const order = db.prepare("SELECT source, table_number FROM orders WHERE id = ?").get(orderId) as { source: OrderSource; table_number: string | null } | undefined;
  if (!order) throw new Error("Order not found.");
  const menuType = getMenuTypes(db).find((type) => type.key === order.source);
  if (!(menuType?.tablesEnabled ?? order.source === "in_house")) throw new Error("This order type does not use tables.");
  if (order.table_number === nextTable) return getOrderSummary(db, orderId);
  assertTableAvailable(db, nextTable, orderId);
  const tx = db.transaction(() => {
    invalidateCurrentBill(db, orderId);
    db.prepare("UPDATE orders SET table_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextTable, orderId);
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('change_order_table', 'order', ?, ?)"
    ).run(String(orderId), JSON.stringify({ from: order.table_number, to: nextTable }));
  });
  tx();
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
  const item = db.prepare("SELECT order_id, kitchen_sent_at FROM order_items WHERE id = ? AND status = 'active'").get(orderItemId) as { order_id: number; kitchen_sent_at: string | null } | undefined;
  if (!item) {
    throw new Error("Order item not found.");
  }
  assertEditableOrder(db, item.order_id);
  if (item.kitchen_sent_at && isInitialKotConfirmed(db, item.order_id)) {
    throw new Error("Use Swap / Change for an item already sent to the kitchen.");
  }
  db.prepare("UPDATE order_items SET quantity = ?, note = ?, parcel = ? WHERE id = ?").run(input.quantity, input.note?.trim() || null, input.parcel ? 1 : 0, orderItemId);
  touchOrder(db, item.order_id);
  refreshUnconfirmedInitialKot(db, item.order_id);
  return getOrderDetail(db, item.order_id);
}

export function removeOrderItem(db: Database.Database, orderItemId: number, reason = "Removed by cashier"): OrderDetail {
  const item = db.prepare("SELECT order_id, kitchen_sent_at FROM order_items WHERE id = ? AND status = 'active'").get(orderItemId) as { order_id: number; kitchen_sent_at: string | null } | undefined;
  if (!item) {
    throw new Error("Order item not found.");
  }
  assertEditableOrder(db, item.order_id);
  if (item.kitchen_sent_at && isInitialKotConfirmed(db, item.order_id)) {
    throw new Error("Use Swap / Change for an item already sent to the kitchen.");
  }
  db.prepare("UPDATE order_items SET status = 'voided', void_reason = ? WHERE id = ?").run(reason.trim() || "Removed by cashier", orderItemId);
  touchOrder(db, item.order_id);
  refreshUnconfirmedInitialKot(db, item.order_id);
  return getOrderDetail(db, item.order_id);
}

export function swapOrderItem(
  db: Database.Database,
  orderItemId: number,
  replacement: OrderItemInput,
  authorization: ManagerAuthorization
): { order: OrderDetail; voidPrintJobId: number; adjustmentPrintJobId: number } {
  return adjustPostKotItem(db, orderItemId, replacement, authorization, "swap");
}

export function cancelOrderItem(
  db: Database.Database,
  orderItemId: number,
  authorization: ManagerAuthorization
): { order: OrderDetail; voidPrintJobId: number; adjustmentPrintJobId: number } {
  return adjustPostKotItem(db, orderItemId, null, authorization, "cancel");
}

function adjustPostKotItem(
  db: Database.Database,
  orderItemId: number,
  replacement: OrderItemInput | null,
  authorization: ManagerAuthorization,
  eventKind: "swap" | "cancel"
): { order: OrderDetail; voidPrintJobId: number; adjustmentPrintJobId: number } {
  const reason = authorization.reason.trim().replace(/\s+/g, " ");
  const operator = authorization.operator.trim().replace(/\s+/g, " ") || "Cashier";
  if (reason.length < 2 || reason.length > 240) throw new Error(`A ${eventKind === "cancel" ? "cancellation" : "Swap / Change"} reason is required.`);
  const manager = verifyManagerPin(db, authorization.managerId, authorization.pin);
  const original = db.prepare(
    `SELECT oi.order_id, oi.kitchen_sent_at, oi.name, oi.quantity,
            o.initial_kot_print_job_id
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = ? AND oi.status = 'active'`
  ).get(orderItemId) as { order_id: number; kitchen_sent_at: string | null; name: string; quantity: number; initial_kot_print_job_id: number | null } | undefined;
  if (!original) throw new Error("Order item not found.");
  if (!original.kitchen_sent_at || !isInitialKotConfirmed(db, original.order_id)) {
    throw new Error("Remove and replace this item before the first Kitchen KOT prints.");
  }
  assertEditableOrder(db, original.order_id);
  const tx = db.transaction(() => {
    db.prepare("UPDATE order_items SET status = 'voided', void_reason = ? WHERE id = ?").run(reason, orderItemId);
    const adjustmentPrintJobId = enqueuePrintJob(
      db,
      "void_kot",
      buildKitchenTicket(db, original.order_id, [orderItemId], eventKind === "cancel" ? "Yamzo Cancelled KOT" : "Yamzo Swap / Change - Remove"),
      getPrinterName(db) || null,
      { orderId: original.order_id, operator, managerId: manager.id, reason, relatedPrintJobId: original.initial_kot_print_job_id ?? undefined }
    );
    db.prepare(
      "INSERT OR IGNORE INTO order_print_requirements (order_id, print_job_id, kind) VALUES (?, ?, 'swap_change')"
    ).run(original.order_id, adjustmentPrintJobId);
    const replacementOrderItemId = replacement ? addOrderItem(db, original.order_id, replacement) : null;
    const replacementRow = replacementOrderItemId
      ? db.prepare("SELECT name, quantity FROM order_items WHERE id = ?").get(replacementOrderItemId) as { name: string; quantity: number }
      : null;
    db.prepare(
      `INSERT INTO swap_events
        (order_id, original_order_item_id, replacement_order_item_id, original_name, original_quantity,
         replacement_name, replacement_quantity, manager_id, manager_name, operator, reason,
         original_kot_print_job_id, adjustment_print_job_id, event_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      original.order_id,
      orderItemId,
      replacementOrderItemId,
      original.name,
      original.quantity,
      replacementRow?.name ?? null,
      replacementRow?.quantity ?? null,
      manager.id,
      manager.name,
      operator,
      reason,
      original.initial_kot_print_job_id,
      adjustmentPrintJobId,
      eventKind
    );
    db.prepare(
      "INSERT INTO audit_logs (actor, action, entity_type, entity_id, details) VALUES (?, ?, 'order', ?, ?)"
    ).run(manager.name, eventKind === "cancel" ? "cancel_kot_item" : "swap_order_item", String(original.order_id), JSON.stringify({ orderItemId, replacementOrderItemId, reason, operator, adjustmentPrintJobId }));
    touchOrder(db, original.order_id);
    return { order: getOrderDetail(db, original.order_id), voidPrintJobId: adjustmentPrintJobId, adjustmentPrintJobId };
  });
  return tx();
}

export function cancelOrder(db: Database.Database, orderId: number, reason = ""): OrderSummary {
  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (order.status === "cancelled") {
    return getOrderSummary(db, orderId);
  }
  if (order.status === "settled") {
    throw new Error("Completed orders are permanent and cannot be cancelled.");
  }
  assertNoRecordedPayment(db, orderId);
  const cancellationReason = reason.trim();
  if (cancellationReason.length < 2) {
    throw new Error("A short cancellation reason is required.");
  }
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('cancel_order', 'order', ?, ?)"
    ).run(String(orderId), JSON.stringify({ reason: cancellationReason || null, fromStatus: order.status }));
    db.prepare("UPDATE kitchen_tickets SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE order_id = ?").run(orderId);
    db.prepare(
      `UPDATE orders
       SET status = 'cancelled', settled_at = NULL,
           kitchen_completed_at = CASE WHEN first_kitchen_sent_at IS NOT NULL THEN COALESCE(kitchen_completed_at, CURRENT_TIMESTAMP) ELSE kitchen_completed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(orderId);
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
  throw new Error("Closed orders are permanent and cannot be reopened.");
}

export function orderHasKitchenPrintedItems(db: Database.Database, orderId: number): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ? AND kitchen_sent_at IS NOT NULL").get(orderId) as { count: number };
  return row.count > 0;
}

export function markKitchenDelivered(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT status, first_kitchen_sent_at FROM orders WHERE id = ?").get(orderId) as { status: string; first_kitchen_sent_at: string | null } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (!order.first_kitchen_sent_at) {
    throw new Error("Kitchen Copy has not been sent yet.");
  }
  assertRunningOrderStatus(order.status);
  assertInitialKotConfirmed(db, orderId);
  db.prepare("UPDATE kitchen_tickets SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE order_id = ? AND completed_at IS NULL").run(orderId);
  db.prepare("UPDATE orders SET kitchen_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
  return getOrderSummary(db, orderId);
}

export function restartKitchenTimer(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT status, first_kitchen_sent_at FROM orders WHERE id = ?").get(orderId) as { status: string; first_kitchen_sent_at: string | null } | undefined;
  if (!order) {
    throw new Error("Order not found.");
  }
  if (!order.first_kitchen_sent_at) {
    throw new Error("Kitchen Copy has not been sent yet.");
  }
  assertRunningOrderStatus(order.status);
  db.prepare("UPDATE kitchen_tickets SET completed_at = NULL WHERE order_id = ?").run(orderId);
  db.prepare("UPDATE orders SET kitchen_completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
  return getOrderSummary(db, orderId);
}

export function markKitchenBatchDelivered(db: Database.Database, ticketId: number): OrderSummary {
  const ticket = db.prepare("SELECT kt.order_id, o.status FROM kitchen_tickets kt JOIN orders o ON o.id = kt.order_id WHERE kt.id = ?").get(ticketId) as { order_id: number; status: string } | undefined;
  if (!ticket) {
    throw new Error("Kitchen batch not found.");
  }
  assertRunningOrderStatus(ticket.status);
  assertInitialKotConfirmed(db, ticket.order_id);
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
  const ticket = db.prepare("SELECT kt.order_id, o.status FROM kitchen_tickets kt JOIN orders o ON o.id = kt.order_id WHERE kt.id = ?").get(ticketId) as { order_id: number; status: string } | undefined;
  if (!ticket) {
    throw new Error("Kitchen batch not found.");
  }
  assertRunningOrderStatus(ticket.status);
  db.prepare("UPDATE kitchen_tickets SET completed_at = NULL WHERE id = ?").run(ticketId);
  db.prepare("UPDATE orders SET kitchen_completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticket.order_id);
  return getOrderSummary(db, ticket.order_id);
}

export function recordOrderPayment(
  db: Database.Database,
  orderId: number,
  input: { method: PaymentMethod; cashReceived?: number; bkashAmount?: number; reference?: string; hostName?: string }
): RecordPaymentResult {
  const order = db.prepare("SELECT status, source FROM orders WHERE id = ?").get(orderId) as { status: string; source: string } | undefined;
  if (!order) throw new Error("Order not found.");
  if (order.status === "settled" || order.status === "cancelled") throw new Error("Order is already closed.");
  if (isPlatformManagedSource(order.source)) throw new Error("Foodpanda and Foodie orders do not require payment entry or bill copies.");
  assertAllRequiredKotsPrinted(db, orderId);
  const bill = db.prepare(
    `SELECT pj.status
     FROM orders o
     LEFT JOIN print_jobs pj ON pj.id = o.bill_print_job_id
     WHERE o.id = ?`
  ).get(orderId) as { status: string | null } | undefined;
  if (bill?.status !== "printed") throw new Error("Print the Unpaid Bill Copy before recording payment.");
  const totals = calculateOrderTotals(db, orderId);
  if (totals.total <= 0) throw new Error("Cannot record payment for an empty order.");
  if (!["cash", "bkash", "split"].includes(input.method)) throw new Error("Choose Cash, bKash, or Multi before recording payment.");
  const hostName = cleanHostName(input.hostName);
  const reference = input.reference?.trim().slice(0, 120) || null;
  const bkashAmount = input.method === "bkash" || input.method === "split" ? normalizeMoney(input.bkashAmount, "bKash Amount") : 0;
  if (input.method === "bkash" && bkashAmount !== totals.total) throw new Error("bKash Amount must equal the payable total.");
  if (input.method === "split" && (bkashAmount <= 0 || bkashAmount >= totals.total)) throw new Error("Multi payment needs both a cash portion and a bKash portion.");
  const cashAmount = input.method === "cash" ? totals.total : input.method === "split" ? totals.total - bkashAmount : 0;
  const cashReceived = cashAmount > 0 ? normalizeMoney(input.cashReceived, "Cash Received") : null;
  if (cashAmount > 0 && (cashReceived ?? 0) < cashAmount) throw new Error("Cash Received cannot be less than the cash portion.");
  const changeGiven = cashAmount > 0 ? (cashReceived ?? 0) - cashAmount : 0;
  const existing = db.prepare(
    "SELECT method, payable_amount, cash_amount, bkash_amount, cash_received, reference, host_name FROM order_payment_sessions WHERE order_id = ?"
  ).get(orderId) as { method: PaymentMethod; payable_amount: number; cash_amount: number; bkash_amount: number; cash_received: number | null; reference: string | null; host_name: string } | undefined;
  if (existing) {
    if (existing.method === input.method && existing.payable_amount === totals.total && existing.cash_amount === cashAmount && existing.bkash_amount === bkashAmount && existing.cash_received === cashReceived && existing.reference === reference && existing.host_name === hostName) {
      const pointer = db.prepare("SELECT paid_slip_print_job_id FROM orders WHERE id = ?").get(orderId) as { paid_slip_print_job_id: number | null };
      if (!pointer.paid_slip_print_job_id) throw new Error("Paid Slip is missing for the recorded payment.");
      return { order: getOrderSummary(db, orderId), paidSlipPrintJobId: pointer.paid_slip_print_job_id };
    }
    throw new Error("Payment is already recorded for this order.");
  }
  const branding = getBrandingSettings(db);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO order_payment_sessions
        (order_id, method, payable_amount, cash_amount, bkash_amount, cash_received, change_given, reference, host_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(orderId, input.method, totals.total, cashAmount, bkashAmount, cashReceived, changeGiven, reference, hostName);
    if (cashAmount > 0) db.prepare("INSERT INTO payments (order_id, method, amount) VALUES (?, 'cash', ?)").run(orderId, cashAmount);
    if (bkashAmount > 0) db.prepare("INSERT INTO payments (order_id, method, amount) VALUES (?, 'bkash', ?)").run(orderId, bkashAmount);
    db.prepare("UPDATE orders SET host_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(hostName, orderId);
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('record_payment', 'order', ?, ?)"
    ).run(String(orderId), JSON.stringify({ method: input.method, amount: totals.total, cashAmount, bkashAmount, cashReceived, changeGiven, reference }));
    const paidSlipPrintJobId = enqueuePrintJob(
      db,
      "paid_slip",
      buildReceipt(db, orderId, branding, "PAID SLIP", {
        paid: true,
        method: input.method,
        amount: totals.total,
        cashAmount,
        bkashAmount,
        cashReceived: cashReceived ?? undefined,
        changeGiven,
        reference: reference ?? undefined,
        host: hostName
      }, { consolidateUnmodifiedItems: true }),
      getPrinterName(db) || null,
      { orderId, operator: hostName }
    );
    db.prepare("UPDATE orders SET paid_slip_print_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(paidSlipPrintJobId, orderId);
    return paidSlipPrintJobId;
  });
  const paidSlipPrintJobId = tx();
  return { order: getOrderSummary(db, orderId), paidSlipPrintJobId };
}

export function redoOrderPayment(
  db: Database.Database,
  orderId: number,
  authorization: ManagerAuthorization
): OrderDetail {
  const reason = authorization.reason.trim().replace(/\s+/g, " ");
  const operator = authorization.operator.trim().replace(/\s+/g, " ") || "Cashier";
  if (reason.length < 2 || reason.length > 240) throw new Error("A payment redo reason is required.");
  const manager = verifyManagerPin(db, authorization.managerId, authorization.pin);
  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as { status: string } | undefined;
  if (!order) throw new Error("Order not found.");
  if (order.status === "settled" || order.status === "cancelled") throw new Error("Completed and cancelled orders are permanent.");
  const payment = db.prepare(
    "SELECT method, payable_amount, cash_amount, bkash_amount, cash_received, change_given, reference, host_name, created_at FROM order_payment_sessions WHERE order_id = ?"
  ).get(orderId) as Record<string, unknown> | undefined;
  if (!payment) throw new Error("No recorded payment is available to redo.");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payments WHERE order_id = ?").run(orderId);
    db.prepare("DELETE FROM order_payment_sessions WHERE order_id = ?").run(orderId);
    db.prepare(
      "UPDATE orders SET bill_print_job_id = NULL, paid_slip_print_job_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(orderId);
    db.prepare(
      "INSERT INTO audit_logs (actor, action, entity_type, entity_id, details) VALUES (?, 'redo_order_payment', 'order', ?, ?)"
    ).run(manager.name, String(orderId), JSON.stringify({ reason, operator, previousPayment: payment }));
  });
  tx();
  return getOrderDetail(db, orderId);
}

export function completePaidOrder(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT status, source, external_order_id FROM orders WHERE id = ?").get(orderId) as { status: string; source: string; external_order_id: string | null } | undefined;
  if (!order) throw new Error("Order not found.");
  if (order.status === "settled") return getOrderSummary(db, orderId);
  if (order.status === "cancelled") throw new Error("Cancelled orders cannot be completed.");
  assertAllRequiredKotsPrinted(db, orderId);
  const totals = calculateOrderTotals(db, orderId);
  const platformManaged = isPlatformManagedSource(order.source);
  if (platformManaged && !order.external_order_id?.trim()) throw new Error("Foodpanda and Foodie orders require an External Order ID before completion.");
  if (!platformManaged) {
    const payment = db.prepare("SELECT payable_amount FROM order_payment_sessions WHERE order_id = ?").get(orderId) as { payable_amount: number } | undefined;
    if (!payment || payment.payable_amount !== totals.total) throw new Error("A valid payment is required before completion.");
    const bill = db.prepare(
      `SELECT pj.status FROM orders o LEFT JOIN print_jobs pj ON pj.id = o.bill_print_job_id WHERE o.id = ?`
    ).get(orderId) as { status: string } | undefined;
    if (bill?.status !== "printed") throw new Error("The current Unpaid Bill Copy must print successfully before completion.");
    const paidSlip = db.prepare(
      `SELECT pj.status FROM orders o LEFT JOIN print_jobs pj ON pj.id = o.paid_slip_print_job_id WHERE o.id = ?`
    ).get(orderId) as { status: string | null } | undefined;
    if (paidSlip?.status !== "printed") throw new Error("Paid Slip must print successfully before completion.");
  }
  const tx = db.transaction(() => {
    createOrderCostSnapshot(db, orderId);
    db.prepare("UPDATE kitchen_tickets SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE order_id = ? AND completed_at IS NULL").run(orderId);
    db.prepare(
      `UPDATE orders
       SET status = 'settled', settled_at = CURRENT_TIMESTAMP,
           kitchen_completed_at = CASE WHEN first_kitchen_sent_at IS NOT NULL THEN COALESCE(kitchen_completed_at, CURRENT_TIMESTAMP) ELSE kitchen_completed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(orderId);
    db.prepare(
      "INSERT INTO audit_logs (action, entity_type, entity_id, details) VALUES ('complete_paid_order', 'order', ?, ?)"
    ).run(String(orderId), JSON.stringify({ amount: totals.total, platformManaged, source: order.source, externalOrderId: order.external_order_id }));
  });
  tx();
  return getOrderSummary(db, orderId);
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
  assertInitialKotConfirmed(db, orderId);
  const paidAmount = amount ?? totals.total;
  const branding = getBrandingSettings(db);
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO payments (order_id, method, amount) VALUES (?, ?, ?)").run(orderId, method, paidAmount);
    createOrderCostSnapshot(db, orderId);
    db.prepare("UPDATE kitchen_tickets SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE order_id = ? AND completed_at IS NULL").run(orderId);
    db.prepare(
      `UPDATE orders
       SET status = 'settled',
           settled_at = CURRENT_TIMESTAMP,
           kitchen_completed_at = CASE
             WHEN first_kitchen_sent_at IS NOT NULL THEN COALESCE(kitchen_completed_at, CURRENT_TIMESTAMP)
             ELSE kitchen_completed_at
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(orderId);
    enqueuePrintJob(db, "receipt", buildReceipt(db, orderId, branding, "RECEIPT", { paid: true, method, amount: paidAmount, reference, host }), getPrinterName(db) || null);
  });
  tx();
  return getOrderSummary(db, orderId);
}

export function getOrderSummary(db: Database.Database, orderId: number): OrderSummary {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as {
    id: number;
    order_number: string;
    external_order_id: string | null;
    source: OrderSource;
    table_number: string | null;
    guest_count: number;
    host_name: string;
    status: OrderSummary["status"];
    order_date: string;
    created_at: string;
    updated_at: string;
    settled_at: string | null;
    first_kitchen_sent_at: string | null;
    kitchen_completed_at: string | null;
    delivery_fee: number;
    discount_mode: string;
    discount_input: number;
    manual_total_input: number | null;
    is_test: number;
    initial_kot_print_job_id: number | null;
    initial_kot_printed_at: string | null;
    bill_print_job_id: number | null;
    paid_slip_print_job_id: number | null;
    requires_kot: number;
  };
  const totals = calculateOrderTotals(db, orderId);
  const itemCount = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS count FROM order_items WHERE order_id = ? AND status = 'active'")
    .get(orderId) as { count: number };
  const itemPreview = db
    .prepare("SELECT name FROM order_items WHERE order_id = ? AND status = 'active' ORDER BY id LIMIT 4")
    .all(orderId)
    .map((row) => (row as { name: string }).name);
  const initialKot = db.prepare(
    "SELECT state FROM website_initial_kots WHERE pos_order_id = ?"
  ).get(orderId) as { state: OrderSummary["websiteInitialKotState"] } | undefined;
  const initialKotJob = order.initial_kot_print_job_id
    ? db.prepare("SELECT status FROM print_jobs WHERE id = ?").get(order.initial_kot_print_job_id) as { status: string } | undefined
    : undefined;
  const billJob = order.bill_print_job_id
    ? db.prepare("SELECT status FROM print_jobs WHERE id = ?").get(order.bill_print_job_id) as { status: OrderSummary["billState"] } | undefined
    : undefined;
  const paidSlipJob = order.paid_slip_print_job_id
    ? db.prepare("SELECT status FROM print_jobs WHERE id = ?").get(order.paid_slip_print_job_id) as { status: OrderSummary["paidSlipState"] } | undefined
    : undefined;
  const paid = db.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ?").get(orderId) as { count: number };
  const payment = db.prepare(
    `SELECT method, payable_amount, cash_amount, bkash_amount, cash_received, change_given, reference, host_name, created_at
     FROM order_payment_sessions WHERE order_id = ?`
  ).get(orderId) as {
    method: PaymentMethod;
    payable_amount: number;
    cash_amount: number;
    bkash_amount: number;
    cash_received: number | null;
    change_given: number;
    reference: string | null;
    host_name: string;
    created_at: string;
  } | undefined;
  const kotRequirements = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN pj.status = 'printed' THEN 0 ELSE 1 END) AS unresolved,
            SUM(CASE WHEN pj.status IN ('failed', 'retry') THEN 1 ELSE 0 END) AS failed
     FROM order_print_requirements opr
     JOIN print_jobs pj ON pj.id = opr.print_job_id
     WHERE opr.order_id = ?`
  ).get(orderId) as { total: number; unresolved: number | null; failed: number | null };
  const initialKotState = order.requires_kot !== 1 || itemCount.count <= 0
    ? null
    : order.initial_kot_printed_at || initialKotJob?.status === "printed"
      ? "confirmed"
      : initialKotJob?.status === "failed"
        ? "awaiting_retry"
        : initialKotJob
          ? "queued"
          : "required";
  return {
    id: order.id,
    orderNumber: order.order_number,
    externalOrderId: order.external_order_id,
    source: order.source,
    tableNumber: order.table_number,
    guestCount: normalizeGuestCount(order.guest_count),
    hostName: cleanHostName(order.host_name),
    status: order.status,
    orderDate: order.order_date,
    subtotal: totals.subtotal,
    deliveryFee: totals.deliveryFee,
    discount: totals.discount,
    discountMode: order.discount_mode === "percent" ? "percent" : "tk",
    discountInput: Number.isFinite(order.discount_input) ? order.discount_input : totals.discount,
    manualTotalInput: typeof order.manual_total_input === "number" && Number.isSafeInteger(order.manual_total_input) && order.manual_total_input >= 0 ? order.manual_total_input : null,
    total: totals.total,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    closedAt: order.status === "settled" ? order.settled_at ?? order.updated_at : order.status === "cancelled" ? order.updated_at : null,
    kitchenStartedAt: order.first_kitchen_sent_at,
    kitchenCompletedAt: order.kitchen_completed_at,
    itemCount: itemCount.count,
    itemPreview,
    batches: listOrderBatches(db, orderId),
    isTest: order.is_test === 1,
    initialKotState,
    initialKotPrintJobId: order.initial_kot_print_job_id,
    paid: paid.count > 0,
    payment: payment ? {
      method: payment.method,
      amount: payment.payable_amount,
      cashAmount: payment.cash_amount,
      bkashAmount: payment.bkash_amount,
      cashReceived: payment.cash_received,
      changeGiven: payment.change_given,
      reference: payment.reference,
      hostName: payment.host_name,
      createdAt: payment.created_at
    } : null,
    requiredKotCount: Math.max(kotRequirements.total, initialKotState === "required" ? 1 : 0),
    unresolvedKotCount: Math.max(kotRequirements.unresolved ?? 0, initialKotState === "required" ? 1 : 0),
    failedKotCount: kotRequirements.failed ?? 0,
    billState: billJob?.status ?? "not_printed",
    paidSlipState: paidSlipJob?.status ?? "not_printed",
    websiteInitialKotState: initialKot?.state ?? null
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

export function listOrderHistory(db: Database.Database, range: HistoryRange = {}): OrderSummary[] {
  const clauses = ["status IN ('settled', 'cancelled')"];
  const params: string[] = [];
  if (range.startDate) { clauses.push("date(order_date) >= date(?)"); params.push(range.startDate); }
  if (range.endDate) { clauses.push("date(order_date) <= date(?)"); params.push(range.endDate); }
  const rows = db.prepare(`SELECT id FROM orders WHERE ${clauses.join(" AND ")} ORDER BY order_date DESC, updated_at DESC LIMIT 1000`).all(...params) as Array<{ id: number }>;
  return rows.map((row) => getOrderSummary(db, row.id));
}

export function reprintReceipt(db: Database.Database, orderId: number): number {
  const branding = getBrandingSettings(db);
  return enqueuePrintJob(db, "receipt_reprint", buildReceipt(db, orderId, branding, "RECEIPT REPRINT"), getPrinterName(db) || null);
}

export function printBillCopy(db: Database.Database, orderId: number, paymentInfo?: ReceiptPaymentInfo, reprint = false): number {
  const order = db.prepare(
    "SELECT source, requires_kot, bill_print_job_id FROM orders WHERE id = ?"
  ).get(orderId) as { source: string; requires_kot: number; bill_print_job_id: number | null } | undefined;
  if (!order) throw new Error("Order not found.");
  if (isPlatformManagedSource(order.source)) throw new Error("Foodpanda and Foodie orders do not require bill copies.");
  assertAllRequiredKotsPrinted(db, orderId);
  assertNoRecordedPayment(db, orderId);
  paymentInfo = { paid: false, method: "cash" };
  if (!reprint && order.bill_print_job_id) return order.bill_print_job_id;
  const branding = getBrandingSettings(db);
  const host = db.prepare("SELECT host_name FROM orders WHERE id = ?").get(orderId) as { host_name: string };
  const jobId = enqueuePrintJob(db, "bill", buildReceipt(db, orderId, branding, "UNPAID BILL COPY", paymentInfo, { consolidateUnmodifiedItems: true }), getPrinterName(db) || null, { orderId, operator: host.host_name, relatedPrintJobId: reprint ? order.bill_print_job_id ?? undefined : undefined });
  db.prepare(
    "INSERT INTO order_bill_prints (order_id, print_job_id, is_original) VALUES (?, ?, ?)"
  ).run(orderId, jobId, order.bill_print_job_id ? 0 : 1);
  if (!order.bill_print_job_id) {
    db.prepare("UPDATE orders SET bill_print_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(jobId, orderId);
  }
  return jobId;
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
  const order = db.prepare("SELECT host_name, initial_kot_print_job_id FROM orders WHERE id = ?").get(orderId) as { host_name: string; initial_kot_print_job_id: number | null };
  return enqueuePrintJob(
    db,
    "kot_reprint",
    buildKitchenTicket(db, orderId, items.map((item) => item.id), "Yamzo Kitchen Copy Reprint"),
    getPrinterName(db) || null,
    { orderId, operator: order.host_name, relatedPrintJobId: order.initial_kot_print_job_id ?? undefined }
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
  assertNoRecordedPayment(db, orderId);
}

function assertRunningOrderStatus(status: string): void {
  if (status === "settled" || status === "cancelled") throw new Error("Closed-order timers cannot be restarted or changed.");
}

function isPlatformManagedSource(source: string): boolean {
  return source.trim().toLowerCase() === "foodpanda" || source.trim().toLowerCase() === "foodie";
}

function assertNoRecordedPayment(db: Database.Database, orderId: number): void {
  const paid = db.prepare("SELECT 1 FROM order_payment_sessions WHERE order_id = ?").get(orderId);
  if (paid) throw new Error("Order items and totals are locked after payment.");
}

function assertAllRequiredKotsPrinted(db: Database.Database, orderId: number): void {
  const order = db.prepare("SELECT requires_kot FROM orders WHERE id = ?").get(orderId) as { requires_kot: number } | undefined;
  if (!order) throw new Error("Order not found.");
  if (order.requires_kot !== 1) return;
  assertInitialKotConfirmed(db, orderId);
  const requirements = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN pj.status = 'printed' THEN 0 ELSE 1 END) AS unresolved
     FROM order_print_requirements opr
     JOIN print_jobs pj ON pj.id = opr.print_job_id
     WHERE opr.order_id = ?`
  ).get(orderId) as { total: number; unresolved: number | null };
  if (requirements.total <= 0 || (requirements.unresolved ?? 0) > 0) {
    throw new Error("Every required Kitchen KOT must print successfully before continuing.");
  }
}

function hasKitchenTicket(db: Database.Database, orderId: number): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id = ?").get(orderId) as { count: number };
  return row.count > 0;
}

function assertInitialKotConfirmed(db: Database.Database, orderId: number): void {
  const initialKot = db.prepare(
    "SELECT state FROM website_initial_kots WHERE pos_order_id = ?"
  ).get(orderId) as { state: string } | undefined;
  if (initialKot && initialKot.state !== "confirmed") {
    throw new Error("Awaiting KOT. Retry Kitchen KOT before continuing this website order.");
  }
  const localInitialKot = db.prepare(
    `SELECT pj.status, o.initial_kot_printed_at, o.requires_kot
     FROM orders o
     LEFT JOIN print_jobs pj ON pj.id = o.initial_kot_print_job_id
     WHERE o.id = ?`
  ).get(orderId) as { status: string | null; initial_kot_printed_at: string | null; requires_kot: number } | undefined;
  if (localInitialKot?.requires_kot !== 1) return;
  if (!localInitialKot?.initial_kot_printed_at && localInitialKot?.status !== "printed") {
    throw new Error("Kitchen KOT must print successfully before continuing this order.");
  }
}

function isInitialKotConfirmed(db: Database.Database, orderId: number): boolean {
  const row = db.prepare(
    `SELECT o.initial_kot_printed_at, pj.status
     FROM orders o
     LEFT JOIN print_jobs pj ON pj.id = o.initial_kot_print_job_id
     WHERE o.id = ?`
  ).get(orderId) as { initial_kot_printed_at: string | null; status: string | null } | undefined;
  return Boolean(row?.initial_kot_printed_at || row?.status === "printed");
}

function refreshUnconfirmedInitialKot(db: Database.Database, orderId: number): void {
  const order = db.prepare(
    `SELECT o.initial_kot_print_job_id, o.requires_kot, pj.status
     FROM orders o
     LEFT JOIN print_jobs pj ON pj.id = o.initial_kot_print_job_id
     WHERE o.id = ?`
  ).get(orderId) as { initial_kot_print_job_id: number | null; requires_kot: number; status: string | null } | undefined;
  if (!order?.initial_kot_print_job_id || order.requires_kot !== 1 || order.status === "printed") return;
  const ticket = db.prepare(
    "SELECT id FROM kitchen_tickets WHERE order_id = ? AND type = 'kot' ORDER BY id LIMIT 1"
  ).get(orderId) as { id: number } | undefined;
  if (!ticket) return;
  const items = db.prepare(
    "SELECT id FROM order_items WHERE order_id = ? AND status = 'active' ORDER BY id"
  ).all(orderId) as Array<{ id: number }>;
  db.prepare("DELETE FROM kitchen_ticket_items WHERE ticket_id = ?").run(ticket.id);
  const insert = db.prepare(
    "INSERT INTO kitchen_ticket_items (ticket_id, order_item_id, quantity, note) SELECT ?, id, quantity, note FROM order_items WHERE id = ?"
  );
  for (const item of items) insert.run(ticket.id, item.id);
  if (items.length > 0) {
    db.prepare(
      "UPDATE order_items SET kitchen_sent_at = COALESCE(kitchen_sent_at, CURRENT_TIMESTAMP) WHERE id IN (" + items.map(() => "?").join(",") + ")"
    ).run(...items.map((item) => item.id));
  }
  const content = buildKitchenTicket(db, orderId, items.map((item) => item.id), "Yamzo Kitchen Order");
  db.prepare(
    `UPDATE print_jobs
     SET content = ?, status = 'failed', error_message = 'Kitchen KOT changed before successful print.', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(content, order.initial_kot_print_job_id);
}

function normalizeGuestCount(value?: number): number {
  const count = Math.round(Number(value ?? 1));
  if (!Number.isSafeInteger(count) || count < 1 || count > 99) {
    throw new Error("Number of guests must be between 1 and 99.");
  }
  return count;
}

function cleanHostName(value?: string | null): string {
  return value?.trim().slice(0, 80) || "Cashier";
}

function normalizeMoney(value: number | undefined, label: string): number {
  const amount = Math.round(Number(value));
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a valid whole TK amount.`);
  return amount;
}

function touchOrder(db: Database.Database, orderId: number): void {
  invalidateCurrentBill(db, orderId);
  db.prepare("UPDATE orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
}

function invalidateCurrentBill(db: Database.Database, orderId: number): void {
  const payment = db.prepare("SELECT 1 FROM order_payment_sessions WHERE order_id = ?").get(orderId);
  if (payment) return;
  db.prepare("UPDATE orders SET bill_print_job_id = NULL WHERE id = ? AND bill_print_job_id IS NOT NULL").run(orderId);
}

function assertTableAvailable(db: Database.Database, tableNumber: string | null, excludeOrderId?: number): void {
  if (!tableNumber) return;
  const occupied = db.prepare(
    `SELECT id, order_number
     FROM orders
     WHERE table_number = ? COLLATE NOCASE
       AND status IN ('open', 'kitchen_sent')
       AND (? IS NULL OR id <> ?)
     LIMIT 1`
  ).get(tableNumber, excludeOrderId ?? null, excludeOrderId ?? null) as { id: number; order_number: string } | undefined;
  if (occupied) throw new Error(`${tableNumber} is already in use by ${occupied.order_number}. Choose an available table.`);
}

function cleanExternalOrderId(value?: string | null): string | null {
  return value?.trim() || null;
}

function nextOrderNumber(db: Database.Database, orderDate: string): string {
  const [year, monthNumber, day] = orderDate.split("-");
  const month = MONTH_NAMES[Number(monthNumber) - 1];
  const prefix = `yamzo-${year}-${month}-${day}`;
  const rows = db
    .prepare("SELECT order_number FROM orders WHERE order_number LIKE ?")
    .all(`${prefix}-%`) as Array<{ order_number: string }>;
  const highestSuffix = rows.reduce((highest, row) => {
    const suffix = Number(row.order_number.slice(prefix.length + 1));
    return Number.isInteger(suffix) && suffix >= 111 ? Math.max(highest, suffix) : highest;
  }, 110);
  return `${prefix}-${String(highestSuffix + 1).padStart(3, "0")}`;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

function localBusinessDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeBusinessDate(value: string): string {
  const date = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error("Order date must use YYYY-MM-DD.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error("Order date is invalid.");
  }
  return date;
}
