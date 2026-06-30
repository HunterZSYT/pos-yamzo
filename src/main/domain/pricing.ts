import type Database from "better-sqlite3";

export interface Totals {
  subtotal: number;
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
  const order = db.prepare("SELECT discount FROM orders WHERE id = ?").get(orderId) as { discount: number };
  const subtotal = row.subtotal ?? 0;
  const discount = Math.max(0, Math.min(order.discount ?? 0, subtotal));
  return { subtotal, discount, total: subtotal - discount };
}
