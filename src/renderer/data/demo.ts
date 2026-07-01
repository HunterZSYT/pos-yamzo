import type { MenuItem, OrderSummary, SalesSummary } from "../../shared/types";

export const demoMenu: MenuItem[] = [
  { id: 1, name: "Chicken Momo", price: 190, category: "Momo", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 190 } },
  { id: 2, name: "Chicken Cheese Momo", price: 240, category: "Momo", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 240 } },
  { id: 3, name: "Ocean Chilli Pasta", price: 450, category: "Pasta", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 450 } },
  { id: 4, name: "Garlic Chicken Fried Rice", price: 290, category: "Rice", trackRecipe: true, available: true, archived: false, menuPrices: { in_house: 290 } }
];

export const demoOrders: OrderSummary[] = [];

export const demoSummary: SalesSummary = {
  totalSales: 0,
  totalOrders: 0,
  openOrders: 0,
  settledOrders: 0,
  discountTotal: 0,
  voidTotal: 0,
  commissionTotal: 0,
  paymentBreakdown: {},
  sourceBreakdown: {},
  topItems: [],
  averageKitchenMinutes: 0
};
