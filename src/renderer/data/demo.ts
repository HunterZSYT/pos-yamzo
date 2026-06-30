import type { MenuItem, OrderSummary, SalesSummary } from "../../shared/types";

export const demoMenu: MenuItem[] = [
  { id: 1, name: "Chicken Momo", price: 190, category: "Momo", available: true, archived: false },
  { id: 2, name: "Chicken Cheese Momo", price: 240, category: "Momo", available: true, archived: false },
  { id: 3, name: "Ocean Chilli Pasta", price: 450, category: "Pasta", available: true, archived: false },
  { id: 4, name: "Garlic Chicken Fried Rice", price: 290, category: "Rice", available: true, archived: false }
];

export const demoOrders: OrderSummary[] = [];

export const demoSummary: SalesSummary = {
  totalSales: 0,
  totalOrders: 0,
  openOrders: 0,
  settledOrders: 0,
  discountTotal: 0,
  voidTotal: 0,
  paymentBreakdown: {},
  sourceBreakdown: {},
  topItems: [],
  averageKitchenMinutes: 0
};
