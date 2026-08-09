import type Database from "better-sqlite3";

export interface Totals {
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
}

export function calculateOrderTotals(db: Database.Database, orderId: number): Totals {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity * unit_price), 0) AS subtotal
       FROM order_items
       WHERE order_id = ? AND status = 'active'`
    )
    .get(orderId) as { subtotal: number };
  const order = db.prepare("SELECT discount, delivery_fee FROM orders WHERE id = ?").get(orderId) as { discount: number; delivery_fee: number };
  const subtotal = row.subtotal ?? 0;
  const deliveryFee = Math.max(0, order.delivery_fee ?? 0);
  const discount = Math.max(0, Math.min(order.discount ?? 0, subtotal + deliveryFee));
  return { subtotal, deliveryFee, discount, total: subtotal + deliveryFee - discount };
}
