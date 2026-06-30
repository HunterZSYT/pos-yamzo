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
