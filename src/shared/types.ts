export type OrderSource = string;

export type OrderStatus = "open" | "kitchen_sent" | "settled" | "cancelled";
export type PaymentMethod = "cash" | "bkash" | "nagad" | "card" | "other" | "split";
export interface PaymentMethodSetting {
  key: Exclude<PaymentMethod, "split">;
  label: string;
  active: boolean;
}
export type PrintJobStatus = "pending" | "printed" | "failed" | "retry";
export type PrintJobType =
  | "kot"
  | "kot_reprint"
  | "addition_kot"
  | "void_kot"
  | "parcel_slip"
  | "bill"
  | "audit"
  | "receipt"
  | "paid_slip"
  | "receipt_reprint"
  | "test";

export interface User {
  id: number;
  username: string;
  role: "admin" | "cashier";
  createdAt: string;
}

export interface MenuItem {
  id: number;
  publicId: string;
  name: string;
  price: number;
  menuPrices?: Record<string, number>;
  category: string | null;
  trackRecipe: boolean;
  available: boolean;
  archived: boolean;
}

export interface MenuItemInput {
  name: string;
  price: number;
  category?: string | null;
  trackRecipe?: boolean;
  menuPrices?: Record<string, number>;
  available?: boolean;
}

export interface MenuImportResult {
  imported: number;
  updated: number;
  skipped: number;
  replaced?: number;
  menuTypes?: string[];
  cancelled?: boolean;
}

export interface MenuDataSetting {
  key: string;
  label: string;
  active: boolean;
  externalOrderIdEnabled?: boolean;
}

export interface MenuTypeSetting {
  key: string;
  label: string;
  menuDataKey: string;
  tablesEnabled: boolean;
  commissionPercent: number;
  active: boolean;
}

export interface OrderItemInput {
  menuItemId: number;
  quantity: number;
  note?: string;
  parcel?: boolean;
}

export interface OrderLine {
  id: number;
  menuItemId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  note: string | null;
  status: "active" | "voided";
  kitchenPrinted: boolean;
  parcel: boolean;
}

export interface OrderBatch {
  id: number;
  label: string;
  type: "kot" | "addition_kot" | string;
  createdAt: string;
  completedAt: string | null;
  items: string[];
}

export interface OrderSummary {
  id: number;
  orderNumber: string;
  orderDate: string;
  externalOrderId: string | null;
  source: OrderSource;
  tableNumber: string | null;
  guestCount: number;
  hostName: string;
  status: OrderStatus;
  subtotal: number;
  deliveryFee?: number;
  discount: number;
  discountMode: "tk" | "percent";
  discountInput: number;
  manualTotalInput: number | null;
  total: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  kitchenStartedAt: string | null;
  kitchenCompletedAt: string | null;
  itemCount: number;
  itemPreview: string[];
  batches: OrderBatch[];
  isTest?: boolean;
  initialKotState: InitialKotState | null;
  initialKotPrintJobId: number | null;
  paid: boolean;
  payment: OrderPayment | null;
  requiredKotCount: number;
  unresolvedKotCount: number;
  failedKotCount: number;
  billState: PrintJobStatus | "not_printed";
  paidSlipState: PrintJobStatus | "not_printed";
  websiteInitialKotState?: WebsiteInitialKotState | null;
}

export interface DiscountInputState {
  mode: "tk" | "percent";
  value: number;
  manualTotal: number | null;
}

export interface RecordPaymentResult {
  order: OrderSummary;
  paidSlipPrintJobId: number;
}

export interface Manager {
  id: number;
  managerCode: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagerInput {
  id?: number;
  managerCode: string;
  name: string;
  pin?: string;
  active?: boolean;
}

export interface ManagerAuthorization {
  managerId: number;
  pin: string;
  reason: string;
  operator: string;
}

export type InitialKotState = "required" | "queued" | "awaiting_retry" | "confirmed";

export interface OrderPayment {
  method: PaymentMethod;
  amount: number;
  cashAmount: number;
  bkashAmount: number;
  cashReceived: number | null;
  changeGiven: number;
  reference: string | null;
  hostName: string;
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  note: string | null;
  items: OrderLine[];
}

export interface SalesSummary {
  totalSales: number;
  grossSales: number;
  netSales: number;
  averageOrderValue: number;
  netAfterCommission: number;
  totalOrders: number;
  openOrders: number;
  settledOrders: number;
  dineInGuests: number;
  averageGuestsPerDineInOrder: number;
  discountTotal: number;
  voidTotal: number;
  commissionTotal: number;
  paymentBreakdown: Record<string, number>;
  sourceBreakdown: Record<string, number>;
  sourceTotals: Array<{
    source: string;
    orders: number;
    grossSales: number;
    discount: number;
    netSales: number;
    commission: number;
    netAfterCommission: number;
  }>;
  paymentTotals: Array<{ method: string; orders: number; amount: number }>;
  registerTotals: {
    cash: number;
    bkash: number;
    foodpanda: number;
    foodie: number;
  };
  topItems: Array<{ name: string; quantity: number; total: number }>;
  rawMaterialCost: number;
  recordedCostTotal: number;
  costRecordCount: number;
  inventoryRestockSpend: number;
  inventoryRestockCount: number;
  inventoryPhysicalCountCount: number;
  inventoryEvents: InventoryReportEvent[];
  operatingProfit: number;
  rawMaterialUsage: Array<{
    inventoryItemId: number;
    itemName: string;
    quantityBase: number;
    unitLabel: string;
    rawCost: number;
  }>;
  averageKitchenMinutes: number;
}

export type WebsiteOrderStatus =
  | "pending"
  | "accepted"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "rejected"
  | "cancelled";

export interface WebsiteOrderAddress {
  sector: string;
  road: string;
  house: string;
  flat: string;
}

export interface WebsiteOrderItemSnapshot {
  remoteItemId: string;
  /** Stable cross-system catalog key (for example, menu_item_chicken_momo), never a POS row id. */
  menuItemPublicId: string;
  name: string;
  quantity: number;
  /** Whole Bangladeshi taka after the main-process transport validates/converts remote minor units. */
  unitPrice: number;
  note?: string | null;
}

export interface WebsiteOrderSnapshot {
  remoteId: string;
  orderCode: string;
  remoteVersion: number;
  /**
   * Cloud mirror of the POS-owned restaurant lifecycle after terminal claim.
   * Website Admin remains the gateway/observer and cannot advance this value.
   */
  status: WebsiteOrderStatus;
  customerName: string;
  customerPhone: string;
  address: WebsiteOrderAddress;
  deliveryNote?: string | null;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  isTest: boolean;
  remoteCreatedAt: string;
  remoteUpdatedAt: string;
  items: WebsiteOrderItemSnapshot[];
}

export interface WebsiteOrderItem extends WebsiteOrderItemSnapshot {
  id: number;
  menuItemId: number | null;
  mapped: boolean;
}

export interface WebsiteOrderSummary {
  remoteId: string;
  orderCode: string;
  remoteVersion: number;
  status: WebsiteOrderStatus;
  customerName: string;
  customerPhone: string;
  total: number;
  isTest: boolean;
  itemCount: number;
  itemPreview: string[];
  posOrderId: number | null;
  receivedAt: string;
  remoteCreatedAt: string;
  updatedAt: string;
  initialKotState: WebsiteInitialKotState | null;
}

export type WebsiteInitialKotState =
  | "queued"
  | "printing"
  | "awaiting_retry"
  | "confirmed";

export interface WebsiteConnectionSettings {
  baseUrl: string;
  terminalCode: string;
  includeTestOrders: boolean;
}

export type WebsiteConnectionState =
  | "connected"
  | "reconnecting"
  | "offline"
  | "error"
  | "disconnected";

export type WebsiteRealtimeState =
  | "connected"
  | "reconnecting"
  | "offline";

export interface WebsiteRealtimeSession {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: string;
  expiresAt: string;
  topic: string;
  event: "pending_order_may_exist";
  terminal: {
    id: string;
    code: string;
    name: string;
    mode: "test" | "live";
    lastHeartbeatAt: string | null;
    keyRotatedAt: string;
    keyExpiresAt: string | null;
  };
}

export interface WebsiteConnectionStatus {
  configured: boolean;
  connection: WebsiteConnectionState;
  realtime: WebsiteRealtimeState;
  terminalName: string | null;
  terminalCode: string | null;
  environment: "test" | "live" | null;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
  lastWebsiteOrder: { reference: string; receivedAt: string } | null;
  menuReconciliation: {
    status: "ready" | "issues";
    issueCount: number;
  };
  terminalKey: {
    status: "valid" | "expiring" | "rotation_required" | "unknown";
    rotatedAt: string | null;
    expiresAt: string | null;
  };
  errors: string[];
}

export interface WebsiteConnectionDiagnostics extends WebsiteConnectionStatus {
  baseUrl: string | null;
  syncCursorPresent: boolean;
  pendingLocalEvents: number;
  failedLocalEvents: number;
  pendingInitialKotCount: number;
  generatedAt: string;
}

export interface WebsiteOrderDetail extends WebsiteOrderSummary {
  address: WebsiteOrderAddress;
  deliveryNote: string | null;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  rejectionReason: string | null;
  items: WebsiteOrderItem[];
}

export type WebsiteOrderPrintKind = "kitchen_copy" | "customer_receipt";

export interface WebsiteOrderPrintJob {
  id: number;
  kind: WebsiteOrderPrintKind;
}

export interface WebsiteOrderPrintBatch {
  websiteOrder: WebsiteOrderDetail;
  jobs: WebsiteOrderPrintJob[];
}

export interface WebsiteOutboxEvent {
  id: number;
  /** Durable UUID used for remote idempotency even if the local SQLite IDs are reused. */
  eventKey: string;
  remoteOrderId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: string;
}

export interface WebsiteTransitionResult {
  eventId: number;
  remoteOrderId: string;
  status: WebsiteOrderStatus;
  remoteVersion: number;
}

export interface InventoryReportEvent {
  id: number;
  eventType: "restock" | "adjustment" | "physical_count";
  timestamp: string;
  itemName: string;
  quantityBase: number;
  unitLabel: string;
  totalCost: number;
}

export interface PrintJob {
  id: number;
  type: PrintJobType;
  content: string;
  printer: string | null;
  status: PrintJobStatus;
  errorMessage: string | null;
  createdAt: string;
}

export interface ActivityLog {
  id: number;
  actor: string | null;
  action: string;
  title: string;
  description: string;
  status: "success" | "failed" | "info";
  createdAt: string;
}

export interface InventoryCategory {
  id: number;
  name: string;
  active: boolean;
}

export interface InventoryUnit {
  id: number;
  name: string;
  shortName: string;
  active: boolean;
}

export interface InventoryUnitInput {
  id?: number;
  name: string;
  shortName: string;
  active?: boolean;
}

export interface InventoryItem {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  baseUnitId: number;
  unitName: string;
  unitShortName: string;
  currentStock: number;
  latestPrice: number;
  estimatedValue: number;
  lowStockThreshold: number;
  status: "ok" | "low" | "out";
  stockUsed: number;
  expectedLeft: number;
  lastCountAt: string | null;
  lastRestockAt: string | null;
  latestRestockQuantity: number;
  estimatedWastage: number;
  countRequired: boolean;
  active: boolean;
}

export interface HistoryRange {
  startDate?: string;
  endDate?: string;
}

export interface KotHistoryEntry {
  printJobId: number;
  orderId: number;
  orderNumber: string;
  source: string;
  tableNumber: string | null;
  guestCount: number;
  kotType: string;
  items: string[];
  printer: string | null;
  operator: string;
  managerName: string | null;
  reason: string | null;
  status: PrintJobStatus;
  errorMessage: string | null;
  requestedAt: string;
  printedAt: string | null;
  attemptCount: number;
  successfulPrintCount: number;
  reprintCount: number;
}

export interface SwapHistoryEntry {
  id: number;
  orderId: number;
  orderNumber: string;
  source: string;
  tableNumber: string | null;
  guestCount: number;
  eventKind: "swap" | "cancel";
  originalName: string;
  originalQuantity: number;
  replacementName: string | null;
  replacementQuantity: number | null;
  reason: string;
  managerName: string;
  operator: string;
  originalKotPrintJobId: number | null;
  adjustmentPrintJobId: number;
  adjustmentStatus: PrintJobStatus;
  successfulPrintCount: number;
  createdAt: string;
}

export type InventoryBindingType = "recipe" | "item";
export type HistoricalScope = "future" | "all" | "range";

export interface MenuInventoryBinding {
  id: number;
  menuItemId: number;
  menuItemName: string;
  bindingType: InventoryBindingType;
  recipeId: number | null;
  recipeName: string | null;
  inventoryItemId: number | null;
  inventoryItemName: string | null;
  quantityBase: number;
  unitLabel: string;
  updatedAt: string;
}

export interface RecipeVersionSummary {
  id: number;
  versionNumber: number;
  changeNote: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  current: boolean;
}

export interface RecipeIngredient {
  id: number;
  inventoryItemId: number;
  itemName: string;
  quantityBase: number;
  unitLabel: string;
  latestPrice: number;
  rawCost: number;
}

export interface RecipeIngredientInput {
  kind?: "raw" | "recipe";
  inventoryItemId?: number;
  childRecipeId?: number;
  quantityBase: number;
  unitLabel: string;
}

export interface RecipeChildIngredient {
  id: number;
  childRecipeId: number;
  menuItemName: string;
  quantityBase: number;
  unitLabel: string;
  rawCost: number;
}

export interface MenuRecipe {
  id: number;
  menuItemId: number;
  menuItemName: string;
  sellingPrice: number;
  status: "available" | "missing";
  standalone: boolean;
  restockEnabled: boolean;
  useInRecipeEnabled: boolean;
  currentVersionId: number | null;
  versionNumber: number;
  versions: RecipeVersionSummary[];
  rawCost: number;
  estimatedProfit: number;
  profitMargin: number;
  ingredients: RecipeIngredient[];
  childIngredients: RecipeChildIngredient[];
}

export interface InventoryBackfillPreview {
  orderCount: number;
  missingSnapshotCount: number;
  existingSnapshotCount: number;
  estimatedRevenue: number;
  estimatedRawCost: number;
  currentSnapshotRawCost: number;
  rawCostDelta: number;
  estimatedMissingRecipeCount: number;
}

export interface RecipeSaveInput {
  menuItemId?: number;
  recipeName?: string;
  standalone?: boolean;
  ingredients: RecipeIngredientInput[];
}

export interface InventoryBindingPreview extends InventoryBackfillPreview {
  menuItemId: number;
  menuItemName: string;
}

export interface RestockEntry {
  id: number;
  inventoryItemId: number;
  itemName: string;
  itemType: "raw" | "recipe";
  entryType: "purchase" | "adjustment";
  recipeId: number | null;
  recipeName: string | null;
  quantityBase: number;
  unitLabel: string;
  totalCost: number;
  pricePerBase: number;
  supplierName: string | null;
  responsiblePerson: string | null;
  note: string | null;
  adjustmentReason: string | null;
  entryDate: string;
  updatedAt: string;
}

export interface PriceHistoryRecord {
  id: number;
  inventoryItemId: number;
  itemName: string;
  pricePerBase: number;
  effectiveAt: string;
  responsiblePerson: string | null;
  note: string | null;
}

export interface CostCategory {
  id: number;
  name: string;
  active: boolean;
  sortOrder?: number;
}

export interface CostRecord {
  id: number;
  categoryId: number | null;
  categoryName: string | null;
  costName: string;
  amount: number;
  paymentMethod: string | null;
  responsiblePerson: string | null;
  note: string | null;
  costDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface RestockEntryInput {
  inventoryItemId: number;
  itemType?: "raw" | "recipe";
  entryType?: "purchase" | "adjustment";
  recipeId?: number | null;
  quantity: number;
  unitLabel?: string;
  totalCost?: number;
  supplierName?: string | null;
  responsiblePerson?: string | null;
  note?: string | null;
  adjustmentReason?: string | null;
  /** Local inventory event time. Accepts YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss]. */
  entryDate?: string | null;
}

export interface RestockEntryUpdateInput extends RestockEntryInput {
  id: number;
}

export interface PhysicalCountEntry {
  id: number;
  inventoryItemId: number;
  itemName: string;
  quantityBase: number;
  reductionDelta: number | null;
  unitLabel: string;
  responsiblePerson: string | null;
  note: string | null;
  countDate: string;
  updatedAt: string;
  source: "manual" | "restock";
}

export interface InventoryItemImportResult {
  imported: number;
  updated: number;
  skipped: number;
  deleted: number;
  errors: string[];
  cancelled?: boolean;
}

export interface InventoryImportResult {
  recipesImported: number;
  recipesUpdated: number;
  inventoryItemsCreated: number;
  menuItemsCreated: number;
  rowsSkipped: number;
  errors: string[];
  versionsCreated?: number;
  versionsUpdated?: number;
  historicalOrdersUpdated?: number;
  cancelled?: boolean;
}

export interface InventoryStatusSummary {
  totalInventoryValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  missingRecipeCount: number;
  recipeAvailableCount: number;
  inventoryItemCount: number;
  recentRestocks: RestockEntry[];
  lowStockItems: InventoryItem[];
  missingRecipes: Array<{ menuItemId: number; name: string; price: number }>;
}

export interface SalesProfitSummary {
  revenue: number;
  rawCost: number;
  otherCost: number;
  grossProfit: number;
  netProfit: number;
  missingRecipeCount: number;
  topProfitItems: Array<{ name: string; revenue: number; rawCost: number; profit: number }>;
}

export interface InventoryOrderUsageIngredient {
  inventoryItemId: number;
  itemName: string;
  quantityBase: number;
  unitLabel: string;
  rawCost: number;
}

export interface InventoryOrderUsageMenuItem {
  orderItemId: number;
  menuItemName: string;
  quantity: number;
  revenue: number;
  rawCost: number;
  ingredients: InventoryOrderUsageIngredient[];
}

export interface InventoryOrderUsageSummary {
  orderId: number;
  orderNumber: string;
  orderDate: string;
  source: OrderSource;
  tableNumber: string | null;
  settledAt: string | null;
  total: number;
  items: InventoryOrderUsageMenuItem[];
}

export interface InventoryIngredientUsageTotal {
  inventoryItemId: number;
  itemName: string;
  quantityBase: number;
  unitLabel: string;
  rawCost: number;
}

export interface InventoryOrderUsageSnapshot {
  orders: InventoryOrderUsageSummary[];
  totals: InventoryIngredientUsageTotal[];
}

export interface InventorySnapshot {
  categories: InventoryCategory[];
  units: InventoryUnit[];
  items: InventoryItem[];
  recipes: MenuRecipe[];
  bindings: MenuInventoryBinding[];
  restocks: RestockEntry[];
  physicalCounts: PhysicalCountEntry[];
  priceHistory: PriceHistoryRecord[];
  costCategories: CostCategory[];
  costRecords: CostRecord[];
  orderUsage: InventoryOrderUsageSnapshot;
  status: InventoryStatusSummary;
  profit: SalesProfitSummary;
}

export interface InventoryActivityResetResult {
  usageAdjustments: number;
  restockEntries: number;
  physicalCounts: number;
}

export interface PhysicalCountInput {
  inventoryItemId: number;
  quantity: number;
  responsiblePerson?: string | null;
  note?: string | null;
  /** Local inventory event time. Accepts YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss]. */
  countDate?: string | null;
  source?: "manual" | "restock";
}

export interface PhysicalCountUpdateInput extends PhysicalCountInput {
  id: number;
  reason?: string | null;
}

export type GoogleSheetsSyncStatus = "disconnected" | "ready" | "pending" | "syncing" | "synced" | "error";

export type GoogleIntegrationErrorCode =
  | "apps_script_user_setting_disabled"
  | "credentials_missing"
  | "authorization_required"
  | "authorization_expired"
  | "permission_missing"
  | "invalid_client"
  | "invalid_spreadsheet"
  | "google_request_failed";

export interface GoogleOAuthClientInput {
  clientId: string;
  /** Leave blank to retain the locally saved secret for the same client ID. */
  clientSecret?: string;
}

export interface GoogleSpreadsheetOption {
  id: string;
  name: string;
  modifiedTime: string | null;
  webViewLink: string | null;
}

export interface GoogleSheetTabOption {
  id: number;
  title: string;
  index: number;
  hidden: boolean;
}

export interface GoogleSheetTabListResult {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: GoogleSheetTabOption[];
}

export interface GoogleSheetsSettings {
  enabled: boolean;
  redirectUri: string;
  spreadsheetId: string;
  spreadsheetTitle: string | null;
  ordersTab: string;
  orderItemsTab: string;
  costsTab: string;
  clientId: string;
  hasClientCredentials: boolean;
  connectedEmail: string | null;
  connected: boolean;
  syncStatus: GoogleSheetsSyncStatus;
  pending: boolean;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastErrorCode: GoogleIntegrationErrorCode | null;
  lastErrorActionUrl: string | null;
  scriptProjectId: string | null;
  reportToolInstalled: boolean;
}

export interface GoogleSheetsSettingsInput {
  enabled?: boolean;
  spreadsheetId?: string;
  ordersTab?: string;
  orderItemsTab?: string;
  costsTab?: string;
}

export interface GoogleSheetsConnectionResult {
  settings: GoogleSheetsSettings;
  spreadsheetTitle: string | null;
  connectedEmail: string | null;
  redirectUri: string;
}

export interface GoogleSheetsSyncResult {
  spreadsheetId: string;
  spreadsheetTitle: string;
  orders: number;
  orderItems: number;
  costs: number;
  syncedAt: string;
}

export interface GoogleReportToolResult {
  scriptProjectId: string;
  editorUrl: string;
  installedAt: string;
}

export interface ReceiptPaymentInfo {
  paid: boolean;
  method: PaymentMethod;
  amount?: number;
  cashAmount?: number;
  bkashAmount?: number;
  cashReceived?: number;
  changeGiven?: number;
  reference?: string;
  host?: string;
}

export interface EmailSettings {
  enabled: boolean;
  recipientEmail: string;
  sendDailySummary: boolean;
  sendEachSettledOrder: boolean;
  sendTime?: string;
  connectedEmail?: string | null;
  lastDailySummaryDate?: string | null;
  lastDailySummarySentAt?: string | null;
  lastError?: string | null;
}

export interface EmailSettingsInput {
  enabled?: boolean;
  recipientEmail?: string;
  sendDailySummary?: boolean;
  sendEachSettledOrder?: boolean;
  sendTime?: string;
}

export interface EmailSendResult {
  recipientEmail: string;
  connectedEmail: string;
  sentAt: string;
}

export interface BrandingSettings {
  restaurantName: string;
  address: string;
  phone: string;
  emailWebsiteSocial: string;
  footerMessage: string;
  vatText: string;
  showLogo: boolean;
  showQr: boolean;
  showAddressPhone: boolean;
  showFooter: boolean;
  logoPath?: string;
  qrPath?: string;
}
