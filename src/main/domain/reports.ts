import type Database from "better-sqlite3";
import type { InventoryReportEvent, SalesSummary } from "../../shared/types.js";
import { getMenuTypes } from "../services/settings.js";

interface SalesRange {
  startDate?: string;
  endDate?: string;
}

interface SettledOrderRow {
  id: number;
  source: string;
  discount: number;
  gross_sales: number;
}

interface SourceAccumulator {
  source: string;
  orders: number;
  grossSales: number;
  discount: number;
  netSales: number;
}

interface RawMaterialUsageAccumulator {
  inventoryItemId: number;
  itemName: string;
  quantityBase: number;
  unitLabel: string;
  rawCost: number;
}

export function getSalesSummary(
  db: Database.Database,
  startOrRange?: string | SalesRange,
  end?: string
): SalesSummary {
  const range = resolveDateRange(startOrRange, end);
  const { where, params } = buildSettledOrderFilter(range);
  const orders = db
    .prepare(
      `SELECT o.id, o.source, o.discount,
              COALESCE(SUM(CASE WHEN oi.status = 'active' THEN oi.quantity * oi.unit_price ELSE 0 END), 0) + o.delivery_fee AS gross_sales
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       ${where}
       GROUP BY o.id, o.source, o.discount, o.delivery_fee`
    )
    .all(...params) as SettledOrderRow[];
  const payments = db
    .prepare(`SELECT p.order_id, p.method, p.amount FROM payments p JOIN orders o ON o.id = p.order_id ${where}`)
    .all(...params) as Array<{ order_id: number; method: string; amount: number }>;
  const menuTypes = getMenuTypes(db);
  const commissionBySource = new Map(menuTypes.map((type) => [type.key, type.commissionPercent]));
  const menuTypeOrder = new Map(menuTypes.map((type, index) => [type.key, index]));

  const sourceAccumulators = new Map<string, SourceAccumulator>();
  for (const order of orders) {
    const grossSales = Math.max(0, Number(order.gross_sales) || 0);
    const discount = Math.min(grossSales, Math.max(0, Number(order.discount) || 0));
    const current = sourceAccumulators.get(order.source) ?? {
      source: order.source,
      orders: 0,
      grossSales: 0,
      discount: 0,
      netSales: 0
    };
    current.orders += 1;
    current.grossSales += grossSales;
    current.discount += discount;
    current.netSales += grossSales - discount;
    sourceAccumulators.set(order.source, current);
  }

  const sourceTotals = Array.from(sourceAccumulators.values())
    .map((source) => {
      const commission = roundMoney((source.netSales * (commissionBySource.get(source.source) ?? 0)) / 100);
      const grossSales = roundMoney(source.grossSales);
      const discount = roundMoney(source.discount);
      const netSales = roundMoney(source.netSales);
      return {
        source: source.source,
        orders: source.orders,
        grossSales,
        discount,
        netSales,
        commission,
        netAfterCommission: roundMoney(netSales - commission)
      };
    })
    .sort((left, right) => {
      const leftIndex = menuTypeOrder.get(left.source) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = menuTypeOrder.get(right.source) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || left.source.localeCompare(right.source);
    });
  const paymentTotals = buildPaymentTotals(payments);
  const grossSales = roundMoney(sourceTotals.reduce((sum, source) => sum + source.grossSales, 0));
  const discountTotal = roundMoney(sourceTotals.reduce((sum, source) => sum + source.discount, 0));
  const netSales = roundMoney(sourceTotals.reduce((sum, source) => sum + source.netSales, 0));
  const commissionTotal = roundMoney(sourceTotals.reduce((sum, source) => sum + source.commission, 0));
  const netAfterCommission = roundMoney(netSales - commissionTotal);
  const rawMaterials = getRawMaterialMetrics(db, where, params);
  const recordedCosts = getRecordedCostMetrics(db, range);
  const inventoryEvents = getInventoryEventMetrics(db, range);
  const operatingProfit = roundMoney(netAfterCommission - rawMaterials.total - recordedCosts.total);
  const guestMetrics = db.prepare(
    `SELECT COALESCE(SUM(o.guest_count), 0) AS guests, COUNT(*) AS orders
     FROM orders o ${where} AND o.table_number IS NOT NULL`
  ).get(...params) as { guests: number; orders: number };
  const topItems = db
    .prepare(
      `SELECT oi.name, SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unit_price) AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${where} AND oi.status = 'active'
       GROUP BY oi.name
       ORDER BY quantity DESC, total DESC, oi.name ASC
       LIMIT 10`
    )
    .all(...params) as Array<{ name: string; quantity: number; total: number }>;

  return {
    totalSales: netSales,
    grossSales,
    netSales,
    netAfterCommission,
    averageOrderValue: orders.length ? roundMoney(netSales / orders.length) : 0,
    totalOrders: orders.length,
    openOrders: getOpenOrderCount(db, range),
    settledOrders: orders.length,
    dineInGuests: Number(guestMetrics.guests) || 0,
    averageGuestsPerDineInOrder: guestMetrics.orders ? roundMoney(guestMetrics.guests / guestMetrics.orders) : 0,
    discountTotal,
    voidTotal: getVoidTotal(db, where, params),
    commissionTotal,
    paymentBreakdown: Object.fromEntries(paymentTotals.map((payment) => [payment.method, payment.amount])),
    paymentTotals,
    sourceBreakdown: Object.fromEntries(sourceTotals.map((source) => [source.source, source.orders])),
    sourceTotals,
    topItems: topItems.map((item) => ({ ...item, total: roundMoney(item.total) })),
    rawMaterialCost: rawMaterials.total,
    recordedCostTotal: recordedCosts.total,
    costRecordCount: recordedCosts.count,
    inventoryRestockSpend: inventoryEvents.restockSpend,
    inventoryRestockCount: inventoryEvents.restockCount,
    inventoryPhysicalCountCount: inventoryEvents.physicalCountCount,
    inventoryEvents: inventoryEvents.events,
    operatingProfit,
    rawMaterialUsage: rawMaterials.usage,
    averageKitchenMinutes: getAverageKitchenMinutes(db, where, params)
  };
}

function resolveDateRange(startOrRange?: string | SalesRange, end?: string): SalesRange {
  const startValue = typeof startOrRange === "string" ? startOrRange : startOrRange?.startDate;
  const endValue = typeof startOrRange === "string" ? end : startOrRange?.endDate;
  const startDate = startValue ? normalizeReportDate(startValue) : undefined;
  const endDate = endValue ? normalizeReportDate(endValue) : undefined;
  if (startDate && endDate && startDate > endDate) {
    throw new Error("Report start date cannot be after end date.");
  }
  return { startDate, endDate };
}

function buildSettledOrderFilter(range: SalesRange): { where: string; params: string[] } {
  const clauses = ["o.status = 'settled'", "o.is_test = 0"];
  const params: string[] = [];
  if (range.startDate) {
    clauses.push("o.order_date >= ?");
    params.push(range.startDate);
  }
  if (range.endDate) {
    clauses.push("o.order_date <= ?");
    params.push(range.endDate);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function buildPaymentTotals(
  payments: Array<{ order_id: number; method: string; amount: number }>
): Array<{ method: string; orders: number; amount: number }> {
  const totals = new Map<string, { method: string; orderIds: Set<number>; amount: number }>();
  for (const payment of payments) {
    const current = totals.get(payment.method) ?? { method: payment.method, orderIds: new Set<number>(), amount: 0 };
    current.orderIds.add(payment.order_id);
    current.amount += Number(payment.amount) || 0;
    totals.set(payment.method, current);
  }
  return Array.from(totals.values())
    .map((payment) => ({ method: payment.method, orders: payment.orderIds.size, amount: roundMoney(payment.amount) }))
    .sort((left, right) => right.amount - left.amount || left.method.localeCompare(right.method));
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
  return roundMoney(row.total ?? 0);
}

function getOpenOrderCount(db: Database.Database, range: SalesRange): number {
  const clauses = ["status IN ('open', 'kitchen_sent')", "is_test = 0"];
  const params: string[] = [];
  if (range.startDate) {
    clauses.push("order_date >= ?");
    params.push(range.startDate);
  }
  if (range.endDate) {
    clauses.push("order_date <= ?");
    params.push(range.endDate);
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE ${clauses.join(" AND ")}`).get(...params) as { count: number };
  return row.count;
}

function getRawMaterialMetrics(
  db: Database.Database,
  where: string,
  params: string[]
): { total: number; usage: RawMaterialUsageAccumulator[] } {
  const rows = db
    .prepare(
      `SELECT oics.quantity, oics.raw_cost, oics.details_json
       FROM order_item_cost_snapshots oics
       JOIN orders o ON o.id = oics.order_id
       ${where}`
    )
    .all(...params) as Array<{ quantity: number; raw_cost: number; details_json: string | null }>;
  const totals = new Map<string, RawMaterialUsageAccumulator>();
  for (const row of rows) {
    const quantity = Number(row.quantity) || 0;
    for (const ingredient of parseRawMaterialDetails(row.details_json)) {
      const key = `${ingredient.inventoryItemId}:${ingredient.unitLabel}`;
      const current = totals.get(key) ?? {
        inventoryItemId: ingredient.inventoryItemId,
        itemName: ingredient.itemName,
        quantityBase: 0,
        unitLabel: ingredient.unitLabel,
        rawCost: 0
      };
      current.quantityBase += ingredient.quantityBase * quantity;
      current.rawCost += ingredient.rawCost * quantity;
      totals.set(key, current);
    }
  }
  return {
    total: roundMoney(rows.reduce((sum, row) => sum + (Number(row.raw_cost) || 0), 0)),
    usage: Array.from(totals.values())
      .map((item) => ({ ...item, quantityBase: roundQuantity(item.quantityBase), rawCost: roundMoney(item.rawCost) }))
      .sort((left, right) => right.rawCost - left.rawCost || left.itemName.localeCompare(right.itemName))
  };
}

function getRecordedCostMetrics(db: Database.Database, range: SalesRange): { total: number; count: number } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (range.startDate) {
    clauses.push("date(cost_date) >= date(?)");
    params.push(range.startDate);
  }
  if (range.endDate) {
    clauses.push("date(cost_date) <= date(?)");
    params.push(range.endDate);
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM cost_records${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`
    )
    .get(...params) as { total: number; count: number };
  return { total: roundMoney(Number(row.total) || 0), count: Number(row.count) || 0 };
}

function getInventoryEventMetrics(
  db: Database.Database,
  range: SalesRange
): { restockSpend: number; restockCount: number; physicalCountCount: number; events: InventoryReportEvent[] } {
  const restockFilter = buildInventoryEventDateFilter("entry_date", range);
  const restocks = db.prepare(
    `SELECT COALESCE(SUM(total_cost), 0) AS spend, COUNT(*) AS count
     FROM inventory_restock_entries${restockFilter.where}`
  ).get(...restockFilter.params) as { spend: number; count: number };
  const countFilter = buildInventoryEventDateFilter("count_date", range);
  const physicalCounts = db.prepare(
    `SELECT COUNT(*) AS count FROM inventory_physical_counts${countFilter.where}`
  ).get(...countFilter.params) as { count: number };
  const restockEvents = db.prepare(
    `SELECT re.id, COALESCE(re.entry_type, 'purchase') AS entry_type, re.entry_date AS event_time,
            ii.name AS item_name, re.quantity_base, re.unit_label, re.total_cost
     FROM inventory_restock_entries re
     JOIN inventory_items ii ON ii.id = re.inventory_item_id${restockFilter.where}
     ORDER BY datetime(re.entry_date) DESC, re.id DESC
     LIMIT 8`
  ).all(...restockFilter.params).map((row) => {
    const event = row as { id: number; entry_type: string; event_time: string; item_name: string; quantity_base: number; unit_label: string; total_cost: number };
    return {
      id: event.id,
      eventType: event.entry_type === "adjustment" ? "adjustment" as const : "restock" as const,
      timestamp: event.event_time,
      itemName: event.item_name,
      quantityBase: Number(event.quantity_base) || 0,
      unitLabel: event.unit_label,
      totalCost: roundMoney(Number(event.total_cost) || 0)
    };
  });
  const physicalCountEvents = db.prepare(
    `SELECT pc.id, pc.count_date AS event_time, ii.name AS item_name, pc.quantity_base, pc.unit_label
     FROM inventory_physical_counts pc
     JOIN inventory_items ii ON ii.id = pc.inventory_item_id${countFilter.where}
     ORDER BY datetime(pc.count_date) DESC, pc.id DESC
     LIMIT 8`
  ).all(...countFilter.params).map((row) => {
    const event = row as { id: number; event_time: string; item_name: string; quantity_base: number; unit_label: string };
    return {
      id: event.id,
      eventType: "physical_count" as const,
      timestamp: event.event_time,
      itemName: event.item_name,
      quantityBase: Number(event.quantity_base) || 0,
      unitLabel: event.unit_label,
      totalCost: 0
    };
  });
  return {
    restockSpend: roundMoney(Number(restocks.spend) || 0),
    restockCount: Number(restocks.count) || 0,
    physicalCountCount: Number(physicalCounts.count) || 0,
    events: [...restockEvents, ...physicalCountEvents]
      .sort((left, right) => {
        const timeDifference = parseReportEventTimestamp(right.timestamp) - parseReportEventTimestamp(left.timestamp);
        return timeDifference || right.id - left.id;
      })
      .slice(0, 8)
  };
}

function buildInventoryEventDateFilter(column: "entry_date" | "count_date", range: SalesRange): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (range.startDate) {
    clauses.push(`date(${column}) >= date(?)`);
    params.push(range.startDate);
  }
  if (range.endDate) {
    clauses.push(`date(${column}) <= date(?)`);
    params.push(range.endDate);
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function parseRawMaterialDetails(value: string | null): RawMaterialUsageAccumulator[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Record<string, unknown>;
      const inventoryItemId = Number(item.inventoryItemId);
      const itemName = typeof item.itemName === "string" ? item.itemName.trim() : "";
      const quantityBase = Number(item.quantityBase);
      const unitLabel = typeof item.unitLabel === "string" ? item.unitLabel.trim() : "";
      const rawCost = Number(item.rawCost);
      if (!Number.isInteger(inventoryItemId) || inventoryItemId <= 0 || !itemName || !unitLabel) return [];
      if (!Number.isFinite(quantityBase) || quantityBase <= 0 || !Number.isFinite(rawCost) || rawCost < 0) return [];
      return [{ inventoryItemId, itemName, quantityBase, unitLabel, rawCost }];
    });
  } catch {
    return [];
  }
}

function getAverageKitchenMinutes(db: Database.Database, where: string, params: string[]): number {
  const row = db
    .prepare(
      `SELECT AVG(
         CASE
           WHEN julianday(COALESCE(o.kitchen_completed_at, o.settled_at)) >= julianday(o.first_kitchen_sent_at)
             THEN (julianday(COALESCE(o.kitchen_completed_at, o.settled_at)) - julianday(o.first_kitchen_sent_at)) * 24 * 60
           ELSE NULL
         END
       ) AS average
       FROM orders o
       ${where}
       AND o.first_kitchen_sent_at IS NOT NULL
       AND o.settled_at IS NOT NULL`
    )
    .get(...params) as { average: number | null };
  return Math.max(0, Math.round(row.average ?? 0));
}

function normalizeReportDate(value: string): string {
  const date = value.trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error("Report date must use YYYY-MM-DD.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error("Report date is invalid.");
  }
  return date;
}

function parseReportEventTimestamp(value: string): number {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
