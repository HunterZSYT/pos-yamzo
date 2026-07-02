import { useEffect, useId, useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  BrandingSettings,
  EmailSettings,
  ActivityLog,
  CostCategory,
  InventoryCategory,
  InventoryItem,
  InventorySnapshot,
  InventoryUnit,
  MenuDataSetting,
  MenuTypeSetting,
  MenuRecipe,
  MenuImportResult,
  MenuItem,
  OrderDetail,
  OrderLine,
  OrderSource,
  OrderSummary,
  PaymentMethod,
  PrintJob,
  RestockEntry,
  SalesSummary
} from "../../shared/types";
import { demoMenu, demoOrders, demoSummary } from "../data/demo";

type Screen = "newOrder" | "editOrder" | "openOrders" | "completedOrders" | "cancelledOrders" | "reports" | "menu" | "inventory" | "costs" | "admin";
type AdminTab = "receipt" | "printer" | "email" | "app" | "adminSettings" | "activity";
type DiscountMode = "tk" | "percent";
type OrderLane = "newOrder" | "openOrders";
type PrintConfirm = { type: "kitchen" | "bill"; orderId: number; orderNumber: string } | null;
type NoteEdit = { line: OrderLine; draft: string } | null;
type ProtectedScreen = "completedOrders" | "cancelledOrders" | "admin";
type MenuFormState = { id: number; name: string; price: string; category: string; available: boolean; trackRecipe: boolean; menuPrices: Record<string, string> };

interface PrinterOption {
  name: string;
  displayName: string;
  isDefault: boolean;
}

const defaultMenuTypes: MenuTypeSetting[] = [
  { key: "in_house", label: "Dine-in", menuDataKey: "in_house", tablesEnabled: true, commissionPercent: 0, active: true },
  { key: "parcel", label: "Parcel", menuDataKey: "in_house", tablesEnabled: false, commissionPercent: 0, active: true },
  { key: "delivery", label: "Delivery", menuDataKey: "in_house", tablesEnabled: false, commissionPercent: 0, active: true },
  { key: "foodpanda", label: "Foodpanda", menuDataKey: "foodpanda", tablesEnabled: false, commissionPercent: 0, active: true },
  { key: "foodie", label: "Foodie", menuDataKey: "foodie", tablesEnabled: false, commissionPercent: 0, active: true },
  { key: "other", label: "Other", menuDataKey: "in_house", tablesEnabled: false, commissionPercent: 0, active: true }
];

const defaultMenuData: MenuDataSetting[] = [
  { key: "in_house", label: "Store Menu", active: true },
  { key: "foodpanda", label: "Foodpanda Menu", active: true },
  { key: "foodie", label: "Foodie Menu", active: true }
];

const deleteReasons = [
  "Customer cancelled",
  "Wrong table",
  "Wrong item entered",
  "Duplicate order",
  "Payment issue",
  "Staff mistake",
  "Kitchen requested cancel"
];

const emptyEmailSettings: EmailSettings = {
  enabled: false,
  recipientEmail: "",
  sendDailySummary: false,
  sendEachSettledOrder: false,
  credentialPath: "",
  tokenPath: ""
};

const emptyBranding: BrandingSettings = {
  restaurantName: "Yamzo",
  address: "House-80, Road-20, Sector 11, Uttara, Dhaka 1230",
  phone: "01761-737584",
  emailWebsiteSocial: "yamzo.uttara@gmail.com",
  footerMessage: "THANK YOU FOR DINING WITH US!",
  vatText: "",
  showLogo: true,
  showQr: true,
  showAddressPhone: true,
  showFooter: true,
  logoPath: "yamzo://default-logo",
  qrPath: "yamzo://review-qr"
};

const emptyInventorySnapshot: InventorySnapshot = {
  categories: [],
  units: [],
  items: [],
  recipes: [],
  restocks: [],
  physicalCounts: [],
  priceHistory: [],
  costCategories: [],
  costRecords: [],
  orderUsage: { orders: [], totals: [] },
  status: {
    totalInventoryValue: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
    missingRecipeCount: 0,
    recipeAvailableCount: 0,
    inventoryItemCount: 0,
    recentRestocks: [],
    lowStockItems: [],
    missingRecipes: []
  },
  profit: {
    revenue: 0,
    rawCost: 0,
    otherCost: 0,
    grossProfit: 0,
    netProfit: 0,
    missingRecipeCount: 0,
    topProfitItems: []
  }
};

const PROTECTED_ACCESS_MS = 30 * 60 * 1000;

export function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("1234");
  const [screen, setScreen] = useState<Screen>("newOrder");
  const [orderLane, setOrderLane] = useState<OrderLane>("newOrder");
  const [adminTab, setAdminTab] = useState<AdminTab>("receipt");
  const [menu, setMenu] = useState<MenuItem[]>(demoMenu);
  const [openOrders, setOpenOrders] = useState<OrderSummary[]>(demoOrders);
  const [history, setHistory] = useState<OrderSummary[]>([]);
  const [summary, setSummary] = useState<SalesSummary>(demoSummary);
  const [printJobs, setPrintJobs] = useState<PrintJob[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState("");
  const [emailPreview, setEmailPreview] = useState("");
  const [emailSettings, setEmailSettings] = useState<EmailSettings>(emptyEmailSettings);
  const [branding, setBranding] = useState<BrandingSettings>(emptyBranding);
  const [trackInventory, setTrackInventory] = useState(false);
  const [inventorySnapshot, setInventorySnapshot] = useState<InventorySnapshot>(emptyInventorySnapshot);
  const [totalTables, setTotalTables] = useState(10);
  const [hostNames, setHostNames] = useState<string[]>(["Cashier"]);
  const [menuCategories, setMenuCategories] = useState<string[]>([]);
  const [menuData, setMenuData] = useState<MenuDataSetting[]>(defaultMenuData);
  const [menuTypes, setMenuTypes] = useState<MenuTypeSetting[]>(defaultMenuTypes);
  const [selectedHost, setSelectedHost] = useState("Cashier");
  const [hostDraft, setHostDraft] = useState("");
  const [menuCategoryDraft, setMenuCategoryDraft] = useState("");
  const [showEmailAdvanced, setShowEmailAdvanced] = useState(false);
  const [source, setSource] = useState<OrderSource>("in_house");
  const [tableNumber, setTableNumber] = useState("");
  const [orderNote, setOrderNote] = useState("");
  const [discountMode, setDiscountMode] = useState<DiscountMode>("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [finalTotalInput, setFinalTotalInput] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [markAsPaid, setMarkAsPaid] = useState(false);
  const [paymentReference, setPaymentReference] = useState("");
  const [activeOrder, setActiveOrder] = useState<OrderDetail | null>(null);
  const [externalKitchenEnabled, setExternalKitchenEnabled] = useState(false);
  const [menuForm, setMenuForm] = useState<MenuFormState>({ id: 0, name: "", price: "", category: "", available: true, trackRecipe: true, menuPrices: {} });
  const [message, setMessage] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteNeedsReason, setDeleteNeedsReason] = useState(false);
  const [printConfirm, setPrintConfirm] = useState<PrintConfirm>(null);
  const [sessionPrinted, setSessionPrinted] = useState<Record<string, boolean>>({});
  const [noteEdit, setNoteEdit] = useState<NoteEdit>(null);
  const [historyView, setHistoryView] = useState<OrderDetail | null>(null);
  const [reprintMode, setReprintMode] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  const [menuSearch, setMenuSearch] = useState("");
  const [recipeEdit, setRecipeEdit] = useState<MenuRecipe | null>(null);
  const [priceHistoryItemId, setPriceHistoryItemId] = useState<number | null>(null);
  const [protectedTarget, setProtectedTarget] = useState<ProtectedScreen | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [protectedAccess, setProtectedAccess] = useState<Partial<Record<ProtectedScreen, number>>>({});

  useEffect(() => {
    if (!loggedIn) return;
    void refreshData();
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    const timer = window.setInterval(() => void refreshData(), 30000);
    return () => window.clearInterval(timer);
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    const timer = window.setInterval(() => {
      setOpenOrders((orders) => [...orders]);
      setHistory((orders) => [...orders]);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loggedIn]);

  useEffect(() => {
    if (!message || !loggedIn) return;
    const timer = window.setTimeout(() => setMessage(""), 4500);
    return () => window.clearTimeout(timer);
  }, [message, loggedIn]);

  const activeItems = activeOrder?.items.filter((item) => item.status === "active") ?? [];
  const subtotal = activeOrder?.subtotal ?? 0;
  const calculatedDiscount = useMemo(() => {
    const parsed = Number(discountValue || 0);
    const raw = Number.isFinite(parsed) ? parsed : 0;
    if (discountMode === "percent") {
      return Math.round((subtotal * Math.min(Math.max(raw, 0), 100)) / 100);
    }
    return Math.min(Math.max(Math.round(raw), 0), subtotal);
  }, [discountMode, discountValue, subtotal]);
  const payableTotal = Math.max(0, subtotal - calculatedDiscount);
  const activeMenuTypes = useMemo(() => menuTypes.filter((type) => type.active !== false), [menuTypes]);
  const selectedMenuType = activeMenuTypes.find((type) => type.key === source) ?? activeMenuTypes[0] ?? defaultMenuTypes[0];
  const tablesEnabledForSource = selectedMenuType?.tablesEnabled ?? source === "in_house";
  const isExternalOrder = !tablesEnabledForSource && ["foodpanda", "foodie", "other"].includes(source);
  const canPrintKitchen = !isExternalOrder || externalKitchenEnabled;
  const needsDineInTable = tablesEnabledForSource && !tableNumber.trim();
  const failedPrintJobs = printJobs.filter((job) => job.status === "failed" || job.status === "retry");
  const completedOrders = history.filter((order) => order.status === "settled");
  const cancelledOrders = history.filter((order) => order.status === "cancelled");
  const openOrderByTable = useMemo(() => {
    const map = new Map<string, OrderSummary>();
    for (const order of openOrders) {
      const orderType = menuTypes.find((type) => type.key === order.source);
      if ((orderType?.tablesEnabled ?? order.source === "in_house") && order.tableNumber) {
        map.set(order.tableNumber, order);
      }
    }
    return map;
  }, [menuTypes, openOrders]);
  const groupedMenu = useMemo(() => {
    const query = menuSearch.trim().toLowerCase();
    const groups = new Map<string, MenuItem[]>();
    for (const item of menu) {
      const sourcePrice = menuItemPrice(item, source, menuTypes);
      if (sourcePrice <= 0) continue;
      const haystack = `${item.name} ${item.category ?? ""}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      const category = item.category?.trim() || "Other";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)?.push(item);
    }
    const ordered: Array<[string, MenuItem[]]> = [];
    for (const category of menuCategories) {
      const items = groups.get(category);
      if (items) {
        ordered.push([category, items]);
        groups.delete(category);
      }
    }
    return [...ordered, ...Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))];
  }, [menu, menuCategories, menuSearch, source, menuTypes]);

  async function refreshData() {
    if (!window.yamzo) return;
    const [menuRows, openRows, historyRows, sales, jobs, email, receipt, inventory, inventoryData, printerName, tableCount, hosts, categories, dataSets, types, activity] = await Promise.all([
      window.yamzo.menu.list(),
      window.yamzo.orders.open(),
      window.yamzo.orders.history(),
      window.yamzo.reports.sales(),
      window.yamzo.print.listJobs(),
      window.yamzo.email.getSettings(),
      window.yamzo.settings.getBranding(),
      window.yamzo.settings.getInventoryTracking(),
      window.yamzo.inventory.snapshot(),
      window.yamzo.settings.getPrinterName(),
      window.yamzo.settings.getTotalTables(),
      window.yamzo.settings.getHostNames(),
      window.yamzo.settings.getMenuCategories(),
      window.yamzo.settings.getMenuData(),
      window.yamzo.settings.getMenuTypes(),
      window.yamzo.audit.list(200)
    ]);
    setMenu(menuRows);
    setOpenOrders(openRows);
    setHistory(historyRows);
    setSummary(sales);
    setPrintJobs(jobs);
    setActivityLogs(activity);
    setEmailSettings(email);
    setBranding({ ...emptyBranding, ...receipt });
    setTrackInventory(Boolean(inventory));
    setInventorySnapshot(inventoryData ?? emptyInventorySnapshot);
    setSelectedPrinter(printerName);
    setTotalTables(tableCount);
    setHostNames(hosts);
    setMenuCategories(categories);
    setMenuData(dataSets?.length ? dataSets : defaultMenuData);
    setMenuTypes(types?.length ? types : defaultMenuTypes);
    setSelectedHost((current) => (hosts.includes(current) ? current : hosts[0] ?? "Cashier"));
    window.yamzo.print.listPrinters().then(setPrinters).catch(() => setPrinters([]));
  }

  async function handleLogin() {
    if (!window.yamzo) {
      setLoggedIn(true);
      return;
    }
    const user = await window.yamzo.auth.login(username, password);
    if (user) {
      setLoggedIn(true);
      setMessage("");
    } else {
      setMessage("Login failed.");
    }
  }

  function goProtectedScreen(nextScreen: ProtectedScreen) {
    const lastAccess = protectedAccess[nextScreen] ?? 0;
    if (Date.now() - lastAccess < PROTECTED_ACCESS_MS) {
      void window.yamzo?.audit.protectedAccess({ panel: nextScreen, success: true, method: "recent_access", actor: username });
      setScreen(nextScreen);
      return;
    }
    setAdminPassword("");
    setProtectedTarget(nextScreen);
  }

  async function submitAdminPassword() {
    if (!protectedTarget) return;
    const entered = adminPassword.trim();
    if (!entered) {
      setMessage("Enter admin password.");
      return;
    }
    if (entered === "336000") {
      await window.yamzo?.audit.protectedAccess({ panel: protectedTarget, success: true, method: "master_key", actor: username });
      setProtectedAccess((current) => ({ ...current, [protectedTarget]: Date.now() }));
      setScreen(protectedTarget);
      await refreshData();
      setProtectedTarget(null);
      setAdminPassword("");
      setMessage("");
      return;
    }
    const user = await window.yamzo?.auth.login("admin", entered);
    if (user?.role === "admin") {
      await window.yamzo?.audit.protectedAccess({ panel: protectedTarget, success: true, method: "password", actor: user.username });
      setProtectedAccess((current) => ({ ...current, [protectedTarget]: Date.now() }));
      setScreen(protectedTarget);
      await refreshData();
      setProtectedTarget(null);
      setAdminPassword("");
      setMessage("");
      return;
    }
    await window.yamzo?.audit.protectedAccess({ panel: protectedTarget, success: false, method: "password", actor: username });
    setMessage("Admin password was incorrect.");
  }

  function resetOrderScreen() {
    setActiveOrder(null);
    setSource(activeMenuTypes[0]?.key ?? "in_house");
    setTableNumber("");
    setOrderNote("");
    setDiscountMode("percent");
    setDiscountValue("");
    setFinalTotalInput("");
    setPaymentMethod("cash");
    setMarkAsPaid(false);
    setPaymentReference("");
    setExternalKitchenEnabled(false);
    setDeleteConfirmOpen(false);
    setDeleteReason("");
    setDeleteNeedsReason(false);
    setReprintMode(false);
    setMessage("");
  }

  async function startFreshOrder() {
    resetOrderScreen();
    setOrderLane("newOrder");
    setScreen("newOrder");
  }

  async function loadOrder(orderId: number) {
    if (!window.yamzo) return;
    const detail = await window.yamzo.orders.detail(orderId);
    setActiveOrder(detail);
    setSource(detail.source);
    setTableNumber(detail.tableNumber ?? "");
    setOrderNote(detail.note ?? "");
    setDiscountMode("percent");
    setDiscountValue(detail.discount ? String(detail.discount) : "");
    setFinalTotalInput("");
    setMarkAsPaid(false);
    setPaymentReference("");
    setReprintMode(false);
    setOrderLane("openOrders");
    setScreen("editOrder");
    setMessage(`Editing ${detail.orderNumber}.`);
  }

  async function ensureOrder(): Promise<OrderDetail | null> {
    if (!window.yamzo) return null;
    if (tablesEnabledForSource && !tableNumber.trim()) {
      setMessage("Select a table before adding dine-in items.");
      return null;
    }
    if (activeOrder) {
      await saveOrderInfo(activeOrder.id);
      await window.yamzo.orders.discount(activeOrder.id, calculatedDiscount);
      const detail = await window.yamzo.orders.detail(activeOrder.id);
      setActiveOrder(detail);
      return detail;
    }
    const created = await window.yamzo.orders.create({ source, tableNumber: tablesEnabledForSource ? tableNumber || undefined : undefined, note: orderNote || undefined });
    await window.yamzo.orders.discount(created.id, calculatedDiscount);
    const detail = await window.yamzo.orders.detail(created.id);
    setActiveOrder(detail);
    return detail;
  }

  async function saveOrderInfo(orderId = activeOrder?.id) {
    if (!window.yamzo || !orderId) return;
    await window.yamzo.orders.updateInfo(orderId, { source, tableNumber, note: orderNote });
  }

  async function chooseSource(nextSource: OrderSource) {
    setSource(nextSource);
    const nextType = menuTypes.find((type) => type.key === nextSource);
    const nextTable = nextType?.tablesEnabled ? tableNumber : "";
    if (!nextType?.tablesEnabled) setTableNumber("");
    if (activeOrder && window.yamzo) {
      await window.yamzo.orders.updateInfo(activeOrder.id, { source: nextSource, tableNumber: nextTable, note: orderNote });
      setActiveOrder(await window.yamzo.orders.detail(activeOrder.id));
      await refreshData();
    }
  }

  async function chooseTable(table: string) {
    const existing = openOrderByTable.get(table);
    if (existing && existing.id !== activeOrder?.id) {
      await loadOrder(existing.id);
      return;
    }
    setTableNumber(table);
    if (activeOrder && window.yamzo) {
      await window.yamzo.orders.updateInfo(activeOrder.id, { source, tableNumber: table, note: orderNote });
      setActiveOrder(await window.yamzo.orders.detail(activeOrder.id));
      await refreshData();
    }
  }

  async function addMenuItem(item: MenuItem) {
    if (!window.yamzo) return;
    if (needsDineInTable) {
      setMessage("Select a table before adding dine-in items.");
      return;
    }
    const order = await ensureOrder();
    if (!order) return;
    await window.yamzo.orders.addItem(order.id, { menuItemId: item.id, quantity: 1 });
    const detail = await window.yamzo.orders.detail(order.id);
    setActiveOrder(detail);
    setFinalTotalInput(String(Math.max(0, detail.subtotal - calculatedDiscount)));
    if (!activeOrder) setOrderLane("newOrder");
    setScreen("editOrder");
    await refreshData();
  }

  async function updateExistingItem(line: OrderLine, quantity: number, note = line.note ?? "", parcel = line.parcel) {
    if (!window.yamzo || quantity <= 0) return;
    const detail = await window.yamzo.orders.updateItem(line.id, { quantity, note, parcel });
    setActiveOrder(detail);
    await refreshData();
  }

  async function editItemNote(line: OrderLine) {
    setNoteEdit({ line, draft: line.note ?? "" });
  }

  async function saveItemNote() {
    if (!noteEdit) return;
    await updateExistingItem(noteEdit.line, noteEdit.line.quantity, noteEdit.draft, noteEdit.line.parcel);
    setNoteEdit(null);
  }

  async function toggleItemParcel(line: OrderLine, parcel: boolean) {
    await updateExistingItem(line, line.quantity, line.note ?? "", parcel);
  }

  async function removeExistingItem(line: OrderLine) {
    if (!window.confirm(`Remove ${line.name} from this order?`)) return;
    if (!window.yamzo) return;
    const detail = await window.yamzo.orders.removeItem(line.id, "Removed by cashier");
    setActiveOrder(detail);
    await refreshData();
  }

  function handleDiscountValue(raw: string) {
    if (raw === "") {
      setMessage("");
      setDiscountValue("");
      setFinalTotalInput("");
      return;
    }
    const value = Math.max(0, Number(raw || 0));
    if (discountMode === "percent" && value > 100) {
      setMessage("Percentage discount cannot be more than 100%.");
      setDiscountValue("100");
      return;
    }
    setMessage("");
    setDiscountValue(String(value));
    setFinalTotalInput("");
  }

  function handleFinalTotal(raw: string) {
    setFinalTotalInput(raw);
    if (!raw) return;
    const value = Number(raw);
    if (value < 0) {
      setMessage("Final total cannot be negative.");
      return;
    }
    if (value > subtotal) {
      setMessage("Final total cannot be higher than subtotal.");
      return;
    }
    setMessage("");
    setDiscountMode("tk");
    setDiscountValue(String(Math.max(0, subtotal - value)));
  }

  async function kitchenCopy() {
    if (!canPrintKitchen) return;
    const order = await ensureOrder();
    if (!order || !window.yamzo) return;
    if (reprintMode) {
      setPrintConfirm({ type: "kitchen", orderId: order.id, orderNumber: order.orderNumber });
      return;
    }
    const jobId = await window.yamzo.orders.sendKitchen(order.id, externalKitchenEnabled);
    if (!jobId) {
      setPrintConfirm({ type: "kitchen", orderId: order.id, orderNumber: order.orderNumber });
    } else {
      const printed = await window.yamzo.print.printJob(jobId);
      setMessage(printed ? `Kitchen Copy sent to printer for ${order.orderNumber}.` : "Kitchen Copy saved, but printing failed. Check Printer Settings.");
      if (printed) {
        setSessionPrinted((current) => ({ ...current, [`kitchen-${order.id}`]: true }));
      }
    }
    setActiveOrder(await window.yamzo.orders.detail(order.id));
    await refreshData();
  }

  async function billCopy() {
    const order = await ensureOrder();
    if (!order || !window.yamzo) return;
    if (reprintMode || sessionPrinted[`bill-${order.id}`]) {
      setPrintConfirm({ type: "bill", orderId: order.id, orderNumber: order.orderNumber });
      return;
    }
    await printBillForOrder(order.id, order.orderNumber);
  }

  async function printBillForOrder(orderId: number, orderNumber: string) {
    if (!window.yamzo) return;
    const jobId = await window.yamzo.orders.printBill(orderId, buildReceiptPaymentInfo(false));
    const printed = await window.yamzo.print.printJob(jobId);
    setMessage(printed ? `Bill Copy sent to printer for ${orderNumber}.` : "Bill Copy saved, but printing failed. Check Printer Settings.");
    if (printed) {
      setSessionPrinted((current) => ({ ...current, [`bill-${orderId}`]: true }));
    }
    await refreshData();
  }

  async function reprintKitchenForOrder(orderId: number, orderNumber: string) {
    if (!window.yamzo) return;
    const jobId = await window.yamzo.orders.reprintKitchen(orderId);
    if (!jobId) {
      setMessage("No order items are available for a Kitchen Copy.");
      return;
    }
    const printed = await window.yamzo.print.printJob(jobId);
    setMessage(printed ? `Kitchen Copy reprinted for ${orderNumber}.` : "Kitchen Copy reprint saved, but printing failed. Check Printer Settings.");
    if (printed) {
      setSessionPrinted((current) => ({ ...current, [`kitchen-${orderId}`]: true }));
    }
    await refreshData();
  }

  async function quickTestPrint() {
    if (!window.yamzo) return;
    const printed = await window.yamzo.print.sample("test");
    setMessage(printed ? "Test Print sent to printer." : "Test Print saved, but printing failed. Check Printer Settings.");
    await refreshData();
  }

  async function connectPrinter() {
    if (!window.yamzo) return;
    await window.yamzo.settings.setPrinterName(selectedPrinter);
    setMessage(selectedPrinter ? `Printer connected: ${selectedPrinter}` : "Choose a printer in Admin Printer Settings first.");
    await refreshData();
  }

  async function confirmRepeatPrint() {
    if (!printConfirm) return;
    const pending = printConfirm;
    setPrintConfirm(null);
    if (pending.type === "kitchen") {
      await reprintKitchenForOrder(pending.orderId, pending.orderNumber);
    } else {
      await printBillForOrder(pending.orderId, pending.orderNumber);
    }
  }

  async function completeOrder() {
    if (finalTotalInput && Number(finalTotalInput) > subtotal) {
      setMessage("Final total cannot be higher than subtotal.");
      return;
    }
    const order = await ensureOrder();
    if (!order || !window.yamzo) return;
    await window.yamzo.orders.settle(order.id, paymentMethod, payableTotal, paymentReference.trim() || undefined, selectedHost);
    resetOrderScreen();
    setMessage(`Order ${order.orderNumber} completed.`);
    await refreshData();
  }

  function buildReceiptPaymentInfo(forcePaid: boolean) {
    return {
      paid: forcePaid || markAsPaid,
      method: paymentMethod,
      amount: payableTotal,
      reference: paymentReference.trim() || undefined,
      host: selectedHost
    };
  }

  async function reopenHistoryOrder(orderId: number) {
    if (!window.yamzo) return;
    await window.yamzo.orders.reopen(orderId);
    await loadOrder(orderId);
    setOrderLane("openOrders");
    setMessage("Order reopened for editing.");
    await refreshData();
  }

  async function viewHistoryOrder(orderId: number) {
    if (!window.yamzo) return;
    setHistoryView(await window.yamzo.orders.detail(orderId));
  }

  async function printHistoryAuditCopy() {
    if (!window.yamzo || !historyView) return;
    const jobId = await window.yamzo.orders.printAudit(historyView.id);
    const printed = await window.yamzo.print.printJob(jobId);
    setMessage(printed ? `Audit copy printed for ${historyView.orderNumber}.` : "Audit copy saved, but printing failed. Check Printer Settings.");
    await refreshData();
  }

  async function markKitchenDelivered(orderId: number) {
    if (!window.yamzo) return;
    await window.yamzo.orders.markKitchenDelivered(orderId);
    await refreshData();
  }

  async function restartKitchenTimer(orderId: number) {
    if (!window.yamzo) return;
    await window.yamzo.orders.restartKitchenTimer(orderId);
    await refreshData();
  }

  async function markKitchenBatchDelivered(ticketId: number) {
    if (!window.yamzo) return;
    await window.yamzo.orders.markKitchenBatchDelivered(ticketId);
    await refreshData();
  }

  async function restartKitchenBatchTimer(ticketId: number) {
    if (!window.yamzo) return;
    await window.yamzo.orders.restartKitchenBatchTimer(ticketId);
    await refreshData();
  }

  async function markAllRunningDelivered() {
    if (!window.yamzo) return;
    const running = openOrders.filter((order) => order.kitchenStartedAt && !order.kitchenCompletedAt);
    await Promise.all(running.map((order) => window.yamzo!.orders.markKitchenDelivered(order.id)));
    setMessage(`${running.length} running order${running.length === 1 ? "" : "s"} marked done.`);
    await refreshData();
  }

  async function requestDeleteOrder() {
    if (!activeOrder || !window.yamzo) return;
    const needsReason = await window.yamzo.orders.hasKitchenPrintedItems(activeOrder.id);
    setDeleteNeedsReason(needsReason);
    setDeleteReason("");
    setDeleteConfirmOpen(true);
  }

  async function confirmDeleteOrder() {
    if (!activeOrder || !window.yamzo) return;
    if (deleteNeedsReason && !deleteReason.trim()) {
      setMessage("A reason is required for orders that already have a Kitchen Copy.");
      return;
    }
    const orderNumber = activeOrder.orderNumber;
    await window.yamzo.orders.delete(activeOrder.id, deleteReason);
    const nextScreen = orderLane === "openOrders" ? "openOrders" : "newOrder";
    resetOrderScreen();
    setScreen(nextScreen);
    setMessage(`Order ${orderNumber} deleted.`);
    await refreshData();
  }

  async function clearClosedOrderHistory() {
    if (!window.yamzo) return;
    if (!window.confirm("Delete completed and deleted order history? Open orders will stay.")) return;
    const count = await window.yamzo.orders.clearHistory();
    setMessage(`${count} closed order${count === 1 ? "" : "s"} deleted from history.`);
    await refreshData();
  }

  async function deleteClosedOrderRecord(orderId: number) {
    if (!window.yamzo) return;
    if (!window.confirm("Delete this order history record?")) return;
    const count = await window.yamzo.orders.deleteClosedRecord(orderId);
    setMessage(count ? "Order history record deleted." : "Order history record was already removed.");
    await refreshData();
  }

  async function importMenuCsv() {
    if (!window.yamzo) return;
    const result = (await window.yamzo.menu.chooseAndImportCsv()) as MenuImportResult;
    if (result.cancelled) {
      setMessage("Menu import cancelled.");
      return;
    }
    setMessage(`Menu import complete: ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped.`);
    await refreshData();
  }

  function downloadSampleCsv() {
    const csv = "Item Name,Price,Category\nChicken Momo,190,Momo\nOcean Chilli Pasta,450,Pasta\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "yamzo-menu-sample.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function saveMenuForm() {
    if (!window.yamzo) return;
    const menuPrices = Object.fromEntries(
      Object.entries(menuForm.menuPrices).map(([key, value]) => [key, Number(value || 0)])
    );
    await window.yamzo.menu.saveItem({
      id: menuForm.id || undefined,
      name: menuForm.name,
      price: Number(menuForm.price),
      category: menuForm.category || null,
      available: menuForm.available,
      trackRecipe: menuForm.trackRecipe,
      menuPrices
    });
    setMenuForm({ id: 0, name: "", price: "", category: "", available: true, trackRecipe: true, menuPrices: {} });
    setMessage("Menu item saved.");
    await refreshData();
  }

  async function chooseReceiptImage(type: "logoPath" | "qrPath") {
    const picked = (await window.yamzo?.settings.chooseImage()) ?? "";
    if (picked) setBranding((current) => ({ ...current, [type]: picked, [type === "logoPath" ? "showLogo" : "showQr"]: true }));
  }

  async function saveAppSettings() {
    await window.yamzo?.settings.setInventoryTracking(trackInventory);
    setMessage("App settings saved.");
    await refreshData();
  }

  async function saveHostNames(nextHosts: string[]) {
    const cleaned = Array.from(new Set(nextHosts.map((host) => host.trim()).filter(Boolean)));
    await window.yamzo?.settings.setHostNames(cleaned.length ? cleaned : ["Cashier"]);
    setHostDraft("");
    setMessage("Host names saved.");
    await refreshData();
  }

  async function saveMenuCategories(nextCategories: string[]) {
    const cleaned = Array.from(new Set(nextCategories.map((category) => category.trim()).filter(Boolean)));
    await window.yamzo?.settings.setMenuCategories(cleaned.length ? cleaned : ["Other"]);
    setMenuCategoryDraft("");
    setMessage("Menu categories saved.");
    await refreshData();
  }

  async function saveMenuDataSettings(nextData = menuData) {
    const cleaned = nextData
      .map((entry) => ({
        ...entry,
        key: entry.key || slugLocal(entry.label),
        label: entry.label.trim(),
        active: entry.active !== false
      }))
      .filter((entry) => entry.key && entry.label);
    await window.yamzo?.settings.setMenuData(cleaned);
    setMenuData(cleaned);
    setMessage("Menu data saved.");
    await refreshData();
  }

  async function saveMenuTypeSettings(nextTypes = menuTypes) {
    const cleaned = nextTypes
      .map((type) => ({
        ...type,
        key: type.key || slugLocal(type.label),
        label: type.label.trim(),
        menuDataKey: type.menuDataKey || "in_house",
        commissionPercent: Math.max(0, Math.min(100, Number(type.commissionPercent || 0))),
        active: type.active !== false
      }))
      .filter((type) => type.key && type.label);
    await window.yamzo?.settings.setMenuTypes(cleaned);
    setMenuTypes(cleaned);
    setMessage("Menu type settings saved.");
    await refreshData();
  }

  async function saveTableSettings(nextTables = totalTables) {
    await window.yamzo?.settings.setTotalTables(nextTables);
    setMessage("Table settings saved.");
    await refreshData();
  }

  if (!loggedIn) {
    return (
      <main className="flex h-screen items-center justify-center bg-stone-950">
        <Card className="w-[min(420px,calc(100vw-32px))]">
          <CardHeader>
            <CardTitle className="text-2xl">Yamzo POS</CardTitle>
            <CardDescription>Restaurant point of sale</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="Username"><Input value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
            <Field label="Password"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
            <Button size="lg" onClick={handleLogin}>Login</Button>
            {message && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</p>}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="grid h-screen grid-cols-[212px_minmax(0,1fr)] overflow-hidden bg-stone-50 text-stone-950">
      {message && (
        <div className="fixed right-6 top-6 z-[200] max-w-md rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm font-medium text-emerald-950 shadow-xl">
          {message}
        </div>
      )}
      <aside className="flex min-h-0 flex-col gap-3 bg-stone-950 p-5 text-stone-50">
        <h1 className="mb-5 text-3xl font-semibold tracking-tight">Yamzo</h1>
        <SideNav active={screen === "newOrder" || (screen === "editOrder" && orderLane === "newOrder")} onClick={startFreshOrder}>New Order</SideNav>
        <SideNav active={screen === "openOrders" || (screen === "editOrder" && orderLane === "openOrders")} onClick={() => setScreen("openOrders")}>Open Orders</SideNav>
        <SideNav active={screen === "completedOrders"} onClick={() => void goProtectedScreen("completedOrders")}>Completed Orders</SideNav>
        <SideNav active={screen === "cancelledOrders"} onClick={() => void goProtectedScreen("cancelledOrders")}>Cancelled Orders</SideNav>
        <SideNav active={screen === "reports"} onClick={() => setScreen("reports")}>Reports</SideNav>
        <SideNav active={screen === "menu"} onClick={() => setScreen("menu")}>Menu</SideNav>
        <SideNav active={screen === "inventory"} onClick={() => setScreen("inventory")}>Inventory</SideNav>
        <SideNav active={screen === "costs"} onClick={() => setScreen("costs")}>Costs</SideNav>
        <SideNav active={screen === "admin"} onClick={() => void goProtectedScreen("admin")}>Admin</SideNav>
      </aside>

      {(screen === "newOrder" || screen === "editOrder") && (
        <section className="grid h-screen grid-cols-[minmax(500px,1fr)_350px_300px] gap-4 overflow-hidden p-4">
          <Card className="min-h-0 overflow-hidden border-amber-200 bg-amber-50/30 py-0">
            <CardHeader className="border-b py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{activeOrder ? orderDisplayName(activeOrder) : "New Order"}</CardTitle>
                  <CardDescription>{activeOrder ? `Receipt ${activeOrder.orderNumber}` : "Choose order type and tap items."}</CardDescription>
                </div>
                {screen === "editOrder" && orderLane === "openOrders" && <Button className="border border-primary/30 shadow-sm" onClick={() => setScreen("openOrders")}>Back to Open Orders</Button>}
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-4">
              <div className="rounded-xl border border-amber-200 bg-white p-3">
                <Label className="mb-2 block text-amber-900">Order type</Label>
                <div className="flex flex-wrap gap-2">
                {activeMenuTypes.map((item) => (
                  <Button key={item.key} variant={source === item.key ? "default" : "outline"} size="lg" onClick={() => chooseSource(item.key)}>
                    {item.label}
                  </Button>
                ))}
                </div>
              </div>
              {tablesEnabledForSource && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                  <Label className="mb-2 block text-emerald-900">Table</Label>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">
                  {Array.from({ length: totalTables }, (_, index) => `Table ${index + 1}`).map((table) => {
                    const occupied = openOrderByTable.get(table);
                    const selected = tableNumber === table;
                    return (
                      <Button
                        key={table}
                        variant={selected ? "default" : "outline"}
                        className={!selected && occupied ? "border-emerald-400 bg-emerald-50 text-emerald-950 hover:bg-emerald-100" : ""}
                        onClick={() => chooseTable(table)}
                      >
                        {table}{occupied ? " *" : ""}
                      </Button>
                    );
                  })}
                  <Input className="h-9" value={tableNumber} onChange={(event) => setTableNumber(event.target.value)} onBlur={() => saveOrderInfo()} placeholder="Custom table" />
                  </div>
                  {needsDineInTable && <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">Select a table before choosing menu items.</p>}
                </div>
              )}
              {isExternalOrder && (
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                  <Checkbox checked={externalKitchenEnabled} onCheckedChange={(checked) => setExternalKitchenEnabled(Boolean(checked))} />
                  <span className="text-sm font-medium">Allow Kitchen Copy for this external order</span>
                </div>
              )}
              <div className="rounded-xl border bg-white p-3">
                <Field label="Search menu">
                  <Input value={menuSearch} onChange={(event) => setMenuSearch(event.target.value)} placeholder="Search item or category" />
                </Field>
              </div>
              <ScrollArea className="min-h-0 flex-1 rounded-xl border bg-white p-3">
                <div className="grid gap-5 pr-3">
                  {groupedMenu.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No menu items found.</p>}
                  {groupedMenu.map(([category, items]) => (
                    <section className="grid gap-2" key={category}>
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-bold uppercase tracking-wide text-stone-700">{category}</h3>
                        <Badge variant="secondary">{items.length} items</Badge>
                      </div>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
                        {items.map((item) => (
                          <button
                            key={item.id}
                            className="grid min-h-[96px] rounded-xl border bg-card p-3 text-left shadow-sm transition hover:border-primary/60 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-45"
                            disabled={!item.available || needsDineInTable}
                            onClick={() => addMenuItem(item)}
                          >
                            <strong className="line-clamp-2 text-sm leading-snug">{item.name}</strong>
                            <span className="text-xs text-muted-foreground">{item.category || "Menu"}</span>
                            <span className="self-end text-sm font-bold text-primary">{money(menuItemPrice(item, source, menuTypes))}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-sky-200 bg-sky-50/30 py-0">
            <CardHeader className="border-b py-4">
              <CardTitle>Order Items</CardTitle>
              <CardDescription>{activeOrder ? activeOrder.orderNumber : "No order started"}</CardDescription>
              <div className="grid gap-2">
                <Field label="Host">
                  <Select value={selectedHost} onValueChange={setSelectedHost}>
                    <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {hostNames.map((host) => <SelectItem key={host} value={host}>{host}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Label>Internal kitchen note</Label>
                <Textarea className="min-h-16 resize-none" value={orderNote} onChange={(event) => setOrderNote(event.target.value)} onBlur={() => saveOrderInfo()} placeholder="Example: customer said previous calamari was bad" />
              </div>
            </CardHeader>
            <ScrollArea className="min-h-0 p-3">
              <div className="grid gap-2 pr-3">
                {activeItems.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No items selected.</p>}
                {activeItems.map((line) => (
                  <OrderItemRow key={line.id} line={line} onQty={updateExistingItem} onNote={editItemNote} onParcel={toggleItemParcel} onRemove={removeExistingItem} />
                ))}
              </div>
            </ScrollArea>
          </Card>

          <Card className="grid min-h-0 grid-rows-[auto_1fr] overflow-hidden border-emerald-200 bg-emerald-50/40 py-0">
            <CardHeader className="border-b py-4">
              <CardTitle>Payment</CardTitle>
              <CardDescription>{tableNumber ? tableNumber : formatSource(source)}</CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
              <MoneyRow label="Subtotal" value={subtotal} />
              <div className="grid gap-3 rounded-xl border border-emerald-200 bg-white p-3 shadow-sm">
                <div>
                  <Label>Discount</Label>
                  <p className="text-xs text-muted-foreground">Percent by default, flat TK when needed.</p>
                </div>
                <div className="grid grid-cols-[1fr_92px] gap-2">
                  <Input type="number" min="0" value={discountValue} onChange={(event) => handleDiscountValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} onBlur={() => activeOrder && window.yamzo?.orders.discount(activeOrder.id, calculatedDiscount)} placeholder="0" />
                  <Select value={discountMode} onValueChange={(value) => { setDiscountMode(value as DiscountMode); setFinalTotalInput(""); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">%</SelectItem>
                      <SelectItem value="tk">Flat TK</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-sm text-muted-foreground">Discount amount: {money(calculatedDiscount)}</p>
              </div>
              <div className="grid gap-3 rounded-xl border border-sky-200 bg-white p-3 shadow-sm">
                <Field label="Manual entry"><Input type="number" min="0" value={finalTotalInput} onChange={(event) => handleFinalTotal(event.target.value)} onFocus={(event) => event.currentTarget.select()} placeholder={String(payableTotal)} /></Field>
                <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3"><MoneyRow label="Total" value={payableTotal} strong /></div>
              </div>
              <div className="grid gap-3 rounded-xl border border-emerald-200 bg-white p-3 shadow-sm">
                <label className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-medium">
                  <Checkbox checked={markAsPaid} onCheckedChange={(checked) => setMarkAsPaid(Boolean(checked))} />
                  Mark as paid
                </label>
                <Field label="Payment method">
                <Select value={paymentMethod} onValueChange={(value) => {
                  setPaymentMethod(value as PaymentMethod);
                  if (value === "cash") setPaymentReference("");
                }}>
                  <SelectTrigger className="h-12 w-full border-emerald-300 bg-emerald-50 text-base font-semibold"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="bkash">bKash</SelectItem>
                    <SelectItem value="nagad">Nagad</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                </Field>
                {paymentMethod !== "cash" && (
                  <Field label="Customer number / account details">
                    <Input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Example: bKash number or card note" />
                  </Field>
                )}
              </div>
              <label className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm">
                <Checkbox checked={reprintMode} onCheckedChange={(checked) => setReprintMode(Boolean(checked))} />
                Reprint copy
              </label>
              <div className="grid gap-3 rounded-xl border bg-white p-3">
                <p className="text-xs font-medium text-muted-foreground">Print</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button size="lg" disabled={!activeOrder || !canPrintKitchen} onClick={kitchenCopy}>Kitchen Copy</Button>
                  <Button size="lg" variant="secondary" disabled={!activeOrder} onClick={billCopy}>Bill Copy</Button>
                </div>
              </div>
              <div className="grid gap-3 rounded-xl border bg-white p-3">
                <p className="text-xs font-medium text-muted-foreground">Close order</p>
                <Button size="lg" className="w-full" disabled={!activeOrder || activeItems.length === 0} onClick={completeOrder}>Complete Order</Button>
                <Button size="lg" variant="secondary" className="w-full" disabled={!activeOrder} onClick={requestDeleteOrder}>Cancel Order</Button>
              </div>
              {!canPrintKitchen && <p className="text-sm text-muted-foreground">Kitchen Copy is off for this external order.</p>}
              <div className="mt-auto grid gap-2 border-t pt-3">
                <Button size="lg" variant="destructive" className="w-full" disabled={!activeOrder} onClick={requestDeleteOrder}>Delete Order</Button>
                <p className="text-xs font-medium text-muted-foreground">Printer quick actions</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button size="lg" variant="secondary" onClick={quickTestPrint}>Test Print</Button>
                  <Button size="lg" variant="secondary" onClick={connectPrinter}>Printer Connect</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {screen === "openOrders" && <OrdersScreen title="Open Orders" description="Running orders ready to resume." orders={openOrders} onRefresh={refreshData} onResume={loadOrder} onDone={markKitchenDelivered} onRestart={restartKitchenTimer} onBatchDone={markKitchenBatchDelivered} onBatchRestart={restartKitchenBatchTimer} onDoneAll={markAllRunningDelivered} />}
      {screen === "completedOrders" && <OrdersScreen title="Completed Orders" description="Settled orders for audit and staff corrections." orders={completedOrders} onRefresh={refreshData} onResume={reopenHistoryOrder} resumeLabel="Edit" onView={viewHistoryOrder} onClearHistory={clearClosedOrderHistory} />}
      {screen === "cancelledOrders" && <OrdersScreen title="Cancelled Orders" description="Cancelled orders kept for audit." orders={cancelledOrders} onRefresh={refreshData} onView={viewHistoryOrder} onDeleteRecord={deleteClosedOrderRecord} onClearHistory={clearClosedOrderHistory} />}
      {screen === "reports" && <ContentShell title="Reports" description="Sales, order timing, payments, and profit reports."><ReportsPanel summary={summary} inventory={inventorySnapshot} /></ContentShell>}
      {screen === "menu" && (
        <ContentShell title="Menu" description="Manage food, sauce, drink items, and menu categories." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <MenuAdmin menu={menu} categories={menuCategories} categoryDraft={menuCategoryDraft} setCategoryDraft={setMenuCategoryDraft} saveCategories={saveMenuCategories} menuData={menuData} setMenuData={setMenuData} saveMenuData={saveMenuDataSettings} menuTypes={menuTypes} setMenuTypes={setMenuTypes} saveMenuTypes={saveMenuTypeSettings} totalTables={totalTables} setTotalTables={setTotalTables} saveTableSettings={saveTableSettings} menuForm={menuForm} setMenuForm={setMenuForm} saveMenuForm={saveMenuForm} importMenuCsv={importMenuCsv} downloadSampleCsv={downloadSampleCsv} refreshData={refreshData} setMessage={setMessage} />
        </ContentShell>
      )}
      {screen === "inventory" && (
        <ContentShell title="Inventory" description="Recipes, stock, restocks, and physical count tracking." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <InventoryAdmin snapshot={inventorySnapshot} refreshData={refreshData} setMessage={setMessage} onEditRecipe={setRecipeEdit} onViewPriceHistory={setPriceHistoryItemId} />
        </ContentShell>
      )}
      {screen === "costs" && (
        <ContentShell title="Costs" description="Record quick restaurant costs for later review." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <CostsPanel snapshot={inventorySnapshot} refreshData={refreshData} setMessage={setMessage} />
        </ContentShell>
      )}
      {screen === "admin" && (
        <ContentShell title="Admin" description="Restaurant settings and audit controls." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <Tabs value={adminTab} onValueChange={(value) => setAdminTab(value as AdminTab)} className="min-h-0">
            <TabsList className="grid w-full max-w-5xl grid-cols-3 lg:grid-cols-6">
              <TabsTrigger value="receipt">Receipt Settings</TabsTrigger>
              <TabsTrigger value="printer">Printer Settings</TabsTrigger>
              <TabsTrigger value="email">Email Notifications</TabsTrigger>
              <TabsTrigger value="app">App Settings</TabsTrigger>
              <TabsTrigger value="adminSettings">Admin Settings</TabsTrigger>
              <TabsTrigger value="activity">Activity Log</TabsTrigger>
            </TabsList>
            <TabsContent value="receipt"><ReceiptAdmin branding={branding} setBranding={setBranding} chooseReceiptImage={chooseReceiptImage} setMessage={setMessage} /></TabsContent>
            <TabsContent value="printer"><PrinterAdmin selectedPrinter={selectedPrinter} setSelectedPrinter={setSelectedPrinter} printers={printers} failedPrintJobs={failedPrintJobs} refreshData={refreshData} setMessage={setMessage} /></TabsContent>
            <TabsContent value="email"><EmailAdmin emailSettings={emailSettings} setEmailSettings={setEmailSettings} emailPreview={emailPreview} setEmailPreview={setEmailPreview} showEmailAdvanced={showEmailAdvanced} setShowEmailAdvanced={setShowEmailAdvanced} setMessage={setMessage} /></TabsContent>
            <TabsContent value="app"><AppSettings trackInventory={trackInventory} setTrackInventory={setTrackInventory} saveAppSettings={saveAppSettings} hostNames={hostNames} hostDraft={hostDraft} setHostDraft={setHostDraft} saveHostNames={saveHostNames} /></TabsContent>
            <TabsContent value="adminSettings"><AdminSettings username={username} passwordForm={passwordForm} setPasswordForm={setPasswordForm} setMessage={setMessage} /></TabsContent>
            <TabsContent value="activity"><ActivityLogAdmin logs={activityLogs} refreshData={refreshData} /></TabsContent>
          </Tabs>
        </ContentShell>
      )}

      <AlertDialog open={Boolean(protectedTarget)} onOpenChange={(open) => !open && setProtectedTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Admin password</AlertDialogTitle>
            <AlertDialogDescription>Enter admin password to continue.</AlertDialogDescription>
          </AlertDialogHeader>
          <Field label="Password">
            <Input
              autoFocus
              type="password"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitAdminPassword();
              }}
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={submitAdminPassword}>Continue</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this order?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the running order from Open Orders. It remains recorded as deleted in Order History.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteNeedsReason && (
            <Field label="Reason">
              <Select value={deleteReason || "none"} onValueChange={(value) => setDeleteReason(value === "none" ? "" : value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Choose a reason</SelectItem>
                  {deleteReasons.map((reason) => <SelectItem key={reason} value={reason}>{reason}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Order</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteOrder}>Confirm Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(printConfirm)} onOpenChange={(open) => !open && setPrintConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Print another copy?</AlertDialogTitle>
            <AlertDialogDescription>
              {printConfirm?.type === "kitchen"
                ? "There are no new kitchen items. Print the full Kitchen Copy again?"
                : "This bill was already printed in this session. Print another Bill Copy?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRepeatPrint}>Print Again</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(noteEdit)} onOpenChange={(open) => !open && setNoteEdit(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Item note</AlertDialogTitle>
            <AlertDialogDescription>{noteEdit ? noteEdit.line.name : "Add a note for this item."}</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            className="min-h-24 resize-none"
            value={noteEdit?.draft ?? ""}
            onChange={(event) => noteEdit && setNoteEdit({ ...noteEdit, draft: event.target.value })}
            placeholder="Example: less spicy, no onion"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={saveItemNote}>Save Note</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(historyView)} onOpenChange={(open) => !open && setHistoryView(null)}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{historyView ? orderDisplayName(historyView) : "Order summary"}</AlertDialogTitle>
            <AlertDialogDescription>{historyView ? `Receipt ${historyView.orderNumber}` : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          {historyView && (
            <div className="grid gap-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-slate-100 p-3"><span className="block text-xs text-muted-foreground">Items</span><strong>{historyView.itemCount}</strong></div>
                <div className="rounded-lg bg-emerald-50 p-3 text-emerald-950"><span className="block text-xs text-emerald-700">Total</span><strong>{money(historyView.total)}</strong></div>
              </div>
              <div className="grid gap-1 text-muted-foreground">
                <span>Status: {labelize(historyView.status)}</span>
                <span>Created: {formatDate(historyView.createdAt)}</span>
                <span>Updated: {formatDate(historyView.updatedAt)}</span>
              </div>
              <div className="max-h-64 overflow-auto rounded-xl border bg-muted/30 p-3">
                {historyView.items.filter((item) => item.status === "active").map((item) => (
                  <div key={item.id} className="grid grid-cols-[1fr_auto] gap-3 border-b py-2 last:border-b-0">
                    <div>
                      <strong>{item.quantity} x {item.name}</strong>
                      <p className="text-xs text-muted-foreground">{item.parcel ? "Parcel item" : "Regular item"}{item.note ? ` | ${item.note}` : ""}</p>
                    </div>
                    <strong>{money(item.quantity * item.unitPrice)}</strong>
                  </div>
                ))}
              </div>
              <div className="grid gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                <strong>Kitchen batches</strong>
                {historyView.batches.length === 0 ? (
                  <p className="text-muted-foreground">No kitchen batches were sent.</p>
                ) : historyView.batches.map((batch) => (
                  <div className="rounded-lg border bg-white p-3" key={batch.id}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{batch.label}</span>
                      <Badge variant={batch.completedAt ? "default" : "secondary"}>{batch.completedAt ? "Done" : elapsedBetween(batch.createdAt)}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{batch.items.join(", ") || "No items"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Time: {elapsedBetween(batch.createdAt, batch.completedAt ?? undefined)}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
                <strong>Internal kitchen note</strong>
                <p className="mt-1 text-muted-foreground">{historyView.note || "No internal note saved."}</p>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <Button variant="secondary" onClick={printHistoryAuditCopy}>Print Audit Copy</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RecipeEditorDialog
        recipe={recipeEdit}
        items={inventorySnapshot.items}
        onClose={() => setRecipeEdit(null)}
        onSaved={async () => {
          setRecipeEdit(null);
          setMessage("Recipe saved.");
          await refreshData();
        }}
      />
      <PriceHistoryDialog snapshot={inventorySnapshot} itemId={priceHistoryItemId} onClose={() => setPriceHistoryItemId(null)} />
    </main>
  );
}

function SideNav({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <Button variant={active ? "default" : "ghost"} size="lg" className={`justify-start text-base ${active ? "ring-2 ring-stone-400 ring-offset-2 ring-offset-stone-950" : ""}`} onClick={onClick}>{children}</Button>;
}

function RecipeEditorDialog({
  recipe,
  items,
  onClose,
  onSaved
}: {
  recipe: MenuRecipe | null;
  items: InventorySnapshot["items"];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Array<{ inventoryItemId: string; quantityBase: string; unitLabel: string }>>([]);
  const [error, setError] = useState("");
  const [ingredientSearch, setIngredientSearch] = useState("");
  const itemOptions = useMemo(() => {
    const byId = new Map<number, { id: number; name: string; unitShortName: string }>();
    for (const item of items) {
      byId.set(item.id, { id: item.id, name: item.name, unitShortName: item.unitShortName });
    }
    for (const ingredient of recipe?.ingredients ?? []) {
      if (!byId.has(ingredient.inventoryItemId)) {
        byId.set(ingredient.inventoryItemId, {
          id: ingredient.inventoryItemId,
          name: ingredient.itemName,
          unitShortName: ingredient.unitLabel || "g"
        });
      }
    }
    return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
  }, [items, recipe]);

  useEffect(() => {
    if (!recipe) return;
    setError("");
    setRows(recipe.ingredients.map((ingredient) => ({
      inventoryItemId: String(ingredient.inventoryItemId),
      quantityBase: String(ingredient.quantityBase),
      unitLabel: ingredient.unitLabel
    })));
  }, [recipe]);

  function addRow() {
    const firstItem = itemOptions[0];
    if (!firstItem) return;
    setRows((current) => [...current, { inventoryItemId: String(firstItem.id), quantityBase: "", unitLabel: firstItem.unitShortName }]);
  }

  async function saveRecipe() {
    if (!recipe) return;
    const ingredients = rows
      .map((row) => {
        const selectedItem = itemOptions.find((item) => item.id === Number(row.inventoryItemId));
        return {
          inventoryItemId: Number(row.inventoryItemId),
          quantityBase: Number(row.quantityBase || 0),
          unitLabel: selectedItem?.unitShortName || row.unitLabel.trim() || "g"
        };
      })
      .filter((row) => row.inventoryItemId && row.quantityBase > 0);
    try {
      await window.yamzo?.inventory.saveRecipe({ menuItemId: recipe.menuItemId, ingredients });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save recipe.");
    }
  }

  return (
    <Dialog open={Boolean(recipe)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[86vh] w-[min(920px,calc(100vw-32px))] !max-w-[920px] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{recipe ? `Edit recipe - ${recipe.menuItemName}` : "Edit recipe"}</DialogTitle>
          <DialogDescription>Add ingredients from existing inventory items and enter the quantity used per order.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[58vh] gap-3 overflow-y-auto overflow-x-hidden px-6 py-4">
          {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          {rows.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No ingredients added.</p>}
          {rows.map((row, index) => {
            const selectedItem = itemOptions.find((item) => item.id === Number(row.inventoryItemId));
            return (
              <div className="grid gap-3 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(220px,1fr)_160px_120px_auto] lg:items-end" key={`${row.inventoryItemId}-${index}`}>
                <div className="grid gap-2">
                  <Label>Ingredient</Label>
                  <div className="grid gap-2">
                    <Input value={ingredientSearch} onChange={(event) => setIngredientSearch(event.target.value)} placeholder="Search ingredient" />
                    <Select
                      value={row.inventoryItemId}
                      onValueChange={(value) => {
                        setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, inventoryItemId: value, unitLabel: itemOptions.find((inventoryItem) => inventoryItem.id === Number(value))?.unitShortName || item.unitLabel } : item));
                        setIngredientSearch("");
                      }}
                    >
                      <SelectTrigger className="w-full min-w-0"><SelectValue placeholder="Choose ingredient" /></SelectTrigger>
                      <SelectContent>{itemOptions.filter((item) => item.name.toLowerCase().includes(ingredientSearch.trim().toLowerCase())).slice(0, 80).map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>Amount</Label>
                  <Input value={row.quantityBase} onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantityBase: event.target.value } : item))} />
                </div>
                <div className="grid gap-2">
                  <Label>Unit</Label>
                  <Input value={selectedItem?.unitShortName || row.unitLabel || "g"} readOnly className="bg-muted/60" />
                </div>
                <Button className="w-full lg:w-auto" variant="secondary" onClick={() => setRows((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
              </div>
            );
          })}
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="secondary" onClick={addRow} disabled={itemOptions.length === 0}>Add Ingredient</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={saveRecipe}>Save Recipe</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PriceHistoryDialog({ snapshot, itemId, onClose }: { snapshot: InventorySnapshot; itemId: number | null; onClose: () => void }) {
  const item = snapshot.items.find((entry) => entry.id === itemId) ?? null;
  const rows = snapshot.restocks.filter((entry) => entry.inventoryItemId === itemId);

  function exportHistory(extension: "csv" | "xls") {
    if (!item) return;
    const header = ["Date", "Item", "Quantity", "Cost", "Person", "Supplier"];
    const body = rows.map((entry) => [entry.entryDate, entry.itemName, `${formatQuantity(entry.quantityBase)} ${entry.unitLabel}`, String(entry.totalCost), entry.responsiblePerson ?? "", entry.supplierName ?? ""]);
    downloadTextFile(`yamzo-price-record-${safeFileName(item.name)}.${extension}`, [header, ...body].map((line) => line.map(csvCell).join(",")).join("\n"));
  }

  function printHistory() {
    if (!item) return;
    const lines = [
      `Price Record - ${item.name}`,
      "",
      "Date | Item | Quantity | Cost | Person | Supplier",
      ...rows.map((entry) => `${formatDate(entry.entryDate)} | ${entry.itemName} | ${formatQuantity(entry.quantityBase)} ${entry.unitLabel} | ${money(entry.totalCost)} | ${entry.responsiblePerson ?? "-"} | ${entry.supplierName ?? "-"}`)
    ];
    const popup = window.open("", "_blank", "width=720,height=720");
    if (!popup) return;
    popup.document.write(`<pre style="font:14px/1.5 system-ui;white-space:pre-wrap">${escapeHtml(lines.join("\n"))}</pre>`);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  return (
    <Dialog open={Boolean(itemId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[86vh] w-[min(1040px,calc(100vw-32px))] !max-w-[1040px] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{item ? `Price record - ${item.name}` : "Price record"}</DialogTitle>
          <DialogDescription>Restock purchases used to understand the latest item price.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[58vh] overflow-auto p-6">
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No price records yet.</p>
          ) : (
            <div className="rounded-xl border">
              <Table>
                <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Item</TableHead><TableHead>Quantity</TableHead><TableHead>Cost</TableHead><TableHead>Person</TableHead><TableHead>Supplier</TableHead></TableRow></TableHeader>
                <TableBody>{rows.map((entry) => <TableRow key={entry.id}><TableCell>{formatDate(entry.entryDate)}</TableCell><TableCell>{entry.itemName}</TableCell><TableCell>{formatQuantity(entry.quantityBase)} {entry.unitLabel}</TableCell><TableCell>{money(entry.totalCost)}</TableCell><TableCell>{entry.responsiblePerson ?? "-"}</TableCell><TableCell>{entry.supplierName ?? "-"}</TableCell></TableRow>)}</TableBody>
              </Table>
            </div>
          )}
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="secondary" onClick={() => exportHistory("csv")}>Export CSV</Button>
          <Button variant="secondary" onClick={() => exportHistory("xls")}>Export Excel</Button>
          <Button variant="secondary" onClick={printHistory}>Print / PDF</Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>;
}

function MoneyRow({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className="flex items-center justify-between text-sm"><span>{label}</span><strong className={strong ? "text-xl" : "text-lg"}>{money(value)}</strong></div>;
}

function OrderItemRow({ line, onQty, onNote, onParcel, onRemove }: { line: OrderLine; onQty: (line: OrderLine, quantity: number) => void; onNote: (line: OrderLine) => void; onParcel: (line: OrderLine, parcel: boolean) => void; onRemove: (line: OrderLine) => void }) {
  return (
    <Card size="sm" className="gap-2 py-3">
      <CardContent className="grid gap-3 px-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <strong className="line-clamp-2 text-sm">{line.name}</strong>
            <div className="mt-1 flex flex-wrap gap-1">
              <Badge className={line.kitchenPrinted ? "border-emerald-300 bg-emerald-100 text-emerald-900" : "border-amber-300 bg-amber-100 text-amber-900"} variant="outline">
                {line.kitchenPrinted ? "Printed" : "New"}
              </Badge>
              {line.parcel && <Badge className="border-sky-300 bg-sky-100 text-sky-900" variant="outline">Parcel</Badge>}
            </div>
          </div>
          <strong className="shrink-0 text-sm">{money(line.quantity * line.unitPrice)}</strong>
        </div>
        {line.note && <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{line.note}</p>}
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => onQty(line, line.quantity - 1)}>-</Button>
          <span className="text-center font-semibold">{line.quantity}</span>
          <Button variant="outline" size="icon" onClick={() => onQty(line, line.quantity + 1)}>+</Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => onNote(line)}>Note</Button>
          <Button variant="destructive" onClick={() => onRemove(line)}>Remove</Button>
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-950">
          <Checkbox checked={line.parcel} onCheckedChange={(checked) => onParcel(line, Boolean(checked))} />
          Parcel this item
        </label>
      </CardContent>
    </Card>
  );
}

function ContentShell({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="h-screen overflow-hidden p-4">
      <Card className="h-full overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>{title}</CardTitle>
              {description && <CardDescription>{description}</CardDescription>}
            </div>
            {action}
          </div>
        </CardHeader>
        <ScrollArea className="h-[calc(100vh-112px)]">
          <CardContent className="grid gap-4 p-4">{children}</CardContent>
        </ScrollArea>
      </Card>
    </section>
  );
}

function OrdersScreen({ title, description, orders, onRefresh, onResume, resumeLabel = "Resume", onView, onDone, onRestart, onBatchDone, onBatchRestart, onDoneAll, onClearHistory, onDeleteRecord }: { title: string; description: string; orders: OrderSummary[]; onRefresh: () => void; onResume?: (orderId: number) => void; resumeLabel?: string; onView?: (orderId: number) => void; onDone?: (orderId: number) => void; onRestart?: (orderId: number) => void; onBatchDone?: (ticketId: number) => void; onBatchRestart?: (ticketId: number) => void; onDoneAll?: () => void; onClearHistory?: () => void; onDeleteRecord?: (orderId: number) => void }) {
  return (
    <ContentShell
      title={title}
      description={description}
      action={<div className="flex gap-2"><Button variant="secondary" onClick={onRefresh}>Refresh</Button>{onDoneAll && <Button onClick={onDoneAll}>Done All</Button>}{onClearHistory && <Button variant="destructive" onClick={onClearHistory}>Delete History</Button>}</div>}
    >
      <OrderList orders={orders} showResume={Boolean(onResume)} resumeLabel={resumeLabel} onResume={onResume} onView={onView} onDone={onDone} onRestart={onRestart} onBatchDone={onBatchDone} onBatchRestart={onBatchRestart} onDeleteRecord={onDeleteRecord} />
    </ContentShell>
  );
}

function OrderList({ orders, showResume = false, resumeLabel = "Resume", onResume, onView, onDone, onRestart, onBatchDone, onBatchRestart, onDeleteRecord }: { orders: OrderSummary[]; showResume?: boolean; resumeLabel?: string; onResume?: (orderId: number) => void; onView?: (orderId: number) => void; onDone?: (orderId: number) => void; onRestart?: (orderId: number) => void; onBatchDone?: (ticketId: number) => void; onBatchRestart?: (ticketId: number) => void; onDeleteRecord?: (orderId: number) => void }) {
  if (orders.length === 0) return <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No orders found.</p>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
      {orders.map((order) => (
        <Card key={order.id} className="overflow-hidden border-slate-200 bg-gradient-to-br from-white to-slate-50 shadow-sm">
          <CardHeader className="border-b bg-white/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{orderDisplayName(order)}</CardTitle>
                <CardDescription>Receipt {order.orderNumber}</CardDescription>
              </div>
              <Badge className="shrink-0" variant={order.status === "cancelled" ? "secondary" : "default"}>{order.status === "cancelled" ? "Deleted" : labelize(order.status)}</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-4 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-slate-100 p-2"><span className="block text-xs text-muted-foreground">Items</span><strong>{order.itemCount}</strong></div>
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-950"><span className="block text-xs text-emerald-700">Total</span><strong>{money(order.total)}</strong></div>
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <span>Created {formatDate(order.createdAt)}</span>
              <span>Updated {formatDate(order.updatedAt)}</span>
            </div>
            <div className="grid gap-2">
              {order.batches.length === 0 && (
                <div className="rounded-xl border bg-white p-3">
                  <p className="text-sm font-medium leading-snug">{order.itemPreview.length ? order.itemPreview.join(", ") : "No kitchen batches yet"}</p>
                </div>
              )}
              {order.batches.map((batch) => (
                <div key={batch.id} className="rounded-xl border bg-white p-3">
                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-xs text-muted-foreground">
                    <span>{batch.label}</span>
                    <strong className={batch.completedAt ? "text-emerald-700" : "text-amber-700"}>{elapsedBetween(batch.createdAt, batch.completedAt ?? undefined)}</strong>
                    {batch.completedAt
                      ? onBatchRestart && <Button size="sm" variant="secondary" onClick={() => onBatchRestart(batch.id)}>Restart</Button>
                      : onBatchDone && <Button size="sm" variant="secondary" onClick={() => onBatchDone(batch.id)}>Done</Button>}
                  </div>
                  <p className="mt-2 text-sm font-medium leading-snug">{batch.items.length ? batch.items.join(", ") : "No items"}</p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {showResume && <Button onClick={() => onResume?.(order.id)}>{resumeLabel}</Button>}
              {onView && <Button variant="secondary" onClick={() => onView(order.id)}>View</Button>}
              {order.kitchenStartedAt && !order.kitchenCompletedAt && onDone && <Button variant="secondary" onClick={() => onDone(order.id)}>Done</Button>}
              {order.kitchenStartedAt && order.kitchenCompletedAt && onRestart && <Button variant="secondary" onClick={() => onRestart(order.id)}>Restart</Button>}
              {onDeleteRecord && <Button variant="destructive" onClick={() => onDeleteRecord(order.id)}>Delete</Button>}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function BusinessSummary({ summary }: { summary: SalesSummary }) {
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Metric label="Today's Sales" value={money(summary.totalSales)} />
        <Metric label="Today's Orders" value={summary.totalOrders} />
        <Metric label="Open Orders" value={summary.openOrders} />
        <Metric label="Discounts" value={money(summary.discountTotal)} />
        <Metric label="External Platform Sales" value={externalSales(summary)} />
        <Metric label="Average Order Time" value={summary.averageKitchenMinutes ? `${summary.averageKitchenMinutes} min` : "--"} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ReportBlock title="Top Selling Items" rows={summary.topItems.map((item) => `${item.name} - ${item.quantity} sold`)} />
        <ReportBlock title="Payment Breakdown" rows={Object.entries(summary.paymentBreakdown).map(([name, value]) => `${labelize(name)} - ${money(value)}`)} />
      </div>
    </div>
  );
}

function ReportsPanel({ summary, inventory }: { summary: SalesSummary; inventory: InventorySnapshot }) {
  const [reportRange, setReportRange] = useState({ start: "", end: "" });
  const [reportSummary, setReportSummary] = useState(summary);
  const missingRecipeRows = inventory.status.missingRecipes.map((item) => [item.name, money(item.price), "Recipe not available"]);

  useEffect(() => {
    let cancelled = false;
    async function loadRangeSummary() {
      const next = await window.yamzo?.reports.sales(rangeStartForSql(reportRange.start), rangeEndForSql(reportRange.end));
      if (!cancelled) setReportSummary(next ?? summary);
    }
    void loadRangeSummary();
    return () => {
      cancelled = true;
    };
  }, [reportRange.start, reportRange.end, summary]);

  function applyPreset(preset: "today" | "yesterday" | "7days" | "1month") {
    const today = startOfLocalDay(new Date());
    const start = new Date(today);
    const end = new Date(today);
    if (preset === "yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    }
    if (preset === "7days") {
      start.setDate(start.getDate() - 6);
    }
    if (preset === "1month") {
      start.setMonth(start.getMonth() - 1);
    }
    setReportRange({ start: dateInputValue(start), end: dateInputValue(end) });
  }

  function exportSalesPdf() {
    const lines = [
      ["Total Sales", money(reportSummary.totalSales)],
      ["Total Orders", String(reportSummary.totalOrders)],
      ["Open Orders", String(reportSummary.openOrders)],
      ["Discounts", money(reportSummary.discountTotal)],
      ["Commissions", money(reportSummary.commissionTotal)],
      ["Void Total", money(reportSummary.voidTotal)],
      ["Average Order Time", reportSummary.averageKitchenMinutes ? `${reportSummary.averageKitchenMinutes} min` : "--"]
    ];
    const topItems = reportSummary.topItems.map((item) => [item.name, `${item.quantity} sold`, money(item.total)]);
    const payments = Object.entries(reportSummary.paymentBreakdown).map(([name, value]) => [labelize(name), money(value)]);
    const popup = window.open("", "_blank", "width=920,height=900");
    if (!popup) return;
    const period = reportRange.start || reportRange.end ? `${reportRange.start || "Start"} to ${reportRange.end || "End"}` : "All completed sales";
    popup.document.write(`
      <html>
        <head>
          <title>Yamzo Sales Report</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 32px; color: #111; }
            h1 { margin: 0 0 4px; font-size: 24px; }
            .muted { color: #666; margin-bottom: 24px; }
            table { width: 100%; border-collapse: collapse; margin: 16px 0 28px; }
            th, td { border-bottom: 1px solid #ddd; padding: 10px 8px; text-align: left; }
            th { background: #f5f5f5; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
            @media print { button { display: none; } body { margin: 18mm; } }
          </style>
        </head>
        <body>
          <button onclick="window.print()">Save / Print PDF</button>
          <h1>Yamzo Sales Report</h1>
          <div class="muted">${escapeHtml(period)}</div>
          <h2>Summary</h2>
          ${htmlTable(["Metric", "Value"], lines)}
          <div class="grid">
            <section><h2>Top Selling Items</h2>${htmlTable(["Item", "Quantity", "Sales"], topItems)}</section>
            <section><h2>Payment Breakdown</h2>${htmlTable(["Method", "Amount"], payments)}</section>
          </div>
        </body>
      </html>
    `);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="grid gap-3 p-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => applyPreset("today")}>Today</Button>
            <Button variant="secondary" size="sm" onClick={() => applyPreset("yesterday")}>Yesterday</Button>
            <Button variant="secondary" size="sm" onClick={() => applyPreset("7days")}>7 Days</Button>
            <Button variant="secondary" size="sm" onClick={() => applyPreset("1month")}>1 Month</Button>
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
            <DateRangeControl value={reportRange} onChange={setReportRange} />
            <Button variant="secondary" onClick={exportSalesPdf}>Export Sales PDF</Button>
          </div>
        </CardContent>
      </Card>
      <BusinessSummary summary={reportSummary} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Metric label="Revenue" value={money(reportSummary.totalSales)} />
        <Metric label="Raw Cost" value={money(inventory.profit.rawCost)} />
        <Metric label="Commissions" value={money(reportSummary.commissionTotal)} />
        <Metric label="Estimated Net" value={money(reportSummary.totalSales - inventory.profit.rawCost - reportSummary.commissionTotal)} />
        <Metric label="Missing Recipes" value={inventory.profit.missingRecipeCount} />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <ReportBlock title="Top Profit Items" rows={inventory.profit.topProfitItems.map((item) => `${item.name} - ${money(item.profit)} profit`)} />
        <ReportBlock title="Inventory Attention" rows={[
          `${inventory.status.lowStockCount} low-stock items`,
          `${inventory.status.outOfStockCount} out-of-stock items`,
          `${inventory.status.missingRecipeCount} menu items need recipes`
        ]} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Missing Recipes</CardTitle>
          <CardDescription>Menu items that still need ingredient recipes before profit and inventory usage can be audited.</CardDescription>
        </CardHeader>
        <CardContent>
          <InventoryTable headers={["Menu item", "Selling price", "Status"]} rows={missingRecipeRows} />
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <Card><CardContent className="grid gap-1 p-4"><span className="text-sm text-muted-foreground">{label}</span><strong className="text-2xl">{value}</strong></CardContent></Card>;
}

function ReportBlock({ title, rows }: { title: string; rows: string[] }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent className="grid gap-2">{rows.length === 0 ? <p className="text-sm text-muted-foreground">No data yet.</p> : rows.map((row) => <span key={row} className="text-sm">{row}</span>)}</CardContent></Card>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/20 p-6 text-center">
      <strong>{title}</strong>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function InventoryAdmin({
  snapshot,
  refreshData,
  setMessage,
  onEditRecipe,
  onViewPriceHistory
}: {
  snapshot: InventorySnapshot;
  refreshData: () => Promise<void>;
  setMessage: (message: string) => void;
  onEditRecipe: (recipe: MenuRecipe) => void;
  onViewPriceHistory: (itemId: number) => void;
}) {
  const activeCategories = snapshot.categories.filter((category) => category.active);
  const activeUnits = snapshot.units.filter((unit) => unit.active);
  const activeCostCategories = snapshot.costCategories.filter((category) => category.active);
  const firstItem = snapshot.items[0];
  const firstUnit = activeUnits[0];
  const firstCategory = activeCategories[0];
  const firstCostCategory = activeCostCategories[0];
  const firstMissingRecipe = snapshot.recipes.find((recipe) => recipe.status === "missing") ?? snapshot.recipes[0] ?? null;
  const restockableRecipes = snapshot.recipes.filter((recipe) => recipe.restockEnabled && recipe.status === "available");
  const [itemForm, setItemForm] = useState({
    id: 0,
    name: "",
    categoryId: firstCategory?.id ? String(firstCategory.id) : "",
    baseUnitId: firstUnit?.id ? String(firstUnit.id) : "",
    lowStockThreshold: "1000"
  });
  const [restockForm, setRestockForm] = useState({
    itemType: "raw",
    inventoryItemId: firstItem?.id ? String(firstItem.id) : "",
    recipeId: "",
    quantity: "",
    totalCost: "",
    supplierName: "",
    responsiblePerson: "",
    note: ""
  });
  const [physicalCountForm, setPhysicalCountForm] = useState({
    inventoryItemId: firstItem?.id ? String(firstItem.id) : "",
    quantity: "",
    responsiblePerson: "",
    note: ""
  });
  const [costForm, setCostForm] = useState({
    categoryId: firstCostCategory?.id ? String(firstCostCategory.id) : "",
    costName: "",
    quantity: "1",
    amount: "",
    paymentMethod: "cash",
    responsiblePerson: "",
    note: ""
  });
  const [categoryName, setCategoryName] = useState("");
  const [costCategoryName, setCostCategoryName] = useState("");
  const [unitForm, setUnitForm] = useState({ name: "", shortName: "" });
  const [statusRange, setStatusRange] = useState({ start: "", end: "" });
  const [itemEdit, setItemEdit] = useState<InventoryItem | null>(null);
  const [restockEdit, setRestockEdit] = useState<RestockEntry | null>(null);
  const [restockDialogOpen, setRestockDialogOpen] = useState(false);
  const [physicalDialogOpen, setPhysicalDialogOpen] = useState(false);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [recipeStatusFilter, setRecipeStatusFilter] = useState("all");
  const [inventoryItemSearch, setInventoryItemSearch] = useState("");
  const [restockSearch, setRestockSearch] = useState("");
  const [physicalSearch, setPhysicalSearch] = useState("");
  const selectedRestockItem = snapshot.items.find((item) => String(item.id) === restockForm.inventoryItemId) ?? null;
  const selectedPhysicalItem = snapshot.items.find((item) => String(item.id) === physicalCountForm.inventoryItemId) ?? null;

  useEffect(() => {
    if (!itemForm.baseUnitId && activeUnits[0]) setItemForm((current) => ({ ...current, baseUnitId: String(activeUnits[0].id) }));
    if (!itemForm.categoryId && activeCategories[0]) setItemForm((current) => ({ ...current, categoryId: String(activeCategories[0].id) }));
    if (!restockForm.inventoryItemId && snapshot.items[0]) setRestockForm((current) => ({ ...current, inventoryItemId: String(snapshot.items[0].id) }));
    if (!physicalCountForm.inventoryItemId && snapshot.items[0]) setPhysicalCountForm((current) => ({ ...current, inventoryItemId: String(snapshot.items[0].id) }));
    if (!costForm.categoryId && activeCostCategories[0]) setCostForm((current) => ({ ...current, categoryId: String(activeCostCategories[0].id) }));
  }, [snapshot]);

  async function saveItem() {
    if (!itemForm.name.trim()) {
      setMessage("Inventory item name is required.");
      return;
    }
    await window.yamzo?.inventory.saveItem({
      name: itemForm.name,
      categoryId: itemForm.categoryId ? Number(itemForm.categoryId) : null,
      baseUnitId: Number(itemForm.baseUnitId),
      lowStockThreshold: Number(itemForm.lowStockThreshold || 0),
      active: true
    });
    setItemForm({ ...itemForm, id: 0, name: "" });
    setMessage("Inventory item saved.");
    await refreshData();
  }

  function editItem(item: InventoryItem) {
    setItemEdit(item);
  }

  async function removeItem(item: InventoryItem) {
    if (!window.confirm(`Remove ${item.name} from active inventory items?`)) return;
    await window.yamzo?.inventory.deleteItem(item.id);
    setMessage("Inventory item removed.");
    await refreshData();
  }

  async function addRestock() {
    await window.yamzo?.inventory.addRestock({
      inventoryItemId: Number(restockForm.inventoryItemId),
      itemType: restockForm.itemType as "raw" | "recipe",
      recipeId: restockForm.recipeId ? Number(restockForm.recipeId) : null,
      quantity: Number(restockForm.quantity || 0),
      totalCost: Number(restockForm.totalCost || 0),
      supplierName: restockForm.supplierName || null,
      responsiblePerson: restockForm.responsiblePerson || null,
      note: restockForm.note || null
    });
    setRestockForm({ ...restockForm, quantity: "", totalCost: "", supplierName: "", note: "" });
    setRestockDialogOpen(false);
    setMessage("Restock entry saved.");
    await refreshData();
  }

  async function addPhysicalCountEntry() {
    await window.yamzo?.inventory.addPhysicalCount({
      inventoryItemId: Number(physicalCountForm.inventoryItemId),
      quantity: Number(physicalCountForm.quantity || 0),
      responsiblePerson: physicalCountForm.responsiblePerson || null,
      note: physicalCountForm.note || null
    });
    setPhysicalCountForm({ ...physicalCountForm, quantity: "", note: "" });
    setPhysicalDialogOpen(false);
    setMessage("Physical count saved.");
    await refreshData();
  }

  async function importInventoryItemsCsv() {
    const result = await window.yamzo?.inventory.chooseAndImportItemsCsv();
    if (!result || result.cancelled) {
      setMessage("Inventory item import cancelled.");
      return;
    }
    setMessage(`Inventory items replaced: ${result.imported} imported, ${result.skipped} skipped.`);
    await refreshData();
  }

  async function importRecipesCsv() {
    const result = await window.yamzo?.inventory.chooseAndImportCsv();
    if (!result || result.cancelled) {
      setMessage("Recipe import cancelled.");
      return;
    }
    setMessage(`Recipes imported: ${result.recipesImported} new, ${result.recipesUpdated} updated, ${result.inventoryItemsCreated} inventory items created.`);
    await refreshData();
  }

  async function deleteRestock(entry: RestockEntry) {
    if (!window.confirm(`Delete this restock entry for ${entry.itemName}?`)) return;
    await window.yamzo?.inventory.deleteRestock(entry.id);
    setMessage("Restock entry deleted.");
    await refreshData();
  }

  async function addCost() {
    await window.yamzo?.inventory.addCost({
      categoryId: costForm.categoryId ? Number(costForm.categoryId) : null,
      costName: costForm.costName,
      quantity: Number(costForm.quantity || 1),
      amount: Number(costForm.amount || 0),
      paymentMethod: costForm.paymentMethod,
      responsiblePerson: costForm.responsiblePerson || null,
      note: costForm.note || null
    });
    setCostForm({ ...costForm, costName: "", quantity: "1", amount: "", note: "" });
    setMessage("Cost record saved.");
    await refreshData();
  }

  async function addCategory() {
    if (!categoryName.trim()) return;
    await window.yamzo?.inventory.saveCategory({ name: categoryName.trim(), active: true });
    setCategoryName("");
    setMessage("Inventory category saved.");
    await refreshData();
  }

  async function removeCategory(category: InventoryCategory) {
    if (!window.confirm(`Remove inventory category ${category.name}?`)) return;
    await window.yamzo?.inventory.removeCategory(category.id);
    setMessage("Inventory category removed.");
    await refreshData();
  }

  async function addCostCategory() {
    if (!costCategoryName.trim()) return;
    await window.yamzo?.inventory.saveCostCategory({ name: costCategoryName.trim(), active: true, sortOrder: activeCostCategories.length });
    setCostCategoryName("");
    setMessage("Cost category saved.");
    await refreshData();
  }

  async function removeCostCategory(category: CostCategory) {
    if (!window.confirm(`Remove cost category ${category.name}?`)) return;
    await window.yamzo?.inventory.removeCostCategory(category.id);
    setMessage("Cost category removed.");
    await refreshData();
  }

  async function addUnit() {
    if (!unitForm.name.trim() || !unitForm.shortName.trim()) return;
    await window.yamzo?.inventory.saveUnit({ name: unitForm.name.trim(), shortName: unitForm.shortName.trim(), active: true });
    setUnitForm({ name: "", shortName: "" });
    setMessage("Base unit saved.");
    await refreshData();
  }

  async function removeUnit(unit: InventoryUnit) {
    if (!window.confirm(`Remove base unit ${unit.name}?`)) return;
    await window.yamzo?.inventory.removeUnit(unit.id);
    setMessage("Base unit removed.");
    await refreshData();
  }

  function stockRows() {
    return snapshot.items.map((item) => [
      item.name,
      item.categoryName ?? "Other",
      `${formatQuantity(item.currentStock)} ${item.unitShortName}`,
      `${formatQuantity(item.lowStockThreshold)} ${item.unitShortName}`,
      item.status === "ok" ? "OK" : item.status === "low" ? "Low stock" : "Out of stock"
    ]);
  }

  function restockRows() {
    return snapshot.restocks
      .filter((entry) => withinDateRange(entry.entryDate, statusRange))
      .map((entry) => [formatDate(entry.entryDate), entry.itemName, `${formatQuantity(entry.quantityBase)} ${entry.unitLabel}`, money(entry.totalCost), entry.responsiblePerson ?? "-", entry.supplierName ?? "-"]);
  }

  const filteredRecipes = snapshot.recipes.filter((recipe) => {
    const text = `${recipe.menuItemName} ${recipe.ingredients.map((item) => item.itemName).join(" ")}`.toLowerCase();
    const queryMatch = text.includes(recipeSearch.trim().toLowerCase());
    const statusMatch = recipeStatusFilter === "all" || recipe.status === recipeStatusFilter;
    return queryMatch && statusMatch;
  });
  const filteredInventoryItems = snapshot.items.filter((item) => {
    const text = `${item.name} ${item.categoryName ?? ""} ${item.unitShortName} ${item.status}`.toLowerCase();
    return text.includes(inventoryItemSearch.trim().toLowerCase());
  });
  const filteredRestocks = snapshot.restocks.filter((entry) => {
    const text = `${entry.itemName} ${entry.supplierName ?? ""} ${entry.responsiblePerson ?? ""} ${entry.note ?? ""}`.toLowerCase();
    return text.includes(restockSearch.trim().toLowerCase());
  });
  const filteredPhysicalCounts = snapshot.physicalCounts.filter((entry) => {
    const text = `${entry.itemName} ${entry.responsiblePerson ?? ""} ${entry.note ?? ""} ${entry.source}`.toLowerCase();
    return text.includes(physicalSearch.trim().toLowerCase());
  });

  return (
    <div className="grid gap-4 pt-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Metric label="Inventory Value" value={money(snapshot.status.totalInventoryValue)} />
        <Metric label="Inventory Items" value={snapshot.status.inventoryItemCount} />
        <Metric label="Recipes Ready" value={snapshot.status.recipeAvailableCount} />
        <Metric label="Missing Recipes" value={snapshot.status.missingRecipeCount} />
        <Metric label="Low Stock" value={snapshot.status.lowStockCount} />
      </div>
      <Tabs defaultValue="status">
        <TabsList className="grid w-full grid-cols-3 lg:grid-cols-7">
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="recipes">Recipes</TabsTrigger>
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="restock">Restock</TabsTrigger>
          <TabsTrigger value="physical">Physical Count</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="status" className="grid gap-4 pt-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><CardTitle>Stock Status</CardTitle><CardDescription>Current stock position for active inventory items.</CardDescription></div>
                  <Button variant="secondary" onClick={() => exportCsvRows("yamzo-stock-status.csv", [["Item", "Category", "Stock", "Warning", "Status"], ...stockRows()])}>Export</Button>
                </div>
              </CardHeader>
              <CardContent>
                <DateRangeControl value={statusRange} onChange={setStatusRange} />
                <div className="mt-4"><InventoryTable headers={["Item", "Category", "Stock", "Warning", "Status"]} rows={stockRows()} /></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><CardTitle>Restock Status</CardTitle><CardDescription>Restock entries in the selected date range.</CardDescription></div>
                  <Button variant="secondary" onClick={() => exportCsvRows("yamzo-restock-status.csv", [["Date", "Item", "Quantity", "Cost", "Person", "Supplier"], ...restockRows()])}>Export</Button>
                </div>
              </CardHeader>
              <CardContent>
                <DateRangeControl value={statusRange} onChange={setStatusRange} />
                <div className="mt-4"><InventoryTable headers={["Date", "Item", "Quantity", "Cost", "Person", "Supplier"]} rows={restockRows()} /></div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="recipes" className="grid gap-4 pt-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Recipes</CardTitle>
                  <CardDescription>Search recipes and edit one recipe at a time from existing inventory items.</CardDescription>
                </div>
                <Button disabled={!firstMissingRecipe} onClick={() => firstMissingRecipe && onEditRecipe(firstMissingRecipe)}>{firstMissingRecipe?.status === "missing" ? "Add Recipe" : "Edit Recipe"}</Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-[minmax(260px,1fr)_220px]">
              <Field label="Search recipe"><Input value={recipeSearch} onChange={(event) => setRecipeSearch(event.target.value)} placeholder="Search by dish or ingredient" /></Field>
              <Field label="Status">
                <Select value={recipeStatusFilter} onValueChange={setRecipeStatusFilter}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All recipes</SelectItem>
                    <SelectItem value="available">Recipe available</SelectItem>
                    <SelectItem value="missing">Missing recipe</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>
          {filteredRecipes.map((recipe) => (
            <Card key={recipe.menuItemId} size="sm">
              <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_180px_180px_180px] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><strong>{recipe.menuItemName}</strong><Badge variant={recipe.status === "available" ? "default" : "destructive"}>{recipe.status === "available" ? "Recipe Available" : "Recipe Not Available"}</Badge></div>
                  <p className="text-sm text-muted-foreground">{recipe.ingredients.length === 0 ? "No ingredients added." : recipe.ingredients.map((item) => item.itemName).join(", ")}</p>
                </div>
                <span>Raw cost: <strong>{money(recipe.rawCost)}</strong></span>
                <span>Profit: <strong>{money(recipe.estimatedProfit)}</strong></span>
                <span>Margin: <strong>{recipe.profitMargin}%</strong></span>
                <label className="flex items-center gap-2">
                  <Checkbox checked={recipe.restockEnabled} onCheckedChange={async (checked) => { await window.yamzo?.inventory.setRecipeRestockEnabled(recipe.menuItemId, Boolean(checked)); await refreshData(); }} />
                  Enable restock option
                </label>
                <Button variant="secondary" onClick={() => onEditRecipe(recipe)}>{recipe.status === "missing" ? "Add Recipe" : "Edit Recipe"}</Button>
              </CardContent>
            </Card>
          ))}
          {filteredRecipes.length === 0 && <EmptyState title="No recipes found" description="Try a different recipe, ingredient, or status filter." />}
        </TabsContent>

        <TabsContent value="items" className="grid gap-4 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Field label="Search inventory items"><Input value={inventoryItemSearch} onChange={(event) => setInventoryItemSearch(event.target.value)} placeholder="Search by item, category, unit, or status" /></Field>
            <Button variant="secondary" onClick={importInventoryItemsCsv}>Import Items CSV</Button>
          </div>
          <Card>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
              <Field label="Item name"><Input value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} /></Field>
              <Field label="Category"><Select value={itemForm.categoryId} onValueChange={(value) => setItemForm({ ...itemForm, categoryId: value })}><SelectTrigger><SelectValue placeholder="Choose category" /></SelectTrigger><SelectContent>{activeCategories.map((category) => <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Base unit"><Select value={itemForm.baseUnitId} onValueChange={(value) => setItemForm({ ...itemForm, baseUnitId: value })}><SelectTrigger><SelectValue placeholder="Choose unit" /></SelectTrigger><SelectContent>{activeUnits.map((unit) => <SelectItem key={unit.id} value={String(unit.id)}>{unit.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Low stock warning"><Input value={itemForm.lowStockThreshold} onChange={(event) => setItemForm({ ...itemForm, lowStockThreshold: event.target.value })} /></Field>
              <Button className="self-end" onClick={saveItem}>Save Item</Button>
            </CardContent>
          </Card>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filteredInventoryItems.map((item) => (
              <Card key={item.id} size="sm" className="overflow-hidden">
                <CardContent className="grid min-h-[190px] gap-3 p-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <strong className="line-clamp-2">{item.name}</strong>
                      <Badge variant={item.status === "ok" ? "secondary" : "destructive"}>{item.status === "ok" ? "OK" : item.status === "low" ? "Low" : "Out"}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.categoryName ?? "Other"}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <InventoryMiniMetric label="Stock" value={`${formatQuantity(item.currentStock)} ${item.unitShortName}`} />
                    <InventoryMiniMetric label="Latest" value={`${formatQuantity(item.latestPrice)} / ${item.unitShortName}`} />
                    <InventoryMiniMetric label="Value" value={money(item.estimatedValue)} />
                    <InventoryMiniMetric label="Warning" value={`${formatQuantity(item.lowStockThreshold)} ${item.unitShortName}`} />
                  </div>
                  <div className="mt-auto grid grid-cols-3 gap-2">
                    <Button variant="secondary" size="sm" onClick={() => editItem(item)}>Edit</Button>
                    <Button variant="secondary" size="sm" onClick={() => onViewPriceHistory(item.id)}>Price Record</Button>
                    <Button variant="destructive" size="sm" onClick={() => removeItem(item)}>Remove</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {filteredInventoryItems.length === 0 && <EmptyState title="No inventory items found" description="Try a different item name, category, unit, or stock status." />}
        </TabsContent>

        <TabsContent value="restock" className="grid gap-4 pt-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Restock History</CardTitle>
                  <CardDescription>Search recent restocks by item, supplier, person, or note.</CardDescription>
                </div>
                <Button onClick={() => { setRestockForm({ ...restockForm, inventoryItemId: "", recipeId: "", quantity: "", totalCost: "", supplierName: "", note: "" }); setRestockDialogOpen(true); }}>Add Restock</Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Input value={restockSearch} onChange={(event) => setRestockSearch(event.target.value)} placeholder="Search restock records" />
              <RestockEntryTable entries={filteredRestocks} onEdit={setRestockEdit} onDelete={deleteRestock} />
            </CardContent>
          </Card>
          <RestockCreateDialog
            open={restockDialogOpen}
            onOpenChange={setRestockDialogOpen}
            items={snapshot.items}
            restockableRecipes={restockableRecipes}
            form={restockForm}
            selectedItem={selectedRestockItem}
            setForm={setRestockForm}
            onSave={addRestock}
          />
        </TabsContent>

        <TabsContent value="physical" className="grid gap-4 pt-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Physical Count History</CardTitle>
                  <CardDescription>Manual stock counts are the source of truth for current stock.</CardDescription>
                </div>
                <Button onClick={() => { setPhysicalCountForm({ ...physicalCountForm, inventoryItemId: "", quantity: "", note: "" }); setPhysicalDialogOpen(true); }}>Add Count</Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Input value={physicalSearch} onChange={(event) => setPhysicalSearch(event.target.value)} placeholder="Search physical counts" />
              <InventoryTable
                headers={["Date", "Item", "Count", "Source", "Person", "Note"]}
                rows={filteredPhysicalCounts.map((entry) => [formatDate(entry.countDate), entry.itemName, `${formatQuantity(entry.quantityBase)} ${entry.unitLabel}`, labelize(entry.source), entry.responsiblePerson ?? "-", entry.note ?? "-"])}
              />
            </CardContent>
          </Card>
          <PhysicalCountCreateDialog
            open={physicalDialogOpen}
            onOpenChange={setPhysicalDialogOpen}
            items={snapshot.items}
            form={physicalCountForm}
            selectedItem={selectedPhysicalItem}
            setForm={setPhysicalCountForm}
            onSave={addPhysicalCountEntry}
          />
        </TabsContent>

        <TabsContent value="orders" className="pt-4">
          <InventoryOrdersPanel usage={snapshot.orderUsage} />
        </TabsContent>

        <TabsContent value="settings" className="grid gap-4 pt-4">
          <div className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader><CardTitle>Inventory Categories</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <div className="grid grid-cols-[1fr_auto] gap-2"><Input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Example: Beverage" /><Button onClick={addCategory} disabled={!categoryName.trim()}>Add Category</Button></div>
                <EditableSettingList items={activeCategories} onSave={(item, name) => window.yamzo?.inventory.saveCategory({ id: item.id, name, active: true }).then(refreshData)} onRemove={removeCategory} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Base Units</CardTitle><CardDescription>Use measurable stock units only.</CardDescription></CardHeader>
              <CardContent className="grid gap-3">
                <div className="grid grid-cols-[1fr_92px_auto] gap-2">
                  <Input value={unitForm.name} onChange={(event) => setUnitForm({ ...unitForm, name: event.target.value })} placeholder="Kilogram" />
                  <Input value={unitForm.shortName} onChange={(event) => setUnitForm({ ...unitForm, shortName: event.target.value })} placeholder="kg" />
                  <Button onClick={addUnit} disabled={!unitForm.name.trim() || !unitForm.shortName.trim()}>Add Unit</Button>
                </div>
                <div className="grid gap-2">
                  {activeUnits.map((unit) => <EditableUnitRow key={unit.id} unit={unit} onSave={async (name, shortName) => { await window.yamzo?.inventory.saveUnit({ id: unit.id, name, shortName, active: true }); await refreshData(); }} onRemove={() => removeUnit(unit)} />)}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
      <InventoryItemEditorDialog
        item={itemEdit}
        categories={activeCategories}
        units={activeUnits}
        onClose={() => setItemEdit(null)}
        onSaved={async () => {
          setItemEdit(null);
          setMessage("Inventory item saved.");
          await refreshData();
        }}
      />
      <RestockEditorDialog
        entry={restockEdit}
        items={snapshot.items}
        onClose={() => setRestockEdit(null)}
        onSaved={async () => {
          setRestockEdit(null);
          setMessage("Restock entry saved. Date updated to latest save time.");
          await refreshData();
        }}
      />
    </div>
  );
}

function InventoryItemEditorDialog({
  item,
  categories,
  units,
  onClose,
  onSaved
}: {
  item: InventoryItem | null;
  categories: InventoryCategory[];
  units: InventoryUnit[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({ name: "", categoryId: "", baseUnitId: "", lowStockThreshold: "0" });
  const [error, setError] = useState("");

  useEffect(() => {
    if (!item) return;
    setError("");
    setDraft({
      name: item.name,
      categoryId: item.categoryId ? String(item.categoryId) : "",
      baseUnitId: String(item.baseUnitId),
      lowStockThreshold: String(item.lowStockThreshold)
    });
  }, [item]);

  async function save() {
    if (!item) return;
    if (!draft.name.trim()) {
      setError("Item name is required.");
      return;
    }
    try {
      await window.yamzo?.inventory.saveItem({
        id: item.id,
        name: draft.name.trim(),
        categoryId: draft.categoryId ? Number(draft.categoryId) : null,
        baseUnitId: Number(draft.baseUnitId),
        lowStockThreshold: Number(draft.lowStockThreshold || 0),
        active: true
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save inventory item.");
    }
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(760px,calc(100vw-32px))] !max-w-[760px] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{item ? `Edit item - ${item.name}` : "Edit item"}</DialogTitle>
          <DialogDescription>Update stock setup without changing existing restock history.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 p-6">
          {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Item name"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
            <Field label="Category">
              <Select value={draft.categoryId || "none"} onValueChange={(value) => setDraft({ ...draft, categoryId: value === "none" ? "" : value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {categories.map((category) => <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Base unit">
              <Select value={draft.baseUnitId} onValueChange={(value) => setDraft({ ...draft, baseUnitId: value })}>
                <SelectTrigger><SelectValue placeholder="Choose unit" /></SelectTrigger>
                <SelectContent>{units.map((unit) => <SelectItem key={unit.id} value={String(unit.id)}>{unit.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Low stock warning"><Input value={draft.lowStockThreshold} onChange={(event) => setDraft({ ...draft, lowStockThreshold: event.target.value })} /></Field>
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save Item</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestockEntryTable({ entries, onEdit, onDelete }: { entries: RestockEntry[]; onEdit: (entry: RestockEntry) => void; onDelete: (entry: RestockEntry) => void }) {
  return (
    <div className="rounded-xl border bg-card">
      {entries.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No restock entries yet.</p>
      ) : (
        <div className="overflow-auto">
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow><TableHead>Date</TableHead><TableHead>Item</TableHead><TableHead>Quantity</TableHead><TableHead>Cost</TableHead><TableHead>Person</TableHead><TableHead>Supplier</TableHead><TableHead className="text-right">Action</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{formatDate(entry.updatedAt || entry.entryDate)}</TableCell>
                  <TableCell>{entry.itemName}</TableCell>
                  <TableCell>{formatQuantity(entry.quantityBase)} {entry.unitLabel}</TableCell>
                  <TableCell>{money(entry.totalCost)}</TableCell>
                  <TableCell>{entry.responsiblePerson ?? "-"}</TableCell>
                  <TableCell>{entry.supplierName ?? "-"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => onEdit(entry)}>Edit</Button>
                      <Button size="sm" variant="destructive" onClick={() => onDelete(entry)}>Delete</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function RestockEditorDialog({
  entry,
  items,
  onClose,
  onSaved
}: {
  entry: RestockEntry | null;
  items: InventoryItem[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({ inventoryItemId: "", quantity: "", unitLabel: "", totalCost: "", supplierName: "", responsiblePerson: "", note: "" });
  const [error, setError] = useState("");
  const selectedItem = items.find((item) => item.id === Number(draft.inventoryItemId));

  useEffect(() => {
    if (!entry) return;
    setError("");
    setDraft({
      inventoryItemId: String(entry.inventoryItemId),
      quantity: String(entry.quantityBase),
      unitLabel: entry.unitLabel,
      totalCost: String(entry.totalCost),
      supplierName: entry.supplierName ?? "",
      responsiblePerson: entry.responsiblePerson ?? "",
      note: entry.note ?? ""
    });
  }, [entry]);

  function chooseItem(value: string) {
    const nextItem = items.find((item) => item.id === Number(value));
    setDraft((current) => ({ ...current, inventoryItemId: value, unitLabel: nextItem?.unitShortName ?? current.unitLabel }));
  }

  async function save() {
    if (!entry) return;
    try {
      await window.yamzo?.inventory.updateRestock({
        id: entry.id,
        inventoryItemId: Number(draft.inventoryItemId),
        quantity: Number(draft.quantity || 0),
        unitLabel: selectedItem?.unitShortName || draft.unitLabel,
        totalCost: Number(draft.totalCost || 0),
        supplierName: draft.supplierName || null,
        responsiblePerson: draft.responsiblePerson || null,
        note: draft.note || null
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save restock entry.");
    }
  }

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(860px,calc(100vw-32px))] !max-w-[860px] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{entry ? `Edit restock - ${entry.itemName}` : "Edit restock"}</DialogTitle>
          <DialogDescription>Saving this entry updates its date to the latest save time.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 p-6">
          {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <InventoryItemPicker label="Item" value={draft.inventoryItemId} items={items} onChange={chooseItem} />
            <Field label="Quantity"><Input value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })} /></Field>
            <Field label="Unit"><Input value={selectedItem?.unitShortName || draft.unitLabel} readOnly className="bg-muted/60" /></Field>
            <Field label="Total cost"><Input value={draft.totalCost} onChange={(event) => setDraft({ ...draft, totalCost: event.target.value })} /></Field>
            <Field label="Person responsible"><Input value={draft.responsiblePerson} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></Field>
            <Field label="Supplier"><Input value={draft.supplierName} onChange={(event) => setDraft({ ...draft, supplierName: event.target.value })} /></Field>
            <div className="md:col-span-2"><Field label="Note"><Textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></Field></div>
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save Restock</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InventoryItemCardPicker({
  items,
  selectedItemId,
  onSelect,
  search,
  onSearch
}: {
  items: InventoryItem[];
  selectedItemId: string;
  onSelect: (item: InventoryItem) => void;
  search: string;
  onSearch: (value: string) => void;
}) {
  const groupedItems = useMemo(() => {
    const filtered = items.filter((item) => {
      const haystack = `${item.name} ${item.categoryName ?? ""} ${item.unitShortName}`.toLowerCase();
      return haystack.includes(search.trim().toLowerCase());
    });
    return filtered.reduce<Record<string, InventoryItem[]>>((groups, item) => {
      const key = item.categoryName || "Other";
      groups[key] = groups[key] ?? [];
      groups[key].push(item);
      return groups;
    }, {});
  }, [items, search]);

  return (
    <div className="grid gap-3">
      <Input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search item or category" />
      <ScrollArea className="h-[420px] rounded-xl border bg-muted/20 p-3">
        <div className="grid gap-5 pr-3">
          {Object.entries(groupedItems).map(([category, categoryItems]) => (
            <section key={category} className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">{category}</h4>
                <Badge variant="secondary">{categoryItems.length}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {categoryItems.map((item) => {
                  const selected = selectedItemId === String(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSelect(item)}
                      className={`rounded-xl border bg-card p-3 text-left shadow-sm transition hover:border-foreground/30 hover:bg-accent ${selected ? "border-foreground ring-2 ring-foreground/10" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <strong className="line-clamp-2 text-sm">{item.name}</strong>
                        <Badge variant={item.status === "ok" ? "secondary" : "destructive"}>{item.status === "ok" ? "OK" : item.status === "low" ? "Low" : "Out"}</Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <span>Stock <strong className="block text-foreground">{formatQuantity(item.currentStock)} {item.unitShortName}</strong></span>
                        <span>Latest <strong className="block text-foreground">{formatQuantity(item.latestPrice)} / {item.unitShortName}</strong></span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {Object.keys(groupedItems).length === 0 && <EmptyState title="No items found" description="Try another item name or category." />}
        </div>
      </ScrollArea>
    </div>
  );
}

function RestockCreateDialog({
  open,
  onOpenChange,
  items,
  restockableRecipes,
  form,
  selectedItem,
  setForm,
  onSave
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryItem[];
  restockableRecipes: MenuRecipe[];
  form: { itemType: string; inventoryItemId: string; recipeId: string; quantity: string; totalCost: string; supplierName: string; responsiblePerson: string; note: string };
  selectedItem: InventoryItem | null;
  setForm: (form: { itemType: string; inventoryItemId: string; recipeId: string; quantity: string; totalCost: string; supplierName: string; responsiblePerson: string; note: string }) => void;
  onSave: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(1120px,calc(100vw-32px))] !max-w-[1120px] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Add Restock</DialogTitle>
          <DialogDescription>Select the purchased item first, then enter quantity and cost details.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[calc(100vh-190px)] gap-5 overflow-auto p-6 lg:grid-cols-[minmax(420px,1fr)_380px]">
          <InventoryItemCardPicker
            items={items}
            selectedItemId={form.inventoryItemId}
            search={search}
            onSearch={setSearch}
            onSelect={(item) => setForm({ ...form, inventoryItemId: String(item.id) })}
          />
          <div className="grid content-start gap-4">
            <Card className="bg-emerald-50/60">
              <CardContent className="grid gap-2 p-4">
                <span className="text-sm text-muted-foreground">Selected item</span>
                <strong>{selectedItem?.name ?? "Choose an item"}</strong>
                {selectedItem && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <InventoryMiniMetric label="Category" value={selectedItem.categoryName ?? "Other"} />
                    <InventoryMiniMetric label="Unit" value={selectedItem.unitShortName} />
                    <InventoryMiniMetric label="Current stock" value={`${formatQuantity(selectedItem.currentStock)} ${selectedItem.unitShortName}`} />
                    <InventoryMiniMetric label="Latest price" value={`${formatQuantity(selectedItem.latestPrice)} / ${selectedItem.unitShortName}`} />
                  </div>
                )}
              </CardContent>
            </Card>
            <Field label="Item type">
              <Select value={form.itemType} onValueChange={(value) => setForm({ ...form, itemType: value, recipeId: "" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="raw">Raw materials</SelectItem><SelectItem value="recipe">Recipe materials</SelectItem></SelectContent>
              </Select>
            </Field>
            {form.itemType === "recipe" && (
              <Field label="Recipe material">
                <SearchableRecipeSelect value={form.recipeId} recipes={restockableRecipes} onChange={(value) => setForm({ ...form, recipeId: value })} />
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Quantity (${selectedItem?.unitShortName ?? "unit"})`}><Input value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></Field>
              <Field label="Total cost"><Input value={form.totalCost} onChange={(event) => setForm({ ...form, totalCost: event.target.value })} /></Field>
              <Field label="Supplier"><Input value={form.supplierName} onChange={(event) => setForm({ ...form, supplierName: event.target.value })} /></Field>
              <Field label="Person responsible"><Input value={form.responsiblePerson} onChange={(event) => setForm({ ...form, responsiblePerson: event.target.value })} /></Field>
            </div>
            <Field label="Note"><Textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></Field>
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSave} disabled={!selectedItem || !form.quantity || !form.totalCost}>Save Restock</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PhysicalCountCreateDialog({
  open,
  onOpenChange,
  items,
  form,
  selectedItem,
  setForm,
  onSave
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryItem[];
  form: { inventoryItemId: string; quantity: string; responsiblePerson: string; note: string };
  selectedItem: InventoryItem | null;
  setForm: (form: { inventoryItemId: string; quantity: string; responsiblePerson: string; note: string }) => void;
  onSave: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(1040px,calc(100vw-32px))] !max-w-[1040px] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Add Physical Count</DialogTitle>
          <DialogDescription>Select the counted item from cards, then record the measured quantity.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[calc(100vh-190px)] gap-5 overflow-auto p-6 lg:grid-cols-[minmax(420px,1fr)_340px]">
          <InventoryItemCardPicker
            items={items}
            selectedItemId={form.inventoryItemId}
            search={search}
            onSearch={setSearch}
            onSelect={(item) => setForm({ ...form, inventoryItemId: String(item.id) })}
          />
          <div className="grid content-start gap-4">
            <Card className="bg-sky-50/70">
              <CardContent className="grid gap-2 p-4">
                <span className="text-sm text-muted-foreground">Selected item</span>
                <strong>{selectedItem?.name ?? "Choose an item"}</strong>
                {selectedItem && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <InventoryMiniMetric label="Category" value={selectedItem.categoryName ?? "Other"} />
                    <InventoryMiniMetric label="Unit" value={selectedItem.unitShortName} />
                    <InventoryMiniMetric label="Current stock" value={`${formatQuantity(selectedItem.currentStock)} ${selectedItem.unitShortName}`} />
                    <InventoryMiniMetric label="Warning" value={`${formatQuantity(selectedItem.lowStockThreshold)} ${selectedItem.unitShortName}`} />
                  </div>
                )}
              </CardContent>
            </Card>
            <Field label={`Count (${selectedItem?.unitShortName ?? "unit"})`}><Input value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></Field>
            <Field label="Person responsible"><Input value={form.responsiblePerson} onChange={(event) => setForm({ ...form, responsiblePerson: event.target.value })} /></Field>
            <Field label="Note"><Textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></Field>
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSave} disabled={!selectedItem || !form.quantity}>Save Count</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InventoryOrdersPanel({ usage }: { usage: InventorySnapshot["orderUsage"] }) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Inventory Used by Completed Orders</CardTitle>
          <CardDescription>Total ingredient usage calculated from saved recipe cost snapshots.</CardDescription>
        </CardHeader>
        <CardContent>
          <InventoryTable
            headers={["Inventory item", "Quantity used", "Raw cost"]}
            rows={usage.totals.map((item) => [item.itemName, `${formatQuantity(item.quantityBase)} ${item.unitLabel}`, money(item.rawCost)])}
          />
        </CardContent>
      </Card>
      <div className="grid gap-3">
        {usage.orders.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No completed orders with recipe usage yet.</p>
        ) : usage.orders.map((order) => (
          <Card key={order.orderId} size="sm">
            <CardContent className="grid gap-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{order.tableNumber ? `${formatSource(order.source)} - ${order.tableNumber}` : formatSource(order.source)}</CardTitle>
                  <CardDescription>Receipt {order.orderNumber} | {order.settledAt ? formatDate(order.settledAt) : "Completed"}</CardDescription>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <InventoryMiniMetric label="Items" value={order.items.reduce((total, item) => total + item.quantity, 0)} />
                  <InventoryMiniMetric label="Revenue" value={money(order.total)} />
                  <InventoryMiniMetric label="Raw Cost" value={money(order.items.reduce((total, item) => total + item.rawCost, 0))} />
                </div>
              </div>
              <div className="grid gap-2">
                {order.items.map((item) => (
                  <div key={item.orderItemId} className="rounded-lg border bg-muted/20 p-3">
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong>{item.quantity} x {item.menuItemName}</strong>
                      <span className="text-sm text-muted-foreground">Raw cost {money(item.rawCost)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.ingredients.length === 0 ? (
                        <Badge variant="destructive">No saved recipe usage</Badge>
                      ) : item.ingredients.map((ingredient) => (
                        <Badge key={`${item.orderItemId}-${ingredient.inventoryItemId}`} variant="secondary">
                          {ingredient.itemName}: {formatQuantity(ingredient.quantityBase)} {ingredient.unitLabel}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function InventoryMiniMetric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-lg border bg-background px-3 py-2"><span className="block text-xs text-muted-foreground">{label}</span><strong>{value}</strong></div>;
}

function InventoryItemPicker({ label, value, items, onChange }: { label: string; value: string; items: InventorySnapshot["items"]; onChange: (value: string) => void }) {
  const inputId = useId();
  const selectedItem = items.find((item) => String(item.id) === value);
  const [text, setText] = useState(selectedItem?.name ?? "");
  const listId = `${inputId}-items`;

  useEffect(() => {
    setText(selectedItem?.name ?? "");
  }, [selectedItem?.id, selectedItem?.name]);

  function commit(nextText: string) {
    const normalized = nextText.trim().toLowerCase();
    const exact = items.find((item) => item.name.trim().toLowerCase() === normalized);
    if (exact) {
      onChange(String(exact.id));
      return;
    }
    const firstMatch = items.find((item) => item.name.toLowerCase().includes(normalized));
    if (firstMatch && normalized) {
      onChange(String(firstMatch.id));
      setText(firstMatch.name);
    }
  }

  return (
    <Field label={label}>
      <Input
        list={listId}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          commit(event.target.value);
        }}
        onBlur={() => commit(text)}
        placeholder="Type item name"
      />
      <datalist id={listId}>{items.map((item) => <option key={item.id} value={item.name}>{item.categoryName ?? ""}</option>)}</datalist>
      {selectedItem && <p className="mt-1 text-xs text-muted-foreground">{selectedItem.categoryName ?? "Uncategorized"} | {formatQuantity(selectedItem.currentStock)} {selectedItem.unitShortName} in stock</p>}
    </Field>
  );
}

function SearchableRecipeSelect({ value, recipes, onChange }: { value: string; recipes: MenuRecipe[]; onChange: (value: string) => void }) {
  const inputId = useId();
  const selected = recipes.find((recipe) => String(recipe.id) === value);
  const [text, setText] = useState(selected?.menuItemName ?? "");
  const listId = `${inputId}-recipes`;

  useEffect(() => {
    setText(selected?.menuItemName ?? "");
  }, [selected?.id, selected?.menuItemName]);

  function commit(nextText: string) {
    const normalized = nextText.trim().toLowerCase();
    if (!normalized) {
      onChange("");
      return;
    }
    const exact = recipes.find((recipe) => recipe.menuItemName.trim().toLowerCase() === normalized);
    if (exact) {
      onChange(String(exact.id));
      return;
    }
    const firstMatch = recipes.find((recipe) => recipe.menuItemName.toLowerCase().includes(normalized));
    if (firstMatch) {
      onChange(String(firstMatch.id));
      setText(firstMatch.menuItemName);
    }
  }

  return (
    <>
      <Input
        list={listId}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          commit(event.target.value);
        }}
        onBlur={() => commit(text)}
        placeholder="Type recipe name"
      />
      <datalist id={listId}>{recipes.map((recipe) => <option key={recipe.id} value={recipe.menuItemName}>{recipe.ingredients.length} ingredients</option>)}</datalist>
      {selected && <p className="mt-1 text-xs text-muted-foreground">{selected.ingredients.length} ingredients | raw cost {money(selected.rawCost)}</p>}
    </>
  );
}

function EditableSettingList<T extends { id: number; name: string }>({
  items,
  onSave,
  onRemove,
  onReorder
}: {
  items: T[];
  onSave: (item: T, name: string) => Promise<unknown> | void;
  onRemove: (item: T) => Promise<void> | void;
  onReorder?: (items: T[]) => Promise<void> | void;
}) {
  const [draggedId, setDraggedId] = useState<number | null>(null);

  function moveItem(fromId: number, toId: number) {
    if (!onReorder || fromId === toId) return;
    const fromIndex = items.findIndex((item) => item.id === fromId);
    const toIndex = items.findIndex((item) => item.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextItems = [...items];
    const [moved] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, moved);
    void onReorder(nextItems);
  }

  function nudgeItem(item: T, direction: -1 | 1) {
    if (!onReorder) return;
    const index = items.findIndex((entry) => entry.id === item.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return;
    const nextItems = [...items];
    const [moved] = nextItems.splice(index, 1);
    nextItems.splice(nextIndex, 0, moved);
    void onReorder(nextItems);
  }

  return (
    <div className="grid gap-2">
      {items.length === 0 ? <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No entries yet.</p> : items.map((item) => (
        <div
          key={item.id}
          draggable={Boolean(onReorder)}
          onDragStart={() => setDraggedId(item.id)}
          onDragOver={(event) => onReorder && event.preventDefault()}
          onDrop={() => {
            if (draggedId) moveItem(draggedId, item.id);
            setDraggedId(null);
          }}
        >
          <EditableNameRow
            item={item}
            onSave={onSave}
            onRemove={onRemove}
            canReorder={Boolean(onReorder)}
            onMoveUp={() => nudgeItem(item, -1)}
            onMoveDown={() => nudgeItem(item, 1)}
          />
        </div>
      ))}
    </div>
  );
}

function EditableNameRow<T extends { id: number; name: string }>({
  item,
  onSave,
  onRemove,
  canReorder = false,
  onMoveUp,
  onMoveDown
}: {
  item: T;
  onSave: (item: T, name: string) => Promise<unknown> | void;
  onRemove: (item: T) => Promise<void> | void;
  canReorder?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.name);

  useEffect(() => setDraft(item.name), [item.name]);

  if (editing) {
    return (
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-lg border bg-card p-2">
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button size="sm" onClick={async () => { await onSave(item, draft.trim()); setEditing(false); }}>Save</Button>
        <Button size="sm" variant="secondary" onClick={() => { setDraft(item.name); setEditing(false); }}>Cancel</Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <strong className="truncate">{item.name}</strong>
      {canReorder && (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={onMoveUp}>Up</Button>
          <Button size="sm" variant="secondary" onClick={onMoveDown}>Down</Button>
        </div>
      )}
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
      <Button size="sm" variant="destructive" onClick={() => onRemove(item)}>Remove</Button>
    </div>
  );
}

function EditableUnitRow({ unit, onSave, onRemove }: { unit: InventoryUnit; onSave: (name: string, shortName: string) => Promise<void>; onRemove: () => Promise<void> | void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: unit.name, shortName: unit.shortName });

  useEffect(() => setDraft({ name: unit.name, shortName: unit.shortName }), [unit.name, unit.shortName]);

  if (editing) {
    return (
      <div className="grid grid-cols-[1fr_92px_auto_auto] items-center gap-2 rounded-lg border bg-card p-2">
        <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <Input value={draft.shortName} onChange={(event) => setDraft({ ...draft, shortName: event.target.value })} />
        <Button size="sm" onClick={async () => { await onSave(draft.name.trim(), draft.shortName.trim()); setEditing(false); }}>Save</Button>
        <Button size="sm" variant="secondary" onClick={() => { setDraft({ name: unit.name, shortName: unit.shortName }); setEditing(false); }}>Cancel</Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <strong className="truncate">{unit.name}</strong>
      <Badge variant="secondary">{unit.shortName}</Badge>
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
      <Button size="sm" variant="destructive" onClick={onRemove}>Remove</Button>
    </div>
  );
}

function DateRangeControl({ value, onChange }: { value: { start: string; end: string }; onChange: (value: { start: string; end: string }) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <Field label="Start date"><Input type="date" value={value.start} onChange={(event) => onChange({ ...value, start: event.target.value })} /></Field>
      <Field label="End date"><Input type="date" value={value.end} onChange={(event) => onChange({ ...value, end: event.target.value })} /></Field>
      <Button variant="secondary" onClick={() => onChange({ start: "", end: "" })}>Clear Dates</Button>
    </div>
  );
}

function CostsPanel({ snapshot, refreshData, setMessage }: { snapshot: InventorySnapshot; refreshData: () => Promise<void>; setMessage: (message: string) => void }) {
  const activeCostCategories = snapshot.costCategories.filter((category) => category.active);
  const firstCostCategory = activeCostCategories[0];
  const [costTab, setCostTab] = useState("status");
  const [costRange, setCostRange] = useState({ start: "", end: "" });
  const [costCategoryName, setCostCategoryName] = useState("");
  const [costForm, setCostForm] = useState({
    categoryId: firstCostCategory?.id ? String(firstCostCategory.id) : "",
    costName: "",
    quantity: "1",
    amount: "",
    paymentMethod: "cash",
    responsiblePerson: "",
    note: ""
  });

  useEffect(() => {
    if (!costForm.categoryId && activeCostCategories[0]) setCostForm((current) => ({ ...current, categoryId: String(activeCostCategories[0].id) }));
  }, [snapshot]);

  async function addCost() {
    await window.yamzo?.inventory.addCost({
      categoryId: costForm.categoryId ? Number(costForm.categoryId) : null,
      costName: costForm.costName,
      quantity: Number(costForm.quantity || 1),
      amount: Number(costForm.amount || 0),
      paymentMethod: costForm.paymentMethod,
      responsiblePerson: costForm.responsiblePerson || null,
      note: costForm.note || null
    });
    setCostForm({ ...costForm, costName: "", quantity: "1", amount: "", note: "" });
    setMessage("Cost record saved.");
    await refreshData();
  }

  async function addCostCategory() {
    if (!costCategoryName.trim()) return;
    await window.yamzo?.inventory.saveCostCategory({ name: costCategoryName.trim(), active: true, sortOrder: activeCostCategories.length });
    setCostCategoryName("");
    setMessage("Cost category saved.");
    await refreshData();
  }

  async function removeCostCategory(category: CostCategory) {
    if (!window.confirm(`Remove cost category ${category.name}?`)) return;
    await window.yamzo?.inventory.removeCostCategory(category.id);
    setMessage("Cost category removed.");
    await refreshData();
  }

  async function reorderCostCategories(categories: CostCategory[]) {
    await Promise.all(categories.map((category, index) => window.yamzo?.inventory.saveCostCategory({ id: category.id, name: category.name, active: true, sortOrder: index })));
    setMessage("Cost category order saved.");
    await refreshData();
  }

  function applyCostPreset(preset: "today" | "yesterday" | "7days" | "1month") {
    const today = startOfLocalDay(new Date());
    const start = new Date(today);
    const end = new Date(today);
    if (preset === "yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    }
    if (preset === "7days") start.setDate(start.getDate() - 6);
    if (preset === "1month") start.setMonth(start.getMonth() - 1);
    setCostRange({ start: dateInputValue(start), end: dateInputValue(end) });
  }

  const costRows = snapshot.costRecords
    .filter((entry) => withinDateRange(entry.costDate, costRange))
    .map((entry) => [formatDate(entry.costDate), entry.categoryName ?? "Other", entry.costName, formatQuantity(entry.quantity), money(entry.amount), entry.responsiblePerson ?? "-", entry.note ?? "-"]);

  return (
    <div className="grid gap-4 pt-4">
      <Tabs value={costTab} onValueChange={setCostTab}>
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="status" className="grid gap-4 pt-4">
          <Card>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
              <Field label="Category"><Select value={costForm.categoryId} onValueChange={(value) => setCostForm({ ...costForm, categoryId: value })}><SelectTrigger><SelectValue placeholder="Choose category" /></SelectTrigger><SelectContent>{activeCostCategories.map((category) => <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Cost name"><Input value={costForm.costName} onChange={(event) => setCostForm({ ...costForm, costName: event.target.value })} /></Field>
              <Field label="Qty"><Input value={costForm.quantity} onChange={(event) => setCostForm({ ...costForm, quantity: event.target.value })} /></Field>
              <Field label="Amount"><Input value={costForm.amount} onChange={(event) => setCostForm({ ...costForm, amount: event.target.value })} /></Field>
              <Field label="Payment method"><Input value={costForm.paymentMethod} onChange={(event) => setCostForm({ ...costForm, paymentMethod: event.target.value })} /></Field>
              <Field label="Person responsible"><Input value={costForm.responsiblePerson} onChange={(event) => setCostForm({ ...costForm, responsiblePerson: event.target.value })} /></Field>
              <Field label="Note"><Input value={costForm.note} onChange={(event) => setCostForm({ ...costForm, note: event.target.value })} /></Field>
              <Button className="self-end" onClick={addCost}>Add Cost Record</Button>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-3 p-4">
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => applyCostPreset("today")}>Today</Button>
                <Button variant="secondary" size="sm" onClick={() => applyCostPreset("yesterday")}>Yesterday</Button>
                <Button variant="secondary" size="sm" onClick={() => applyCostPreset("7days")}>7 Days</Button>
                <Button variant="secondary" size="sm" onClick={() => applyCostPreset("1month")}>1 Month</Button>
                <Button variant="secondary" size="sm" onClick={() => exportCsvRows("yamzo-costs.csv", [["Date", "Category", "Cost", "Qty", "Amount", "Person", "Note"], ...costRows])}>Export CSV</Button>
              </div>
              <DateRangeControl value={costRange} onChange={setCostRange} />
              <InventoryTable headers={["Date", "Category", "Cost", "Qty", "Amount", "Person", "Note"]} rows={costRows} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <Card>
            <CardHeader><CardTitle>Cost Categories</CardTitle><CardDescription>Used when recording quick restaurant costs.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid grid-cols-[1fr_auto] gap-2"><Input value={costCategoryName} onChange={(event) => setCostCategoryName(event.target.value)} placeholder="Example: Marketing" /><Button onClick={addCostCategory} disabled={!costCategoryName.trim()}>Add Category</Button></div>
              <EditableSettingList
                items={activeCostCategories}
                onSave={(item, name) => window.yamzo?.inventory.saveCostCategory({ id: item.id, name, active: true, sortOrder: item.sortOrder ?? 0 }).then(refreshData)}
                onRemove={removeCostCategory}
                onReorder={reorderCostCategories}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InventoryTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="rounded-xl border bg-card">
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No records yet.</p>
      ) : (
        <div className="overflow-auto">
          <Table className="min-w-[760px]">
            <TableHeader><TableRow>{headers.map((header) => <TableHead key={header}>{header}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={`${row.join("-")}-${rowIndex}`}>{row.map((cell, cellIndex) => <TableCell key={`${cell}-${cellIndex}`}>{cell}</TableCell>)}</TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function MenuAdmin({
  menu,
  categories,
  categoryDraft,
  setCategoryDraft,
  saveCategories,
  menuData,
  setMenuData,
  saveMenuData,
  menuTypes,
  setMenuTypes,
  saveMenuTypes,
  totalTables,
  setTotalTables,
  saveTableSettings,
  menuForm,
  setMenuForm,
  saveMenuForm,
  importMenuCsv,
  downloadSampleCsv,
  refreshData,
  setMessage
}: {
  menu: MenuItem[];
  categories: string[];
  categoryDraft: string;
  setCategoryDraft: (value: string) => void;
  saveCategories: (categories: string[]) => void;
  menuData: MenuDataSetting[];
  setMenuData: (value: MenuDataSetting[]) => void;
  saveMenuData: (menuData?: MenuDataSetting[]) => Promise<void>;
  menuTypes: MenuTypeSetting[];
  setMenuTypes: (value: MenuTypeSetting[]) => void;
  saveMenuTypes: (menuTypes?: MenuTypeSetting[]) => void;
  totalTables: number;
  setTotalTables: (value: number) => void;
  saveTableSettings: (totalTables?: number) => void;
  menuForm: MenuFormState;
  setMenuForm: (value: MenuFormState) => void;
  saveMenuForm: () => void;
  importMenuCsv: () => void;
  downloadSampleCsv: () => void;
  refreshData: () => void;
  setMessage: (message: string) => void;
}) {
  const [dragCategory, setDragCategory] = useState<string | null>(null);
  const activeMenuData = menuData.filter((entry) => entry.active !== false);
  const [selectedMenuDataKey, setSelectedMenuDataKey] = useState(activeMenuData[0]?.key ?? "in_house");
  const [menuDataDraft, setMenuDataDraft] = useState("");
  const [menuSearch, setMenuSearch] = useState("");
  const selectedMenuData = activeMenuData.find((entry) => entry.key === selectedMenuDataKey) ?? activeMenuData[0] ?? defaultMenuData[0];

  useEffect(() => {
    if (!activeMenuData.some((entry) => entry.key === selectedMenuDataKey)) {
      setSelectedMenuDataKey(activeMenuData[0]?.key ?? "in_house");
    }
  }, [activeMenuData, selectedMenuDataKey]);

  function selectedMenuPrice(item: MenuItem): number {
    return item.menuPrices?.[selectedMenuData.key] ?? (selectedMenuData.key === "in_house" ? item.price : 0);
  }

  const filteredMenu = menu.filter((item) => {
    const text = `${item.name} ${item.category ?? ""} ${item.available ? "available" : "unavailable"} ${item.trackRecipe ? "recipe" : ""}`.toLowerCase();
    return text.includes(menuSearch.trim().toLowerCase());
  });

  function menuFormSelectedPrice(): string {
    return menuForm.menuPrices[selectedMenuData.key] ?? (selectedMenuData.key === "in_house" ? menuForm.price : "");
  }

  function updateMenuFormPrice(value: string) {
    setMenuForm({
      ...menuForm,
      price: selectedMenuData.key === "in_house" || !menuForm.price ? value : menuForm.price,
      menuPrices: { ...menuForm.menuPrices, [selectedMenuData.key]: value }
    });
  }

  async function addMenuData() {
    const label = menuDataDraft.trim();
    if (!label) return;
    const key = uniqueMenuDataKey(label, menuData);
    const next = [...menuData, { key, label, active: true }];
    setMenuData(next);
    setMenuDataDraft("");
    await saveMenuData(next);
  }

  async function duplicateSelectedMenuData() {
    const label = menuDataDraft.trim() || `${selectedMenuData.label} Copy`;
    const key = uniqueMenuDataKey(label, menuData);
    const next = [...menuData, { key, label, active: true }];
    await saveMenuData(next);
    for (const item of menu) {
      const copyPrice = selectedMenuPrice(item);
      if (copyPrice <= 0) continue;
      await window.yamzo?.menu.saveItem({
        id: item.id,
        name: item.name,
        price: item.price,
        category: item.category,
        trackRecipe: item.trackRecipe,
        available: item.available,
        menuPrices: { ...(item.menuPrices ?? {}), [key]: copyPrice }
      });
    }
    setSelectedMenuDataKey(key);
    setMenuDataDraft("");
    setMessage(`Menu data duplicated: ${label}`);
    await refreshData();
  }

  async function hideSelectedMenuData() {
    if (activeMenuData.length <= 1) return;
    if (!window.confirm(`Hide ${selectedMenuData.label}? Existing item prices will be kept for future use.`)) return;
    const next = menuData.map((entry) => entry.key === selectedMenuData.key ? { ...entry, active: false } : entry);
    await saveMenuData(next);
  }

  function moveCategory(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= categories.length) return;
    const next = [...categories];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    saveCategories(next);
  }

  function dropCategory(targetCategory: string) {
    if (!dragCategory || dragCategory === targetCategory) {
      setDragCategory(null);
      return;
    }
    const next = [...categories];
    const from = next.indexOf(dragCategory);
    const to = next.indexOf(targetCategory);
    if (from < 0 || to < 0) {
      setDragCategory(null);
      return;
    }
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    saveCategories(next);
    setDragCategory(null);
  }

  return (
    <div className="grid gap-4 pt-4">
      <Tabs defaultValue="items">
        <TabsList className="grid w-full max-w-xl grid-cols-2">
          <TabsTrigger value="items">Menu Items</TabsTrigger>
          <TabsTrigger value="settings">Menu Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="items" className="grid gap-4 pt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Menu Data</CardTitle>
              <CardDescription>Choose which catalog you are editing. Menu Types in settings decide where each catalog is used.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 p-4 pt-0">
              <div className="grid gap-3 xl:grid-cols-[260px_minmax(260px,1fr)_auto_auto] xl:items-end">
                <Field label="Editing catalog">
                  <Select value={selectedMenuData.key} onValueChange={setSelectedMenuDataKey}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{activeMenuData.map((entry) => <SelectItem key={entry.key} value={entry.key}>{entry.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label="New / duplicate catalog name"><Input value={menuDataDraft} onChange={(event) => setMenuDataDraft(event.target.value)} placeholder="Example: Parcel Menu" /></Field>
                <Button variant="secondary" onClick={addMenuData} disabled={!menuDataDraft.trim()}>Add Catalog</Button>
                <Button variant="secondary" onClick={duplicateSelectedMenuData}>Duplicate Selected</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={importMenuCsv}>Import CSV</Button>
                <Button variant="secondary" onClick={downloadSampleCsv}>Download sample CSV format</Button>
                <Button variant="secondary" disabled={activeMenuData.length <= 1} onClick={hideSelectedMenuData}>Hide Selected Catalog</Button>
              </div>
            </CardContent>
          </Card>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Field label={`Search ${selectedMenuData.label}`}><Input value={menuSearch} onChange={(event) => setMenuSearch(event.target.value)} placeholder="Search item, category, availability, or recipe status" /></Field>
            <Badge variant="secondary">{filteredMenu.length} visible items</Badge>
          </div>
          <Card>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
              <Field label="Item name"><Input value={menuForm.name} onChange={(event) => setMenuForm({ ...menuForm, name: event.target.value })} /></Field>
              <Field label={`Price in ${selectedMenuData.label}`}><Input value={menuFormSelectedPrice()} onChange={(event) => updateMenuFormPrice(event.target.value)} placeholder="Leave blank to hide from this menu" /></Field>
              <Field label="Category">
                <Select value={menuForm.category || "Other"} onValueChange={(value) => setMenuForm({ ...menuForm, category: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <label className="flex items-center gap-2 self-end"><Checkbox checked={menuForm.available} onCheckedChange={(checked) => setMenuForm({ ...menuForm, available: Boolean(checked) })} />Available</label>
              <label className="flex items-center gap-2 self-end"><Checkbox checked={menuForm.trackRecipe} onCheckedChange={(checked) => setMenuForm({ ...menuForm, trackRecipe: Boolean(checked) })} />Track recipe</label>
              <Button className="self-end" onClick={saveMenuForm}>{menuForm.id ? "Save Item" : "Add Item"}</Button>
            </CardContent>
          </Card>
          <div className="grid gap-2">
            {filteredMenu.map((item) => <MenuAdminRow key={item.id} item={item} categories={categories} selectedMenuData={selectedMenuData} onEdit={setMenuForm} onDone={refreshData} />)}
          </div>
          {filteredMenu.length === 0 && <EmptyState title="No menu items found" description="Try a different item name, category, availability, or recipe search." />}
        </TabsContent>
        <TabsContent value="settings" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Table Numbers</CardTitle><CardDescription>Used by menu types where table selection is enabled.</CardDescription></CardHeader>
            <CardContent className="grid max-w-md grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Total tables"><Input type="number" min="1" max="200" value={totalTables} onChange={(event) => setTotalTables(Number(event.target.value || 10))} /></Field>
              <Button onClick={() => saveTableSettings(totalTables)}>Save Tables</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Menu Types</CardTitle><CardDescription>These become the order type buttons. Enable tables only for dine-in style types.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-2">
                {menuTypes.map((type, index) => (
                  <div key={`${type.key}-${index}`} className="grid gap-2 rounded-lg border bg-white p-3 lg:grid-cols-[1fr_180px_120px_150px_130px_auto] lg:items-center">
                    <Field label="Name"><Input value={type.label} onChange={(event) => setMenuTypes(menuTypes.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value, key: item.key || slugLocal(event.target.value) } : item))} /></Field>
                    <Field label="Uses menu data">
                      <Select value={type.menuDataKey || "in_house"} onValueChange={(value) => setMenuTypes(menuTypes.map((item, itemIndex) => itemIndex === index ? { ...item, menuDataKey: value } : item))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{activeMenuData.map((entry) => <SelectItem key={entry.key} value={entry.key}>{entry.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field label="Commission %"><Input value={String(type.commissionPercent ?? 0)} onChange={(event) => setMenuTypes(menuTypes.map((item, itemIndex) => itemIndex === index ? { ...item, commissionPercent: Number(event.target.value || 0) } : item))} /></Field>
                    <label className="flex items-center gap-2"><Checkbox checked={type.tablesEnabled} onCheckedChange={(checked) => setMenuTypes(menuTypes.map((item, itemIndex) => itemIndex === index ? { ...item, tablesEnabled: Boolean(checked) } : item))} />Enable tables</label>
                    <label className="flex items-center gap-2"><Checkbox checked={type.active !== false} onCheckedChange={(checked) => setMenuTypes(menuTypes.map((item, itemIndex) => itemIndex === index ? { ...item, active: Boolean(checked) } : item))} />Active</label>
                    <Button variant="destructive" disabled={menuTypes.length === 1} onClick={() => setMenuTypes(menuTypes.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setMenuTypes([...menuTypes, { key: `type_${Date.now()}`, label: "New Type", menuDataKey: selectedMenuData.key, tablesEnabled: false, commissionPercent: 0, active: true }])}>Add Menu Type</Button>
                <Button onClick={() => saveMenuTypes(menuTypes)}>Save Menu Types</Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Menu Categories</CardTitle><CardDescription>Categories become sections in New Order and dropdown choices for menu items.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)} placeholder="Example: Sauce" />
                <Button variant="secondary" disabled={!categoryDraft.trim()} onClick={() => saveCategories([...categories, categoryDraft])}>Add Category</Button>
              </div>
              <div className="grid gap-2">
                {categories.map((category, index) => (
                  <div
                    className={`grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-lg border bg-white px-3 py-2 transition ${dragCategory === category ? "border-primary bg-primary/5 shadow-sm" : ""}`}
                    draggable
                    key={category}
                    onDragStart={() => setDragCategory(category)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => dropCategory(category)}
                    onDragEnd={() => setDragCategory(null)}
                  >
                    <span className="cursor-grab select-none text-muted-foreground" title="Drag to reorder">::</span>
                    <span className="min-w-0 truncate font-medium">{category}</span>
                    <Button variant="secondary" size="sm" disabled={index === 0} onClick={() => moveCategory(index, -1)}>Up</Button>
                    <Button variant="secondary" size="sm" disabled={index === categories.length - 1} onClick={() => moveCategory(index, 1)}>Down</Button>
                    <Button variant="secondary" size="sm" disabled={categories.length === 1} onClick={() => saveCategories(categories.filter((item) => item !== category))}>Remove</Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MenuAdminRow({
  item,
  categories,
  selectedMenuData,
  onEdit: _onEdit,
  onDone
}: {
  item: MenuItem;
  categories: string[];
  selectedMenuData: MenuDataSetting;
  onEdit: (value: MenuFormState) => void;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MenuFormState>({
    id: item.id,
    name: item.name,
    price: String(item.price),
    category: item.category ?? "",
    available: item.available,
    trackRecipe: item.trackRecipe,
    menuPrices: Object.fromEntries(Object.entries(item.menuPrices ?? { in_house: item.price }).map(([key, value]) => [key, String(value)]))
  });

  useEffect(() => {
    setDraft({
      id: item.id,
      name: item.name,
      price: String(item.price),
      category: item.category ?? "",
      available: item.available,
      trackRecipe: item.trackRecipe,
      menuPrices: Object.fromEntries(Object.entries(item.menuPrices ?? { in_house: item.price }).map(([key, value]) => [key, String(value)]))
    });
  }, [item]);

  const selectedPrice = draft.menuPrices[selectedMenuData.key] ?? (selectedMenuData.key === "in_house" ? draft.price : "");
  const displayPrice = item.menuPrices?.[selectedMenuData.key] ?? (selectedMenuData.key === "in_house" ? item.price : 0);

  async function saveInline() {
    const menuPrices = Object.fromEntries(Object.entries(draft.menuPrices).map(([key, value]) => [key, Number(value || 0)]));
    const basePrice = Number(draft.price || draft.menuPrices.in_house || selectedPrice || item.price || 0);
    await window.yamzo?.menu.saveItem({ id: item.id, name: draft.name, price: basePrice, category: draft.category || null, available: draft.available, trackRecipe: draft.trackRecipe, menuPrices });
    setEditing(false);
    await onDone();
  }
  if (editing) {
    return (
      <Card size="sm">
        <CardContent className="grid gap-3 p-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] items-end gap-3">
            <Field label="Item"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
            <Field label={`Price in ${selectedMenuData.label}`}>
              <Input
                value={selectedPrice}
                onChange={(event) => {
                  const nextPrices = { ...draft.menuPrices, [selectedMenuData.key]: event.target.value };
                  setDraft({ ...draft, menuPrices: nextPrices, price: selectedMenuData.key === "in_house" ? event.target.value : draft.price });
                }}
                placeholder="Leave blank to hide"
              />
            </Field>
            <Field label="Category"><Select value={draft.category || "Other"} onValueChange={(value) => setDraft({ ...draft, category: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></Field>
            <label className="flex h-10 items-center gap-2"><Checkbox checked={draft.available} onCheckedChange={(checked) => setDraft({ ...draft, available: Boolean(checked) })} />Available</label>
            <label className="flex h-10 items-center gap-2"><Checkbox checked={draft.trackRecipe} onCheckedChange={(checked) => setDraft({ ...draft, trackRecipe: Boolean(checked) })} />Track recipe</label>
          </div>
          <div className="flex justify-end gap-2"><Button onClick={saveInline}>Save</Button><Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button></div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card size="sm">
      <CardContent className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 p-3">
        <div className="min-w-0">
          <strong>{item.name}</strong>
          <p className="text-sm text-muted-foreground">
            {item.category || "Menu"} | {displayPrice > 0 ? `${money(displayPrice)} in ${selectedMenuData.label}` : `Hidden from ${selectedMenuData.label}`} | {item.available ? "Available" : "Unavailable"} | {item.trackRecipe ? "Tracks recipe" : "No recipe tracking"}
          </p>
        </div>
        <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
        <Button variant="secondary" onClick={async () => { await window.yamzo?.menu.archiveItem(item.id); await onDone(); }}>Archive</Button>
        <Button variant="destructive" onClick={async () => { await window.yamzo?.menu.deleteItem(item.id); await onDone(); }}>Delete</Button>
      </CardContent>
    </Card>
  );
}

function ReceiptAdmin({ branding, setBranding, chooseReceiptImage, setMessage }: { branding: BrandingSettings; setBranding: React.Dispatch<React.SetStateAction<BrandingSettings>>; chooseReceiptImage: (type: "logoPath" | "qrPath") => void; setMessage: (message: string) => void }) {
  return (
    <div className="grid grid-cols-[minmax(280px,420px)_1fr] gap-4 pt-4">
      <Card>
        <CardContent className="grid gap-3 p-4">
          <Button variant="secondary" onClick={() => chooseReceiptImage("logoPath")}>Upload Logo</Button>
          <FileName label="Logo" path={branding.logoPath} />
          <Button variant="secondary" onClick={() => chooseReceiptImage("qrPath")}>Upload QR Code</Button>
          <FileName label="QR code" path={branding.qrPath} />
          <Field label="Restaurant name"><Input value={branding.restaurantName} onChange={(event) => setBranding({ ...branding, restaurantName: event.target.value })} /></Field>
          <Field label="Address"><Input value={branding.address} onChange={(event) => setBranding({ ...branding, address: event.target.value })} /></Field>
          <Field label="Phone"><Input value={branding.phone} onChange={(event) => setBranding({ ...branding, phone: event.target.value })} /></Field>
          <Field label="Email"><Input value={branding.emailWebsiteSocial} onChange={(event) => setBranding({ ...branding, emailWebsiteSocial: event.target.value })} /></Field>
          <Field label="Footer message"><Input value={branding.footerMessage} onChange={(event) => setBranding({ ...branding, footerMessage: event.target.value })} /></Field>
          <Button onClick={async () => { await window.yamzo?.settings.setBranding(branding); setMessage("Receipt settings saved."); }}>Save Receipt Settings</Button>
          <Button variant="secondary" onClick={() => window.yamzo?.print.sample("receipt")}>Print test receipt</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Preview receipt</CardTitle></CardHeader>
        <CardContent><pre className="whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm">{receiptPreview(branding)}</pre></CardContent>
      </Card>
    </div>
  );
}

function PrinterAdmin({ selectedPrinter, setSelectedPrinter, printers, failedPrintJobs, refreshData, setMessage }: { selectedPrinter: string; setSelectedPrinter: (value: string) => void; printers: PrinterOption[]; failedPrintJobs: PrintJob[]; refreshData: () => void; setMessage: (message: string) => void }) {
  async function sample(type: "test" | "kot" | "receipt") {
    if (!window.yamzo) return;
    const printed = await window.yamzo.print.sample(type);
    setMessage(printed ? `${samplePrintLabel(type)} sent to printer.` : `${samplePrintLabel(type)} saved, but printing failed.`);
    await refreshData();
  }

  return <div className="grid gap-4 pt-4"><Card><CardContent className="grid grid-cols-[minmax(280px,420px)_1fr] gap-4 p-4"><Field label="Selected printer"><Select value={selectedPrinter || "none"} onValueChange={(value) => setSelectedPrinter(value === "none" ? "" : value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Choose a printer</SelectItem>{printers.map((printer) => <SelectItem key={printer.name} value={printer.name}>{printer.displayName || printer.name}{printer.isDefault ? " (Windows default)" : ""}</SelectItem>)}</SelectContent></Select></Field><div className="grid grid-cols-2 gap-2 self-end xl:grid-cols-4"><Button onClick={async () => { await window.yamzo?.settings.setPrinterName(selectedPrinter); setMessage(selectedPrinter ? "Printer settings saved." : "Choose a printer before printing."); }}>Save Printer</Button><Button variant="secondary" disabled={!selectedPrinter} onClick={() => sample("test")}>Test Print</Button><Button variant="secondary" disabled={!selectedPrinter} onClick={() => sample("kot")}>Sample Kitchen Copy</Button><Button variant="secondary" disabled={!selectedPrinter} onClick={() => sample("receipt")}>Sample Receipt</Button></div></CardContent></Card><Card><CardHeader><CardTitle>Failed print jobs</CardTitle></CardHeader><CardContent className="grid gap-2">{failedPrintJobs.length === 0 && <p className="text-sm text-muted-foreground">No failed print jobs.</p>}{failedPrintJobs.map((job) => <div className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-lg border p-3" key={job.id}><div><strong>{friendlyPrintType(job.type)}</strong><p className="text-sm text-muted-foreground">{job.errorMessage || "Needs attention"} | {formatDate(job.createdAt)}</p></div><Button variant="secondary" onClick={async () => { await window.yamzo?.print.retryJob(job.id); await refreshData(); }}>Retry</Button></div>)}</CardContent></Card></div>;
}

function samplePrintLabel(type: "test" | "kot" | "receipt"): string {
  return type === "kot" ? "Sample Kitchen Copy" : type === "receipt" ? "Sample Receipt" : "Test Print";
}

function EmailAdmin({ emailSettings, setEmailSettings, emailPreview, setEmailPreview, showEmailAdvanced, setShowEmailAdvanced, setMessage }: { emailSettings: EmailSettings; setEmailSettings: React.Dispatch<React.SetStateAction<EmailSettings>>; emailPreview: string; setEmailPreview: (value: string) => void; showEmailAdvanced: boolean; setShowEmailAdvanced: (value: boolean) => void; setMessage: (message: string) => void }) {
  return <div className="grid grid-cols-[minmax(280px,520px)_1fr] gap-4 pt-4"><Card><CardContent className="grid gap-3 p-4"><label className="flex items-center gap-2"><Checkbox checked={emailSettings.enabled} onCheckedChange={(checked) => setEmailSettings({ ...emailSettings, enabled: Boolean(checked) })} />Enable daily sales email</label><Field label="Recipient email"><Input value={emailSettings.recipientEmail} onChange={(event) => setEmailSettings({ ...emailSettings, recipientEmail: event.target.value })} /></Field><p className="text-sm text-muted-foreground">Gmail connection status: {emailSettings.tokenPath ? "Connected" : "Not connected"}</p><div className="flex flex-wrap gap-2"><Button onClick={async () => { await window.yamzo?.email.saveSettings(emailSettings); setMessage("Email notification settings saved."); }}>Save Email Settings</Button><Button variant="secondary" onClick={async () => { await window.yamzo?.email.sendDaily(); setMessage("Test email requested."); }}>Send test email</Button><Button variant="secondary" onClick={async () => setEmailPreview((await window.yamzo?.email.dailyPreview()) ?? "")}>Preview daily sales email</Button><Button variant="destructive" onClick={async () => { if (window.confirm("Clear the saved Gmail connection?")) await window.yamzo?.email.clearAuth(); }}>Clear Gmail connection</Button></div><Button variant="link" className="w-fit px-0" onClick={() => setShowEmailAdvanced(!showEmailAdvanced)}>Advanced setup</Button>{showEmailAdvanced && <div className="grid gap-3 rounded-lg border bg-muted/30 p-3"><Field label="Google credentials file"><Input value={emailSettings.credentialPath} onChange={(event) => setEmailSettings({ ...emailSettings, credentialPath: event.target.value })} /></Field><Field label="Google connection file"><Input value={emailSettings.tokenPath} onChange={(event) => setEmailSettings({ ...emailSettings, tokenPath: event.target.value })} /></Field></div>}</CardContent></Card>{emailPreview && <Card><CardHeader><CardTitle>Email preview</CardTitle></CardHeader><CardContent><pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm">{emailPreview}</pre></CardContent></Card>}</div>;
}

function AppSettings({
  trackInventory,
  setTrackInventory,
  saveAppSettings,
  hostNames,
  hostDraft,
  setHostDraft,
  saveHostNames
}: {
  trackInventory: boolean;
  setTrackInventory: (value: boolean) => void;
  saveAppSettings: () => void;
  hostNames: string[];
  hostDraft: string;
  setHostDraft: (value: string) => void;
  saveHostNames: (hostNames: string[]) => void;
}) {
  return (
    <div className="grid max-w-2xl gap-3 pt-4">
      <Card>
        <CardContent className="grid gap-4 p-4">
          <label className="flex items-start gap-3">
            <Checkbox checked={trackInventory} onCheckedChange={(checked) => setTrackInventory(Boolean(checked))} />
            <span className="grid gap-1"><strong>Track Inventory</strong><small className="text-muted-foreground">Inventory tracking is reserved for a future update.</small></span>
          </label>
          <Button onClick={saveAppSettings}>Save App Settings</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Host Names</CardTitle>
          <CardDescription>These names appear in the order host dropdown and on receipts.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input value={hostDraft} onChange={(event) => setHostDraft(event.target.value)} placeholder="Example: Cashier 2" />
            <Button variant="secondary" onClick={() => saveHostNames([...hostNames, hostDraft])} disabled={!hostDraft.trim()}>Add Host</Button>
          </div>
          <div className="grid gap-2">
            {hostNames.map((host) => (
              <div className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-lg border bg-white px-3 py-2" key={host}>
                <span className="font-medium">{host}</span>
                <Button variant="secondary" size="sm" disabled={hostNames.length === 1} onClick={() => saveHostNames(hostNames.filter((item) => item !== host))}>Remove</Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AdminSettings({ username, passwordForm, setPasswordForm, setMessage }: { username: string; passwordForm: { current: string; next: string; confirm: string }; setPasswordForm: React.Dispatch<React.SetStateAction<{ current: string; next: string; confirm: string }>>; setMessage: (message: string) => void }) {
  async function savePassword() {
    if (passwordForm.next !== passwordForm.confirm) {
      setMessage("New password and confirmation do not match.");
      return;
    }
    const changed = await window.yamzo?.auth.changePassword(username, passwordForm.current, passwordForm.next);
    setMessage(changed ? "Admin password changed." : "Current password was incorrect.");
    if (changed) setPasswordForm({ current: "", next: "", confirm: "" });
  }
  return (
    <div className="grid max-w-2xl gap-3 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>Admin Password</CardTitle>
          <CardDescription>Use the master key only for password recovery.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field label="Current password"><Input type="password" value={passwordForm.current} onChange={(event) => setPasswordForm({ ...passwordForm, current: event.target.value })} /></Field>
          <Field label="New password"><Input type="password" value={passwordForm.next} onChange={(event) => setPasswordForm({ ...passwordForm, next: event.target.value })} /></Field>
          <Field label="Confirm new password"><Input type="password" value={passwordForm.confirm} onChange={(event) => setPasswordForm({ ...passwordForm, confirm: event.target.value })} /></Field>
          <Button onClick={savePassword}>Change Password</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ActivityLogAdmin({ logs, refreshData }: { logs: ActivityLog[]; refreshData: () => void }) {
  return (
    <div className="grid gap-3 pt-4">
      <Card>
        <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-3">
          <div>
            <CardTitle>Activity Log</CardTitle>
            <CardDescription>Important admin, order, and protected-screen activity for later audit.</CardDescription>
          </div>
          <Button variant="secondary" onClick={refreshData}>Refresh</Button>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-white">
              <div className="grid grid-cols-[160px_120px_150px_minmax(0,1fr)] gap-3 border-b bg-muted/50 px-4 py-3 text-sm font-semibold">
                <span>Time</span>
                <span>Status</span>
                <span>Staff</span>
                <span>Activity</span>
              </div>
              <div className="max-h-[520px] overflow-auto">
                {logs.map((log) => (
                  <div className="grid grid-cols-[160px_120px_150px_minmax(0,1fr)] gap-3 border-b px-4 py-3 text-sm last:border-b-0" key={log.id}>
                    <span className="text-muted-foreground">{formatDate(log.createdAt)}</span>
                    <span><Badge variant={activityBadgeVariant(log.status)}>{activityStatusLabel(log.status)}</Badge></span>
                    <span className="font-medium">{log.actor || "System"}</span>
                    <span className="min-w-0">
                      <strong className="block">{log.title}</strong>
                      <span className="block text-muted-foreground">{log.description}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FileName({ label, path }: { label: string; path?: string }) {
  const name = path ? path.split(/[\\/]/).pop() : "";
  return <p className="text-sm text-muted-foreground">{label}: {name || "Not selected"}</p>;
}

function receiptPreview(branding: BrandingSettings): string {
  return [
    branding.showLogo ? "[Yamzo logo]" : "",
    branding.restaurantName || "Yamzo",
    branding.address,
    branding.phone,
    branding.emailWebsiteSocial ? `Email: ${branding.emailWebsiteSocial}` : "",
    "",
    "Sample Receipt",
    "1 x Sample Item    100 TK",
    "Total              100 TK",
    "",
    branding.footerMessage,
    branding.showQr ? "Please drop a like on our socials" : "",
    branding.showQr ? "[Review QR]" : "",
    branding.showQr ? "@yamzo.uttara" : ""
  ].filter(Boolean).join("\n");
}

function friendlyPrintType(type: PrintJob["type"]): string {
  const labels: Record<PrintJob["type"], string> = { kot: "Kitchen copy", kot_reprint: "Kitchen copy reprint", addition_kot: "Additional kitchen copy", void_kot: "Removed item notice", parcel_slip: "Parcel slip", bill: "Bill copy", audit: "Audit copy", receipt: "Receipt", receipt_reprint: "Receipt reprint", test: "Printer test" };
  return labels[type];
}

function activityBadgeVariant(status: ActivityLog["status"]): "default" | "destructive" | "secondary" {
  if (status === "failed") return "destructive";
  if (status === "success") return "default";
  return "secondary";
}

function activityStatusLabel(status: ActivityLog["status"]): string {
  return status === "failed" ? "Needs review" : status === "success" ? "Completed" : "Recorded";
}

function externalSales(summary: SalesSummary): string {
  const count = ["foodpanda", "foodie", "other"].reduce((sum, key) => sum + (summary.sourceBreakdown[key] ?? 0), 0);
  return `${count} orders`;
}

function formatSource(source: OrderSource): string {
  if (source === "in_house") return "Dine-in";
  return labelize(source);
}

function orderDisplayName(order: Pick<OrderSummary, "source" | "tableNumber">): string {
  if (order.source === "in_house" && order.tableNumber) {
    return `Dine-in - ${order.tableNumber}`;
  }
  return formatSource(order.source);
}

function kitchenElapsed(order: Pick<OrderSummary, "kitchenStartedAt" | "kitchenCompletedAt">): string {
  if (!order.kitchenStartedAt) return "--";
  return elapsedBetween(order.kitchenStartedAt, order.kitchenCompletedAt ?? undefined);
}

function elapsedBetween(start: string, end?: string): string {
  const startTime = parseSqliteTimestamp(start).getTime();
  const endTime = end ? parseSqliteTimestamp(end).getTime() : Date.now();
  const elapsedMs = endTime - startTime;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "--";
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string): string {
  return parseSqliteTimestamp(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function parseSqliteTimestamp(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(" ", "T")}Z`);
  }
  return new Date(value);
}

function money(value: number): string {
  return `${Math.round(value)} TK`;
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportCsvRows(filename: string, rows: string[][]) {
  downloadTextFile(filename, rows.map((line) => line.map(csvCell).join(",")).join("\n"));
}

function withinDateRange(value: string, range: { start: string; end: string }): boolean {
  if (!range.start && !range.end) return true;
  const date = parseSqliteTimestamp(value);
  if (Number.isNaN(date.getTime())) return true;
  if (range.start) {
    const start = new Date(`${range.start}T00:00:00`);
    if (date < start) return false;
  }
  if (range.end) {
    const end = new Date(`${range.end}T23:59:59`);
    if (date > end) return false;
  }
  return true;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeStartForSql(value: string): string | undefined {
  return value ? `${value} 00:00:00` : undefined;
}

function rangeEndForSql(value: string): string | undefined {
  return value ? `${value} 23:59:59` : undefined;
}

function htmlTable(headers: string[], rows: string[][]): string {
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows.length
    ? rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
        .join("")
    : `<tr><td colspan="${headers.length}">No data.</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function safeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function slugLocal(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (["price", "dine in", "dine-in", "dinein", "in house", "in-house"].includes(lowered)) return "in_house";
  return lowered.replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "other";
}

function uniqueMenuDataKey(label: string, existing: MenuDataSetting[]): string {
  const base = slugLocal(label);
  const used = new Set(existing.map((entry) => entry.key));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function menuItemPrice(item: MenuItem, source: string, menuTypes: MenuTypeSetting[]): number {
  const menuType = menuTypes.find((type) => type.key === source);
  const menuDataKey = menuType?.menuDataKey || source;
  if (menuDataKey === "in_house") return item.menuPrices?.in_house ?? item.price;
  return item.menuPrices?.[menuDataKey] ?? 0;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
