import { dialog, ipcMain, shell } from "electron";
import type Database from "better-sqlite3";
import type {
  OrderSummary,
  WebsiteConnectionDiagnostics,
  WebsiteConnectionStatus
} from "../shared/types.js";
import { login, changePassword } from "./domain/auth.js";
import { listManagers, saveManager, verifyManagerPin } from "./domain/managers.js";
import {
  addOrderItem,
  applyDiscount,
  cancelOrder,
  completePaidOrder,
  createOrder,
  getOrderDetail,
  listOpenOrders,
  listOrderHistory,
  printAuditCopy,
  printBillCopy,
  recordOrderPayment,
  reprintKitchenCopy,
  reprintReceipt,
  restartKitchenBatchTimer,
  restartKitchenTimer,
  reopenOrder,
  removeOrderItem,
  sendNewItemsToKitchen,
  swapOrderItem,
  updateOrderInfo,
  updateOrderDate,
  updateOrderItem,
  updateOrderNote
} from "./domain/orders.js";
import { getSalesSummary } from "./domain/reports.js";
import {
  getWebsiteOrderDetail,
  listWebsiteOrders,
  queueWebsiteOrderLifecycleForPosOrder,
  queueWebsiteOrderPrint
} from "./domain/websiteOrders.js";
import {
  addCostRecord,
  addPriceRecord,
  addPhysicalCount,
  addRestockEntry,
  applyInventoryBackfill,
  deleteCostRecord,
  deleteInventoryItem,
  deletePhysicalCount,
  deleteRestockEntry,
  importInventoryItemsCsv,
  importRecipeInventoryCsv,
  listMenuInventoryBindings,
  listInventorySnapshot,
  previewMenuBindingImpact,
  previewInventoryBackfill,
  recalculateOrderUsage,
  removeCostCategory,
  removeInventoryCategory,
  removeInventoryUnit,
  saveCostCategory,
  saveInventoryCategory,
  saveInventoryItem,
  saveInventoryUnit,
  saveMenuRecipe,
  saveMenuInventoryBinding,
  removeMenuInventoryBinding,
  setRecipeRestockEnabled,
  setRecipeUseInRecipeEnabled,
  updateCostRecord,
  updatePhysicalCount,
  updateRestockEntry
} from "./domain/inventory.js";
import { archiveMenuItem, deleteMenuItem, importMenuCsv, listMenuItems, saveMenuItem } from "./services/menuImport.js";
import {
  getBrandingSettings,
  getHostNames,
  getInventoryTracking,
  getMenuCategories,
  getMenuData,
  getMenuTypes,
  getPaymentMethods,
  getPrinterName,
  getTotalTables,
  setBrandingSettings,
  setHostNames,
  setInventoryTracking,
  setMenuCategories,
  setMenuData,
  setMenuTypes,
  setPaymentMethods,
  setPrinterName,
  setTotalTables
} from "./services/settings.js";
import { enqueuePrintJob, listPrintJobs } from "./services/printQueue.js";
import { listWindowsPrinters, printJob, retryPrintJob } from "./services/printer.js";
import { printWebsiteInitialKot, retryWebsiteInitialKotForOrder } from "./services/websiteInitialKot.js";
import { buildDailySalesEmail, clearGmailAuth, getEmailSettings, saveEmailSettings, sendDailySalesEmail } from "./services/email.js";
import { listActivityLogs, recordActivity, recordProtectedPanelAccess } from "./services/audit.js";
import { listKotHistory, listSwapHistory } from "./services/operationsHistory.js";
import {
  connectGoogleSheets,
  disconnectGoogle,
  GOOGLE_APPS_SCRIPT_USER_SETTINGS_URL,
  getGoogleSheetsSettings,
  installGoogleReportTool,
  listGoogleSpreadsheets,
  listGoogleSheetTabs,
  queueGoogleSheetsSync,
  saveGoogleOAuthClient,
  setGoogleSheetsSettings,
  syncGoogleSheets
} from "./services/googleSheets.js";

export interface IpcDependencies {
  acceptWebsiteOrder?: (remoteId: string, expectedVersion: number) => Promise<OrderSummary>;
  websiteConnection?: {
    getStatus(): WebsiteConnectionStatus;
    getDiagnostics(): WebsiteConnectionDiagnostics;
    testConnection(): Promise<WebsiteConnectionStatus>;
    reconnect(): Promise<WebsiteConnectionStatus>;
    registerTerminal(baseUrl: string, registrationCode: string): Promise<WebsiteConnectionStatus>;
    disconnect(): WebsiteConnectionStatus;
    rotateTerminalKey(): Promise<WebsiteConnectionStatus>;
  };
}

export function registerIpc(db: Database.Database, dependencies: IpcDependencies = {}): void {
  const queueSheetsWithoutBlockingPos = (): void => {
    try {
      queueGoogleSheetsSync(db);
    } catch {
      // Google sync is best effort. A remote/configuration failure must never undo local POS work.
    }
  };
  const withSheetSync = <T>(operation: () => T): T => {
    const result = operation();
    queueSheetsWithoutBlockingPos();
    return result;
  };

  ipcMain.handle("auth:login", (_event, username: string, password: string) => login(db, username, password));
  ipcMain.handle("auth:changePassword", (_event, username: string, currentPassword: string, nextPassword: string) => {
    const changed = changePassword(db, username, currentPassword, nextPassword);
    recordActivity(db, changed ? "admin_password_changed" : "admin_password_change_failed", { username, result: changed ? "success" : "failed" }, username);
    return changed;
  });
  ipcMain.handle("audit:list", (_event, limit?: number) => listActivityLogs(db, limit));
  ipcMain.handle("audit:protectedAccess", (_event, input) => recordProtectedPanelAccess(db, input));
  ipcMain.handle("managers:list", (_event, includeInactive?: boolean) => listManagers(db, includeInactive));
  ipcMain.handle("managers:save", (_event, input) => {
    const manager = saveManager(db, input);
    recordActivity(db, "manager_saved", { managerId: manager.id, managerCode: manager.managerCode, active: manager.active }, manager.name);
    return manager;
  });
  ipcMain.handle("managers:verify", (_event, managerId: number, pin: string) => verifyManagerPin(db, managerId, pin));
  ipcMain.handle("operations:kotHistory", (_event, range) => listKotHistory(db, range));
  ipcMain.handle("operations:swapHistory", (_event, range) => listSwapHistory(db, range));
  ipcMain.handle("inventory:snapshot", () => listInventorySnapshot(db));
  ipcMain.handle("inventory:previewBackfill", (_event, input) => previewInventoryBackfill(db, input));
  ipcMain.handle("inventory:applyBackfill", (_event, input) => applyInventoryBackfill(db, input));
  ipcMain.handle("inventory:recalculateOrderUsage", (_event, orderId: number) => recalculateOrderUsage(db, orderId));
  ipcMain.handle("inventory:chooseAndImportCsv", async (_event, options) => {
    const picked = await dialog.showOpenDialog({
      title: "Choose recipe or inventory CSV",
      properties: ["openFile"],
      filters: [{ name: "CSV files", extensions: ["csv"] }]
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { recipesImported: 0, recipesUpdated: 0, inventoryItemsCreated: 0, menuItemsCreated: 0, rowsSkipped: 0, errors: [], cancelled: true };
    }
    return importRecipeInventoryCsv(db, picked.filePaths[0], options ?? {});
  });
  ipcMain.handle("inventory:importCsv", (_event, csvPath: string, options) => importRecipeInventoryCsv(db, csvPath, options ?? {}));
  ipcMain.handle("inventory:chooseAndImportItemsCsv", async () => {
    const picked = await dialog.showOpenDialog({
      title: "Choose inventory items CSV",
      properties: ["openFile"],
      filters: [{ name: "CSV files", extensions: ["csv"] }]
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { imported: 0, updated: 0, skipped: 0, deleted: 0, errors: [], cancelled: true };
    }
    return importInventoryItemsCsv(db, picked.filePaths[0]);
  });
  ipcMain.handle("inventory:importItemsCsv", (_event, csvPath: string) => importInventoryItemsCsv(db, csvPath));
  ipcMain.handle("inventory:saveItem", (_event, input) => saveInventoryItem(db, input));
  ipcMain.handle("inventory:deleteItem", (_event, id: number) => deleteInventoryItem(db, id));
  ipcMain.handle("inventory:saveRecipe", (_event, input, options) => saveMenuRecipe(db, input, options ?? {}));
  ipcMain.handle("inventory:listBindings", () => listMenuInventoryBindings(db));
  ipcMain.handle("inventory:previewBindingImpact", (_event, input) => previewMenuBindingImpact(db, input));
  ipcMain.handle("inventory:saveBinding", (_event, input) => saveMenuInventoryBinding(db, input));
  ipcMain.handle("inventory:removeBinding", (_event, menuItemId: number, options) => removeMenuInventoryBinding(db, menuItemId, options ?? {}));
  ipcMain.handle("inventory:setRecipeRestockEnabled", (_event, menuItemId: number, enabled: boolean) => setRecipeRestockEnabled(db, menuItemId, enabled));
  ipcMain.handle("inventory:setRecipeUseInRecipeEnabled", (_event, menuItemId: number, enabled: boolean) => setRecipeUseInRecipeEnabled(db, menuItemId, enabled));
  ipcMain.handle("inventory:saveCategory", (_event, input) => saveInventoryCategory(db, input));
  ipcMain.handle("inventory:removeCategory", (_event, id: number) => removeInventoryCategory(db, id));
  ipcMain.handle("inventory:saveUnit", (_event, input) => saveInventoryUnit(db, input));
  ipcMain.handle("inventory:removeUnit", (_event, id: number) => removeInventoryUnit(db, id));
  ipcMain.handle("inventory:addRestock", (_event, input) => addRestockEntry(db, input));
  ipcMain.handle("inventory:updateRestock", (_event, input) => updateRestockEntry(db, input));
  ipcMain.handle("inventory:deleteRestock", (_event, id: number) => deleteRestockEntry(db, id));
  ipcMain.handle("inventory:addPhysicalCount", (_event, input) => addPhysicalCount(db, input));
  ipcMain.handle("inventory:updatePhysicalCount", (_event, input) => updatePhysicalCount(db, input));
  ipcMain.handle("inventory:deletePhysicalCount", (_event, id: number, reason: string) => deletePhysicalCount(db, id, reason));
  ipcMain.handle("inventory:addPrice", (_event, input) => addPriceRecord(db, input));
  ipcMain.handle("inventory:saveCostCategory", (_event, input) => withSheetSync(() => saveCostCategory(db, input)));
  ipcMain.handle("inventory:removeCostCategory", (_event, id: number) => withSheetSync(() => removeCostCategory(db, id)));
  ipcMain.handle("inventory:addCost", (_event, input) => withSheetSync(() => addCostRecord(db, input)));
  ipcMain.handle("inventory:updateCost", (_event, input) => withSheetSync(() => updateCostRecord(db, input)));
  ipcMain.handle("inventory:deleteCost", (_event, id: number, reason?: string) => withSheetSync(() => deleteCostRecord(db, id, reason)));
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
  ipcMain.handle("orders:create", (_event, input) => withSheetSync(() => createOrder(db, input)));
  ipcMain.handle("orders:addItem", (_event, orderId: number, input) => withSheetSync(() => addOrderItem(db, orderId, input)));
  ipcMain.handle("orders:sendKitchen", (_event, orderId: number, allowExternal?: boolean) => withSheetSync(() => sendNewItemsToKitchen(db, orderId, allowExternal)));
  ipcMain.handle("orders:discount", (_event, orderId: number, discount: number) => withSheetSync(() => applyDiscount(db, orderId, discount)));
  ipcMain.handle("orders:updateNote", (_event, orderId: number, note: string) => withSheetSync(() => updateOrderNote(db, orderId, note)));
  ipcMain.handle("orders:updateInfo", (_event, orderId: number, input) => withSheetSync(() => updateOrderInfo(db, orderId, input)));
  ipcMain.handle("orders:updateDate", (_event, orderId: number, orderDate: string) => withSheetSync(() => updateOrderDate(db, orderId, orderDate)));
  ipcMain.handle("orders:updateItem", (_event, orderItemId: number, input) => withSheetSync(() => updateOrderItem(db, orderItemId, input)));
  ipcMain.handle("orders:removeItem", (_event, orderItemId: number, reason?: string) => withSheetSync(() => removeOrderItem(db, orderItemId, reason)));
  ipcMain.handle("orders:swapItem", (_event, orderItemId: number, replacement, authorization) => withSheetSync(() => swapOrderItem(db, orderItemId, replacement, authorization)));
  ipcMain.handle("orders:recordPayment", (_event, orderId: number, input) => withSheetSync(() => recordOrderPayment(db, orderId, input)));
  ipcMain.handle("orders:completePaid", (_event, orderId: number) => withSheetSync(() => completePaidOrder(db, orderId)));
  ipcMain.handle("orders:cancel", (_event, orderId: number, reason?: string) => withSheetSync(() => cancelOrder(db, orderId, reason)));
  ipcMain.handle("orders:reopen", (_event, orderId: number) => withSheetSync(() => reopenOrder(db, orderId)));
  ipcMain.handle("orders:restartKitchenTimer", (_event, orderId: number) => withSheetSync(() => restartKitchenTimer(db, orderId)));
  ipcMain.handle("orders:restartKitchenBatchTimer", (_event, ticketId: number) => withSheetSync(() => restartKitchenBatchTimer(db, ticketId)));
  ipcMain.handle("orders:detail", (_event, orderId: number) => getOrderDetail(db, orderId));
  ipcMain.handle("orders:open", () => listOpenOrders(db));
  ipcMain.handle("orders:history", () => listOrderHistory(db));
  ipcMain.handle("orders:retryInitialKot", async (_event, orderId: number) => {
    const order = getOrderDetail(db, orderId);
    if (!order.initialKotPrintJobId) throw new Error("Initial Kitchen KOT has not been queued.");
    await retryPrintJob(db, order.initialKotPrintJobId);
    return getOrderDetail(db, orderId);
  });
  ipcMain.handle("orders:retryAdjustmentKots", async (_event, orderId: number) => {
    const jobs = db.prepare(
      `SELECT opr.print_job_id
       FROM order_print_requirements opr
       JOIN print_jobs pj ON pj.id = opr.print_job_id
       WHERE opr.order_id = ? AND opr.kind <> 'initial_kot' AND pj.status IN ('failed', 'retry')
       ORDER BY opr.id`
    ).all(orderId) as Array<{ print_job_id: number }>;
    for (const job of jobs) await retryPrintJob(db, job.print_job_id);
    return getOrderDetail(db, orderId);
  });
  ipcMain.handle("orders:reprintKitchen", (_event, orderId: number) => reprintKitchenCopy(db, orderId));
  ipcMain.handle("orders:reprintReceipt", (_event, orderId: number) => reprintReceipt(db, orderId));
  ipcMain.handle("orders:printBill", (_event, orderId: number, paymentInfo, reprint?: boolean) => printBillCopy(db, orderId, paymentInfo, reprint));
  ipcMain.handle("orders:retryBill", async (_event, orderId: number) => {
    const order = getOrderDetail(db, orderId);
    if (order.billState === "not_printed") throw new Error("Bill Copy has not been queued.");
    const row = db.prepare("SELECT bill_print_job_id FROM orders WHERE id = ?").get(orderId) as { bill_print_job_id: number | null } | undefined;
    if (!row?.bill_print_job_id) throw new Error("Bill Copy has not been queued.");
    await retryPrintJob(db, row.bill_print_job_id);
    return getOrderDetail(db, orderId);
  });
  ipcMain.handle("orders:printAudit", (_event, orderId: number) => printAuditCopy(db, orderId));
  ipcMain.handle("websiteOrders:list", (_event, statuses) => listWebsiteOrders(db, statuses));
  ipcMain.handle("websiteOrders:detail", (_event, remoteId: string) => getWebsiteOrderDetail(db, remoteId));
  ipcMain.handle("websiteOrders:accept", (_event, remoteId: string, expectedVersion: number) => {
    if (!dependencies.acceptWebsiteOrder) {
      throw new Error("Website order acceptance is unavailable in this build.");
    }
    return dependencies.acceptWebsiteOrder(remoteId, expectedVersion);
  });
  ipcMain.handle("websiteOrders:queuePrint", (_event, remoteId: string, kind) => queueWebsiteOrderPrint(db, remoteId, kind));
  ipcMain.handle(
    "websiteOrders:advanceLifecycle",
    (_event, orderId: number, target: "ready" | "out_for_delivery") =>
      queueWebsiteOrderLifecycleForPosOrder(
        db,
        orderId,
        target,
        target === "ready" ? "Marked ready in Yamzo POS" : "Dispatched from Yamzo POS"
      )
  );
  ipcMain.handle("websiteOrders:retryInitialKot", async (_event, remoteId: string) =>
    (await printWebsiteInitialKot(db, remoteId, true)).order
  );
  ipcMain.handle("websiteOrders:retryInitialKotForOrder", async (_event, orderId: number) =>
    (await retryWebsiteInitialKotForOrder(db, orderId)).order
  );
  ipcMain.handle("websiteConnection:status", () => dependencies.websiteConnection?.getStatus() ?? null);
  ipcMain.handle("websiteConnection:diagnostics", () => dependencies.websiteConnection?.getDiagnostics() ?? null);
  ipcMain.handle("websiteConnection:test", () => {
    if (!dependencies.websiteConnection) throw new Error("Yamzo Website Connection is unavailable in this build.");
    return dependencies.websiteConnection.testConnection();
  });
  ipcMain.handle("websiteConnection:reconnect", () => {
    if (!dependencies.websiteConnection) throw new Error("Yamzo Website Connection is unavailable in this build.");
    return dependencies.websiteConnection.reconnect();
  });
  ipcMain.handle("websiteConnection:register", (_event, baseUrl: string, registrationCode: string) => {
    if (!dependencies.websiteConnection) throw new Error("Yamzo Website Connection is unavailable in this build.");
    return dependencies.websiteConnection.registerTerminal(baseUrl, registrationCode);
  });
  ipcMain.handle("websiteConnection:disconnect", () => {
    if (!dependencies.websiteConnection) throw new Error("Yamzo Website Connection is unavailable in this build.");
    return dependencies.websiteConnection.disconnect();
  });
  ipcMain.handle("websiteConnection:rotateKey", () => {
    if (!dependencies.websiteConnection) throw new Error("Yamzo Website Connection is unavailable in this build.");
    return dependencies.websiteConnection.rotateTerminalKey();
  });
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
  ipcMain.handle("reports:sales", (_event, rangeOrStart?: { startDate?: string; endDate?: string } | string, end?: string) => getSalesSummary(db, rangeOrStart, end));
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
  ipcMain.handle("settings:getMenuCategories", () => getMenuCategories(db));
  ipcMain.handle("settings:setMenuCategories", (_event, categories: string[]) => {
    setMenuCategories(db, categories);
    recordActivity(db, "menu_categories_updated", { count: categories.length }, "admin");
  });
  ipcMain.handle("settings:getMenuData", () => getMenuData(db));
  ipcMain.handle("settings:setMenuData", (_event, menuData) => {
    setMenuData(db, menuData);
    recordActivity(db, "menu_data_updated", { count: menuData.length }, "admin");
  });
  ipcMain.handle("settings:getMenuTypes", () => getMenuTypes(db));
  ipcMain.handle("settings:setMenuTypes", (_event, menuTypes) => {
    setMenuTypes(db, menuTypes);
    recordActivity(db, "menu_types_updated", { count: menuTypes.length }, "admin");
  });
  ipcMain.handle("settings:getPaymentMethods", () => getPaymentMethods(db));
  ipcMain.handle("settings:setPaymentMethods", (_event, methods) => {
    setPaymentMethods(db, methods);
    recordActivity(db, "payment_methods_updated", { count: methods.length }, "admin");
  });
  ipcMain.handle("settings:getGoogleSheets", () => getGoogleSheetsSettings(db));
  ipcMain.handle("settings:saveGoogleOAuthClient", (_event, input) => {
    const saved = saveGoogleOAuthClient(db, input ?? {});
    recordActivity(db, "google_oauth_client_saved", { clientIdConfigured: saved.hasClientCredentials }, "admin");
    return saved;
  });
  ipcMain.handle("settings:setGoogleSheets", (_event, settings) => {
    const saved = setGoogleSheetsSettings(db, settings ?? {});
    recordActivity(db, "google_sheets_settings_updated", {
      enabled: saved.enabled,
      ordersTab: saved.ordersTab,
      orderItemsTab: saved.orderItemsTab,
      costsTab: saved.costsTab
    }, "admin");
    queueSheetsWithoutBlockingPos();
    return saved;
  });
  ipcMain.handle("settings:connectGoogleSheets", async () => {
    const result = await connectGoogleSheets(db);
    recordActivity(db, "google_sheets_connected", { spreadsheetTitle: result.spreadsheetTitle }, "admin");
    queueSheetsWithoutBlockingPos();
    return result;
  });
  ipcMain.handle("settings:disconnectGoogle", () => {
    const settings = disconnectGoogle(db);
    recordActivity(db, "google_connection_cleared", {}, "admin");
    return settings;
  });
  ipcMain.handle("settings:listGoogleSpreadsheets", () => listGoogleSpreadsheets(db));
  ipcMain.handle("settings:listGoogleSheetTabs", (_event, spreadsheetId?: string) =>
    listGoogleSheetTabs(db, spreadsheetId));
  ipcMain.handle("settings:openGoogleAppsScriptSettings", async () => {
    await shell.openExternal(GOOGLE_APPS_SCRIPT_USER_SETTINGS_URL);
    return true;
  });
  ipcMain.handle("settings:syncGoogleSheets", async () => {
    const result = await syncGoogleSheets(db);
    recordActivity(db, "google_sheets_synced", {
      orders: result.orders,
      orderItems: result.orderItems,
      costs: result.costs
    }, "admin");
    return result;
  });
  ipcMain.handle("settings:installGoogleReportTool", async () => {
    await syncGoogleSheets(db);
    const result = await installGoogleReportTool(db);
    recordActivity(db, "google_report_tool_installed", {}, "admin");
    return result;
  });
  ipcMain.handle("email:getSettings", () => getEmailSettings(db));
  ipcMain.handle("email:saveSettings", (_event, settings) => {
    const saved = saveEmailSettings(db, settings ?? {});
    recordActivity(db, "email_notification_settings_updated", { enabled: saved.enabled, recipientEmail: saved.recipientEmail }, "admin");
    return saved;
  });
  ipcMain.handle("email:clearAuth", () => {
    clearGmailAuth(db);
    recordActivity(db, "gmail_connection_cleared", {}, "admin");
  });
  ipcMain.handle("email:dailyPreview", () => buildDailySalesEmail(db));
  ipcMain.handle("email:sendDaily", () => sendDailySalesEmail(db));

  queueSheetsWithoutBlockingPos();
}
