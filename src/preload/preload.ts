import { contextBridge, ipcRenderer } from "electron";
import type { BrandingSettings, EmailSettingsInput, GoogleOAuthClientInput, GoogleSheetsSettingsInput, HistoricalScope, MenuDataSetting, MenuItemInput, MenuTypeSetting, OrderItemInput, OrderSource, PaymentMethod, PhysicalCountInput, PhysicalCountUpdateInput, ReceiptPaymentInfo, RecipeSaveInput, RestockEntryInput, RestockEntryUpdateInput, SalesSummary, WebsiteOrderDetail, WebsiteOrderPrintBatch, WebsiteOrderPrintKind, WebsiteOrderStatus, WebsiteOrderSummary } from "../shared/types.js";

const api = {
  auth: {
    login: (username: string, password: string) => ipcRenderer.invoke("auth:login", username, password),
    changePassword: (username: string, currentPassword: string, nextPassword: string) =>
      ipcRenderer.invoke("auth:changePassword", username, currentPassword, nextPassword)
  },
  audit: {
    list: (limit?: number) => ipcRenderer.invoke("audit:list", limit),
    protectedAccess: (input: { panel: string; success: boolean; method: "password" | "master_key" | "recent_access"; actor?: string }) =>
      ipcRenderer.invoke("audit:protectedAccess", input)
  },
  inventory: {
    snapshot: () => ipcRenderer.invoke("inventory:snapshot"),
    previewBackfill: (input?: { start?: string | null; end?: string | null }) => ipcRenderer.invoke("inventory:previewBackfill", input),
    applyBackfill: (input?: { start?: string | null; end?: string | null; mode?: "missing" | "replace"; reason?: string | null }) => ipcRenderer.invoke("inventory:applyBackfill", input),
    recalculateOrderUsage: (orderId: number) => ipcRenderer.invoke("inventory:recalculateOrderUsage", orderId),
    chooseAndImportCsv: (options?: { snapshotMode?: boolean; historicalScope?: HistoricalScope; start?: string | null; end?: string | null; reason?: string | null }) => ipcRenderer.invoke("inventory:chooseAndImportCsv", options),
    importCsv: (csvPath: string, options?: { snapshotMode?: boolean; historicalScope?: HistoricalScope; start?: string | null; end?: string | null; reason?: string | null }) => ipcRenderer.invoke("inventory:importCsv", csvPath, options),
    chooseAndImportItemsCsv: () => ipcRenderer.invoke("inventory:chooseAndImportItemsCsv"),
    importItemsCsv: (csvPath: string) => ipcRenderer.invoke("inventory:importItemsCsv", csvPath),
    saveItem: (input: { id?: number; name: string; categoryId?: number | null; baseUnitId: number; lowStockThreshold?: number; active?: boolean }) =>
      ipcRenderer.invoke("inventory:saveItem", input),
    deleteItem: (id: number) => ipcRenderer.invoke("inventory:deleteItem", id),
    saveRecipe: (input: RecipeSaveInput, options?: { snapshotMode?: boolean; historicalScope?: HistoricalScope; start?: string | null; end?: string | null; reason?: string | null }) =>
      ipcRenderer.invoke("inventory:saveRecipe", input, options),
    listBindings: () => ipcRenderer.invoke("inventory:listBindings"),
    previewBindingImpact: (input: { menuItemId: number; start?: string | null; end?: string | null }) => ipcRenderer.invoke("inventory:previewBindingImpact", input),
    saveBinding: (input: { menuItemId: number; bindingType: "recipe" | "item"; recipeId?: number | null; inventoryItemId?: number | null; quantityBase?: number; unitLabel?: string; historicalScope?: HistoricalScope; start?: string | null; end?: string | null; reason?: string | null }) => ipcRenderer.invoke("inventory:saveBinding", input),
    removeBinding: (menuItemId: number, options?: { historicalScope?: HistoricalScope; start?: string | null; end?: string | null; reason?: string | null }) => ipcRenderer.invoke("inventory:removeBinding", menuItemId, options),
    setRecipeRestockEnabled: (menuItemId: number, enabled: boolean) => ipcRenderer.invoke("inventory:setRecipeRestockEnabled", menuItemId, enabled),
    setRecipeUseInRecipeEnabled: (menuItemId: number, enabled: boolean) => ipcRenderer.invoke("inventory:setRecipeUseInRecipeEnabled", menuItemId, enabled),
    saveCategory: (input: { id?: number; name: string; active?: boolean }) => ipcRenderer.invoke("inventory:saveCategory", input),
    removeCategory: (id: number) => ipcRenderer.invoke("inventory:removeCategory", id),
    saveUnit: (input: { id?: number; name: string; shortName: string; active?: boolean }) => ipcRenderer.invoke("inventory:saveUnit", input),
    removeUnit: (id: number) => ipcRenderer.invoke("inventory:removeUnit", id),
    addRestock: (input: RestockEntryInput) =>
      ipcRenderer.invoke("inventory:addRestock", input),
    updateRestock: (input: RestockEntryUpdateInput) =>
      ipcRenderer.invoke("inventory:updateRestock", input),
    deleteRestock: (id: number) => ipcRenderer.invoke("inventory:deleteRestock", id),
    addPhysicalCount: (input: PhysicalCountInput) =>
      ipcRenderer.invoke("inventory:addPhysicalCount", input),
    updatePhysicalCount: (input: PhysicalCountUpdateInput) =>
      ipcRenderer.invoke("inventory:updatePhysicalCount", input),
    deletePhysicalCount: (id: number, reason?: string) => ipcRenderer.invoke("inventory:deletePhysicalCount", id, reason),
    addPrice: (input: { inventoryItemId: number; pricePerBase: number; effectiveAt?: string | null; responsiblePerson?: string | null; note?: string | null }) =>
      ipcRenderer.invoke("inventory:addPrice", input),
    saveCostCategory: (input: { id?: number; name: string; active?: boolean; sortOrder?: number }) => ipcRenderer.invoke("inventory:saveCostCategory", input),
    removeCostCategory: (id: number) => ipcRenderer.invoke("inventory:removeCostCategory", id),
    addCost: (input: { categoryId?: number | null; costName: string; amount: number; paymentMethod?: string | null; responsiblePerson?: string | null; note?: string | null; costDate?: string | null }) =>
      ipcRenderer.invoke("inventory:addCost", input),
    updateCost: (input: { id: number; categoryId?: number | null; costName: string; amount: number; paymentMethod?: string | null; responsiblePerson?: string | null; note?: string | null; costDate?: string | null; reason?: string | null }) =>
      ipcRenderer.invoke("inventory:updateCost", input),
    deleteCost: (id: number, reason?: string) => ipcRenderer.invoke("inventory:deleteCost", id, reason)
  },
  menu: {
    list: () => ipcRenderer.invoke("menu:list"),
    importCsv: (csvPath: string) => ipcRenderer.invoke("menu:importCsv", csvPath),
    chooseAndImportCsv: () => ipcRenderer.invoke("menu:chooseAndImportCsv"),
    saveItem: (input: MenuItemInput & { id?: number }) => ipcRenderer.invoke("menu:saveItem", input),
    archiveItem: (id: number) => ipcRenderer.invoke("menu:archiveItem", id),
    deleteItem: (id: number) => ipcRenderer.invoke("menu:deleteItem", id)
  },
  orders: {
    create: (input: { source: OrderSource; tableNumber?: string; note?: string; externalOrderId?: string | null; orderDate?: string }) => ipcRenderer.invoke("orders:create", input),
    addItem: (orderId: number, input: OrderItemInput) => ipcRenderer.invoke("orders:addItem", orderId, input),
    sendKitchen: (orderId: number, allowExternal?: boolean) => ipcRenderer.invoke("orders:sendKitchen", orderId, allowExternal),
    discount: (orderId: number, discount: number) => ipcRenderer.invoke("orders:discount", orderId, discount),
    updateNote: (orderId: number, note: string) => ipcRenderer.invoke("orders:updateNote", orderId, note),
    updateInfo: (orderId: number, input: { source: OrderSource; tableNumber?: string | null; note?: string | null; externalOrderId?: string | null }) =>
      ipcRenderer.invoke("orders:updateInfo", orderId, input),
    updateDate: (orderId: number, orderDate: string) => ipcRenderer.invoke("orders:updateDate", orderId, orderDate),
    updateItem: (orderItemId: number, input: { quantity: number; note?: string | null; parcel?: boolean }) => ipcRenderer.invoke("orders:updateItem", orderItemId, input),
    removeItem: (orderItemId: number, reason?: string) => ipcRenderer.invoke("orders:removeItem", orderItemId, reason),
    settle: (orderId: number, method: PaymentMethod, amount?: number, reference?: string, host?: string) => ipcRenderer.invoke("orders:settle", orderId, method, amount, reference, host),
    delete: (orderId: number, reason?: string) => ipcRenderer.invoke("orders:delete", orderId, reason),
    reopen: (orderId: number) => ipcRenderer.invoke("orders:reopen", orderId),
    markKitchenDelivered: (orderId: number) => ipcRenderer.invoke("orders:markKitchenDelivered", orderId),
    restartKitchenTimer: (orderId: number) => ipcRenderer.invoke("orders:restartKitchenTimer", orderId),
    markKitchenBatchDelivered: (ticketId: number) => ipcRenderer.invoke("orders:markKitchenBatchDelivered", ticketId),
    restartKitchenBatchTimer: (ticketId: number) => ipcRenderer.invoke("orders:restartKitchenBatchTimer", ticketId),
    hasKitchenPrintedItems: (orderId: number) => ipcRenderer.invoke("orders:hasKitchenPrintedItems", orderId),
    detail: (orderId: number) => ipcRenderer.invoke("orders:detail", orderId),
    open: () => ipcRenderer.invoke("orders:open"),
    history: () => ipcRenderer.invoke("orders:history"),
    clearHistory: () => ipcRenderer.invoke("orders:clearHistory"),
    deleteClosedRecord: (orderId: number) => ipcRenderer.invoke("orders:deleteClosedRecord", orderId),
    reprintKitchen: (orderId: number) => ipcRenderer.invoke("orders:reprintKitchen", orderId),
    reprintReceipt: (orderId: number) => ipcRenderer.invoke("orders:reprintReceipt", orderId),
    printBill: (orderId: number, paymentInfo?: ReceiptPaymentInfo) => ipcRenderer.invoke("orders:printBill", orderId, paymentInfo),
    printAudit: (orderId: number) => ipcRenderer.invoke("orders:printAudit", orderId)
  },
  websiteOrders: {
    list: (statuses?: WebsiteOrderStatus[]): Promise<WebsiteOrderSummary[]> => ipcRenderer.invoke("websiteOrders:list", statuses),
    detail: (remoteId: string): Promise<WebsiteOrderDetail> => ipcRenderer.invoke("websiteOrders:detail", remoteId),
    queuePrint: (remoteId: string, kind?: WebsiteOrderPrintKind | "both"): Promise<WebsiteOrderPrintBatch> =>
      ipcRenderer.invoke("websiteOrders:queuePrint", remoteId, kind)
  },
  print: {
    listJobs: (status?: string) => ipcRenderer.invoke("print:listJobs", status),
    listPrinters: () => ipcRenderer.invoke("print:listPrinters"),
    printJob: (id: number) => ipcRenderer.invoke("print:printJob", id),
    retryJob: (id: number) => ipcRenderer.invoke("print:retryJob", id),
    sample: (type: "test" | "kot" | "receipt") => ipcRenderer.invoke("print:sample", type)
  },
  reports: {
    sales: (range?: { startDate?: string; endDate?: string }): Promise<SalesSummary> => ipcRenderer.invoke("reports:sales", range)
  },
  settings: {
    getBranding: () => ipcRenderer.invoke("settings:getBranding"),
    setBranding: (branding: BrandingSettings) => ipcRenderer.invoke("settings:setBranding", branding),
    chooseImage: () => ipcRenderer.invoke("settings:chooseImage"),
    getInventoryTracking: () => ipcRenderer.invoke("settings:getInventoryTracking"),
    setInventoryTracking: (enabled: boolean) => ipcRenderer.invoke("settings:setInventoryTracking", enabled),
    getPrinterName: () => ipcRenderer.invoke("settings:getPrinterName"),
    setPrinterName: (printerName: string) => ipcRenderer.invoke("settings:setPrinterName", printerName),
    getTotalTables: () => ipcRenderer.invoke("settings:getTotalTables"),
    setTotalTables: (totalTables: number) => ipcRenderer.invoke("settings:setTotalTables", totalTables),
    getHostNames: () => ipcRenderer.invoke("settings:getHostNames"),
    setHostNames: (hostNames: string[]) => ipcRenderer.invoke("settings:setHostNames", hostNames),
    getMenuCategories: () => ipcRenderer.invoke("settings:getMenuCategories"),
    setMenuCategories: (categories: string[]) => ipcRenderer.invoke("settings:setMenuCategories", categories),
    getMenuData: () => ipcRenderer.invoke("settings:getMenuData"),
    setMenuData: (menuData: MenuDataSetting[]) => ipcRenderer.invoke("settings:setMenuData", menuData),
    getMenuTypes: () => ipcRenderer.invoke("settings:getMenuTypes"),
    setMenuTypes: (menuTypes: MenuTypeSetting[]) => ipcRenderer.invoke("settings:setMenuTypes", menuTypes),
    getGoogleSheets: () => ipcRenderer.invoke("settings:getGoogleSheets"),
    saveGoogleOAuthClient: (input: GoogleOAuthClientInput) => ipcRenderer.invoke("settings:saveGoogleOAuthClient", input),
    setGoogleSheets: (settings: GoogleSheetsSettingsInput) => ipcRenderer.invoke("settings:setGoogleSheets", settings),
    connectGoogleSheets: () => ipcRenderer.invoke("settings:connectGoogleSheets"),
    disconnectGoogle: () => ipcRenderer.invoke("settings:disconnectGoogle"),
    listGoogleSpreadsheets: () => ipcRenderer.invoke("settings:listGoogleSpreadsheets"),
    listGoogleSheetTabs: (spreadsheetId?: string) => ipcRenderer.invoke("settings:listGoogleSheetTabs", spreadsheetId),
    openGoogleAppsScriptSettings: () => ipcRenderer.invoke("settings:openGoogleAppsScriptSettings"),
    syncGoogleSheets: () => ipcRenderer.invoke("settings:syncGoogleSheets"),
    installGoogleReportTool: () => ipcRenderer.invoke("settings:installGoogleReportTool")
  },
  email: {
    getSettings: () => ipcRenderer.invoke("email:getSettings"),
    saveSettings: (settings: EmailSettingsInput) => ipcRenderer.invoke("email:saveSettings", settings),
    clearAuth: () => ipcRenderer.invoke("email:clearAuth"),
    dailyPreview: () => ipcRenderer.invoke("email:dailyPreview"),
    sendDaily: () => ipcRenderer.invoke("email:sendDaily")
  }
};

contextBridge.exposeInMainWorld("yamzo", api);

export type YamzoApi = typeof api;
