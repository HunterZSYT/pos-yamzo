import type Database from "better-sqlite3";
import type { SalesSummary } from "../../shared/types.js";

export function getSalesSummary(db: Database.Database, start?: string, end?: string): SalesSummary {
  const where = start && end ? "WHERE o.created_at BETWEEN ? AND ?" : "";
  const params = start && end ? [start, end] : [];
  const orders = db.prepare(`SELECT status, source, discount FROM orders o ${where}`).all(...params) as Array<{
    status: string;
    source: string;
    discount: number;
  }>;
  const payments = db
    .prepare(`SELECT p.method, p.amount FROM payments p JOIN orders o ON o.id = p.order_id ${where}`)
    .all(...params) as Array<{ method: string; amount: number }>;
  const topItems = db
    .prepare(
      `SELECT oi.name, SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unit_price) AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${where ? `${where} AND` : "WHERE"} oi.status = 'active'
       GROUP BY oi.name
       ORDER BY quantity DESC
       LIMIT 10`
    )
    .all(...params) as Array<{ name: string; quantity: number; total: number }>;

  return {
    totalSales: payments.reduce((sum, payment) => sum + payment.amount, 0),
    totalOrders: orders.length,
    openOrders: orders.filter((order) => order.status === "open" || order.status === "kitchen_sent").length,
    settledOrders: orders.filter((order) => order.status === "settled").length,
    discountTotal: orders.reduce((sum, order) => sum + order.discount, 0),
    voidTotal: getVoidTotal(db, where, params),
    paymentBreakdown: groupMoney(payments, "method"),
    sourceBreakdown: groupCounts(orders, "source"),
    topItems,
    averageKitchenMinutes: getAverageKitchenMinutes(db, where, params)
  };
}

function getVoidTotal(db: Database.Database, where: string, params: string[]): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${where ? `${where} AND` : "WHERE"} oi.status = 'voided'`
    )
    .get(...params) as { total: number };
  return row.total ?? 0;
}

function groupMoney<T extends Record<string, string | number>>(rows: T[], key: keyof T): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const name = String(row[key]);
    acc[name] = (acc[name] ?? 0) + Number(row.amount ?? 0);
    return acc;
  }, {});
}

function groupCounts<T extends Record<string, string | number>>(rows: T[], key: keyof T): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const name = String(row[key]);
    acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {});
}

function getAverageKitchenMinutes(db: Database.Database, where: string, params: string[]): number {
  const row = db
    .prepare(
      `SELECT AVG((julianday(COALESCE(o.kitchen_completed_at, o.settled_at)) - julianday(o.first_kitchen_sent_at)) * 24 * 60) AS average
       FROM orders o
       ${where || "WHERE 1 = 1"}
       AND o.status = 'settled'
       AND o.first_kitchen_sent_at IS NOT NULL
       AND o.settled_at IS NOT NULL`
    )
    .get(...params) as { average: number | null };
  return Math.max(0, Math.round(row.average ?? 0));
}
