import { dialog, ipcMain } from "electron";
import type Database from "better-sqlite3";
import { login, changePassword } from "./domain/auth.js";
import {
  addOrderItem,
  applyDiscount,
  createOrder,
  clearOrderHistory,
  deleteOrder,
  getOrderDetail,
  listOpenOrders,
  listOrderHistory,
  markKitchenBatchDelivered,
  markKitchenDelivered,
  orderHasKitchenPrintedItems,
  printAuditCopy,
  printBillCopy,
  reprintKitchenCopy,
  reprintReceipt,
  restartKitchenBatchTimer,
  restartKitchenTimer,
  reopenOrder,
  removeOrderItem,
  sendNewItemsToKitchen,
  settleOrder,
  updateOrderInfo,
  updateOrderItem,
  updateOrderNote
} from "./domain/orders.js";
import { getSalesSummary } from "./domain/reports.js";
import {
  addCostRecord,
  addPriceRecord,
  addRestockEntry,
  importRecipeInventoryCsv,
  listInventorySnapshot,
  saveCostCategory,
  saveInventoryCategory,
  saveInventoryItem
} from "./domain/inventory.js";
import { archiveMenuItem, deleteMenuItem, importMenuCsv, listMenuItems, saveMenuItem } from "./services/menuImport.js";
import {
  getBrandingSettings,
  getHostNames,
  getInventoryTracking,
  getPrinterName,
  getTotalTables,
  setBrandingSettings,
  setHostNames,
  setInventoryTracking,
  setPrinterName,
  setTotalTables
} from "./services/settings.js";
import { enqueuePrintJob, listPrintJobs } from "./services/printQueue.js";
import { listWindowsPrinters, printJob, retryPrintJob } from "./services/printer.js";
import { buildDailySalesEmail, clearGmailAuth, createGmailAuthUrl, getEmailSettings, saveEmailSettings, sendDailySalesEmail } from "./services/email.js";
import { listActivityLogs, recordActivity, recordProtectedPanelAccess } from "./services/audit.js";

export function registerIpc(db: Database.Database): void {
  ipcMain.handle("auth:login", (_event, username: string, password: string) => login(db, username, password));
  ipcMain.handle("auth:changePassword", (_event, username: string, currentPassword: string, nextPassword: string) => {
    const changed = changePassword(db, username, currentPassword, nextPassword);
    recordActivity(db, changed ? "admin_password_changed" : "admin_password_change_failed", { username, result: changed ? "success" : "failed" }, username);
    return changed;
  });
  ipcMain.handle("audit:list", (_event, limit?: number) => listActivityLogs(db, limit));
  ipcMain.handle("audit:protectedAccess", (_event, input) => recordProtectedPanelAccess(db, input));
  ipcMain.handle("inventory:snapshot", () => listInventorySnapshot(db));
  ipcMain.handle("inventory:chooseAndImportCsv", async () => {
    const picked = await dialog.showOpenDialog({
      title: "Choose recipe or inventory CSV",
      properties: ["openFile"],
      filters: [{ name: "CSV files", extensions: ["csv"] }]
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { recipesImported: 0, recipesUpdated: 0, inventoryItemsCreated: 0, menuItemsCreated: 0, rowsSkipped: 0, errors: [], cancelled: true };
    }
    return importRecipeInventoryCsv(db, picked.filePaths[0]);
  });
  ipcMain.handle("inventory:importCsv", (_event, csvPath: string) => importRecipeInventoryCsv(db, csvPath));
  ipcMain.handle("inventory:saveItem", (_event, input) => saveInventoryItem(db, input));
  ipcMain.handle("inventory:saveCategory", (_event, input) => saveInventoryCategory(db, input));
  ipcMain.handle("inventory:addRestock", (_event, input) => addRestockEntry(db, input));
  ipcMain.handle("inventory:addPrice", (_event, input) => addPriceRecord(db, input));
  ipcMain.handle("inventory:saveCostCategory", (_event, input) => saveCostCategory(db, input));
  ipcMain.handle("inventory:addCost", (_event, input) => addCostRecord(db, input));
  ipcMain.handle("menu:list", () => listMenuItems(db));
  ipcMain.handle("menu:importCsv", (_event, csvPath: string) => importMenuCsv(db, csvPath));
  ipcMain.handle("menu:chooseAndImportCsv", async () => {
    const picked = await dialog.showOpenDialog({
      title: "Choose menu CSV",
      properties: ["openFile"],
      filters: [{ name: "CSV files", extensions: ["csv"] }]
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { imported: 0, updated: 0, skipped: 0, cancelled: true };
    }
    const result = importMenuCsv(db, picked.filePaths[0]);
    recordActivity(db, "menu_csv_imported", { imported: result.imported, updated: result.updated, skipped: result.skipped }, "admin");
    return result;
  });
  ipcMain.handle("menu:saveItem", (_event, input) => {
    const item = saveMenuItem(db, input);
    recordActivity(db, input.id ? "menu_item_updated" : "menu_item_created", { itemName: item.name, price: item.price }, "admin");
    return item;
  });
  ipcMain.handle("menu:archiveItem", (_event, id: number) => {
    archiveMenuItem(db, id);
    recordActivity(db, "menu_item_archived", { entityType: "menu_item", entityId: String(id) }, "admin");
  });
  ipcMain.handle("menu:deleteItem", (_event, id: number) => {
    deleteMenuItem(db, id);
    recordActivity(db, "menu_item_deleted", { entityType: "menu_item", entityId: String(id) }, "admin");
  });
  ipcMain.handle("orders:create", (_event, input) => createOrder(db, input));
  ipcMain.handle("orders:addItem", (_event, orderId: number, input) => addOrderItem(db, orderId, input));
  ipcMain.handle("orders:sendKitchen", (_event, orderId: number, allowExternal?: boolean) => sendNewItemsToKitchen(db, orderId, allowExternal));
  ipcMain.handle("orders:discount", (_event, orderId: number, discount: number) => applyDiscount(db, orderId, discount));
  ipcMain.handle("orders:updateNote", (_event, orderId: number, note: string) => updateOrderNote(db, orderId, note));
  ipcMain.handle("orders:updateInfo", (_event, orderId: number, input) => updateOrderInfo(db, orderId, input));
  ipcMain.handle("orders:updateItem", (_event, orderItemId: number, input) => updateOrderItem(db, orderItemId, input));
  ipcMain.handle("orders:removeItem", (_event, orderItemId: number, reason?: string) => removeOrderItem(db, orderItemId, reason));
  ipcMain.handle("orders:settle", (_event, orderId: number, method, amount?: number, reference?: string, host?: string) => settleOrder(db, orderId, method, amount, reference, host));
  ipcMain.handle("orders:delete", (_event, orderId: number, reason?: string) => deleteOrder(db, orderId, reason));
  ipcMain.handle("orders:reopen", (_event, orderId: number) => reopenOrder(db, orderId));
  ipcMain.handle("orders:markKitchenDelivered", (_event, orderId: number) => markKitchenDelivered(db, orderId));
  ipcMain.handle("orders:restartKitchenTimer", (_event, orderId: number) => restartKitchenTimer(db, orderId));
  ipcMain.handle("orders:markKitchenBatchDelivered", (_event, ticketId: number) => markKitchenBatchDelivered(db, ticketId));
  ipcMain.handle("orders:restartKitchenBatchTimer", (_event, ticketId: number) => restartKitchenBatchTimer(db, ticketId));
  ipcMain.handle("orders:hasKitchenPrintedItems", (_event, orderId: number) => orderHasKitchenPrintedItems(db, orderId));
  ipcMain.handle("orders:detail", (_event, orderId: number) => getOrderDetail(db, orderId));
  ipcMain.handle("orders:open", () => listOpenOrders(db));
  ipcMain.handle("orders:history", () => listOrderHistory(db));
  ipcMain.handle("orders:clearHistory", () => clearOrderHistory(db));
  ipcMain.handle("orders:reprintKitchen", (_event, orderId: number) => reprintKitchenCopy(db, orderId));
  ipcMain.handle("orders:reprintReceipt", (_event, orderId: number) => reprintReceipt(db, orderId));
  ipcMain.handle("orders:printBill", (_event, orderId: number, paymentInfo) => printBillCopy(db, orderId, paymentInfo));
  ipcMain.handle("orders:printAudit", (_event, orderId: number) => printAuditCopy(db, orderId));
  ipcMain.handle("print:listJobs", (_event, status?: string) => listPrintJobs(db, status));
  ipcMain.handle("print:listPrinters", () => listWindowsPrinters());
  ipcMain.handle("print:printJob", (_event, id: number) => printJob(db, id));
  ipcMain.handle("print:retryJob", (_event, id: number) => retryPrintJob(db, id));
  ipcMain.handle("print:sample", async (_event, type: "test" | "kot" | "receipt") => {
    const content =
      type === "kot"
        ? "----------------------------------------\n             KITCHEN COPY\n----------------------------------------\n\nORDER: SAMPLE\nTABLE: Test\nTIME:  Now\nTYPE:  Dine-in\n\n----------------------------------------\n\n1 x Sample Item\n\n----------------------------------------"
        : type === "receipt"
          ? "[[YAMZO_LOGO]]\n----------------------------------------\n                RECEIPT\n----------------------------------------\n\nSample Item\n1 x 100 TK                         100 TK\n----------------------------------------\nSUBTOTAL:                          100 TK\nPAYMENT: Unpaid\n========================================\nTOTAL:                             100 TK\n========================================\n\nThank you for dining with Yamzo.\nWe would like to hear more from you.\nPlease drop a review on our facebook\nby scanning the QR code below.\n\n[[YAMZO_REVIEW_QR]]\n\n             @yamzo.uttara\n\n"
          : "Yamzo printer test\nIf you can read this, printing is connected.";
    const id = enqueuePrintJob(db, type === "kot" ? "kot" : type === "receipt" ? "receipt" : "test", content, getPrinterName(db) || null);
    return printJob(db, id);
  });
  ipcMain.handle("reports:sales", (_event, start?: string, end?: string) => getSalesSummary(db, start, end));
  ipcMain.handle("settings:getBranding", () => getBrandingSettings(db));
  ipcMain.handle("settings:setBranding", (_event, branding) => {
    setBrandingSettings(db, branding);
    recordActivity(db, "receipt_settings_updated", { restaurantName: branding?.restaurantName ?? "" }, "admin");
  });
  ipcMain.handle("settings:chooseImage", async () => {
    const picked = await dialog.showOpenDialog({
      title: "Choose image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    });
    return picked.canceled ? "" : picked.filePaths[0] ?? "";
  });
  ipcMain.handle("settings:getInventoryTracking", () => getInventoryTracking(db));
  ipcMain.handle("settings:setInventoryTracking", (_event, enabled: boolean) => {
    setInventoryTracking(db, enabled);
    recordActivity(db, "inventory_tracking_setting_updated", { enabled }, "admin");
  });
  ipcMain.handle("settings:getPrinterName", () => getPrinterName(db));
  ipcMain.handle("settings:setPrinterName", (_event, printerName: string) => {
    setPrinterName(db, printerName);
    recordActivity(db, "printer_setting_updated", { printerName: printerName.trim() || "None" }, "admin");
  });
  ipcMain.handle("settings:getTotalTables", () => getTotalTables(db));
  ipcMain.handle("settings:setTotalTables", (_event, totalTables: number) => {
    setTotalTables(db, totalTables);
    recordActivity(db, "table_count_updated", { totalTables }, "admin");
  });
  ipcMain.handle("settings:getHostNames", () => getHostNames(db));
  ipcMain.handle("settings:setHostNames", (_event, hostNames: string[]) => {
    setHostNames(db, hostNames);
    recordActivity(db, "host_names_updated", { count: hostNames.length }, "admin");
  });
  ipcMain.handle("email:getSettings", () => getEmailSettings(db));
  ipcMain.handle("email:saveSettings", (_event, settings) => {
    saveEmailSettings(db, settings);
    recordActivity(db, "email_notification_settings_updated", { enabled: Boolean(settings?.enabled), recipientEmail: settings?.recipientEmail ?? "" }, "admin");
  });
  ipcMain.handle("email:authUrl", (_event, config) => createGmailAuthUrl(config));
  ipcMain.handle("email:clearAuth", () => {
    clearGmailAuth(db);
    recordActivity(db, "gmail_connection_cleared", {}, "admin");
  });
  ipcMain.handle("email:dailyPreview", () => buildDailySalesEmail(db));
  ipcMain.handle("email:sendDaily", () => sendDailySalesEmail(db));
}
