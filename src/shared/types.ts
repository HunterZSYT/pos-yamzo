export type OrderSource =
  | "in_house"
  | "takeaway"
  | "parcel"
  | "delivery"
  | "foodpanda"
  | "foodie"
  | "other";

export type OrderStatus = "open" | "kitchen_sent" | "settled" | "cancelled";
export type PaymentMethod = "cash" | "bkash" | "nagad" | "card" | "other" | "split";
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
  name: string;
  price: number;
  category: string | null;
  available: boolean;
  archived: boolean;
}

export interface MenuItemInput {
  name: string;
  price: number;
  category?: string | null;
  available?: boolean;
}

export interface MenuImportResult {
  imported: number;
  updated: number;
  skipped: number;
  cancelled?: boolean;
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
  source: OrderSource;
  tableNumber: string | null;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  createdAt: string;
  updatedAt: string;
  kitchenStartedAt: string | null;
  kitchenCompletedAt: string | null;
  itemCount: number;
  itemPreview: string[];
  batches: OrderBatch[];
}

export interface OrderDetail extends OrderSummary {
  note: string | null;
  items: OrderLine[];
}

export interface SalesSummary {
  totalSales: number;
  totalOrders: number;
  openOrders: number;
  settledOrders: number;
  discountTotal: number;
  voidTotal: number;
  paymentBreakdown: Record<string, number>;
  sourceBreakdown: Record<string, number>;
  topItems: Array<{ name: string; quantity: number; total: number }>;
  averageKitchenMinutes: number;
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
  active: boolean;
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
  inventoryItemId: number;
  quantityBase: number;
  unitLabel: string;
}

export interface MenuRecipe {
  id: number;
  menuItemId: number;
  menuItemName: string;
  sellingPrice: number;
  status: "available" | "missing";
  rawCost: number;
  estimatedProfit: number;
  profitMargin: number;
  ingredients: RecipeIngredient[];
}

export interface RestockEntry {
  id: number;
  inventoryItemId: number;
  itemName: string;
  quantityBase: number;
  unitLabel: string;
  totalCost: number;
  pricePerBase: number;
  supplierName: string | null;
  responsiblePerson: string | null;
  note: string | null;
  entryDate: string;
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
}

export interface InventoryImportResult {
  recipesImported: number;
  recipesUpdated: number;
  inventoryItemsCreated: number;
  menuItemsCreated: number;
  rowsSkipped: number;
  errors: string[];
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

export interface InventorySnapshot {
  categories: InventoryCategory[];
  units: InventoryUnit[];
  items: InventoryItem[];
  recipes: MenuRecipe[];
  restocks: RestockEntry[];
  priceHistory: PriceHistoryRecord[];
  costCategories: CostCategory[];
  costRecords: CostRecord[];
  status: InventoryStatusSummary;
  profit: SalesProfitSummary;
}

export interface ReceiptPaymentInfo {
  paid: boolean;
  method: PaymentMethod;
  amount?: number;
  reference?: string;
  host?: string;
}

export interface EmailSettings {
  enabled: boolean;
  recipientEmail: string;
  sendDailySummary: boolean;
  sendEachSettledOrder: boolean;
  credentialPath: string;
  tokenPath: string;
}

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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
