import { contextBridge, ipcRenderer } from "electron";
import type { BrandingSettings, EmailSettings, GmailOAuthConfig, MenuItemInput, OrderItemInput, OrderSource, PaymentMethod, ReceiptPaymentInfo } from "../shared/types.js";

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
    chooseAndImportCsv: () => ipcRenderer.invoke("inventory:chooseAndImportCsv"),
    importCsv: (csvPath: string) => ipcRenderer.invoke("inventory:importCsv", csvPath),
    saveItem: (input: { id?: number; name: string; categoryId?: number | null; baseUnitId: number; lowStockThreshold?: number; active?: boolean }) =>
      ipcRenderer.invoke("inventory:saveItem", input),
    deleteItem: (id: number) => ipcRenderer.invoke("inventory:deleteItem", id),
    saveRecipe: (input: { menuItemId: number; ingredients: Array<{ inventoryItemId: number; quantityBase: number; unitLabel: string }> }) =>
      ipcRenderer.invoke("inventory:saveRecipe", input),
    saveCategory: (input: { id?: number; name: string; active?: boolean }) => ipcRenderer.invoke("inventory:saveCategory", input),
    removeCategory: (id: number) => ipcRenderer.invoke("inventory:removeCategory", id),
    saveUnit: (input: { id?: number; name: string; shortName: string; active?: boolean }) => ipcRenderer.invoke("inventory:saveUnit", input),
    removeUnit: (id: number) => ipcRenderer.invoke("inventory:removeUnit", id),
    addRestock: (input: { inventoryItemId: number; quantity: number; unitLabel?: string; totalCost?: number; supplierName?: string | null; responsiblePerson?: string | null; note?: string | null; entryDate?: string | null }) =>
      ipcRenderer.invoke("inventory:addRestock", input),
    updateRestock: (input: { id: number; inventoryItemId: number; quantity: number; unitLabel?: string; totalCost?: number; supplierName?: string | null; responsiblePerson?: string | null; note?: string | null }) =>
      ipcRenderer.invoke("inventory:updateRestock", input),
    deleteRestock: (id: number) => ipcRenderer.invoke("inventory:deleteRestock", id),
    addPrice: (input: { inventoryItemId: number; pricePerBase: number; effectiveAt?: string | null; responsiblePerson?: string | null; note?: string | null }) =>
      ipcRenderer.invoke("inventory:addPrice", input),
    saveCostCategory: (input: { id?: number; name: string; active?: boolean }) => ipcRenderer.invoke("inventory:saveCostCategory", input),
    removeCostCategory: (id: number) => ipcRenderer.invoke("inventory:removeCostCategory", id),
    addCost: (input: { categoryId?: number | null; costName: string; amount: number; paymentMethod?: string | null; responsiblePerson?: string | null; note?: string | null; costDate?: string | null }) =>
      ipcRenderer.invoke("inventory:addCost", input)
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
    create: (input: { source: OrderSource; tableNumber?: string; note?: string }) => ipcRenderer.invoke("orders:create", input),
    addItem: (orderId: number, input: OrderItemInput) => ipcRenderer.invoke("orders:addItem", orderId, input),
    sendKitchen: (orderId: number, allowExternal?: boolean) => ipcRenderer.invoke("orders:sendKitchen", orderId, allowExternal),
    discount: (orderId: number, discount: number) => ipcRenderer.invoke("orders:discount", orderId, discount),
    updateNote: (orderId: number, note: string) => ipcRenderer.invoke("orders:updateNote", orderId, note),
    updateInfo: (orderId: number, input: { source: OrderSource; tableNumber?: string | null; note?: string | null }) =>
      ipcRenderer.invoke("orders:updateInfo", orderId, input),
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
    reprintKitchen: (orderId: number) => ipcRenderer.invoke("orders:reprintKitchen", orderId),
    reprintReceipt: (orderId: number) => ipcRenderer.invoke("orders:reprintReceipt", orderId),
    printBill: (orderId: number, paymentInfo?: ReceiptPaymentInfo) => ipcRenderer.invoke("orders:printBill", orderId, paymentInfo),
    printAudit: (orderId: number) => ipcRenderer.invoke("orders:printAudit", orderId)
  },
  print: {
    listJobs: (status?: string) => ipcRenderer.invoke("print:listJobs", status),
    listPrinters: () => ipcRenderer.invoke("print:listPrinters"),
    printJob: (id: number) => ipcRenderer.invoke("print:printJob", id),
    retryJob: (id: number) => ipcRenderer.invoke("print:retryJob", id),
    sample: (type: "test" | "kot" | "receipt") => ipcRenderer.invoke("print:sample", type)
  },
  reports: {
    sales: (start?: string, end?: string) => ipcRenderer.invoke("reports:sales", start, end)
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
    setMenuCategories: (categories: string[]) => ipcRenderer.invoke("settings:setMenuCategories", categories)
  },
  email: {
    getSettings: () => ipcRenderer.invoke("email:getSettings"),
    saveSettings: (settings: EmailSettings) => ipcRenderer.invoke("email:saveSettings", settings),
    authUrl: (config: GmailOAuthConfig) => ipcRenderer.invoke("email:authUrl", config),
    clearAuth: () => ipcRenderer.invoke("email:clearAuth"),
    dailyPreview: () => ipcRenderer.invoke("email:dailyPreview"),
    sendDaily: () => ipcRenderer.invoke("email:sendDaily")
  }
};

contextBridge.exposeInMainWorld("yamzo", api);

export type YamzoApi = typeof api;
