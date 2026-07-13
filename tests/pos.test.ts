import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../src/main/database/connection";
import { login, changePassword } from "../src/main/domain/auth";
import {
  addOrderItem,
  applyDiscount,
  createOrder,
  deleteOrder,
  getOrderDetail,
  clearOrderHistory,
  listOpenOrders,
  markKitchenDelivered,
  orderHasKitchenPrintedItems,
  printAuditCopy,
  printBillCopy,
  reopenOrder,
  removeOrderItem,
  restartKitchenTimer,
  sendNewItemsToKitchen,
  settleOrder,
  updateOrderInfo,
  updateOrderItem,
  updateOrderNote
} from "../src/main/domain/orders";
import { reprintKitchenCopy, reprintReceipt, voidOrderItem } from "../src/main/domain/orders";
import { getSalesSummary } from "../src/main/domain/reports";
import {
  addCostRecord,
  addPhysicalCount,
  addPriceRecord,
  addRestockEntry,
  applyInventoryBackfill,
  deleteCostRecord,
  deletePhysicalCount,
  deleteRestockEntry,
  importInventoryItemsCsv,
  importRecipeInventoryCsv,
  listInventorySnapshot,
  previewInventoryBackfill,
  saveMenuRecipe,
  setRecipeUseInRecipeEnabled,
  updateCostRecord,
  updatePhysicalCount
} from "../src/main/domain/inventory";
import { archiveMenuItem, deleteMenuItem, importMenuCsv, listMenuItems, parsePrice, saveMenuItem } from "../src/main/services/menuImport";
import { getBrandingSettings, getHostNames, getMenuData, getTotalTables, setBrandingSettings, setHostNames, setInventoryTracking, getSetting, setMenuData, setMenuTypes, setPrinterName, setTotalTables } from "../src/main/services/settings";
import { buildDailySalesEmail, clearGmailAuth, getEmailSettings, saveEmailSettings } from "../src/main/services/email";
import { renderReceiptHtml } from "../src/main/services/printer";
import { getPrintJob, listPrintJobs, markPrintJobFailed, markPrintJobRetry } from "../src/main/services/printQueue";
import { buildAuditCopy, buildKitchenTicket, buildReceipt } from "../src/main/services/receipts";
import { listActivityLogs, recordProtectedPanelAccess } from "../src/main/services/audit";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let db: Database.Database | null = null;

function freshDb() {
  db = openMemoryDatabase();
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("Yamzo POS core", () => {
  it("supports default admin login and password change", () => {
    const database = freshDb();
    expect(login(database, "admin", "1234")?.username).toBe("admin");
    expect(changePassword(database, "admin", "1234", "9876")).toBe(true);
    expect(login(database, "admin", "1234")).toBeNull();
    expect(login(database, "admin", "9876")?.username).toBe("admin");
    expect(changePassword(database, "admin", "336000", "1234")).toBe(true);
    expect(login(database, "admin", "1234")?.username).toBe("admin");
  }, 10000);

  it("imports menu CSV rows and parses TK prices", () => {
    const database = freshDb();
    const file = path.join(os.tmpdir(), `yamzo-menu-${Date.now()}.csv`);
    fs.writeFileSync(file, "SL,Item Name,Price\n1,Front Page,\n2,Chicken Momo,190 TK\n3,Ocean Pasta,450 TK\n");
    expect(parsePrice("190 TK")).toBe(190);
    const result = importMenuCsv(database, file);
    expect(result.imported).toBe(2);
    const secondResult = importMenuCsv(database, file);
    expect(secondResult).toMatchObject({ imported: 0, updated: 2, skipped: 1 });
    expect(listMenuItems(database).map((item) => item.name)).toEqual(["Chicken Momo", "Ocean Pasta"]);
    fs.writeFileSync(file, "SL,Item Name,Price\n1,Chicken Momo,210 TK\n");
    expect(importMenuCsv(database, file)).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(listMenuItems(database).find((item) => item.name === "Chicken Momo")?.price).toBe(210);
    fs.unlinkSync(file);
  });

  it("manages menu items manually and archives used items safely", () => {
    const database = freshDb();
    const item = saveMenuItem(database, { name: "Beef Momo", price: 260, category: "Momo", available: true });
    expect(listMenuItems(database).some((row) => row.name === "Beef Momo")).toBe(true);
    const edited = saveMenuItem(database, { id: item.id, name: "Beef Cheese Momo", price: 290, category: "Momo", available: false });
    expect(edited.available).toBe(false);
    deleteMenuItem(database, item.id);
    expect(listMenuItems(database).some((row) => row.id === item.id)).toBe(false);

    const used = saveMenuItem(database, { name: "Chicken Roll", price: 180, category: "Roll", available: true });
    const order = createOrder(database, { source: "takeaway" });
    addOrderItem(database, order.id, { menuItemId: used.id, quantity: 1 });
    deleteMenuItem(database, used.id);
    expect(listMenuItems(database).some((row) => row.id === used.id)).toBe(false);
  });

  it("creates orders, kitchen tickets, addition KOT, discounts, settlement, and print jobs", () => {
    const database = freshDb();
    setPrinterName(database, "Xprinter COM8 Receipt (Generic)");
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 190), ('Pasta', 450)").run();
    const menu = listMenuItems(database);
    const order = createOrder(database, { source: "in_house", tableNumber: "A1" });
    expect(order.orderNumber).toMatch(/^yamzo-\d{4}-[a-z]{3}-\d{2}-111$/);
    const parcelLineId = addOrderItem(database, order.id, { menuItemId: menu[0].id, quantity: 2, parcel: true });
    const firstKitchenPrintId = sendNewItemsToKitchen(database, order.id);
    expect(firstKitchenPrintId).toBeTypeOf("number");
    expect(getPrintJob(database, firstKitchenPrintId ?? 0).type).toBe("kot");
    expect(getOrderDetail(database, order.id).kitchenStartedAt).toBeTruthy();
    const resumed = getOrderDetail(database, order.id);
    expect(resumed.items).toHaveLength(1);
    expect(resumed.itemCount).toBe(2);
    expect(resumed.itemPreview).toContain("Chicken Momo");
    expect(resumed.batches).toHaveLength(1);
    expect(resumed.batches[0].label).toBe("Batch 1");
    expect(resumed.items[0].kitchenPrinted).toBe(true);
    expect(resumed.items[0].parcel).toBe(true);
    expect(buildKitchenTicket(database, order.id, [parcelLineId])).toContain("Note: Parcel");
    updateOrderNote(database, order.id, "Internal kitchen issue");
    expect(buildKitchenTicket(database, order.id, [parcelLineId])).not.toContain("Internal kitchen issue");
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).not.toContain("Internal kitchen issue");
    expect(buildAuditCopy(database, order.id)).toContain("Internal kitchen issue");
    expect(listOpenOrders(database)[0].updatedAt).toBeTruthy();
    expect(getOrderDetail(database, order.id).note).toBe("Internal kitchen issue");
    const delivered = markKitchenDelivered(database, order.id);
    expect(delivered.kitchenCompletedAt).toBeTruthy();
    const restarted = restartKitchenTimer(database, order.id);
    expect(restarted.kitchenCompletedAt).toBeNull();
    addOrderItem(database, order.id, { menuItemId: menu[1].id, quantity: 1 });
    const additionPrintId = sendNewItemsToKitchen(database, order.id);
    expect(additionPrintId).toBeTypeOf("number");
    expect(getPrintJob(database, additionPrintId ?? 0).type).toBe("addition_kot");
    const withAddition = getOrderDetail(database, order.id);
    expect(withAddition.batches).toHaveLength(2);
    expect(withAddition.batches[1].label).toBe("Batch 2");
    const kitchenReprintId = reprintKitchenCopy(database, order.id);
    expect(kitchenReprintId).toBeTypeOf("number");
    expect(getPrintJob(database, kitchenReprintId ?? 0).type).toBe("kot_reprint");
    const discounted = applyDiscount(database, order.id, 50);
    expect(discounted.total).toBe(780);
    const settled = settleOrder(database, order.id, "cash");
    expect(settled.status).toBe("settled");
    expect(getSalesSummary(database).averageKitchenMinutes).toBeGreaterThanOrEqual(0);
    const reopened = reopenOrder(database, order.id);
    expect(reopened.status).toBe("kitchen_sent");
    expect(database.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ?").get(order.id)).toMatchObject({ count: 0 });
    settleOrder(database, order.id, "cash");
    const auditId = printAuditCopy(database, order.id);
    expect(getPrintJob(database, auditId).type).toBe("audit");
    const printJobs = database.prepare("SELECT type FROM print_jobs ORDER BY id").all() as Array<{ type: string }>;
    expect(printJobs.map((job) => job.type)).toEqual(["kot", "addition_kot", "kot_reprint", "receipt", "receipt", "audit"]);
    expect(listPrintJobs(database).every((job) => job.printer === "Xprinter COM8 Receipt (Generic)")).toBe(true);
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).toContain("TABLE: A1");
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).toContain("Note: Parcel");
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).toContain("Thank you for dining with Yamzo");
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).toContain("Please drop a review");
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).toContain("facebook");
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).toContain("@yamzo.uttara");
    expect(buildReceipt(database, order.id, getBrandingSettings(database))).not.toContain("facebook.com/yamzo.uttara/reviews");
  });

  it("prints configured menu type labels instead of internal source keys", () => {
    const database = freshDb();
    const internalSourceKey = "type_1782979170006";
    setMenuTypes(database, [{
      key: internalSourceKey,
      label: "Drive-through",
      menuDataKey: "in_house",
      tablesEnabled: false,
      commissionPercent: 0,
      active: true
    }]);
    const menuItem = saveMenuItem(database, { name: "Chicken Momo", price: 190, category: "Momo", available: true });
    const order = createOrder(database, { source: internalSourceKey });
    const lineId = addOrderItem(database, order.id, { menuItemId: menuItem.id, quantity: 1 });

    for (const output of [
      buildKitchenTicket(database, order.id, [lineId]),
      buildAuditCopy(database, order.id),
      buildReceipt(database, order.id, getBrandingSettings(database))
    ]) {
      expect(output).toContain("Drive-through");
      expect(output).not.toContain("Type 1782979170006");
    }
  });

  it("edits running orders, prints bill copy, and deletes with an audit reason", () => {
    const database = freshDb();
    setPrinterName(database, "Xprinter COM8 Receipt (Generic)");
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 190), ('Pasta', 450)").run();
    const [momo, pasta] = listMenuItems(database);
    const order = createOrder(database, { source: "in_house", tableNumber: "Table 1" });
    const lineId = addOrderItem(database, order.id, { menuItemId: momo.id, quantity: 1, note: "less spicy" });
    updateOrderInfo(database, order.id, { source: "in_house", tableNumber: "Table 3", note: "Window side" });
    updateOrderItem(database, lineId, { quantity: 3, note: "extra sauce" });
    addOrderItem(database, order.id, { menuItemId: pasta.id, quantity: 1 });
    removeOrderItem(database, lineId, "Changed order");
    const detail = getOrderDetail(database, order.id);
    expect(detail.tableNumber).toBe("Table 3");
    expect(detail.note).toBe("Window side");
    expect(detail.itemCount).toBe(1);
    const billId = printBillCopy(database, order.id);
    expect(getPrintJob(database, billId).type).toBe("bill");
    expect(getPrintJob(database, billId).printer).toBe("Xprinter COM8 Receipt (Generic)");
    expect(sendNewItemsToKitchen(database, order.id)).toBeTypeOf("number");
    expect(orderHasKitchenPrintedItems(database, order.id)).toBe(true);
    deleteOrder(database, order.id, "Wrong table");
    expect(getOrderDetail(database, order.id).status).toBe("cancelled");
    expect(clearOrderHistory(database)).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM orders").get()).toMatchObject({ count: 0 });
  });

  it("stores external order IDs only as order metadata", () => {
    const database = freshDb();
    setMenuData(database, [
      { key: "in_house", label: "Store Menu", active: true, externalOrderIdEnabled: false },
      { key: "foodpanda", label: "Foodpanda Menu", active: true, externalOrderIdEnabled: true }
    ]);
    expect(getMenuData(database).find((entry) => entry.key === "foodpanda")?.externalOrderIdEnabled).toBe(true);
    const order = createOrder(database, { source: "foodpanda", externalOrderId: " FP-77881 " });
    expect(getOrderDetail(database, order.id).externalOrderId).toBe("FP-77881");
    updateOrderInfo(database, order.id, { source: "foodpanda", externalOrderId: "FP-77882" });
    expect(listOpenOrders(database)[0].externalOrderId).toBe("FP-77882");
    updateOrderInfo(database, order.id, { source: "in_house", tableNumber: "Table 2", externalOrderId: null });
    const updated = getOrderDetail(database, order.id);
    expect(updated.source).toBe("in_house");
    expect(updated.externalOrderId).toBeNull();
  });

  it("rejects invalid order edges and prevents closed-order mutation", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 190)").run();
    const item = listMenuItems(database)[0];
    const order = createOrder(database, { source: "takeaway" });
    expect(() => addOrderItem(database, order.id, { menuItemId: item.id, quantity: 0 })).toThrow("Quantity");
    expect(() => applyDiscount(database, order.id, -1)).toThrow("Discount");
    expect(() => settleOrder(database, order.id, "cash")).toThrow("empty");
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 });
    settleOrder(database, order.id, "cash");
    expect(() => addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 })).toThrow("closed");
    expect(() => settleOrder(database, order.id, "cash")).toThrow("closed");
  });

  it("tracks void totals, reprints receipts, and supports print retry state", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 190), ('Pasta', 450)").run();
    const [momo, pasta] = listMenuItems(database);
    const order = createOrder(database, { source: "in_house", tableNumber: "4" });
    const voidedItemId = addOrderItem(database, order.id, { menuItemId: momo.id, quantity: 1 });
    addOrderItem(database, order.id, { menuItemId: pasta.id, quantity: 1 });
    voidOrderItem(database, voidedItemId, "Customer changed mind");
    settleOrder(database, order.id, "cash");
    const reprintId = reprintReceipt(database, order.id);
    markPrintJobFailed(database, reprintId, "Printer offline");
    markPrintJobRetry(database, reprintId);
    expect(getPrintJob(database, reprintId).status).toBe("retry");
    expect(getSalesSummary(database).voidTotal).toBe(190);
    expect(listPrintJobs(database).some((job) => job.type === "receipt_reprint")).toBe(true);
  });

  it("skips kitchen print for external manual orders but includes them in reports", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 190)").run();
    const item = listMenuItems(database)[0];
    const order = createOrder(database, { source: "foodpanda" });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 });
    expect(sendNewItemsToKitchen(database, order.id)).toBeNull();
    settleOrder(database, order.id, "other");
    const summary = getSalesSummary(database);
    expect(summary.totalSales).toBe(190);
    expect(summary.sourceBreakdown.foodpanda).toBe(1);
  });

  it("stores receipt branding settings and inventory toggle", () => {
    const database = freshDb();
    const branding = { ...getBrandingSettings(database), restaurantName: "Yamzo Test", showQr: true };
    setBrandingSettings(database, branding);
    setInventoryTracking(database, true);
    setTotalTables(database, 8);
    expect(getBrandingSettings(database).restaurantName).toBe("Yamzo Test");
    expect(getSetting<boolean>(database, "trackInventory", false)).toBe(true);
    expect(getTotalTables(database)).toBe(8);
  });

  it("stores host names and consolidates matching bill-copy items only", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Chowmin', 240)").run();
    const item = listMenuItems(database)[0];
    setHostNames(database, ["Cashier", "Rafi", "Rafi"]);
    expect(getHostNames(database)).toEqual(["Cashier", "Rafi"]);
    const order = createOrder(database, { source: "in_house", tableNumber: "Table 5" });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1, parcel: true });
    const normalReceipt = buildReceipt(database, order.id, getBrandingSettings(database), "RECEIPT");
    const billId = printBillCopy(database, order.id, { paid: false, method: "cash", amount: 720, host: "Rafi" });
    const bill = getPrintJob(database, billId).content;
    expect(normalReceipt.match(/1 x 240 TK/g)).toHaveLength(3);
    expect(bill).toContain("HOST: Rafi");
    expect(bill).toContain("2 x 240 TK");
    expect(bill).toContain("Note: Parcel");
  });

  it("records protected panel activity for audit review", () => {
    const database = freshDb();
    recordProtectedPanelAccess(database, { panel: "admin", success: true, method: "password", actor: "admin" });
    recordProtectedPanelAccess(database, { panel: "completedOrders", success: false, method: "password", actor: "admin" });
    const logs = listActivityLogs(database);
    expect(logs[0]).toMatchObject({
      actor: "admin",
      title: "Completed Orders access denied",
      status: "failed"
    });
    expect(logs[1]).toMatchObject({
      actor: "admin",
      title: "Admin panel opened",
      status: "success"
    });
  });

  it("imports recipe inventory CSV data and builds inventory status", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 240)").run();
    const itemsFile = path.join(os.tmpdir(), `yamzo-items-${Date.now()}.csv`);
    fs.writeFileSync(itemsFile, "Item Name,Unit / Type,Item Category\nChicken,g,Meat\nBengali spice,g,Spice\nGreen chilli,g,Produce\nGarlic,g,Produce\n");
    const file = path.join(os.tmpdir(), `yamzo-recipes-${Date.now()}.csv`);
    fs.writeFileSync(
      file,
      [
        "recipe number,recipe name,item serial no,item names,item quantity GM",
        "1,Chicken Momo,1,Chicken,100 g",
        ",,2,Bengali spice,2 g",
        "2,Green Sauce,1,Green chilli,25 g",
        ",,2,Garlic,5 g"
      ].join("\n")
    );
    expect(importInventoryItemsCsv(database, itemsFile)).toMatchObject({ imported: 4, deleted: 0 });
    const result = importRecipeInventoryCsv(database, file);
    expect(result.recipesImported).toBe(2);
    expect(result.inventoryItemsCreated).toBe(0);
    expect(result.menuItemsCreated).toBe(1);
    const snapshot = listInventorySnapshot(database);
    expect(snapshot.items.map((item) => item.name)).toContain("Chicken");
    const chickenMomoRecipe = snapshot.recipes.find((recipe) => recipe.menuItemName === "Chicken Momo");
    expect(chickenMomoRecipe?.status).toBe("available");
    expect(snapshot.status.inventoryItemCount).toBe(4);
    expect(snapshot.status.totalInventoryValue).toBe(0);
    saveMenuRecipe(database, { menuItemId: chickenMomoRecipe!.menuItemId, ingredients: [] });
    expect(listInventorySnapshot(database).recipes.find((recipe) => recipe.menuItemId === chickenMomoRecipe!.menuItemId)?.status).toBe("missing");
    fs.unlinkSync(file);
    fs.unlinkSync(itemsFile);
  });

  it("records restocks, price history, cost records, and order cost snapshots", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 240)").run();
    const itemsFile = path.join(os.tmpdir(), `yamzo-items-${Date.now()}.csv`);
    fs.writeFileSync(itemsFile, "Item Name,Unit / Type,Item Category\nChicken,g,Meat\nSalt,g,Seasoning\n");
    importInventoryItemsCsv(database, itemsFile);
    const file = path.join(os.tmpdir(), `yamzo-recipes-${Date.now()}.csv`);
    fs.writeFileSync(file, "recipe number,recipe name,item serial no,item names,item quantity GM\n1,Chicken Momo,1,Chicken,100 g\n,,2,Salt,2 g\n");
    importRecipeInventoryCsv(database, file);
    const snapshot = listInventorySnapshot(database);
    const chicken = snapshot.items.find((item) => item.name === "Chicken");
    expect(chicken).toBeTruthy();
    const restock = addRestockEntry(database, { inventoryItemId: chicken!.id, quantity: 1000, totalCost: 900, responsiblePerson: "Cashier" });
    addPriceRecord(database, { inventoryItemId: chicken!.id, pricePerBase: 1, responsiblePerson: "Cashier" });
    deleteRestockEntry(database, restock.id);
    expect(listInventorySnapshot(database).restocks.some((entry) => entry.id === restock.id)).toBe(false);
    addRestockEntry(database, { inventoryItemId: chicken!.id, quantity: 1000, totalCost: 900, responsiblePerson: "Cashier" });
    addCostRecord(database, { categoryId: snapshot.costCategories[0].id, costName: "Electricity", amount: 500, paymentMethod: "cash" });
    const menuItem = listMenuItems(database).find((item) => item.name === "Chicken Momo")!;
    const order = createOrder(database, { source: "in_house", tableNumber: "Table 1" });
    addOrderItem(database, order.id, { menuItemId: menuItem.id, quantity: 2 });
    settleOrder(database, order.id, "cash");
    const costSnapshot = database.prepare("SELECT revenue, raw_cost, gross_profit FROM order_cost_snapshots WHERE order_id = ?").get(order.id) as { revenue: number; raw_cost: number; gross_profit: number };
    expect(costSnapshot.revenue).toBe(480);
    expect(costSnapshot.raw_cost).toBeGreaterThan(0);
    expect(costSnapshot.gross_profit).toBeLessThan(480);
    const after = listInventorySnapshot(database);
    expect(after.profit.revenue).toBe(480);
    expect(after.profit.otherCost).toBe(500);
    expect(after.items.find((item) => item.id === chicken!.id)!.currentStock).toBe(chicken!.currentStock + 800);
    fs.unlinkSync(file);
    fs.unlinkSync(itemsFile);
  });

  it("edits and deletes physical counts and costs with audit reasons", () => {
    const database = freshDb();
    const unit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
    const category = database.prepare("SELECT id FROM inventory_categories LIMIT 1").get() as { id: number };
    const chickenId = Number(database.prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES ('Chicken Breast', ?, ?, 100)").run(category.id, unit.id).lastInsertRowid);

    addRestockEntry(database, { inventoryItemId: chickenId, quantity: 1000, totalCost: 900, responsiblePerson: "Cashier" });
    expect(listInventorySnapshot(database).physicalCounts).toHaveLength(0);

    const countId = addPhysicalCount(database, { inventoryItemId: chickenId, quantity: 800, responsiblePerson: "Cashier", note: "Opening count" }).id;
    updatePhysicalCount(database, { id: countId, inventoryItemId: chickenId, quantity: 750, responsiblePerson: "Manager", note: "Rechecked", reason: "Mistyped count" });
    let snapshot = listInventorySnapshot(database);
    expect(snapshot.physicalCounts.find((entry) => entry.id === countId)).toMatchObject({ quantityBase: 750, responsiblePerson: "Manager" });
    deletePhysicalCount(database, countId, "Duplicate count");
    snapshot = listInventorySnapshot(database);
    expect(snapshot.physicalCounts.some((entry) => entry.id === countId)).toBe(false);

    const costId = addCostRecord(database, { categoryId: snapshot.costCategories[0].id, costName: "Gas", amount: 500, paymentMethod: "cash", responsiblePerson: "Owner" }).id;
    updateCostRecord(database, { id: costId, categoryId: snapshot.costCategories[0].id, costName: "Gas cylinder", amount: 550, paymentMethod: "cash", responsiblePerson: "Owner", note: "Correct bill", reason: "Bill corrected" });
    snapshot = listInventorySnapshot(database);
    expect(snapshot.costRecords.find((entry) => entry.id === costId)).toMatchObject({ costName: "Gas cylinder", amount: 550 });
    deleteCostRecord(database, costId, "Wrong date");
    snapshot = listInventorySnapshot(database);
    expect(snapshot.costRecords.some((entry) => entry.id === costId)).toBe(false);

    const actions = listActivityLogs(database, 20).map((entry) => entry.action);
    expect(actions).toContain("inventory_physical_count_updated");
    expect(actions).toContain("inventory_physical_count_deleted");
    expect(actions).toContain("cost_record_updated");
    expect(actions).toContain("cost_record_deleted");
  });

  it("counts sales and inventory only for completed orders", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 240)").run();
    const itemsFile = path.join(os.tmpdir(), `yamzo-items-${Date.now()}.csv`);
    fs.writeFileSync(itemsFile, "Item Name,Unit / Type,Item Category\nChicken,g,Meat\n");
    importInventoryItemsCsv(database, itemsFile);
    const file = path.join(os.tmpdir(), `yamzo-recipes-${Date.now()}.csv`);
    fs.writeFileSync(file, "recipe number,recipe name,item serial no,item names,item quantity GM\n1,Chicken Momo,1,Chicken,100 g\n");
    importRecipeInventoryCsv(database, file);
    const chicken = listInventorySnapshot(database).items.find((item) => item.name === "Chicken")!;
    addRestockEntry(database, { inventoryItemId: chicken.id, quantity: 1000, totalCost: 1000 });
    const menuItem = listMenuItems(database).find((item) => item.name === "Chicken Momo")!;
    const cancelled = createOrder(database, { source: "in_house", tableNumber: "Table 2" });
    addOrderItem(database, cancelled.id, { menuItemId: menuItem.id, quantity: 1 });
    deleteOrder(database, cancelled.id, "Customer cancelled");
    expect(getSalesSummary(database).totalSales).toBe(0);
    expect(getSalesSummary(database).topItems).toEqual([]);

    const completed = createOrder(database, { source: "in_house", tableNumber: "Table 3" });
    addOrderItem(database, completed.id, { menuItemId: menuItem.id, quantity: 1 });
    settleOrder(database, completed.id, "cash");
    expect(getSalesSummary(database).totalSales).toBe(240);
    expect(database.prepare("SELECT COUNT(*) AS count FROM order_item_cost_snapshots WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 1 });
    expect(listInventorySnapshot(database).items.find((item) => item.id === chicken.id)!.currentStock).toBe(900);
    reopenOrder(database, completed.id);
    expect(getSalesSummary(database).totalSales).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM order_item_cost_snapshots WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 0 });
    expect(listInventorySnapshot(database).items.find((item) => item.id === chicken.id)!.currentStock).toBe(1000);
    fs.unlinkSync(file);
    fs.unlinkSync(itemsFile);
  });

  it("supports nested recipe materials and explicit completed-order recalculation", () => {
    const database = freshDb();
    const base = saveMenuItem(database, { name: "Tartar Sauce", price: 10, category: "Sauce", available: false, trackRecipe: true });
    const fish = saveMenuItem(database, { name: "Fish Plate", price: 300, category: "Fish", available: true, trackRecipe: true });
    const lemonUnit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
    const category = database.prepare("SELECT id FROM inventory_categories LIMIT 1").get() as { id: number };
    const lemonId = Number(database.prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES ('Lemon', ?, ?, 100)").run(category.id, lemonUnit.id).lastInsertRowid);
    addRestockEntry(database, { inventoryItemId: lemonId, quantity: 1000, totalCost: 1000 });
    saveMenuRecipe(database, { menuItemId: base.id, ingredients: [{ inventoryItemId: lemonId, quantityBase: 5, unitLabel: "g" }] });
    const baseRecipe = listInventorySnapshot(database).recipes.find((recipe) => recipe.menuItemId === base.id)!;
    setRecipeUseInRecipeEnabled(database, base.id, true);
    saveMenuRecipe(database, { menuItemId: fish.id, ingredients: [{ kind: "recipe", childRecipeId: baseRecipe.id, quantityBase: 2, unitLabel: "portion" }] });
    const fishRecipe = listInventorySnapshot(database).recipes.find((recipe) => recipe.menuItemId === fish.id)!;
    expect(fishRecipe.childIngredients).toHaveLength(1);
    expect(fishRecipe.ingredients[0]).toMatchObject({ itemName: "Lemon", quantityBase: 10 });

    const order = createOrder(database, { source: "in_house", tableNumber: "Table 1" });
    addOrderItem(database, order.id, { menuItemId: fish.id, quantity: 1 });
    settleOrder(database, order.id, "cash");
    expect(listInventorySnapshot(database).items.find((item) => item.id === lemonId)!.currentStock).toBe(990);
  });

  it("previews and recalculates completed order usage after recipes change", () => {
    const database = freshDb();
    const item = saveMenuItem(database, { name: "Chicken Bowl", price: 250, category: "Rice", available: true, trackRecipe: true });
    const unit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
    const category = database.prepare("SELECT id FROM inventory_categories LIMIT 1").get() as { id: number };
    const chickenId = Number(database.prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES ('Chicken Breast', ?, ?, 100)").run(category.id, unit.id).lastInsertRowid);
    addRestockEntry(database, { inventoryItemId: chickenId, quantity: 1000, totalCost: 1000 });
    const order = createOrder(database, { source: "in_house", tableNumber: "Table 2" });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 2 });
    settleOrder(database, order.id, "cash");
    expect(previewInventoryBackfill(database).estimatedMissingRecipeCount).toBe(1);
    saveMenuRecipe(database, { menuItemId: item.id, ingredients: [{ inventoryItemId: chickenId, quantityBase: 100, unitLabel: "g" }] });
    const preview = previewInventoryBackfill(database);
    expect(preview.orderCount).toBe(1);
    expect(preview.rawCostDelta).toBe(200);
    applyInventoryBackfill(database, { mode: "replace", reason: "Corrected chicken recipe" });
    const snapshot = listInventorySnapshot(database);
    expect(snapshot.orderUsage.totals[0]).toMatchObject({ itemName: "Chicken Breast", quantityBase: 200 });
    expect(snapshot.items.find((row) => row.id === chickenId)!.currentStock).toBe(800);
    expect(listActivityLogs(database, 5).some((log) => log.description.includes("Corrected chicken recipe"))).toBe(true);
  });

  it("stores email settings locally, builds the summary, clears unified Google auth, and escapes print HTML", () => {
    const database = freshDb();
    saveEmailSettings(database, {
      enabled: true,
      recipientEmail: "owner@example.com",
      sendDailySummary: true,
      sendEachSettledOrder: false
    });
    expect(getEmailSettings(database).recipientEmail).toBe("owner@example.com");
    expect(buildDailySalesEmail(database)).toContain("Yamzo Daily Sales Summary");
    clearGmailAuth(database);
    expect(getEmailSettings(database)).not.toHaveProperty("tokenPath");
    expect(renderReceiptHtml("<script>alert(1)</script>")).toContain("&lt;script&gt;");
  });
});
