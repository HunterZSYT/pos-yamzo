import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../src/main/database/connection";
import {
  addOrderItem,
  applyDiscount,
  createOrder,
  deleteOrder,
  markKitchenBatchDelivered,
  sendNewItemsToKitchen,
  settleOrder,
  updateOrderDate,
  voidOrderItem
} from "../src/main/domain/orders";
import { getSalesSummary } from "../src/main/domain/reports";
import { addCostRecord, addRestockEntry, listInventorySnapshot, saveMenuRecipe } from "../src/main/domain/inventory";
import { getMenuTypes, setMenuTypes } from "../src/main/services/settings";
import type { OrderSource, PaymentMethod } from "../src/shared/types";

let db: Database.Database | null = null;

function freshDb(): Database.Database {
  db = openMemoryDatabase();
  const columns = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "order_date")) {
    db.exec("ALTER TABLE orders ADD COLUMN order_date TEXT");
    db.prepare("UPDATE orders SET order_date = date(created_at, 'localtime') WHERE order_date IS NULL").run();
  }
  return db;
}

function addMenuItem(database: Database.Database, name: string, price: number): number {
  return Number(database.prepare("INSERT INTO menu_items (name, price) VALUES (?, ?)").run(name, price).lastInsertRowid);
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("orders and reports release behavior", () => {
  it("creates dated order numbers and collision-safely renumbers open, settled, and cancelled orders", () => {
    const database = freshDb();
    const menuItemId = addMenuItem(database, "Date Test Item", 100);
    const first = createOrder(database, { source: "parcel", orderDate: "2026-06-01" });
    const removedGap = createOrder(database, { source: "parcel", orderDate: "2026-06-01" });
    const third = createOrder(database, { source: "parcel", orderDate: "2026-06-01" });
    expect([first.orderNumber, removedGap.orderNumber, third.orderNumber]).toEqual([
      "yamzo-2026-jun-01-111",
      "yamzo-2026-jun-01-112",
      "yamzo-2026-jun-01-113"
    ]);
    database.prepare("DELETE FROM orders WHERE id = ?").run(removedGap.id);

    const openOrder = createOrder(database, { source: "parcel", orderDate: "2026-06-02" });
    expect(updateOrderDate(database, openOrder.id, "2026-06-01")).toMatchObject({
      status: "open",
      orderDate: "2026-06-01",
      orderNumber: "yamzo-2026-jun-01-114"
    });

    const settledOrder = createOrder(database, {
      source: "foodpanda",
      externalOrderId: "FP-UNCHANGED-42",
      orderDate: "2026-06-03"
    });
    addOrderItem(database, settledOrder.id, { menuItemId, quantity: 1 });
    const settledCreatedAt = settleOrder(database, settledOrder.id, "other").createdAt;
    const correctedSettled = updateOrderDate(database, settledOrder.id, "2026-06-01");
    expect(correctedSettled).toMatchObject({
      status: "settled",
      orderDate: "2026-06-01",
      orderNumber: "yamzo-2026-jun-01-115",
      externalOrderId: "FP-UNCHANGED-42",
      createdAt: settledCreatedAt
    });

    const cancelledOrder = createOrder(database, { source: "parcel", orderDate: "2026-06-04" });
    deleteOrder(database, cancelledOrder.id);
    expect(updateOrderDate(database, cancelledOrder.id, "2026-06-01")).toMatchObject({
      status: "cancelled",
      orderDate: "2026-06-01",
      orderNumber: "yamzo-2026-jun-01-116"
    });

    const audit = database
      .prepare("SELECT details FROM audit_logs WHERE action = 'update_order_date' AND entity_id = ?")
      .get(String(settledOrder.id)) as { details: string };
    expect(JSON.parse(audit.details)).toEqual({
      reason: "Manager date correction",
      before: { orderDate: "2026-06-03", orderNumber: "yamzo-2026-jun-03-111" },
      after: { orderDate: "2026-06-01", orderNumber: "yamzo-2026-jun-01-115" },
      externalOrderId: "FP-UNCHANGED-42"
    });
    expect(() => updateOrderDate(database, first.id, "2026-02-30")).toThrow("invalid");

    const beforeCreate = new Date();
    const defaultDatedOrder = createOrder(database, { source: "parcel" });
    const afterCreate = new Date();
    const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    expect([localDate(beforeCreate), localDate(afterCreate)]).toContain(defaultDatedOrder.orderDate);
  });

  it("settles kitchen timers in the same transaction as payment and inventory snapshots", () => {
    const database = freshDb();
    const firstMenuItemId = addMenuItem(database, "Timer Item One", 100);
    const secondMenuItemId = addMenuItem(database, "Timer Item Two", 150);
    const order = createOrder(database, { source: "in_house", tableNumber: "T1", orderDate: "2026-07-01" });
    addOrderItem(database, order.id, { menuItemId: firstMenuItemId, quantity: 1 });
    sendNewItemsToKitchen(database, order.id);
    const firstTicket = database.prepare("SELECT id FROM kitchen_tickets WHERE order_id = ? ORDER BY id LIMIT 1").get(order.id) as { id: number };
    const completedFirstBatch = markKitchenBatchDelivered(database, firstTicket.id).batches[0].completedAt;
    addOrderItem(database, order.id, { menuItemId: secondMenuItemId, quantity: 1 });
    sendNewItemsToKitchen(database, order.id);

    database.exec(`
      CREATE TRIGGER fail_settlement_for_atomicity
      BEFORE UPDATE OF status ON orders
      WHEN NEW.status = 'settled'
      BEGIN
        SELECT RAISE(ABORT, 'forced settlement failure');
      END;
    `);
    expect(() => settleOrder(database, order.id, "cash")).toThrow("forced settlement failure");
    expect(database.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ?").get(order.id)).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM order_cost_snapshots WHERE order_id = ?").get(order.id)).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id = ? AND completed_at IS NULL").get(order.id)).toMatchObject({ count: 1 });
    database.exec("DROP TRIGGER fail_settlement_for_atomicity");

    const settled = settleOrder(database, order.id, "cash");
    expect(settled.status).toBe("settled");
    expect(settled.kitchenCompletedAt).toBeTruthy();
    expect(settled.batches.every((batch) => batch.completedAt)).toBe(true);
    expect(settled.batches[0].completedAt).toBe(completedFirstBatch);
    expect(database.prepare("SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id = ? AND completed_at IS NULL").get(order.id)).toMatchObject({ count: 0 });
  });

  it("uses order dates for open-ended report filters and returns monetary source and payment totals", () => {
    const database = freshDb();
    setMenuTypes(
      database,
      getMenuTypes(database).map((type) => (type.key === "foodpanda" ? { ...type, commissionPercent: 20 } : type))
    );
    const saleItemId = addMenuItem(database, "Report Item", 100);
    const voidItemId = addMenuItem(database, "Voided Report Item", 50);

    function completeSale(
      source: OrderSource,
      orderDate: string,
      quantity: number,
      discount: number,
      paymentMethod: PaymentMethod
    ): number {
      const order = createOrder(database, { source, orderDate });
      addOrderItem(database, order.id, { menuItemId: saleItemId, quantity });
      if (discount) applyDiscount(database, order.id, discount);
      settleOrder(database, order.id, paymentMethod);
      return order.id;
    }

    completeSale("in_house", "2026-07-01", 2, 20, "cash");
    const foodpandaOrder = createOrder(database, { source: "foodpanda", orderDate: "2026-07-02" });
    addOrderItem(database, foodpandaOrder.id, { menuItemId: saleItemId, quantity: 3 });
    const voidedLineId = addOrderItem(database, foodpandaOrder.id, { menuItemId: voidItemId, quantity: 1 });
    voidOrderItem(database, voidedLineId, "Customer correction");
    applyDiscount(database, foodpandaOrder.id, 30);
    settleOrder(database, foodpandaOrder.id, "other");
    completeSale("parcel", "2026-07-03", 1, 0, "cash");
    createOrder(database, { source: "parcel", orderDate: "2026-07-02" });
    createOrder(database, { source: "parcel", orderDate: "2026-07-10" });

    const summary = getSalesSummary(database, { startDate: "2026-07-01", endDate: "2026-07-02" });
    expect(summary).toMatchObject({
      totalSales: 450,
      grossSales: 500,
      netSales: 450,
      discountTotal: 50,
      commissionTotal: 54,
      netAfterCommission: 396,
      averageOrderValue: 225,
      totalOrders: 2,
      settledOrders: 2,
      openOrders: 1,
      voidTotal: 50,
      sourceBreakdown: { in_house: 1, foodpanda: 1 },
      paymentBreakdown: { other: 270, cash: 180 }
    });
    expect(summary.sourceTotals).toEqual([
      { source: "in_house", orders: 1, grossSales: 200, discount: 20, netSales: 180, commission: 0, netAfterCommission: 180 },
      { source: "foodpanda", orders: 1, grossSales: 300, discount: 30, netSales: 270, commission: 54, netAfterCommission: 216 }
    ]);
    expect(summary.paymentTotals).toEqual([
      { method: "other", orders: 1, amount: 270 },
      { method: "cash", orders: 1, amount: 180 }
    ]);
    expect(summary.topItems).toContainEqual({ name: "Report Item", quantity: 5, total: 500 });

    expect(getSalesSummary(database, { endDate: "2026-07-01" }).totalOrders).toBe(1);
    expect(getSalesSummary(database, "2026-07-02 00:00:00").totalOrders).toBe(2);
    expect(() => getSalesSummary(database, { startDate: "2026-07-03", endDate: "2026-07-01" })).toThrow("after end date");
  });

  it("uses editable order dates for complete raw-material and recorded-cost operational totals", () => {
    const database = freshDb();
    const menuItemId = addMenuItem(database, "Operational Cost Bowl", 300);
    const unit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
    const category = database.prepare("SELECT id FROM inventory_categories ORDER BY id LIMIT 1").get() as { id: number };
    const ingredientId = Number(
      database
        .prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES ('Operational Chicken', ?, ?, 0)")
        .run(category.id, unit.id).lastInsertRowid
    );
    addRestockEntry(database, {
      inventoryItemId: ingredientId,
      quantity: 1000,
      totalCost: 1000,
      entryDate: "2026-07-01T08:00:00"
    });
    const insertRestock = database.prepare(
      `INSERT INTO inventory_restock_entries
       (inventory_item_id, quantity_base, unit_label, total_cost, price_per_base, entry_date)
       VALUES (?, 1, 'g', ?, ?, ?)`
    );
    const insertPhysicalCount = database.prepare(
      `INSERT INTO inventory_physical_counts
       (inventory_item_id, quantity_base, reduction_delta, unit_label, count_date, source)
       VALUES (?, 0, 0, 'g', ?, 'manual')`
    );
    database.transaction(() => {
      for (let index = 0; index < 125; index += 1) {
        insertRestock.run(ingredientId, 2, 2, "2026-07-01 09:00:00");
      }
      insertRestock.run(ingredientId, 7, 7, "2026-07-02 09:00:00");
      insertPhysicalCount.run(ingredientId, "2026-07-01 10:00:00");
      insertPhysicalCount.run(ingredientId, "2026-07-01 11:00:00");
      insertPhysicalCount.run(ingredientId, "2026-07-02 10:00:00");
    })();
    saveMenuRecipe(database, {
      menuItemId,
      ingredients: [{ inventoryItemId: ingredientId, quantityBase: 100, unitLabel: "g" }]
    });
    const order = createOrder(database, { source: "parcel", orderDate: "2026-07-01" });
    addOrderItem(database, order.id, { menuItemId, quantity: 1 });
    settleOrder(database, order.id, "cash");

    const costCategory = database.prepare("SELECT id FROM cost_categories ORDER BY id LIMIT 1").get() as { id: number };
    addCostRecord(database, { categoryId: costCategory.id, costName: "July 1 utility", amount: 50, costDate: "2026-07-01" });
    addCostRecord(database, { categoryId: costCategory.id, costName: "July 2 utility", amount: 70, costDate: "2026-07-02" });

    expect(getSalesSummary(database, { startDate: "2026-07-01", endDate: "2026-07-01" })).toMatchObject({
      netAfterCommission: 300,
      rawMaterialCost: 100,
      recordedCostTotal: 50,
      costRecordCount: 1,
      inventoryRestockSpend: 1250,
      inventoryRestockCount: 126,
      inventoryPhysicalCountCount: 2,
      operatingProfit: 150,
      rawMaterialUsage: [{ inventoryItemId: ingredientId, itemName: "Operational Chicken", quantityBase: 100, unitLabel: "g", rawCost: 100 }]
    });

    updateOrderDate(database, order.id, "2026-07-02");
    expect(getSalesSummary(database, { startDate: "2026-07-01", endDate: "2026-07-01" })).toMatchObject({
      totalOrders: 0,
      rawMaterialCost: 0,
      recordedCostTotal: 50,
      costRecordCount: 1,
      inventoryRestockSpend: 1250,
      inventoryRestockCount: 126,
      inventoryPhysicalCountCount: 2,
      operatingProfit: -50,
      rawMaterialUsage: []
    });
    expect(getSalesSummary(database, { startDate: "2026-07-02", endDate: "2026-07-02" })).toMatchObject({
      totalOrders: 1,
      rawMaterialCost: 100,
      recordedCostTotal: 70,
      costRecordCount: 1,
      inventoryRestockSpend: 7,
      inventoryRestockCount: 1,
      inventoryPhysicalCountCount: 1,
      operatingProfit: 130,
      rawMaterialUsage: [{ inventoryItemId: ingredientId, quantityBase: 100, rawCost: 100 }]
    });

    database.prepare("UPDATE order_item_cost_snapshots SET details_json = 'not-json' WHERE order_id = ?").run(order.id);
    const malformed = getSalesSummary(database, { startDate: "2026-07-02", endDate: "2026-07-02" });
    expect(malformed.rawMaterialCost).toBe(100);
    expect(malformed.rawMaterialUsage).toEqual([]);
  });

  it("loads inventory event details for an older range beyond the latest snapshot cap", () => {
    const database = freshDb();
    const unit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
    const category = database.prepare("SELECT id FROM inventory_categories ORDER BY id LIMIT 1").get() as { id: number };
    const ingredientId = Number(database.prepare(
      "INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES ('Archived-range flour', ?, ?, 0)"
    ).run(category.id, unit.id).lastInsertRowid);
    const insert = database.prepare(
      `INSERT INTO inventory_restock_entries
       (inventory_item_id, quantity_base, unit_label, total_cost, price_per_base, entry_date)
       VALUES (?, 1, 'g', 5, 5, ?)`
    );
    const olderId = Number(insert.run(ingredientId, "2026-06-01 09:00:00").lastInsertRowid);
    database.transaction(() => {
      for (let index = 0; index < 125; index += 1) {
        insert.run(ingredientId, `2026-07-01 09:${String(index % 60).padStart(2, "0")}:00`);
      }
    })();

    const snapshot = listInventorySnapshot(database);
    expect(snapshot.restocks).toHaveLength(120);
    expect(snapshot.restocks.some((entry) => entry.id === olderId)).toBe(false);
    expect(getSalesSummary(database, { startDate: "2026-06-01", endDate: "2026-06-01" })).toMatchObject({
      inventoryRestockCount: 1,
      inventoryRestockSpend: 5,
      inventoryPhysicalCountCount: 0,
      inventoryEvents: [{
        id: olderId,
        eventType: "restock",
        timestamp: "2026-06-01 09:00:00",
        itemName: "Archived-range flour",
        quantityBase: 1,
        unitLabel: "g",
        totalCost: 5
      }]
    });
  });
});
