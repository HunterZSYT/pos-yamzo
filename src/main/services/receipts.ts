import type Database from "better-sqlite3";
import { calculateOrderTotals } from "../domain/pricing.js";
import type { BrandingSettings, ReceiptPaymentInfo } from "../../shared/types.js";
import { centerReceiptText, formatReceiptDateTime, formatSourceLabel, formatTk, leftRightReceiptLine, receiptSeparator, receiptTextLine, wrapReceiptText } from "./receiptFormatter.js";

export function buildKitchenTicket(db: Database.Database, orderId: number, itemIds: number[], title = "Yamzo Kitchen Order"): string {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown>;
  const placeholders = itemIds.map(() => "?").join(",");
  const items = placeholders
    ? (db
        .prepare(`SELECT name, quantity, note, parcel FROM order_items WHERE id IN (${placeholders})`)
        .all(...itemIds) as Array<{ name: string; quantity: number; note: string | null; parcel: number }>)
    : [];

  const lines = cleanReceiptLines([
    receiptSeparator(),
    centerReceiptText(title.toUpperCase()),
    receiptSeparator(),
    "",
    `ORDER: ${order.order_number}`,
    order.table_number ? `TABLE: ${order.table_number}` : `Order type: ${formatSource(String(order.source))}`,
    `TIME:  ${new Date().toLocaleString()}`,
    `TYPE:  ${formatSourceLabel(String(order.source))}`,
    "",
    receiptSeparator(),
    "",
    ...items.flatMap((item) => [
      `${item.quantity} x ${item.name}`,
      item.parcel ? "Note: Parcel" : "",
      item.note ? `Note: ${item.note}` : "",
      ""
    ]),
    receiptSeparator()
  ]);

  return lines.join("\n");
}

export function buildAuditCopy(db: Database.Database, orderId: number): string {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown>;
  const items = db
    .prepare("SELECT name, quantity, unit_price, note, parcel, status FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId) as Array<{ name: string; quantity: number; unit_price: number; note: string | null; parcel: number; status: string }>;
  const totals = calculateOrderTotals(db, orderId);

  return [
    "YAMZO INTERNAL ORDER COPY",
    "--------------------------------",
    order.table_number ? `TABLE: ${order.table_number}` : `ORDER TYPE: ${formatSource(String(order.source))}`,
    `RECEIPT: ${order.order_number}`,
    `STATUS: ${formatSource(String(order.status))}`,
    `CREATED: ${order.created_at}`,
    `UPDATED: ${order.updated_at}`,
    order.first_kitchen_sent_at ? `KITCHEN SENT: ${order.first_kitchen_sent_at}` : "",
    order.kitchen_completed_at ? `DELIVERED: ${order.kitchen_completed_at}` : "",
    "--------------------------------",
    ...items.map((item) => {
      const flags = [item.parcel ? "PARCEL" : "", item.status !== "active" ? formatSource(item.status) : ""].filter(Boolean).join(", ");
      return `${item.quantity} x ${item.name}${flags ? ` [${flags}]` : ""}\n    ${item.unit_price} TK each    ${item.quantity * item.unit_price} TK${item.note ? `\n    Item note: ${item.note}` : ""}`;
    }),
    "--------------------------------",
    order.note ? `Internal note: ${String(order.note)}` : "Internal note: None",
    "--------------------------------",
    `Subtotal      ${totals.subtotal} TK`,
    totals.discount > 0 ? `Discount     -${totals.discount} TK` : "",
    `TOTAL         ${totals.total} TK`,
    ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildReceipt(
  db: Database.Database,
  orderId: number,
  branding: BrandingSettings,
  title = "RECEIPT",
  paymentInfo?: ReceiptPaymentInfo,
  options: { consolidateUnmodifiedItems?: boolean } = {}
): string {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown>;
  const items = loadReceiptItems(db, orderId, Boolean(options.consolidateUnmodifiedItems));
  const totals = calculateOrderTotals(db, orderId);
  const payments = db.prepare("SELECT method, amount FROM payments WHERE order_id = ?").all(orderId) as Array<{
    method: string;
    amount: number;
  }>;
  const { date, time } = formatReceiptDateTime();
  const addressLines = splitAddress(branding.address);
  const paymentLines = renderPaymentLines(payments, paymentInfo);
  const printsLogo = Boolean(branding.showLogo && branding.logoPath);
  const hostName = paymentInfo?.host?.trim() || "Cashier";

  return cleanReceiptLines([
    printsLogo ? "[[YAMZO_LOGO]]" : "",
    ...(printsLogo ? [] : [centerReceiptText((branding.restaurantName || "Yamzo").toUpperCase()), centerReceiptText("Taste The Fun, Dive Into Flavour"), ""]),
    ...(branding.showAddressPhone ? addressLines.map(centerReceiptText) : []),
    branding.showAddressPhone && branding.phone ? centerReceiptText(`Phone: ${branding.phone}`) : "",
    branding.emailWebsiteSocial ? centerReceiptText(`Email: ${branding.emailWebsiteSocial}`) : "",
    "",
    receiptSeparator(),
    centerReceiptText(title),
    receiptSeparator(),
    "",
    leftRightReceiptLine(`HOST: ${hostName}`, date),
    leftRightReceiptLine(`ORDER: ${String(order.order_number)}`, time),
    order.table_number ? receiptTextLine(`TABLE: ${order.table_number}`) : "",
    receiptTextLine(`TYPE:  ${formatSourceLabel(String(order.source))}`),
    "",
    receiptSeparator(),
    "",
    ...items.flatMap(renderReceiptItem),
    receiptSeparator(),
    "",
    leftRightReceiptLine("SUBTOTAL:", formatTk(totals.subtotal)),
    totals.discount > 0 ? leftRightReceiptLine("DISCOUNT:", `-${formatTk(totals.discount)}`) : "",
    ...paymentLines,
    "",
    receiptSeparator("="),
    leftRightReceiptLine("TOTAL:", formatTk(totals.total)),
    receiptSeparator("="),
    "",
    branding.vatText,
    "",
    ...(branding.showFooter ? wrapCenteredFooter("Thank you for dining with Yamzo. We would like to hear more from you. Please drop a review on our facebook by scanning the QR code below.") : []),
    branding.showQr && branding.qrPath ? "" : "",
    branding.showQr && branding.qrPath ? "[[YAMZO_REVIEW_QR]]" : "",
    branding.showQr && branding.qrPath ? "" : "",
    branding.showQr && branding.qrPath ? centerReceiptText("@yamzo.uttara") : "",
    "",
    ""
  ]).join("\n");
}

function loadReceiptItems(db: Database.Database, orderId: number, consolidateUnmodifiedItems: boolean): Array<{ name: string; quantity: number; unit_price: number; note: string | null; parcel: number }> {
  const items = db
    .prepare("SELECT name, quantity, unit_price, note, parcel FROM order_items WHERE order_id = ? AND status = 'active' ORDER BY id")
    .all(orderId) as Array<{ name: string; quantity: number; unit_price: number; note: string | null; parcel: number }>;
  if (!consolidateUnmodifiedItems) {
    return items;
  }
  const grouped = new Map<string, { name: string; quantity: number; unit_price: number; note: string | null; parcel: number }>();
  for (const item of items) {
    const key = JSON.stringify([item.name, item.unit_price, item.note ?? "", item.parcel]);
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      grouped.set(key, { ...item });
    }
  }
  return Array.from(grouped.values());
}

function formatSource(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function splitAddress(address: string): string[] {
  const normalized = address.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.includes(",")) {
    return normalized.split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (normalized.includes("Uttara")) {
    return normalized.replace(" Uttara", ", Uttara").split(",").map((part) => part.trim()).filter(Boolean);
  }
  return wrapReceiptText(normalized, 34);
}

function renderReceiptItem(item: { name: string; quantity: number; unit_price: number; note: string | null; parcel: number }): string[] {
  const itemTotal = item.quantity * item.unit_price;
  return [
    ...wrapReceiptText(item.name, 38),
    leftRightReceiptLine(`${item.quantity} x ${formatTk(item.unit_price)}`, formatTk(itemTotal)),
    item.parcel ? receiptTextLine("Note: Parcel") : "",
    item.note ? receiptTextLine(`Note: ${item.note}`) : ""
  ].filter(Boolean);
}

function cleanReceiptLines(lines: string[]): string[] {
  return lines.filter((line) => line !== null && line !== undefined);
}

function renderPaymentLines(payments: Array<{ method: string; amount: number }>, paymentInfo?: ReceiptPaymentInfo): string[] {
  if (paymentInfo) {
    if (!paymentInfo.paid) {
      return [receiptTextLine("PAYMENT: Unpaid")];
    }
    const method = formatSourceLabel(paymentInfo.method);
    const paidAmount = typeof paymentInfo.amount === "number" ? formatTk(paymentInfo.amount) : "Paid";
    const lines = [leftRightReceiptLine(`PAYMENT: ${method}`, paidAmount)];
    if (paymentInfo.reference?.trim()) {
      lines.push(receiptTextLine(`DETAILS: ${paymentInfo.reference.trim()}`));
    }
    return lines;
  }
  if (payments.length === 0) {
    return [receiptTextLine("PAYMENT: Unpaid")];
  }
  return payments.flatMap((payment) => [leftRightReceiptLine(`PAYMENT: ${formatSourceLabel(payment.method)}`, formatTk(payment.amount))]);
}

function wrapCenteredFooter(value: string): string[] {
  return wrapReceiptText(value, 34).map(centerReceiptText);
}
