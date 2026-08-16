import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase, openMemoryDatabase } from "../src/main/database/connection";
import { login, changePassword } from "../src/main/domain/auth";
import {
  addOrderItem,
  applyDiscount,
  cancelOrder,
  cancelOrderItem,
  changeOrderTable,
  completePaidOrder,
  createOrder,
  getOrderDetail,
  listOrderHistory,
  listOpenOrders,
  markKitchenDelivered,
  orderHasKitchenPrintedItems,
  printAuditCopy,
  printBillCopy,
  reopenOrder,
  recordOrderPayment,
  redoOrderPayment,
  removeOrderItem,
  restartKitchenTimer,
  sendNewItemsToKitchen,
  settleOrder,
  swapOrderItem,
  updateOrderInfo,
  updateOrderItem,
  updateOrderNote
} from "../src/main/domain/orders";
import { reprintKitchenCopy, reprintReceipt, voidOrderItem } from "../src/main/domain/orders";
import { getSalesSummary } from "../src/main/domain/reports";
import { listManagers, saveManager, verifyManagerPin } from "../src/main/domain/managers";
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
  resetInventoryActivity,
  saveMenuRecipe,
  setRecipeUseInRecipeEnabled,
  updateCostRecord,
  updatePhysicalCount
} from "../src/main/domain/inventory";
import { archiveMenuItem, deleteMenuItem, importMenuCsv, listMenuItems, parsePrice, saveMenuItem } from "../src/main/services/menuImport";
import { getBrandingSettings, getHostNames, getMenuData, getTestMode, getTotalTables, setBrandingSettings, setHostNames, setInventoryTracking, getSetting, setMenuData, setMenuTypes, setPaymentMethods, setPrinterName, setTestMode, setTotalTables } from "../src/main/services/settings";
import { buildDailySalesEmail, clearGmailAuth, getEmailSettings, saveEmailSettings } from "../src/main/services/email";
import { printJob, renderReceiptHtml } from "../src/main/services/printer";
import { beginPrintAttempt, enqueuePrintJob, finishPrintAttempt, getPrintJob, listPrintJobs, markPrintJobFailed, markPrintJobPrinted, markPrintJobRetry } from "../src/main/services/printQueue";
import { listCancelledKotHistory, listKotHistory, listSwapHistory } from "../src/main/services/operationsHistory";
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

function settleWithKot(database: Database.Database, orderId: number, method: Parameters<typeof settleOrder>[2]) {
  const detail = getOrderDetail(database, orderId);
  const jobId = detail.initialKotPrintJobId ?? sendNewItemsToKitchen(database, orderId);
  if (jobId) markPrintJobPrinted(database, jobId);
  return settleOrder(database, orderId, method);
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

  it("stores individual manager PIN hashes and rejects disabled managers", () => {
    const database = freshDb();
    const manager = saveManager(database, {
      managerCode: "MGR-002",
      name: "Shift Manager",
      pin: "5678",
      active: true
    });
    const stored = database.prepare("SELECT pin_hash FROM managers WHERE id = ?").get(manager.id) as { pin_hash: string };
    expect(stored.pin_hash).not.toBe("5678");
    expect(verifyManagerPin(database, manager.id, "5678")).toMatchObject({ name: "Shift Manager", active: true });
    expect(() => verifyManagerPin(database, manager.id, "1111")).toThrow(/authorization failed/i);

    saveManager(database, { id: manager.id, managerCode: manager.managerCode, name: manager.name, active: false });
    expect(listManagers(database).some((entry) => entry.id === manager.id)).toBe(false);
    expect(listManagers(database, true).find((entry) => entry.id === manager.id)?.active).toBe(false);
    expect(() => verifyManagerPin(database, manager.id, "5678")).toThrow(/authorization failed/i);
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
    markPrintJobPrinted(database, firstKitchenPrintId!);
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
    const settled = settleWithKot(database, order.id, "cash");
    expect(settled.status).toBe("settled");
    expect(getSalesSummary(database).averageKitchenMinutes).toBeGreaterThanOrEqual(0);
    expect(() => reopenOrder(database, order.id)).toThrow(/permanent/i);
    const auditId = printAuditCopy(database, order.id);
    expect(getPrintJob(database, auditId).type).toBe("audit");
    const printJobs = database.prepare("SELECT type FROM print_jobs ORDER BY id").all() as Array<{ type: string }>;
    expect(printJobs.map((job) => job.type)).toEqual(["kot", "addition_kot", "kot_reprint", "receipt", "audit"]);
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

  it("edits running orders, prints bill copy, and permanently retains cancelled orders", () => {
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
    const initialKotId = sendNewItemsToKitchen(database, order.id)!;
    markPrintJobPrinted(database, initialKotId);
    const billId = printBillCopy(database, order.id);
    expect(getPrintJob(database, billId).type).toBe("bill");
    expect(getPrintJob(database, billId).printer).toBe("Xprinter COM8 Receipt (Generic)");
    expect(orderHasKitchenPrintedItems(database, order.id)).toBe(true);
    expect(() => cancelOrder(database, order.id)).toThrow("cancellation reason");
    cancelOrder(database, order.id, "Wrong table");
    expect(getOrderDetail(database, order.id).status).toBe("cancelled");
    expect(database.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = ?").get(order.id)).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1").get(String(order.id))).toMatchObject({ action: "cancel_order" });
    expect(() => database.prepare("DELETE FROM orders WHERE id = ?").run(order.id)).toThrow("Orders cannot be deleted");
    expect(getOrderDetail(database, order.id).status).toBe("cancelled");
  });

  it("preserves percent, flat-TK, and manual-total checkout entries in their designated fields", () => {
    const database = freshDb();
    const menuItem = saveMenuItem(database, { name: "Checkout State Item", price: 485, category: "Test", available: true });
    const order = createOrder(database, { source: "in_house", tableNumber: "Table 1" });
    addOrderItem(database, order.id, { menuItemId: menuItem.id, quantity: 1 });

    applyDiscount(database, order.id, 49, { mode: "percent", value: 10, manualTotal: null });
    expect(getOrderDetail(database, order.id)).toMatchObject({
      subtotal: 485,
      discount: 49,
      discountMode: "percent",
      discountInput: 10,
      manualTotalInput: null,
      total: 436
    });

    applyDiscount(database, order.id, 10, { mode: "tk", value: 10, manualTotal: null });
    expect(getOrderDetail(database, order.id)).toMatchObject({
      discount: 10,
      discountMode: "tk",
      discountInput: 10,
      manualTotalInput: null,
      total: 475
    });

    applyDiscount(database, order.id, 238, { mode: "tk", value: 238, manualTotal: 247 });
    expect(getOrderDetail(database, order.id)).toMatchObject({
      discount: 238,
      discountMode: "tk",
      discountInput: 238,
      manualTotalInput: 247,
      total: 247
    });
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

  it("locks occupied tables and moves a whole running order only through the table-transfer action", () => {
    const database = freshDb();
    const first = createOrder(database, { source: "in_house", tableNumber: "Table 1", hostName: "Nadia" });
    expect(() => createOrder(database, { source: "in_house", tableNumber: "Table 1" })).toThrow(/already in use/i);
    const second = createOrder(database, { source: "in_house", tableNumber: "Table 2", hostName: "Rafi" });
    expect(() => changeOrderTable(database, second.id, "Table 1")).toThrow(/already in use/i);
    expect(changeOrderTable(database, second.id, "Table 3").tableNumber).toBe("Table 3");
    expect(database.prepare("SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1").get(String(second.id))).toMatchObject({ action: "change_order_table" });
    cancelOrder(database, first.id, "Customer left before ordering");
    expect(changeOrderTable(database, second.id, "Table 1").tableNumber).toBe("Table 1");
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
    settleWithKot(database, order.id, "cash");
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
    settleWithKot(database, order.id, "cash");
    const reprintId = reprintReceipt(database, order.id);
    markPrintJobFailed(database, reprintId, "Printer offline");
    markPrintJobRetry(database, reprintId);
    expect(getPrintJob(database, reprintId).status).toBe("retry");
    expect(getSalesSummary(database).voidTotal).toBe(190);
    expect(listPrintJobs(database).some((job) => job.type === "receipt_reprint")).toBe(true);
  });

  it("requires kitchen print for external manual orders and includes them in reports", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 190)").run();
    const item = listMenuItems(database)[0];
    const order = createOrder(database, { source: "foodpanda" });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 });
    const externalKot = sendNewItemsToKitchen(database, order.id);
    expect(externalKot).toBeTypeOf("number");
    markPrintJobPrinted(database, externalKot!);
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
    const order = createOrder(database, { source: "parcel" });
    const addressLines = buildReceipt(database, order.id, getBrandingSettings(database)).split("\n").filter((line) => /House-80|Road-20|Sector 11|Uttara|Dhaka 1230/.test(line));
    expect(addressLines).toHaveLength(2);
  });

  it("keeps Test Mode off by default and bypasses printer transport without skipping print audit", async () => {
    const database = freshDb();
    expect(getTestMode(database)).toBe(false);
    setTestMode(database, true);
    expect(getTestMode(database)).toBe(true);

    const jobId = enqueuePrintJob(database, "kot", "TEST KOT", "Missing test printer");
    await expect(printJob(database, jobId)).resolves.toBe(true);
    expect(getPrintJob(database, jobId).status).toBe("printed");
    expect(database.prepare("SELECT COUNT(*) AS count FROM print_attempts WHERE print_job_id = ? AND success = 1").get(jobId)).toMatchObject({ count: 1 });
    expect(listActivityLogs(database, 10).some((log) => log.action === "test_mode_print_bypassed")).toBe(true);
  });

  it("stores host names and consolidates matching bill-copy items only", () => {
    const database = freshDb();
    database.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Chowmin', 240)").run();
    const item = listMenuItems(database)[0];
    setHostNames(database, ["Cashier", "Rafi", "Rafi"]);
    expect(getHostNames(database)).toEqual(["Cashier", "Rafi"]);
    const order = createOrder(database, { source: "in_house", tableNumber: "Table 5", hostName: "Rafi" });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1 });
    addOrderItem(database, order.id, { menuItemId: item.id, quantity: 1, parcel: true });
    const normalReceipt = buildReceipt(database, order.id, getBrandingSettings(database), "RECEIPT");
    markPrintJobPrinted(database, sendNewItemsToKitchen(database, order.id)!);
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
    settleWithKot(database, order.id, "cash");
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

  it("resets only inventory activity while preserving catalog, recipes, prices, costs, and orders", () => {
    const database = freshDb();
    const menuItem = saveMenuItem(database, { name: "Reset Boundary Bowl", price: 300, category: "Rice", available: true, trackRecipe: true });
    const unit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
    const category = database.prepare("SELECT id FROM inventory_categories LIMIT 1").get() as { id: number };
    const inventoryItemId = Number(database.prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES ('Reset Boundary Chicken', ?, ?, 100)").run(category.id, unit.id).lastInsertRowid);
    saveMenuRecipe(database, { menuItemId: menuItem.id, ingredients: [{ inventoryItemId, quantityBase: 100, unitLabel: "g" }] });
    addPriceRecord(database, { inventoryItemId, pricePerBase: 1, responsiblePerson: "Admin" });
    addRestockEntry(database, { inventoryItemId, quantity: 1000, totalCost: 1000, responsiblePerson: "Admin" });
    addPhysicalCount(database, { inventoryItemId, quantity: 800, responsiblePerson: "Admin" });
    const costCategory = listInventorySnapshot(database).costCategories[0];
    addCostRecord(database, { categoryId: costCategory.id, costName: "Reset boundary cost", amount: 50, paymentMethod: "cash" });
    const order = createOrder(database, { source: "in_house", tableNumber: "Table 9" });
    addOrderItem(database, order.id, { menuItemId: menuItem.id, quantity: 1 });
    settleWithKot(database, order.id, "cash");

    const retainedTables = [
      "inventory_items",
      "inventory_categories",
      "inventory_units",
      "menu_item_recipes",
      "recipe_ingredients",
      "inventory_price_history",
      "cost_records",
      "orders",
      "order_items",
      "order_cost_snapshots",
      "order_item_cost_snapshots",
      "payments"
    ] as const;
    const before = Object.fromEntries(retainedTables.map((table) => [table, (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
    expect(() => resetInventoryActivity(database, { username: "admin", password: "wrong", confirmation: "RESET INVENTORY ACTIVITY" })).toThrow(/password/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_restock_entries").get()).toMatchObject({ count: 1 });

    expect(resetInventoryActivity(database, { username: "admin", password: "1234", confirmation: "RESET INVENTORY ACTIVITY" })).toEqual({
      usageAdjustments: 1,
      restockEntries: 1,
      physicalCounts: 1
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments").get()).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_restock_entries").get()).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_physical_counts").get()).toMatchObject({ count: 0 });
    for (const table of retainedTables) {
      expect((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(before[table]);
    }
    expect(listInventorySnapshot(database).orderUsage.orders).toEqual([]);
    expect(getOrderDetail(database, order.id).status).toBe("settled");
    expect(listActivityLogs(database, 10).some((log) => log.action === "inventory_activity_reset")).toBe(true);
  }, 10000);

  it("rolls back every inventory activity deletion if any reset step fails", () => {
    const database = freshDb();
    const unit = database.prepare("SELECT id FROM inventory_units WHERE short_name = 'g'").get() as { id: number };
    const category = database.prepare("SELECT id FROM inventory_categories LIMIT 1").get() as { id: number };
    const inventoryItemId = Number(database.prepare("INSERT INTO inventory_items (name, category_id, base_unit_id, low_stock_threshold) VALUES ('Reset Rollback Item', ?, ?, 0)").run(category.id, unit.id).lastInsertRowid);
    addRestockEntry(database, { inventoryItemId, quantity: 500, totalCost: 500 });
    addPhysicalCount(database, { inventoryItemId, quantity: 400 });
    database.prepare("INSERT INTO inventory_adjustments (inventory_item_id, quantity_delta, reason) VALUES (?, -10, 'test')").run(inventoryItemId);
    database.exec("CREATE TRIGGER block_restock_reset BEFORE DELETE ON inventory_restock_entries BEGIN SELECT RAISE(ABORT, 'blocked reset'); END");

    expect(() => resetInventoryActivity(database, { username: "admin", password: "1234", confirmation: "RESET INVENTORY ACTIVITY" })).toThrow(/blocked reset/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments").get()).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_restock_entries").get()).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_physical_counts").get()).toMatchObject({ count: 1 });
    expect(getSetting<number>(database, "inventoryActivityResetOrderId", -1)).toBe(-1);
    expect(listActivityLogs(database, 10).some((log) => log.action === "inventory_activity_reset")).toBe(false);
  }, 10000);

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
    cancelOrder(database, cancelled.id, "Customer cancelled");
    expect(getSalesSummary(database).totalSales).toBe(0);
    expect(getSalesSummary(database).topItems).toEqual([]);

    const completed = createOrder(database, { source: "in_house", tableNumber: "Table 3" });
    addOrderItem(database, completed.id, { menuItemId: menuItem.id, quantity: 1 });
    settleWithKot(database, completed.id, "cash");
    expect(getSalesSummary(database).totalSales).toBe(240);
    expect(database.prepare("SELECT COUNT(*) AS count FROM order_item_cost_snapshots WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 1 });
    expect(listInventorySnapshot(database).items.find((item) => item.id === chicken.id)!.currentStock).toBe(900);
    expect(() => reopenOrder(database, completed.id)).toThrow(/permanent/i);
    expect(getSalesSummary(database).totalSales).toBe(240);
    expect(database.prepare("SELECT COUNT(*) AS count FROM order_item_cost_snapshots WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_adjustments WHERE order_id = ?").get(completed.id)).toMatchObject({ count: 1 });
    expect(listInventorySnapshot(database).items.find((item) => item.id === chicken.id)!.currentStock).toBe(900);
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
    settleWithKot(database, order.id, "cash");
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
    settleWithKot(database, order.id, "cash");
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

  it("persists guests and enforces KOT, payment, Bill Copy, and completion in sequence", () => {
    const database = freshDb();
    const momo = saveMenuItem(database, { name: "Gate Momo", price: 195, category: "Momo", available: true });
    const replacement = saveMenuItem(database, { name: "Gate Pasta", price: 395, category: "Pasta", available: true });
    const order = createOrder(database, {
      source: "in_house",
      tableNumber: "Table 4",
      guestCount: 5,
      hostName: "Nadia",
      requiresKot: true
    });
    const itemId = addOrderItem(database, order.id, { menuItemId: momo.id, quantity: 1, note: "Less spicy" });
    expect(getOrderDetail(database, order.id)).toMatchObject({ guestCount: 5, hostName: "Nadia", initialKotState: "required" });

    const printJobId = sendNewItemsToKitchen(database, order.id)!;
    expect(getOrderDetail(database, order.id).initialKotState).toBe("queued");
    expect(() => settleOrder(database, order.id, "cash")).toThrow(/KOT must print successfully/i);

    markPrintJobFailed(database, printJobId, "No receipt printer selected.");
    expect(getOrderDetail(database, order.id).initialKotState).toBe("awaiting_retry");
    updateOrderItem(database, itemId, { quantity: 2, note: "No chilli", parcel: true });
    expect(getPrintJob(database, printJobId).content).toContain("2 x");
    expect(getPrintJob(database, printJobId).content).toContain("No chilli");

    markPrintJobPrinted(database, printJobId);
    expect(getOrderDetail(database, order.id).initialKotState).toBe("confirmed");
    expect(() => removeOrderItem(database, itemId)).toThrow(/Swap \/ Change/i);
    const originalKot = getPrintJob(database, printJobId).content;
    const manager = listManagers(database)[0];
    const managerAuthorization = {
      managerId: manager.id,
      pin: "1234",
      reason: "Customer requested pasta",
      operator: "Nadia"
    };
    expect(() => swapOrderItem(database, itemId, { menuItemId: replacement.id, quantity: 1 }, {
      ...managerAuthorization,
      pin: "9999"
    })).toThrow(/authorization failed/i);
    expect(getOrderDetail(database, order.id).items.find((orderItem) => orderItem.id === itemId)?.status).toBe("active");

    const swapped = swapOrderItem(database, itemId, { menuItemId: replacement.id, quantity: 1 }, managerAuthorization);
    expect(getPrintJob(database, swapped.voidPrintJobId).type).toBe("void_kot");
    expect(getPrintJob(database, printJobId).content).toBe(originalKot);
    expect(swapped.order.items.filter((item) => item.status === "active")).toHaveLength(1);
    expect(swapped.order.items.find((item) => item.status === "active")?.menuItemId).toBe(replacement.id);
    expect(listSwapHistory(database)[0]).toMatchObject({
      orderId: order.id,
      originalName: "Gate Momo",
      replacementName: "Gate Pasta",
      managerName: manager.name,
      operator: "Nadia",
      reason: "Customer requested pasta",
      adjustmentPrintJobId: swapped.adjustmentPrintJobId,
      successfulPrintCount: 0
    });

    expect(getOrderDetail(database, order.id)).toMatchObject({ requiredKotCount: 2, unresolvedKotCount: 1, failedKotCount: 0 });
    expect(() => recordOrderPayment(database, order.id, { method: "cash", cashReceived: 500, hostName: "Nadia" })).toThrow(/every required Kitchen KOT/i);
    const cancelledLineId = addOrderItem(database, order.id, { menuItemId: momo.id, quantity: 1 });
    const additionJobId = sendNewItemsToKitchen(database, order.id)!;
    expect(getPrintJob(database, additionJobId).type).toBe("addition_kot");
    expect(getOrderDetail(database, order.id)).toMatchObject({ requiredKotCount: 3, unresolvedKotCount: 2 });
    const adjustmentAttemptId = beginPrintAttempt(database, swapped.adjustmentPrintJobId);
    finishPrintAttempt(database, adjustmentAttemptId, true);
    markPrintJobPrinted(database, swapped.voidPrintJobId);
    markPrintJobPrinted(database, additionJobId);
    const cancelled = cancelOrderItem(database, cancelledLineId, { ...managerAuthorization, reason: "Customer cancelled momo" });
    expect(listCancelledKotHistory(database)[0]).toMatchObject({ eventKind: "cancel", originalName: "Gate Momo", reason: "Customer cancelled momo" });
    expect(listSwapHistory(database)).toHaveLength(1);
    markPrintJobPrinted(database, cancelled.adjustmentPrintJobId);
    expect(getOrderDetail(database, order.id).unresolvedKotCount).toBe(0);
    expect(listSwapHistory(database)[0].successfulPrintCount).toBe(1);
    expect(listKotHistory(database).find((entry) => entry.printJobId === swapped.adjustmentPrintJobId)).toMatchObject({
      attemptCount: 1,
      successfulPrintCount: 1,
      managerName: manager.name,
      reason: "Customer requested pasta"
    });
    const billJobId = printBillCopy(database, order.id);
    const bill = getPrintJob(database, billJobId).content;
    expect(bill).toContain("UNPAID BILL COPY");
    expect(bill).toContain("PAYMENT: Unpaid");
    expect(() => recordOrderPayment(database, order.id, { method: "cash", cashReceived: 500, hostName: "Nadia" })).toThrow(/Unpaid Bill Copy/i);
    markPrintJobPrinted(database, billJobId);
    updateOrderInfo(database, order.id, { source: "in_house", tableNumber: "Table 4", guestCount: 5, hostName: "Nadia", note: null, externalOrderId: null });
    applyDiscount(database, order.id, 0);
    expect(getOrderDetail(database, order.id).billState).toBe("printed");
    expect(() => recordOrderPayment(database, order.id, { method: "cash", cashReceived: 300, hostName: "Nadia" })).toThrow(/less than the cash portion/i);

    const paid = recordOrderPayment(database, order.id, { method: "cash", cashReceived: 500, hostName: "Nadia" });
    expect(paid.order.payment).toMatchObject({ method: "cash", amount: 395, cashReceived: 500, changeGiven: 105, hostName: "Nadia" });
    const paidSlip = getPrintJob(database, paid.paidSlipPrintJobId).content;
    expect(paidSlip).toContain("PAID SLIP");
    expect(paidSlip).toContain("CASH RECEIVED:");
    expect(paidSlip).toContain("CHANGE:");
    expect(() => recordOrderPayment(database, order.id, { method: "cash", cashReceived: 600, hostName: "Nadia" })).toThrow(/already recorded/i);
    expect(recordOrderPayment(database, order.id, { method: "cash", cashReceived: 500, hostName: "Nadia" }).paidSlipPrintJobId).toBe(paid.paidSlipPrintJobId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ?").get(order.id)).toMatchObject({ count: 1 });
    expect(bill).toContain("GUESTS: 5");
    expect(bill).toContain("HOST: Nadia");
    expect(() => completePaidOrder(database, order.id)).toThrow(/Paid Slip/i);
    markPrintJobPrinted(database, paid.paidSlipPrintJobId);
    expect(() => redoOrderPayment(database, order.id, { ...managerAuthorization, pin: "9999", reason: "Wrong cash" })).toThrow(/authorization failed/i);
    const reopenedPayment = redoOrderPayment(database, order.id, { ...managerAuthorization, reason: "Wrong cash received" });
    expect(reopenedPayment).toMatchObject({ paid: false, billState: "not_printed", paidSlipState: "not_printed" });
    expect(database.prepare("SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1").get(String(order.id))).toMatchObject({ action: "redo_order_payment" });
    const replacementBillId = printBillCopy(database, order.id);
    markPrintJobPrinted(database, replacementBillId);
    const replacementPayment = recordOrderPayment(database, order.id, { method: "cash", cashReceived: 500, hostName: "Nadia" });
    markPrintJobPrinted(database, replacementPayment.paidSlipPrintJobId);
    const completed = completePaidOrder(database, order.id);
    expect(completed.status).toBe("settled");
    expect(completePaidOrder(database, order.id).status).toBe("settled");
    expect(() => cancelOrder(database, order.id, "No longer wanted")).toThrow(/permanent/i);
    expect(() => reopenOrder(database, order.id)).toThrow(/permanent/i);
    expect(() => updateOrderInfo(database, order.id, { source: "in_house", tableNumber: "Table 9" })).toThrow(/closed/i);
    expect(() => database.prepare("DELETE FROM orders WHERE id = ?").run(order.id)).toThrow(/cannot be deleted/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id = ?").get(order.id)).toMatchObject({ count: 1 });
    expect(getSalesSummary(database)).toMatchObject({ dineInGuests: 5, averageGuestsPerDineInOrder: 5 });

    const takeaway = createOrder(database, { source: "takeaway", guestCount: 2, hostName: "Nadia", requiresKot: true });
    addOrderItem(database, takeaway.id, { menuItemId: momo.id, quantity: 1 });
    expect(getOrderDetail(database, takeaway.id)).toMatchObject({ tableNumber: null, guestCount: 2, initialKotState: "required" });
  }, 15_000);

  it("records Multi tender as separate cash and bKash amounts and closes every timer", () => {
    const database = freshDb();
    const menuItem = saveMenuItem(database, { name: "Split Tender Platter", price: 1000, category: "Checkout", available: true });
    const order = createOrder(database, { source: "parcel", hostName: "Nadia", orderDate: "2026-08-17" });
    addOrderItem(database, order.id, { menuItemId: menuItem.id, quantity: 1 });
    const kotJobId = sendNewItemsToKitchen(database, order.id)!;
    markPrintJobPrinted(database, kotJobId);
    const billJobId = printBillCopy(database, order.id);
    markPrintJobPrinted(database, billJobId);

    expect(() => recordOrderPayment(database, order.id, { method: "split", bkashAmount: 0, cashReceived: 1000, hostName: "Nadia" })).toThrow(/both a cash portion and a bKash portion/i);
    const paid = recordOrderPayment(database, order.id, {
      method: "split",
      bkashAmount: 600,
      cashReceived: 500,
      reference: "BK-600",
      hostName: "Nadia"
    });
    expect(paid.order.payment).toMatchObject({
      method: "split",
      amount: 1000,
      cashAmount: 400,
      bkashAmount: 600,
      cashReceived: 500,
      changeGiven: 100
    });
    expect(database.prepare("SELECT method, amount FROM payments WHERE order_id = ? ORDER BY method").all(order.id)).toEqual([
      { method: "bkash", amount: 600 },
      { method: "cash", amount: 400 }
    ]);
    const paidSlip = getPrintJob(database, paid.paidSlipPrintJobId).content;
    expect(paidSlip).toContain("CASH PORTION:");
    expect(paidSlip).toContain("BKASH PORTION:");
    markPrintJobPrinted(database, paid.paidSlipPrintJobId);

    const completed = completePaidOrder(database, order.id);
    expect(completed).toMatchObject({ status: "settled", payment: { cashAmount: 400, bkashAmount: 600 } });
    expect(completed.closedAt).toBeTruthy();
    expect(completed.kitchenCompletedAt).toBeTruthy();
    expect(completed.batches.every((batch) => batch.completedAt)).toBe(true);
    expect(() => restartKitchenTimer(database, order.id)).toThrow(/Closed-order timers/i);
    expect(getSalesSummary(database).registerTotals).toEqual({ cash: 400, bkash: 600, foodpanda: 0, foodie: 0 });
  });

  it("requires KOT and an external ID for Foodpanda and Foodie but skips bill and payment printing", () => {
    const database = freshDb();
    const menuItem = saveMenuItem(database, { name: "Platform Meal", price: 350, category: "Checkout", available: true });

    for (const [source, externalOrderId] of [["foodpanda", "FP-1701"], ["foodie", "FD-1702"]] as const) {
      const order = createOrder(database, { source, hostName: "Nadia", orderDate: "2026-08-17" });
      addOrderItem(database, order.id, { menuItemId: menuItem.id, quantity: 1 });
      expect(() => completePaidOrder(database, order.id)).toThrow(/Kitchen KOT/i);
      const kotJobId = sendNewItemsToKitchen(database, order.id)!;
      markPrintJobPrinted(database, kotJobId);
      expect(() => printBillCopy(database, order.id)).toThrow(/do not require bill copies/i);
      expect(() => recordOrderPayment(database, order.id, { method: "cash", cashReceived: 350, hostName: "Nadia" })).toThrow(/do not require payment entry/i);
      expect(() => completePaidOrder(database, order.id)).toThrow(/External Order ID/i);
      updateOrderInfo(database, order.id, { source, externalOrderId });
      const completed = completePaidOrder(database, order.id);
      expect(completed).toMatchObject({ status: "settled", source, externalOrderId, paid: false, billState: "not_printed", paidSlipState: "not_printed" });
      expect(completed.batches.every((batch) => batch.completedAt)).toBe(true);
    }

    expect(getSalesSummary(database).registerTotals).toEqual({ cash: 0, bkash: 0, foodpanda: 350, foodie: 350 });
  });

  it("stops cancelled-order timers and filters completed and cancelled history by order date", () => {
    const database = freshDb();
    const menuItem = saveMenuItem(database, { name: "History Meal", price: 200, category: "Checkout", available: true });
    const cancelled = createOrder(database, { source: "parcel", orderDate: "2026-08-16" });
    addOrderItem(database, cancelled.id, { menuItemId: menuItem.id, quantity: 1 });
    sendNewItemsToKitchen(database, cancelled.id);
    const closed = cancelOrder(database, cancelled.id, "Customer cancelled");
    expect(closed).toMatchObject({ status: "cancelled" });
    expect(closed.closedAt).toBeTruthy();
    expect(closed.kitchenCompletedAt).toBeTruthy();
    expect(closed.batches.every((batch) => batch.completedAt)).toBe(true);
    expect(() => restartKitchenTimer(database, cancelled.id)).toThrow(/Closed-order timers/i);

    const completed = createOrder(database, { source: "foodpanda", externalOrderId: "FP-HISTORY", orderDate: "2026-08-17" });
    addOrderItem(database, completed.id, { menuItemId: menuItem.id, quantity: 1 });
    const kotJobId = sendNewItemsToKitchen(database, completed.id)!;
    markPrintJobPrinted(database, kotJobId);
    completePaidOrder(database, completed.id);

    expect(listOrderHistory(database, { startDate: "2026-08-16", endDate: "2026-08-16" }).map((order) => order.id)).toEqual([cancelled.id]);
    expect(listOrderHistory(database, { startDate: "2026-08-17", endDate: "2026-08-17" }).map((order) => order.id)).toEqual([completed.id]);
  });

  it("persists a non-cash payment and Bill prerequisite across a database restart", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yamzo-gate3b-"));
    const databasePath = path.join(tempDirectory, "yamzo.sqlite3");
    try {
      db = openDatabase(databasePath);
      const menuItem = saveMenuItem(db, { name: "Restart Momo", price: 245, category: "Momo", available: true });
      const order = createOrder(db, { source: "takeaway", guestCount: 2, hostName: "Rafi", requiresKot: true });
      addOrderItem(db, order.id, { menuItemId: menuItem.id, quantity: 1 });
      const kotJobId = sendNewItemsToKitchen(db, order.id)!;
      markPrintJobPrinted(db, kotJobId);
      setPaymentMethods(db, [
        { key: "cash", label: "Cash", active: false },
        { key: "bkash", label: "bKash Merchant", active: true },
        { key: "nagad", label: "Nagad", active: false },
        { key: "card", label: "Card", active: false },
        { key: "other", label: "Other", active: false }
      ]);
      const billJobId = printBillCopy(db, order.id);
      markPrintJobPrinted(db, billJobId);
      const paid = recordOrderPayment(db, order.id, { method: "bkash", bkashAmount: 245, reference: "01700000000", hostName: "Rafi" });
      expect(paid.order.payment).toMatchObject({ method: "bkash", amount: 245, cashAmount: 0, bkashAmount: 245, reference: "01700000000", changeGiven: 0 });
      markPrintJobPrinted(db, paid.paidSlipPrintJobId);
      db.close();
      db = null;

      const reopenedDb = openDatabase(databasePath);
      db = reopenedDb;
      expect(getOrderDetail(reopenedDb, order.id)).toMatchObject({
        paid: true,
        unresolvedKotCount: 0,
        billState: "printed",
        paidSlipState: "printed",
        payment: { method: "bkash", amount: 245, reference: "01700000000" }
      });
      expect(completePaidOrder(reopenedDb, order.id).status).toBe("settled");
    } finally {
      db?.close();
      db = null;
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
