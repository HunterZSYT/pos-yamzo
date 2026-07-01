import type Database from "better-sqlite3";
import type { SalesSummary } from "../../shared/types.js";
import { getMenuTypes } from "../services/settings.js";

export function getSalesSummary(db: Database.Database, start?: string, end?: string): SalesSummary {
  const where = start && end ? "WHERE o.settled_at BETWEEN ? AND ? AND o.status = 'settled'" : "WHERE o.status = 'settled'";
  const params = start && end ? [start, end] : [];
  const orders = db.prepare(`SELECT status, source, discount FROM orders o ${where}`).all(...params) as Array<{
    status: string;
    source: string;
    discount: number;
  }>;
  const payments = db
    .prepare(`SELECT p.method, p.amount FROM payments p JOIN orders o ON o.id = p.order_id ${where}`)
    .all(...params) as Array<{ method: string; amount: number }>;
  const commissionBySource = new Map(getMenuTypes(db).map((type) => [type.key, type.commissionPercent]));
  const topItems = db
    .prepare(
      `SELECT oi.name, SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unit_price) AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${where} AND oi.status = 'active'
       GROUP BY oi.name
       ORDER BY quantity DESC
       LIMIT 10`
    )
    .all(...params) as Array<{ name: string; quantity: number; total: number }>;

  return {
    totalSales: payments.reduce((sum, payment) => sum + payment.amount, 0),
    totalOrders: orders.length,
    openOrders: getOpenOrderCount(db),
    settledOrders: orders.filter((order) => order.status === "settled").length,
    discountTotal: orders.reduce((sum, order) => sum + order.discount, 0),
    voidTotal: getVoidTotal(db, where, params),
    commissionTotal: getCommissionTotal(db, where, params, commissionBySource),
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
       ${where} AND oi.status = 'voided'`
    )
    .get(...params) as { total: number };
  return row.total ?? 0;
}

function getOpenOrderCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('open', 'kitchen_sent')").get() as { count: number };
  return row.count;
}

function getCommissionTotal(db: Database.Database, where: string, params: string[], commissionBySource: Map<string, number>): number {
  const rows = db
    .prepare(`SELECT o.source, COALESCE(SUM(p.amount), 0) AS amount FROM payments p JOIN orders o ON o.id = p.order_id ${where} GROUP BY o.source`)
    .all(...params) as Array<{ source: string; amount: number }>;
  return Math.round(rows.reduce((sum, row) => sum + (row.amount * (commissionBySource.get(row.source) ?? 0)) / 100, 0));
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
