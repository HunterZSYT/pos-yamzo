import type { MenuItem, OrderSummary, SalesSummary } from "../../shared/types";

export const demoMenu: MenuItem[] = [
  { id: 1, publicId: "demo-menu-1", name: "Chicken Momo", price: 190, category: "Momo", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 190 } },
  { id: 2, publicId: "demo-menu-2", name: "Chicken Cheese Momo", price: 240, category: "Momo", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 240 } },
  { id: 3, publicId: "demo-menu-3", name: "Ocean Chilli Pasta", price: 450, category: "Pasta", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 450 } },
  { id: 4, publicId: "demo-menu-4", name: "Garlic Chicken Fried Rice", price: 290, category: "Rice", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 290 } }
];

export const demoOrders: OrderSummary[] = [];

export const demoSummary: SalesSummary = {
  totalSales: 0,
  grossSales: 0,
  netSales: 0,
  averageOrderValue: 0,
  netAfterCommission: 0,
  totalOrders: 0,
  openOrders: 0,
  settledOrders: 0,
  dineInGuests: 0,
  averageGuestsPerDineInOrder: 0,
  discountTotal: 0,
  voidTotal: 0,
  commissionTotal: 0,
  paymentBreakdown: {},
  sourceBreakdown: {},
  sourceTotals: [],
  paymentTotals: [],
  topItems: [],
  rawMaterialCost: 0,
  recordedCostTotal: 0,
  costRecordCount: 0,
  inventoryRestockSpend: 0,
  inventoryRestockCount: 0,
  inventoryPhysicalCountCount: 0,
  inventoryEvents: [],
  operatingProfit: 0,
  rawMaterialUsage: [],
  averageKitchenMinutes: 0
};
