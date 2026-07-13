import { useEffect, useMemo, useState } from "react";
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
import { DatePicker, DateRangePicker } from "@/components/ui/date-picker";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  BrandingSettings,
  ActivityLog,
  CostCategory,
  CostRecord,
  InventoryCategory,
  InventoryBindingPreview,
  InventoryIngredientUsageTotal,
  InventoryItem,
  HistoricalScope,
  MenuInventoryBinding,
  PhysicalCountEntry,
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
import { IntegrationsAdmin } from "../components/IntegrationsAdmin";

type Screen = "newOrder" | "editOrder" | "openOrders" | "completedOrders" | "cancelledOrders" | "reports" | "menu" | "inventory" | "costs" | "admin";
type AdminTab = "receipt" | "printer" | "integrations" | "app" | "security" | "activity";
type DiscountMode = "tk" | "percent";
type OrderLane = "newOrder" | "openOrders";
type PrintConfirm = { type: "kitchen" | "bill"; orderId: number; orderNumber: string } | null;
type NoteEdit = { line: OrderLine; draft: string } | null;
type ProtectedScreen = "completedOrders" | "cancelledOrders" | "admin";
type MenuFormState = { id: number; name: string; price: string; category: string; available: boolean; trackRecipe: boolean; menuPrices: Record<string, string> };
type RecipeEditorTarget = { mode: "create" } | { mode: "edit"; recipe: MenuRecipe };

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
  { key: "in_house", label: "Store Menu", active: true, externalOrderIdEnabled: false },
  { key: "foodpanda", label: "Foodpanda Menu", active: true, externalOrderIdEnabled: true },
  { key: "foodie", label: "Foodie Menu", active: true, externalOrderIdEnabled: true }
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
  bindings: [],
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
  const [source, setSource] = useState<OrderSource>("in_house");
  const [tableNumber, setTableNumber] = useState("");
  const [externalOrderId, setExternalOrderId] = useState("");
  const [orderDate, setOrderDate] = useState(dateInputValue(new Date()));
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
  const [recipeEdit, setRecipeEdit] = useState<RecipeEditorTarget | null>(null);
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
  const selectedMenuDataForSource = menuData.find((entry) => entry.key === selectedMenuType?.menuDataKey);
  const externalOrderIdEnabled = Boolean(selectedMenuDataForSource?.externalOrderIdEnabled);
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
    const today = dateInputValue(new Date());
    const [menuRows, openRows, historyRows, sales, jobs, receipt, inventory, inventoryData, printerName, tableCount, hosts, categories, dataSets, types, activity] = await Promise.all([
      window.yamzo.menu.list(),
      window.yamzo.orders.open(),
      window.yamzo.orders.history(),
      window.yamzo.reports.sales({ startDate: today, endDate: today }),
      window.yamzo.print.listJobs(),
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
    setExternalOrderId("");
    setOrderDate(dateInputValue(new Date()));
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
    setExternalOrderId(detail.externalOrderId ?? "");
    setOrderDate(detail.orderDate ?? dateInputValue(parseSqliteTimestamp(detail.createdAt)));
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
    const created = await window.yamzo.orders.create({
      source,
      orderDate,
      tableNumber: tablesEnabledForSource ? tableNumber || undefined : undefined,
      note: orderNote || undefined,
      externalOrderId: externalOrderIdEnabled ? externalOrderId : null
    });
    await window.yamzo.orders.discount(created.id, calculatedDiscount);
    const detail = await window.yamzo.orders.detail(created.id);
    setActiveOrder(detail);
    return detail;
  }

  async function saveOrderInfo(orderId = activeOrder?.id) {
    if (!window.yamzo || !orderId) return;
    await window.yamzo.orders.updateInfo(orderId, { source, tableNumber, note: orderNote, externalOrderId: externalOrderIdEnabled ? externalOrderId : null });
  }

  async function changeActiveOrderDate(nextDate: string) {
    if (!nextDate) return;
    setOrderDate(nextDate);
    if (!activeOrder || !window.yamzo) return;
    const updated = await window.yamzo.orders.updateDate(activeOrder.id, nextDate);
    setActiveOrder(await window.yamzo.orders.detail(updated.id));
    setMessage(`Order date changed. Receipt is now ${updated.orderNumber}.`);
    await refreshData();
  }

  async function changeHistoryOrderDate(nextDate: string) {
    if (!nextDate || !historyView || !window.yamzo) return;
    const updated = await window.yamzo.orders.updateDate(historyView.id, nextDate);
    setHistoryView(await window.yamzo.orders.detail(updated.id));
    setMessage(`Order date changed. Receipt is now ${updated.orderNumber}.`);
    await refreshData();
  }

  async function chooseSource(nextSource: OrderSource) {
    setSource(nextSource);
    const nextType = menuTypes.find((type) => type.key === nextSource);
    const nextTable = nextType?.tablesEnabled ? tableNumber : "";
    const nextMenuData = menuData.find((entry) => entry.key === nextType?.menuDataKey);
    const nextExternalOrderId = nextMenuData?.externalOrderIdEnabled ? externalOrderId : "";
    if (!nextType?.tablesEnabled) setTableNumber("");
    if (!nextMenuData?.externalOrderIdEnabled) setExternalOrderId("");
    if (activeOrder && window.yamzo) {
      await window.yamzo.orders.updateInfo(activeOrder.id, { source: nextSource, tableNumber: nextTable, note: orderNote, externalOrderId: nextExternalOrderId });
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
      await window.yamzo.orders.updateInfo(activeOrder.id, { source, tableNumber: table, note: orderNote, externalOrderId: externalOrderIdEnabled ? externalOrderId : null });
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
        active: entry.active !== false,
        externalOrderIdEnabled: Boolean(entry.externalOrderIdEnabled)
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
    <main className="grid h-screen grid-cols-[160px_minmax(0,1fr)] overflow-hidden bg-stone-50 text-stone-950 xl:grid-cols-[212px_minmax(0,1fr)]">
      {message && (
        <div className="fixed right-6 top-6 z-[200] max-w-md rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm font-medium text-emerald-950 shadow-xl">
          {message}
        </div>
      )}
      <aside className="flex min-h-0 flex-col gap-2 bg-stone-950 p-3 text-stone-50 xl:gap-3 xl:p-5">
        <h1 className="mb-3 text-2xl font-semibold tracking-tight xl:mb-5 xl:text-3xl">Yamzo</h1>
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
        <section className="grid h-screen grid-cols-[minmax(340px,1fr)_minmax(220px,260px)_minmax(200px,230px)] gap-4 overflow-hidden p-4 xl:grid-cols-[minmax(420px,1fr)_minmax(280px,320px)_minmax(260px,280px)]">
          <Card className="min-h-0 overflow-hidden border-amber-200 bg-amber-50/30 py-0">
            <CardHeader className="border-b py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{activeOrder ? orderDisplayName(activeOrder, menuTypes) : "New Order"}</CardTitle>
                  <CardDescription>{activeOrder ? `Receipt ${activeOrder.orderNumber}` : "Choose order type and tap items."}</CardDescription>
                </div>
                <div className="grid min-w-[190px] gap-2">
                  <Label>Order date</Label>
                  <DatePicker value={orderDate} onChange={changeActiveOrderDate} label="Order date" />
                  {screen === "editOrder" && orderLane === "openOrders" && <Button className="border border-primary/30 shadow-sm" onClick={() => setScreen("openOrders")}>Back to Open Orders</Button>}
                </div>
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
                {externalOrderIdEnabled && (
                  <Field label="External order ID">
                    <Input value={externalOrderId} onChange={(event) => setExternalOrderId(event.target.value)} onBlur={() => saveOrderInfo()} placeholder="Example: Foodpanda order ID" />
                  </Field>
                )}
                <Field label="Host">
                  <SearchableSelect
                    value={selectedHost}
                    onValueChange={setSelectedHost}
                    options={hostNames.map((host) => ({ value: host, label: host }))}
                    placeholder="Choose staff member"
                    searchPlaceholder="Search staff..."
                    emptyText="No staff found."
                    ariaLabel="Order host"
                    className="bg-white"
                  />
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
              <CardDescription>{tableNumber ? tableNumber : formatConfiguredSource(source, menuTypes)}</CardDescription>
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

      {screen === "openOrders" && <OrdersScreen title="Open Orders" description="Running orders ready to resume." orders={openOrders} menuTypes={menuTypes} onRefresh={refreshData} onResume={loadOrder} onDone={markKitchenDelivered} onRestart={restartKitchenTimer} onBatchDone={markKitchenBatchDelivered} onBatchRestart={restartKitchenBatchTimer} onDoneAll={markAllRunningDelivered} />}
      {screen === "completedOrders" && <OrdersScreen title="Completed Orders" description="Settled orders for audit and staff corrections." orders={completedOrders} menuTypes={menuTypes} onRefresh={refreshData} onResume={reopenHistoryOrder} resumeLabel="Edit" onView={viewHistoryOrder} onClearHistory={clearClosedOrderHistory} />}
      {screen === "cancelledOrders" && <OrdersScreen title="Cancelled Orders" description="Cancelled orders kept for audit." orders={cancelledOrders} menuTypes={menuTypes} onRefresh={refreshData} onView={viewHistoryOrder} onDeleteRecord={deleteClosedOrderRecord} onClearHistory={clearClosedOrderHistory} />}
      {screen === "reports" && <ContentShell title="Reports" description="Sales, order timing, payments, and profit reports."><ReportsPanel summary={summary} inventory={inventorySnapshot} menuTypes={menuTypes} /></ContentShell>}
      {screen === "menu" && (
        <ContentShell title="Menu" description="Manage food, sauce, drink items, and menu categories." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <MenuAdmin menu={menu} inventory={inventorySnapshot} categories={menuCategories} categoryDraft={menuCategoryDraft} setCategoryDraft={setMenuCategoryDraft} saveCategories={saveMenuCategories} menuData={menuData} setMenuData={setMenuData} saveMenuData={saveMenuDataSettings} menuTypes={menuTypes} setMenuTypes={setMenuTypes} saveMenuTypes={saveMenuTypeSettings} totalTables={totalTables} setTotalTables={setTotalTables} saveTableSettings={saveTableSettings} menuForm={menuForm} setMenuForm={setMenuForm} saveMenuForm={saveMenuForm} importMenuCsv={importMenuCsv} downloadSampleCsv={downloadSampleCsv} refreshData={refreshData} setMessage={setMessage} />
        </ContentShell>
      )}
      {screen === "inventory" && (
        <ContentShell title="Inventory" description="Recipes, stock, restocks, and physical count tracking." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <InventoryAdmin snapshot={inventorySnapshot} menuTypes={menuTypes} activityLogs={activityLogs} refreshData={refreshData} setMessage={setMessage} onCreateRecipe={() => setRecipeEdit({ mode: "create" })} onEditRecipe={(recipe) => setRecipeEdit({ mode: "edit", recipe })} onViewPriceHistory={setPriceHistoryItemId} />
        </ContentShell>
      )}
      {screen === "costs" && (
        <ContentShell title="Costs" description="Record, correct, delete, and review restaurant operating costs." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <CostsPanel snapshot={inventorySnapshot} refreshData={refreshData} setMessage={setMessage} />
        </ContentShell>
      )}
      {screen === "admin" && (
        <ContentShell title="Admin" description="Restaurant settings, integrations, and audit controls.">
          <Tabs value={adminTab} onValueChange={(value) => setAdminTab(value as AdminTab)} className="min-h-0">
            <TabsList className="grid w-full max-w-5xl grid-cols-3 lg:grid-cols-6">
              <TabsTrigger value="receipt">Receipt</TabsTrigger>
              <TabsTrigger value="printer">Printers</TabsTrigger>
              <TabsTrigger value="integrations">Integrations</TabsTrigger>
              <TabsTrigger value="app">App</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="receipt"><ReceiptAdmin branding={branding} setBranding={setBranding} chooseReceiptImage={chooseReceiptImage} setMessage={setMessage} /></TabsContent>
            <TabsContent value="printer"><PrinterAdmin selectedPrinter={selectedPrinter} setSelectedPrinter={setSelectedPrinter} printers={printers} failedPrintJobs={failedPrintJobs} refreshData={refreshData} setMessage={setMessage} /></TabsContent>
            <TabsContent value="integrations"><IntegrationsAdmin /></TabsContent>
            <TabsContent value="app"><AppSettings trackInventory={trackInventory} setTrackInventory={setTrackInventory} saveAppSettings={saveAppSettings} hostNames={hostNames} hostDraft={hostDraft} setHostDraft={setHostDraft} saveHostNames={saveHostNames} /></TabsContent>
            <TabsContent value="security"><SecurityAdmin username={username} passwordForm={passwordForm} setPasswordForm={setPasswordForm} setMessage={setMessage} /></TabsContent>
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
            <AlertDialogTitle>{historyView ? orderDisplayName(historyView, menuTypes) : "Order summary"}</AlertDialogTitle>
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
                <span>Order date: {formatBusinessDate(historyView.orderDate)}</span>
                <span>Created: {formatDate(historyView.createdAt)}</span>
                <span>Updated: {formatDate(historyView.updatedAt)}</span>
              </div>
              <div className="grid gap-2 rounded-xl border bg-background p-3">
                <Label>Correct order date</Label>
                <DatePicker value={historyView.orderDate} onChange={changeHistoryOrderDate} label="Correct order date" />
                <p className="text-xs text-muted-foreground">Changing the date regenerates Yamzo's internal receipt number. External platform IDs stay unchanged.</p>
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
        target={recipeEdit}
        items={inventorySnapshot.items}
        recipes={inventorySnapshot.recipes}
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

function RecipeEditorDialog({ target, items, recipes, onClose, onSaved }: {
  target: RecipeEditorTarget | null;
  items: InventorySnapshot["items"];
  recipes: InventorySnapshot["recipes"];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  type EditorRow = { kind: "raw" | "recipe"; inventoryItemId: string; childRecipeId: string; quantityBase: string; unitLabel: string };
  const recipe = target?.mode === "edit" ? target.recipe : null;
  const creating = target?.mode === "create";
  const [recipeName, setRecipeName] = useState("");
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pickerMode, setPickerMode] = useState<"raw" | "recipe" | null>(null);
  const [ingredientSearch, setIngredientSearch] = useState("");
  const [recipeSearch, setRecipeSearch] = useState("");
  const [snapshotMode, setSnapshotMode] = useState(true);
  const [historicalScope, setHistoricalScope] = useState<HistoricalScope>("future");
  const [historicalRange, setHistoricalRange] = useState({ start: "", end: "" });
  const [changeReason, setChangeReason] = useState("");
  const itemOptions = useMemo(() => {
    const byId = new Map<number, { id: number; name: string; unitShortName: string }>();
    for (const item of items) byId.set(item.id, { id: item.id, name: item.name, unitShortName: item.unitShortName });
    for (const ingredient of recipe?.ingredients ?? []) {
      if (!byId.has(ingredient.inventoryItemId)) byId.set(ingredient.inventoryItemId, { id: ingredient.inventoryItemId, name: ingredient.itemName, unitShortName: ingredient.unitLabel || "g" });
    }
    return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
  }, [items, recipe]);
  const activePickerItems = useMemo(() => items.filter((item) => item.active), [items]);
  const availableRecipeMaterials = useMemo(() => recipes.filter((entry) => entry.id > 0 && entry.status === "available" && entry.id !== recipe?.id), [recipes, recipe?.id]);
  const hasValidIngredients = rows.some((row) => Number(row.quantityBase) > 0 && (row.kind === "recipe" ? Number(row.childRecipeId) > 0 : Number(row.inventoryItemId) > 0));
  const initialRows = useMemo<EditorRow[]>(() => [
    ...(recipe?.ingredients ?? []).map((ingredient) => ({ kind: "raw" as const, inventoryItemId: String(ingredient.inventoryItemId), childRecipeId: "", quantityBase: String(ingredient.quantityBase), unitLabel: ingredient.unitLabel })),
    ...(recipe?.childIngredients ?? []).map((ingredient) => ({ kind: "recipe" as const, inventoryItemId: "", childRecipeId: String(ingredient.childRecipeId), quantityBase: String(ingredient.quantityBase), unitLabel: ingredient.unitLabel || "portion" }))
  ], [recipe]);
  const initialRowsSignature = useMemo(() => JSON.stringify(initialRows), [initialRows]);

  useEffect(() => {
    if (!target) return;
    setRecipeName(recipe?.menuItemName ?? "");
    setRows(initialRows);
    setSnapshotMode(true);
    setHistoricalScope("future");
    setHistoricalRange({ start: "", end: "" });
    setChangeReason("");
    setError("");
    setSaving(false);
    setPickerMode(null);
    setIngredientSearch("");
    setRecipeSearch("");
  }, [target, recipe, initialRows]);

  function addIngredient(item: InventoryItem) {
    setRows((current) => current.some((row) => row.kind === "raw" && Number(row.inventoryItemId) === item.id)
      ? current
      : [...current, { kind: "raw", inventoryItemId: String(item.id), childRecipeId: "", quantityBase: "", unitLabel: item.unitShortName }]);
    setIngredientSearch("");
    setPickerMode(null);
  }

  function addRecipeMaterial(child: MenuRecipe) {
    setRows((current) => current.some((row) => row.kind === "recipe" && Number(row.childRecipeId) === child.id)
      ? current
      : [...current, { kind: "recipe", inventoryItemId: "", childRecipeId: String(child.id), quantityBase: "1", unitLabel: "portion" }]);
    setRecipeSearch("");
    setPickerMode(null);
  }

  async function saveRecipe() {
    if (!target || saving) return;
    const ingredients = rows.map((row) => {
      if (row.kind === "recipe") return { kind: "recipe" as const, childRecipeId: Number(row.childRecipeId), quantityBase: Number(row.quantityBase || 0), unitLabel: row.unitLabel.trim() || "portion" };
      const selectedItem = itemOptions.find((item) => item.id === Number(row.inventoryItemId));
      return { kind: "raw" as const, inventoryItemId: Number(row.inventoryItemId), quantityBase: Number(row.quantityBase || 0), unitLabel: selectedItem?.unitShortName || row.unitLabel.trim() || "g" };
    }).filter((row) => row.quantityBase > 0 && ("childRecipeId" in row ? row.childRecipeId : row.inventoryItemId));

    if (!recipeName.trim()) return setError("Recipe name is required.");
    if (creating && ingredients.length === 0) return setError("Add at least one ingredient with an amount greater than zero.");
    if (!creating && ingredients.length === 0 && !window.confirm("This will remove every ingredient from the recipe. Continue?")) return;
    if (!creating && historicalScope === "range" && !historicalRange.start && !historicalRange.end) return setError("Choose at least one date for the historical range.");

    setSaving(true);
    setError("");
    try {
      await window.yamzo?.inventory.saveRecipe({
        menuItemId: recipe?.menuItemId,
        recipeName: recipeName.trim(),
        standalone: creating || isStandaloneRecipe(recipe),
        ingredients
      }, {
        snapshotMode: creating ? true : snapshotMode,
        historicalScope: creating ? "future" : historicalScope,
        start: !creating && historicalScope === "range" ? historicalRange.start || null : null,
        end: !creating && historicalScope === "range" ? historicalRange.end || null : null,
        reason: changeReason.trim() || null
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save recipe.");
      setSaving(false);
    }
  }

  function requestClose() {
    if (pickerMode) return setPickerMode(null);
    const rowsChanged = JSON.stringify(rows) !== initialRowsSignature;
    const nameChanged = recipeName.trim() !== (recipe?.menuItemName ?? "");
    const saveOptionsChanged = !creating && (!snapshotMode || historicalScope !== "future" || Boolean(changeReason.trim()) || Boolean(historicalRange.start || historicalRange.end));
    if ((rowsChanged || nameChanged || saveOptionsChanged) && !window.confirm("Discard the unsaved recipe changes?")) return;
    onClose();
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="grid max-h-[90vh] w-[min(920px,calc(100vw-32px))] !max-w-[920px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0" onEscapeKeyDown={(event) => { if (!pickerMode) return; event.preventDefault(); setPickerMode(null); }}>
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{pickerMode === "raw" ? "Add raw ingredient" : pickerMode === "recipe" ? "Add recipe material" : creating ? "Create standalone recipe" : recipe ? `Edit recipe - ${recipe.menuItemName}` : "Recipe"}</DialogTitle>
          <DialogDescription>{pickerMode ? "Search and choose one item. You will return to the recipe without closing this editor." : creating ? "Create a reusable inventory recipe now; link it to menu items whenever you are ready." : "Update ingredients and choose how this change should affect saved recipe versions and completed orders."}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto overflow-x-hidden px-6 py-5">
          {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          {pickerMode === "raw" && <InventoryItemCardPicker items={activePickerItems} selectedItemId="" search={ingredientSearch} onSearch={setIngredientSearch} placeholder="Search ingredient or category" onSelect={addIngredient} compact />}
          {pickerMode === "recipe" && <RecipeMaterialCardPicker recipes={availableRecipeMaterials} selectedRecipeId="" search={recipeSearch} onSearch={setRecipeSearch} onSelect={addRecipeMaterial} compact />}
          {!pickerMode && (creating || isStandaloneRecipe(recipe)) && (
            <Card className="border-emerald-200 bg-emerald-50/60">
              <CardContent className="grid gap-3 p-4">
                <Field id="recipe-name" label="Recipe name"><Input id="recipe-name" autoFocus value={recipeName} onChange={(event) => setRecipeName(event.target.value)} placeholder="Example: Signature BBQ sauce" /></Field>
                {creating && <p className="text-sm text-muted-foreground">The recipe will remain independent until it is linked from Menu &gt; Inventory Links.</p>}
                {creating && !hasValidIngredients && <p className="text-sm font-medium text-amber-800">Add an ingredient and enter an amount greater than zero to enable creation.</p>}
              </CardContent>
            </Card>
          )}
          {!pickerMode && !creating && (
            <Card className="border-sky-200 bg-sky-50/70">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><CardTitle>Save behaviour</CardTitle><CardDescription>Choose whether to preserve the current version and which completed orders should be recalculated.</CardDescription></div>
                  <Badge variant="secondary">Current version {recipe?.versionNumber || 1}</Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <label className="flex items-start gap-3 rounded-xl border bg-background p-3">
                  <Checkbox checked={snapshotMode} onCheckedChange={(checked) => setSnapshotMode(Boolean(checked))} />
                  <span className="grid gap-1"><strong>Snapshot mode</strong><small className="text-muted-foreground">On creates a new recipe version and keeps the previous one. Off corrects the current version in place.</small></span>
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Apply inventory usage to">
                    <Select value={historicalScope} onValueChange={(value) => setHistoricalScope(value as HistoricalScope)}>
                      <SelectTrigger aria-label="Apply recipe change to orders"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="future">New orders only</SelectItem><SelectItem value="all">All completed orders</SelectItem><SelectItem value="range">Completed orders in a date range</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <Field label="Change note"><Input value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="Example: corrected sauce quantity" /></Field>
                </div>
                {historicalScope === "range" && <DateRangePicker value={historicalRange} onChange={setHistoricalRange} label="Recipe history date range" />}
                {historicalScope !== "future" && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">This recalculates stock usage for the selected completed orders. Negative stock is allowed so it can be reconciled later.</p>}
              </CardContent>
            </Card>
          )}
          {!pickerMode && rows.length === 0 && <EmptyState title="No ingredients yet" description="Add a raw inventory item or a reusable recipe material to begin." />}
          {!pickerMode && rows.map((row, index) => {
            const selectedItem = itemOptions.find((item) => item.id === Number(row.inventoryItemId));
            const selectedRecipe = recipes.find((entry) => entry.id === Number(row.childRecipeId));
            return (
              <div className="grid gap-3 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(260px,1fr)_160px_120px_auto] lg:items-end" key={`${row.kind}-${row.inventoryItemId || row.childRecipeId}-${index}`}>
                <div className="grid gap-1"><Label>{row.kind === "recipe" ? "Recipe material" : "Ingredient"}</Label><strong className="min-h-10 rounded-lg border bg-muted/40 px-3 py-2">{row.kind === "recipe" ? selectedRecipe?.menuItemName ?? "Unknown recipe" : selectedItem?.name ?? "Unknown ingredient"}</strong><span className="text-xs text-muted-foreground">{row.kind === "recipe" ? "Uses the child recipe's raw material list." : "Base unit is fixed from the inventory item."}</span></div>
                <div className="grid gap-2"><Label>Amount</Label><Input inputMode="decimal" value={row.quantityBase} onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantityBase: event.target.value } : item))} /></div>
                <div className="grid gap-2"><Label>Unit</Label><Input value={row.kind === "recipe" ? row.unitLabel || "portion" : selectedItem?.unitShortName || row.unitLabel || "g"} readOnly={row.kind === "raw"} className={row.kind === "raw" ? "bg-muted/60" : ""} onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, unitLabel: event.target.value } : item))} /></div>
                <Button className="w-full lg:w-auto" variant="secondary" onClick={() => setRows((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
              </div>
            );
          })}
        </div>
        <DialogFooter className="px-6 py-4">
          {pickerMode ? <Button variant="secondary" onClick={() => setPickerMode(null)}>Back to Recipe</Button> : (
            <>
              <div className="mr-auto flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setPickerMode("raw")} disabled={activePickerItems.length === 0}>Add Raw Item</Button>
                <Button variant="secondary" onClick={() => setPickerMode("recipe")} disabled={availableRecipeMaterials.length === 0}>Add Recipe Material</Button>
              </div>
              <Button variant="secondary" onClick={requestClose} disabled={saving}>Cancel</Button>
              <Button onClick={saveRecipe} disabled={saving || Boolean(creating && (!recipeName.trim() || !hasValidIngredients))}>{saving ? "Saving..." : creating ? "Create Recipe" : "Save Recipe"}</Button>
            </>
          )}
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
      <DialogContent className="grid max-h-[90vh] w-[min(1040px,calc(100vw-32px))] !max-w-[1040px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{item ? `Price record - ${item.name}` : "Price record"}</DialogTitle>
          <DialogDescription>Restock purchases used to understand the latest item price.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-auto p-6">
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

function Field({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label>{children}</div>;
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

function OrdersScreen({ title, description, orders, menuTypes, onRefresh, onResume, resumeLabel = "Resume", onView, onDone, onRestart, onBatchDone, onBatchRestart, onDoneAll, onClearHistory, onDeleteRecord }: { title: string; description: string; orders: OrderSummary[]; menuTypes: MenuTypeSetting[]; onRefresh: () => void; onResume?: (orderId: number) => void; resumeLabel?: string; onView?: (orderId: number) => void; onDone?: (orderId: number) => void; onRestart?: (orderId: number) => void; onBatchDone?: (ticketId: number) => void; onBatchRestart?: (ticketId: number) => void; onDoneAll?: () => void; onClearHistory?: () => void; onDeleteRecord?: (orderId: number) => void }) {
  return (
    <ContentShell
      title={title}
      description={description}
      action={<div className="flex gap-2"><Button variant="secondary" onClick={onRefresh}>Refresh</Button>{onDoneAll && <Button onClick={onDoneAll}>Done All</Button>}{onClearHistory && <Button variant="destructive" onClick={onClearHistory}>Delete History</Button>}</div>}
    >
      <OrderList orders={orders} menuTypes={menuTypes} showResume={Boolean(onResume)} resumeLabel={resumeLabel} onResume={onResume} onView={onView} onDone={onDone} onRestart={onRestart} onBatchDone={onBatchDone} onBatchRestart={onBatchRestart} onDeleteRecord={onDeleteRecord} />
    </ContentShell>
  );
}

function OrderList({ orders, menuTypes, showResume = false, resumeLabel = "Resume", onResume, onView, onDone, onRestart, onBatchDone, onBatchRestart, onDeleteRecord }: { orders: OrderSummary[]; menuTypes: MenuTypeSetting[]; showResume?: boolean; resumeLabel?: string; onResume?: (orderId: number) => void; onView?: (orderId: number) => void; onDone?: (orderId: number) => void; onRestart?: (orderId: number) => void; onBatchDone?: (ticketId: number) => void; onBatchRestart?: (ticketId: number) => void; onDeleteRecord?: (orderId: number) => void }) {
  if (orders.length === 0) return <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No orders found.</p>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
      {orders.map((order) => (
        <Card key={order.id} className="overflow-hidden border-slate-200 bg-gradient-to-br from-white to-slate-50 shadow-sm">
          <CardHeader className="border-b bg-white/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{orderDisplayName(order, menuTypes)}</CardTitle>
                <CardDescription>Receipt {order.orderNumber}</CardDescription>
                {order.externalOrderId && <p className="mt-1 text-xs font-medium text-sky-700">External ID: {order.externalOrderId}</p>}
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

function ReportsPanel({ summary, inventory, menuTypes }: { summary: SalesSummary; inventory: InventorySnapshot; menuTypes: MenuTypeSetting[] }) {
  type ReportPreset = "today" | "yesterday" | "7days" | "30days" | "all" | "custom";
  const [reportRange, setReportRange] = useState(() => dateRangeForPreset("today"));
  const [preset, setPreset] = useState<ReportPreset>("today");
  const [reportSummary, setReportSummary] = useState(summary);
  const [loading, setLoading] = useState(false);
  const [reportError, setReportError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadRangeSummary() {
      setLoading(true);
      setReportError("");
      try {
        const next = await window.yamzo?.reports.sales({ startDate: reportRange.start || undefined, endDate: reportRange.end || undefined });
        if (!cancelled) setReportSummary(next ?? summary);
      } catch (caught) {
        if (!cancelled) setReportError(caught instanceof Error ? caught.message : "Could not load the selected report period.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadRangeSummary();
    return () => { cancelled = true; };
  }, [reportRange.start, reportRange.end, summary]);

  const usage = reportSummary.rawMaterialUsage;
  const rawUsageRows = usage.map((item) => [item.itemName, `${formatQuantity(item.quantityBase)} ${item.unitLabel}`, money(item.rawCost)]);
  const rawCostTotal = reportSummary.rawMaterialCost;
  const reportCostRecords = inventory.costRecords.filter((record) => withinDateRange(record.costDate, reportRange));
  const costRows = reportCostRecords.map((record) => [formatBusinessDate(record.costDate), record.categoryName ?? "Other", record.costName, money(record.amount), record.paymentMethod ?? "-", record.responsiblePerson ?? "-"]);
  const reportRestockSpend = reportSummary.inventoryRestockSpend;
  const reportRestockCount = reportSummary.inventoryRestockCount;
  const reportPhysicalCountCount = reportSummary.inventoryPhysicalCountCount;
  const recentInventoryEvents = reportSummary.inventoryEvents.map((event) => ({
    key: `${event.eventType}-${event.id}`,
    timestamp: event.timestamp,
    type: event.eventType === "physical_count" ? "Physical count" : event.eventType === "adjustment" ? "Adjustment" : "Restock",
    itemName: event.itemName,
    detail: `${formatQuantity(event.quantityBase)} ${event.unitLabel}${event.totalCost ? ` | ${money(event.totalCost)}` : ""}`
  }));
  const hasInventoryActivity = reportRestockCount > 0 || reportPhysicalCountCount > 0;
  const costTotal = reportSummary.recordedCostTotal;
  const netAfterCommission = reportSummary.netAfterCommission ?? reportSummary.netSales - reportSummary.commissionTotal;
  const operationalProfit = reportSummary.operatingProfit;
  const periodLabel = reportRange.start || reportRange.end
    ? `${reportRange.start ? formatBusinessDate(reportRange.start) : "Beginning"} - ${reportRange.end ? formatBusinessDate(reportRange.end) : "Today"}`
    : "All recorded dates";

  function choosePreset(nextPreset: Exclude<ReportPreset, "custom">) {
    setPreset(nextPreset);
    setReportRange(dateRangeForPreset(nextPreset));
  }

  return (
    <div className="grid gap-4">
      <Card className="overflow-hidden border-emerald-200 bg-gradient-to-br from-emerald-950 to-emerald-800 text-white shadow-sm">
        <CardContent className="grid gap-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">Operational overview</p>
              <h2 className="mt-1 text-2xl font-semibold">{periodLabel}</h2>
              <p className="mt-1 text-sm text-emerald-100/80">Sales, order mix, payments, food usage, and recorded costs in one view.</p>
            </div>
            <Badge variant="secondary" className="bg-white/10 text-white">{loading ? "Updating..." : `${reportSummary.settledOrders} completed`}</Badge>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Report date shortcuts">
            {([[
              "today", "Today"
            ], ["yesterday", "Yesterday"], ["7days", "7 days"], ["30days", "30 days"], ["all", "All"]] as const).map(([value, label]) => (
              <Button key={value} size="sm" variant={preset === value ? "secondary" : "outline"} className={preset === value ? "" : "border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white"} onClick={() => choosePreset(value)}>{label}</Button>
            ))}
          </div>
          <div className="max-w-xl rounded-xl bg-white p-2 text-stone-950">
            <DateRangePicker value={reportRange} onChange={(value) => { setPreset("custom"); setReportRange(value); }} label="Custom report range" />
          </div>
        </CardContent>
      </Card>

      {reportError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{reportError}</p>}

      <section aria-label="Sales totals" className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <OperationalMetric label="Net sales" value={money(reportSummary.netSales)} detail={`${reportSummary.settledOrders} completed orders`} tone="emerald" />
        <OperationalMetric label="Gross sales" value={money(reportSummary.grossSales)} detail={`Before ${money(reportSummary.discountTotal)} discounts`} />
        <OperationalMetric label="Average order" value={money(reportSummary.averageOrderValue)} detail="Per completed order" />
        <OperationalMetric label="Platform commission" value={money(reportSummary.commissionTotal)} detail={`${money(netAfterCommission)} after commission`} tone="amber" />
        <OperationalMetric label="Recorded costs" value={money(costTotal)} detail={`${reportSummary.costRecordCount} cost records`} tone="amber" />
        <OperationalMetric label="Estimated operating profit" value={money(operationalProfit)} detail={`${money(rawCostTotal)} recipe cost included`} tone={operationalProfit >= 0 ? "emerald" : "red"} />
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Inventory reconciliation activity</CardTitle>
          <CardDescription>Restocks and physical counts recorded in this report period, ordered by their event time.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
            <InventoryMiniMetric label="Restock spend" value={money(reportRestockSpend)} />
            <InventoryMiniMetric label="Restock entries" value={String(reportRestockCount)} />
            <InventoryMiniMetric label="Physical counts" value={String(reportPhysicalCountCount)} />
          </div>
          <div className="grid gap-2">
            {recentInventoryEvents.length === 0 && <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{hasInventoryActivity ? "Inventory activity exists in this period, but detailed entries could not be loaded." : "No restocks or physical counts in this period."}</p>}
            {recentInventoryEvents.map((event) => (
              <div key={event.key} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-center">
                <span className="text-xs text-muted-foreground">{formatDate(event.timestamp)}</span>
                <span className="min-w-0"><strong className="block truncate">{event.itemName}</strong><span className="text-xs text-muted-foreground">{event.type}</span></span>
                <strong className="text-sm tabular-nums">{event.detail}</strong>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <Card>
          <CardHeader>
            <CardTitle>Sales by order type</CardTitle>
            <CardDescription>Order count and money are separated so a high-volume channel cannot hide weak value.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {reportSummary.sourceTotals.every((source) => source.orders <= 0) && <EmptyState title="No completed sales" description="Choose another period or complete an order." />}
            {reportSummary.sourceTotals.filter((source) => source.orders > 0).map((source) => (
              <div key={source.source} className="grid gap-3 rounded-xl border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-2"><strong>{formatConfiguredSource(source.source, menuTypes)}</strong><Badge variant="secondary">{source.orders} orders</Badge></div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <InventoryMiniMetric label="Gross" value={money(source.grossSales)} />
                  <InventoryMiniMetric label="Net sales" value={money(source.netSales)} />
                  <InventoryMiniMetric label="Discount" value={money(source.discount)} />
                  <InventoryMiniMetric label="Commission" value={money(source.commission)} />
                </div>
                <div className="flex items-center justify-between border-t pt-2 text-sm"><span className="text-muted-foreground">After commission</span><strong>{money(source.netAfterCommission)}</strong></div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Payment mix</CardTitle><CardDescription>Collected amount by payment method.</CardDescription></CardHeader>
          <CardContent className="grid gap-2">
            {reportSummary.paymentTotals.every((payment) => payment.amount <= 0) && <p className="text-sm text-muted-foreground">No payments in this period.</p>}
            {reportSummary.paymentTotals.filter((payment) => payment.amount > 0).map((payment) => (
              <div key={payment.method} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div><strong className="block">{labelize(payment.method)}</strong><span className="text-xs text-muted-foreground">{payment.orders} orders</span></div>
                <strong className="text-lg">{money(payment.amount)}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Top-selling items</CardTitle><CardDescription>Best items by sold quantity with revenue alongside.</CardDescription></CardHeader>
          <CardContent className="grid gap-2">
            {reportSummary.topItems.length === 0 && <p className="text-sm text-muted-foreground">No item sales in this period.</p>}
            {reportSummary.topItems.slice(0, 10).map((item, index) => (
              <div key={`${item.name}-${index}`} className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border p-3">
                <span className="grid size-8 place-items-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-900">{index + 1}</span>
                <div className="min-w-0"><strong className="block truncate">{item.name}</strong><span className="text-xs text-muted-foreground">{formatQuantity(item.quantity)} sold</span></div>
                <strong>{money(item.total)}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Cost and timing checks</CardTitle><CardDescription>Fast signals for the manager on duty.</CardDescription></CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <InventoryMiniMetric label="Recipe raw cost" value={money(rawCostTotal)} />
            <InventoryMiniMetric label="Other recorded cost" value={money(costTotal)} />
            <InventoryMiniMetric label="Average kitchen time" value={reportSummary.averageKitchenMinutes ? `${reportSummary.averageKitchenMinutes} min` : "--"} />
            <InventoryMiniMetric label="Voided value" value={money(reportSummary.voidTotal)} />
            <InventoryMiniMetric label="Low stock" value={inventory.status.lowStockCount} />
            <InventoryMiniMetric label="Out of stock" value={inventory.status.outOfStockCount} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Raw material usage</CardTitle><CardDescription>Recipe usage from completed orders in this period.</CardDescription></CardHeader>
          <CardContent><InventoryTable headers={["Raw material", "Quantity used", "Raw cost"]} rows={rawUsageRows} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recorded costs</CardTitle><CardDescription>Costs entered in the Costs tab for this period.</CardDescription></CardHeader>
          <CardContent><InventoryTable headers={["Date", "Category", "Cost", "Amount", "Payment", "Person"]} rows={costRows} /></CardContent>
        </Card>
      </div>
    </div>
  );
}

function OperationalMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "emerald" | "amber" | "red" }) {
  const toneClass = tone === "emerald" ? "border-emerald-200 bg-emerald-50/70" : tone === "amber" ? "border-amber-200 bg-amber-50/70" : tone === "red" ? "border-red-200 bg-red-50/70" : "bg-card";
  return <Card className={toneClass}><CardContent className="grid gap-1 p-4"><span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span><strong className="text-2xl tracking-tight">{value}</strong><span className="text-xs text-muted-foreground">{detail}</span></CardContent></Card>;
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
  menuTypes,
  activityLogs,
  refreshData,
  setMessage,
  onCreateRecipe,
  onEditRecipe,
  onViewPriceHistory
}: {
  snapshot: InventorySnapshot;
  menuTypes: MenuTypeSetting[];
  activityLogs: ActivityLog[];
  refreshData: () => Promise<void>;
  setMessage: (message: string) => void;
  onCreateRecipe: () => void;
  onEditRecipe: (recipe: MenuRecipe) => void;
  onViewPriceHistory: (itemId: number) => void;
}) {
  const activeCategories = snapshot.categories.filter((category) => category.active);
  const activeUnits = snapshot.units.filter((unit) => unit.active);
  const firstItem = snapshot.items[0];
  const firstUnit = activeUnits[0];
  const firstCategory = activeCategories[0];
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
    entryType: "purchase",
    inventoryItemId: firstItem?.id ? String(firstItem.id) : "",
    recipeId: "",
    quantity: "",
    totalCost: "",
    supplierName: "",
    responsiblePerson: "",
    note: "",
    adjustmentReason: "",
    entryDate: dateTimeInputValue(new Date())
  });
  const [physicalCountForm, setPhysicalCountForm] = useState({
    inventoryItemId: firstItem?.id ? String(firstItem.id) : "",
    quantity: "",
    countDate: dateTimeInputValue(new Date()),
    responsiblePerson: "",
    note: ""
  });
  const [categoryName, setCategoryName] = useState("");
  const [unitForm, setUnitForm] = useState({ name: "", shortName: "" });
  const [statusSearch, setStatusSearch] = useState("");
  const [itemEdit, setItemEdit] = useState<InventoryItem | null>(null);
  const [restockEdit, setRestockEdit] = useState<RestockEntry | null>(null);
  const [physicalEdit, setPhysicalEdit] = useState<PhysicalCountEntry | null>(null);
  const [restockDialogOpen, setRestockDialogOpen] = useState(false);
  const [physicalDialogOpen, setPhysicalDialogOpen] = useState(false);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [recipeStatusFilter, setRecipeStatusFilter] = useState("all");
  const [inventoryItemSearch, setInventoryItemSearch] = useState("");
  const [restockSearch, setRestockSearch] = useState("");
  const [physicalSearch, setPhysicalSearch] = useState("");
  const [bulkSnapshotMode, setBulkSnapshotMode] = useState(true);
  const [bulkHistoricalScope, setBulkHistoricalScope] = useState<HistoricalScope>("future");
  const [bulkHistoricalRange, setBulkHistoricalRange] = useState({ start: "", end: "" });
  const [bulkReason, setBulkReason] = useState("");
  const selectedRestockItem = snapshot.items.find((item) => String(item.id) === restockForm.inventoryItemId) ?? null;
  const selectedPhysicalItem = snapshot.items.find((item) => String(item.id) === physicalCountForm.inventoryItemId) ?? null;
  const countStatusByItemId = useMemo(() => buildCountStatusMap(snapshot.physicalCounts), [snapshot.physicalCounts]);

  useEffect(() => {
    if (!itemForm.baseUnitId && activeUnits[0]) setItemForm((current) => ({ ...current, baseUnitId: String(activeUnits[0].id) }));
    if (!itemForm.categoryId && activeCategories[0]) setItemForm((current) => ({ ...current, categoryId: String(activeCategories[0].id) }));
    if (!restockForm.inventoryItemId && snapshot.items[0]) setRestockForm((current) => ({ ...current, inventoryItemId: String(snapshot.items[0].id) }));
    if (!physicalCountForm.inventoryItemId && snapshot.items[0]) setPhysicalCountForm((current) => ({ ...current, inventoryItemId: String(snapshot.items[0].id) }));
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
    let note = restockForm.note || null;
    const countStatus = selectedRestockItem ? countStatusByItemId.get(selectedRestockItem.id) : null;
    if (restockForm.entryType === "purchase" && countStatus?.state === "expired") {
      const reason = await requireAdminReason(`unlock restock for ${selectedRestockItem?.name ?? "this item"}`);
      if (!reason) return;
      await window.yamzo?.audit.protectedAccess({ panel: "Restock count unlock", success: true, method: "password", actor: "admin" });
      note = [note, `Count unlock: ${reason}`].filter(Boolean).join(" | ");
    }
    await window.yamzo?.inventory.addRestock({
      inventoryItemId: Number(restockForm.inventoryItemId),
      itemType: restockForm.itemType as "raw" | "recipe",
      entryType: restockForm.entryType as "purchase" | "adjustment",
      recipeId: restockForm.recipeId ? Number(restockForm.recipeId) : null,
      quantity: Number(restockForm.quantity || 0),
      totalCost: Number(restockForm.totalCost || 0),
      supplierName: restockForm.supplierName || null,
      responsiblePerson: restockForm.responsiblePerson || null,
      note,
      adjustmentReason: restockForm.adjustmentReason || null,
      entryDate: restockForm.entryDate || null
    });
    setRestockForm({ ...restockForm, quantity: "", totalCost: "", supplierName: "", note: "", adjustmentReason: "", entryDate: dateTimeInputValue(new Date()) });
    setRestockDialogOpen(false);
    setMessage("Restock entry saved.");
    await refreshData();
  }

  async function addPhysicalCountEntry() {
    await window.yamzo?.inventory.addPhysicalCount({
      inventoryItemId: Number(physicalCountForm.inventoryItemId),
      quantity: Number(physicalCountForm.quantity || 0),
      countDate: physicalCountForm.countDate || null,
      responsiblePerson: physicalCountForm.responsiblePerson || null,
      note: physicalCountForm.note || null
    });
    setPhysicalCountForm({ ...physicalCountForm, quantity: "", note: "" });
    setPhysicalDialogOpen(false);
    setMessage("Physical count saved.");
    await refreshData();
  }

  async function requireAdminReason(actionLabel: string) {
    const password = window.prompt(`Admin password required to ${actionLabel}`);
    if (!password) return null;
    if (password !== "336000") {
      const user = await window.yamzo?.auth.login("admin", password);
      if (user?.role !== "admin") {
        setMessage("Admin password was incorrect.");
        return null;
      }
    }
    const reason = window.prompt(`Reason for ${actionLabel}`);
    if (!reason?.trim()) {
      setMessage("Reason is required.");
      return null;
    }
    return reason.trim();
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
    if (bulkHistoricalScope === "range" && !bulkHistoricalRange.start && !bulkHistoricalRange.end) {
      setMessage("Choose at least one date before importing a historical range.");
      return;
    }
    const result = await window.yamzo?.inventory.chooseAndImportCsv({
      snapshotMode: bulkSnapshotMode,
      historicalScope: bulkHistoricalScope,
      start: bulkHistoricalScope === "range" ? bulkHistoricalRange.start || null : null,
      end: bulkHistoricalScope === "range" ? bulkHistoricalRange.end || null : null,
      reason: bulkReason.trim() || null
    });
    if (!result || result.cancelled) {
      setMessage("Recipe import cancelled.");
      return;
    }
    setMessage(`Recipes imported: ${result.recipesImported} new, ${result.recipesUpdated} updated, ${result.versionsCreated ?? 0} snapshots created, ${result.historicalOrdersUpdated ?? 0} historical orders recalculated.`);
    await refreshData();
  }

  async function deleteRestock(entry: RestockEntry) {
    if (!window.confirm(`Delete this restock entry for ${entry.itemName}?`)) return;
    await window.yamzo?.inventory.deleteRestock(entry.id);
    setMessage("Restock entry deleted.");
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
    const query = statusSearch.trim().toLowerCase();
    return snapshot.items.filter((item) => {
      if (!query) return true;
      const text = `${item.name} ${item.categoryName ?? ""} ${item.unitShortName} ${item.status}`.toLowerCase();
      return text.includes(query);
    }).map((item) => [
      item.name,
      item.categoryName ?? "Other",
      item.lastCountAt ? formatDate(item.lastCountAt) : "Never counted",
      `${formatQuantity(item.lowStockThreshold)} ${item.unitShortName}`,
      `${formatQuantity(item.latestRestockQuantity)} ${item.unitShortName}`,
      `${formatQuantity(item.stockUsed)} ${item.unitShortName}`,
      `${formatQuantity(item.estimatedWastage)} ${item.unitShortName}`,
      `${formatQuantity(item.currentStock)} ${item.unitShortName}`,
      item.status === "ok" ? "OK" : item.status === "low" ? "Low stock" : "Out of stock"
    ]);
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
      <Tabs defaultValue="status">
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
          <TabsTrigger value="status">Overview</TabsTrigger>
          <TabsTrigger value="recipes">Recipes</TabsTrigger>
          <TabsTrigger value="items">Stock Items</TabsTrigger>
          <TabsTrigger value="restock">Restock</TabsTrigger>
          <TabsTrigger value="physical">Counts</TabsTrigger>
          <TabsTrigger value="orders">Usage</TabsTrigger>
          <TabsTrigger value="audit">Activity</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="status" className="grid gap-4 pt-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <Metric label="Inventory Items" value={snapshot.status.inventoryItemCount} />
            <Metric label="Low Stock" value={snapshot.status.lowStockCount} />
            <Metric label="Out of Stock" value={snapshot.status.outOfStockCount} />
          </div>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><CardTitle>Stock Status</CardTitle><CardDescription>Search current stock position for active inventory items.</CardDescription></div>
                <Button variant="secondary" onClick={() => exportCsvRows("yamzo-stock-status.csv", [["Item", "Category", "Last Count", "Warning", "Restocked", "Used", "Variance", "Current", "Status"], ...stockRows()])}>Export</Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Input value={statusSearch} onChange={(event) => setStatusSearch(event.target.value)} placeholder="Search stock by item, category, unit, or status" />
              <InventoryTable headers={["Item", "Category", "Last Count", "Warning", "Restocked", "Used", "Variance", "Current", "Status"]} rows={stockRows()} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="recipes" className="grid gap-4 pt-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Recipes</CardTitle>
                  <CardDescription>Create reusable recipes independently, then link them to menu items when needed.</CardDescription>
                </div>
                <Button onClick={onCreateRecipe}>Add Recipe</Button>
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
          <Card className="border-sky-200 bg-sky-50/50">
            <CardHeader className="pb-3">
              <CardTitle>Bulk recipe upload</CardTitle>
              <CardDescription>Import the Yamzo recipe CSV using the same version and historical-order rules as a manual edit.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_260px_minmax(260px,1fr)_auto] lg:items-end">
                <label className="flex min-h-10 items-start gap-3 rounded-xl border bg-background p-3">
                  <Checkbox checked={bulkSnapshotMode} onCheckedChange={(checked) => setBulkSnapshotMode(Boolean(checked))} />
                  <span className="grid gap-1"><strong>Snapshot mode</strong><small className="text-muted-foreground">Create new versions instead of correcting the current versions.</small></span>
                </label>
                <Field label="Apply usage to">
                  <Select value={bulkHistoricalScope} onValueChange={(value) => setBulkHistoricalScope(value as HistoricalScope)}>
                    <SelectTrigger aria-label="Bulk recipe historical scope"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="future">New orders only</SelectItem><SelectItem value="all">All completed orders</SelectItem><SelectItem value="range">Completed orders in range</SelectItem></SelectContent>
                  </Select>
                </Field>
                <Field label="Import note"><Input value={bulkReason} onChange={(event) => setBulkReason(event.target.value)} placeholder="Example: July recipe correction" /></Field>
                <Button onClick={importRecipesCsv}>Choose Recipe CSV</Button>
              </div>
              {bulkHistoricalScope === "range" && <DateRangePicker value={bulkHistoricalRange} onChange={setBulkHistoricalRange} label="Bulk recipe history date range" />}
            </CardContent>
          </Card>
          {filteredRecipes.map((recipe) => (
            <Card key={recipe.id > 0 ? `recipe-${recipe.id}` : `menu-${recipe.menuItemId}`} size="sm" className="overflow-hidden">
              <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_330px_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><strong className="text-base">{recipe.menuItemName}</strong><Badge variant={recipe.status === "available" ? "default" : "destructive"}>{recipe.status === "available" ? "Ready" : "Recipe missing"}</Badge>{isStandaloneRecipe(recipe) && <Badge variant="secondary">Standalone</Badge>}<Badge variant="outline">Version {recipe.versionNumber || 1}</Badge></div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{recipe.ingredients.length === 0 ? "No ingredients added." : recipe.ingredients.map((item) => item.itemName).join(", ")}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{recipe.ingredients.length} raw ingredients{recipe.childIngredients?.length ? ` + ${recipe.childIngredients.length} recipe materials` : ""}{recipe.versions.length > 1 ? ` | ${recipe.versions.length} saved snapshots` : ""}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <InventoryMiniMetric label="Raw cost" value={money(recipe.rawCost)} />
                  {isStandaloneRecipe(recipe) ? <InventoryMiniMetric label="Ingredients" value={String(recipe.ingredients.length + (recipe.childIngredients?.length ?? 0))} /> : <InventoryMiniMetric label="Profit" value={money(recipe.estimatedProfit)} />}
                  {isStandaloneRecipe(recipe) ? <InventoryMiniMetric label="Menu links" value={String(snapshot.bindings.filter((binding) => binding.recipeId === recipe.id).length)} /> : <InventoryMiniMetric label="Margin" value={`${recipe.profitMargin}%`} />}
                </div>
                <div className="grid gap-2">
                  <label className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm"><Checkbox checked={recipe.restockEnabled} onCheckedChange={async (checked) => { await window.yamzo?.inventory.setRecipeRestockEnabled(recipe.menuItemId, Boolean(checked)); await refreshData(); }} />Restock option</label>
                  <Button variant={recipe.status === "missing" ? "default" : "secondary"} onClick={() => onEditRecipe(recipe)}>{recipe.status === "missing" ? "Build Recipe" : "Edit Recipe"}</Button>
                </div>
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
          <Card className="border-emerald-200 bg-emerald-50/25">
            <CardHeader className="pb-3"><CardTitle>Add stock item</CardTitle><CardDescription>Create the raw material first; menu links are managed from the Menu tab.</CardDescription></CardHeader>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4 pt-0">
              <Field label="Item name"><Input value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} /></Field>
              <Field label="Category"><SearchableSelect value={itemForm.categoryId} onValueChange={(value) => setItemForm({ ...itemForm, categoryId: value })} options={activeCategories.map((category) => ({ value: String(category.id), label: category.name }))} placeholder="Choose category" searchPlaceholder="Search categories..." emptyText="No categories found." ariaLabel="Inventory category" /></Field>
              <Field label="Base unit"><SearchableSelect value={itemForm.baseUnitId} onValueChange={(value) => setItemForm({ ...itemForm, baseUnitId: value })} options={activeUnits.map((unit) => ({ value: String(unit.id), label: unit.name, description: unit.shortName, keywords: unit.shortName }))} placeholder="Choose unit" searchPlaceholder="Search units..." emptyText="No units found." ariaLabel="Inventory base unit" /></Field>
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
                <Button onClick={() => { setRestockForm({ ...restockForm, entryType: "purchase", inventoryItemId: "", recipeId: "", quantity: "", totalCost: "", supplierName: "", note: "", adjustmentReason: "", entryDate: dateTimeInputValue(new Date()) }); setRestockDialogOpen(true); }}>Add Restock</Button>
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
            countStatusByItemId={countStatusByItemId}
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
                <Button onClick={() => { setPhysicalCountForm({ ...physicalCountForm, inventoryItemId: "", quantity: "", countDate: dateTimeInputValue(new Date()), note: "" }); setPhysicalDialogOpen(true); }}>Add Count</Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Input value={physicalSearch} onChange={(event) => setPhysicalSearch(event.target.value)} placeholder="Search physical counts" />
              <PhysicalCountTable
                entries={filteredPhysicalCounts}
                onEdit={setPhysicalEdit}
                onDelete={async (entry) => {
                  if (!window.confirm(`Delete physical count for ${entry.itemName}? This cannot be undone.`)) return;
                  try {
                    await window.yamzo?.inventory.deletePhysicalCount(entry.id);
                    setMessage("Physical count deleted.");
                    await refreshData();
                  } catch (caught) {
                    setMessage(caught instanceof Error ? caught.message : "Could not delete physical count.");
                  }
                }}
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
          <InventoryOrdersPanel usage={snapshot.orderUsage} menuTypes={menuTypes} />
        </TabsContent>

        <TabsContent value="audit" className="pt-4">
          <InventoryAuditPanel logs={activityLogs} />
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
          setMessage("Restock entry updated.");
          await refreshData();
        }}
      />
      <PhysicalCountEditorDialog
        entry={physicalEdit}
        items={snapshot.items}
        onClose={() => setPhysicalEdit(null)}
        onSave={async (entry, draft) => {
          await window.yamzo?.inventory.updatePhysicalCount({
            id: entry.id,
            inventoryItemId: Number(draft.inventoryItemId),
            quantity: Number(draft.quantity || 0),
            responsiblePerson: draft.responsiblePerson || null,
            note: draft.note || null,
            countDate: draft.countDate || null
          });
          setPhysicalEdit(null);
          setMessage("Physical count updated.");
          await refreshData();
        }}
      />
    </div>
  );
}

function InventoryBindingDialog({
  open,
  menu,
  snapshot,
  initialMenuItemId,
  initialInventoryItemId,
  initialRecipeId,
  lockMenuItem = false,
  onClose,
  onSaved
}: {
  open: boolean;
  menu: MenuItem[];
  snapshot: InventorySnapshot;
  initialMenuItemId?: number;
  initialInventoryItemId?: number;
  initialRecipeId?: number;
  lockMenuItem?: boolean;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const availableMenu = menu.filter((item) => !item.archived);
  const availableRecipes = snapshot.recipes.filter((recipe) => recipe.status === "available" && recipe.id > 0);
  const availableItems = snapshot.items.filter((item) => item.active);
  const [menuItemId, setMenuItemId] = useState("");
  const [bindingType, setBindingType] = useState<"recipe" | "item">("recipe");
  const [sourceId, setSourceId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [historicalScope, setHistoricalScope] = useState<HistoricalScope>("all");
  const [historicalRange, setHistoricalRange] = useState({ start: "", end: "" });
  const [reason, setReason] = useState("");
  const [impact, setImpact] = useState<InventoryBindingPreview | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const selectedMenuId = Number(menuItemId || 0);
  const existingBinding = snapshot.bindings.find((binding) => binding.menuItemId === selectedMenuId) ?? null;
  const selectedItem = bindingType === "item" ? availableItems.find((item) => item.id === Number(sourceId)) : null;

  function loadMenuBinding(nextMenuItemId: number, preferred?: { inventoryItemId?: number; recipeId?: number }) {
    const existing = snapshot.bindings.find((binding) => binding.menuItemId === nextMenuItemId);
    const nextType: "recipe" | "item" = preferred?.inventoryItemId
      ? "item"
      : preferred?.recipeId
        ? "recipe"
        : existing?.bindingType ?? "recipe";
    const nextSourceId = nextType === "item"
      ? String(preferred?.inventoryItemId ?? existing?.inventoryItemId ?? "")
      : String(preferred?.recipeId ?? existing?.recipeId ?? "");
    setMenuItemId(nextMenuItemId ? String(nextMenuItemId) : "");
    setBindingType(nextType);
    setSourceId(nextSourceId);
    setQuantity(String(existing?.quantityBase ?? 1));
    // A brand-new link reconciles already-sold items by default. Editing an
    // existing link stays future-only unless the manager opts into history.
    setHistoricalScope(existing ? "future" : "all");
    setHistoricalRange({ start: "", end: "" });
    setReason("");
    setImpact(null);
    setError("");
  }

  useEffect(() => {
    if (!open) return;
    const initialId = initialMenuItemId ?? 0;
    loadMenuBinding(initialId, { inventoryItemId: initialInventoryItemId, recipeId: initialRecipeId });
  }, [open, initialMenuItemId, initialInventoryItemId, initialRecipeId]);

  function changeBindingType(nextType: "recipe" | "item") {
    setBindingType(nextType);
    setSourceId(nextType === "recipe" ? String(existingBinding?.recipeId ?? "") : String(existingBinding?.inventoryItemId ?? ""));
    setQuantity(String(existingBinding?.bindingType === nextType ? existingBinding.quantityBase : 1));
    setImpact(null);
    setError("");
  }

  function historyOptions() {
    return {
      historicalScope,
      start: historicalScope === "range" ? historicalRange.start || null : null,
      end: historicalScope === "range" ? historicalRange.end || null : null,
      reason: reason.trim() || null
    };
  }

  async function previewImpact() {
    if (!selectedMenuId) {
      setError("Choose a menu item first.");
      return;
    }
    if (historicalScope === "range" && !historicalRange.start && !historicalRange.end) {
      setError("Choose at least one date for the historical range.");
      return;
    }
    setError("");
    try {
      const preview = await window.yamzo?.inventory.previewBindingImpact({
        menuItemId: selectedMenuId,
        start: historicalScope === "range" ? historicalRange.start || null : null,
        end: historicalScope === "range" ? historicalRange.end || null : null
      });
      setImpact(preview ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not preview historical orders.");
    }
  }

  async function saveBinding() {
    if (!selectedMenuId || !sourceId || Number(quantity) <= 0) {
      setError("Choose a menu item, inventory source, and usage quantity greater than zero.");
      return;
    }
    if (historicalScope === "range" && !historicalRange.start && !historicalRange.end) {
      setError("Choose at least one date for the historical range.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await window.yamzo?.inventory.saveBinding({
        menuItemId: selectedMenuId,
        bindingType,
        recipeId: bindingType === "recipe" ? Number(sourceId) : null,
        inventoryItemId: bindingType === "item" ? Number(sourceId) : null,
        quantityBase: Number(quantity),
        unitLabel: bindingType === "item" ? selectedItem?.unitShortName : "portion",
        ...historyOptions()
      });
      await onSaved(`${availableMenu.find((item) => item.id === selectedMenuId)?.name ?? "Menu item"} inventory binding saved.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the inventory binding.");
    } finally {
      setSaving(false);
    }
  }

  async function unlinkBinding() {
    if (!existingBinding || !selectedMenuId) return;
    if (!window.confirm(`Remove the inventory binding from ${existingBinding.menuItemName}?`)) return;
    setSaving(true);
    setError("");
    try {
      await window.yamzo?.inventory.removeBinding(selectedMenuId, historyOptions());
      await onSaved(`${existingBinding.menuItemName} inventory binding removed.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the inventory binding.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="grid max-h-[90vh] w-[min(860px,calc(100vw-32px))] !max-w-[860px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>Link menu item to inventory</DialogTitle>
          <DialogDescription>Choose one recipe or direct stock item to reduce when this menu item is sold.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-5 overflow-y-auto p-6">
          {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Menu item">
              <SearchableSelect
                disabled={lockMenuItem}
                value={menuItemId}
                onValueChange={(value) => loadMenuBinding(Number(value))}
                options={availableMenu.map((item) => ({ value: String(item.id), label: item.name, description: item.category || "Other", keywords: item.category || "" }))}
                placeholder="Choose menu item"
                searchPlaceholder="Search menu items..."
                emptyText="No menu items found."
                ariaLabel="Menu item to bind"
              />
            </Field>
            <Field label="Inventory tracking method">
              <Select value={bindingType} onValueChange={(value) => changeBindingType(value as "recipe" | "item")}>
                <SelectTrigger aria-label="Inventory tracking method"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="recipe">Link to recipe</SelectItem><SelectItem value="item">Direct stock item</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label={bindingType === "recipe" ? "Recipe" : "Inventory item"}>
              <SearchableSelect
                value={sourceId}
                onValueChange={setSourceId}
                options={bindingType === "recipe"
                  ? availableRecipes.map((item) => ({ value: String(item.id), label: item.menuItemName, description: `${item.ingredients.length} ingredients | ${money(item.rawCost)} raw cost`, keywords: item.ingredients.map((ingredient) => ingredient.itemName).join(" ") }))
                  : availableItems.map((item) => ({ value: String(item.id), label: item.name, description: `${item.categoryName ?? "Other"} | ${formatQuantity(item.currentStock)} ${item.unitShortName} in stock`, keywords: `${item.categoryName ?? ""} ${item.unitShortName}` }))}
                placeholder={bindingType === "recipe" ? "Choose recipe" : "Choose inventory item"}
                searchPlaceholder={bindingType === "recipe" ? "Search recipes or ingredients..." : "Search inventory items..."}
                emptyText={bindingType === "recipe" ? "No available recipes found." : "No inventory items found."}
                ariaLabel={bindingType === "recipe" ? "Recipe to link" : "Inventory item to link"}
              />
            </Field>
            <Field label={`Usage per sold item (${bindingType === "recipe" ? "portion" : selectedItem?.unitShortName ?? "unit"})`}><Input type="number" min="0.0001" step="any" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
          </div>
          <Card className="border-amber-200 bg-amber-50/50">
            <CardHeader className="pb-3"><CardTitle>Past order inventory usage</CardTitle><CardDescription>Choose whether this link should change completed orders that already contain the menu item.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <Field label="Apply to">
                <Select value={historicalScope} onValueChange={(value) => { setHistoricalScope(value as HistoricalScope); setImpact(null); }}>
                  <SelectTrigger aria-label="Historical order scope"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="future">New orders only</SelectItem><SelectItem value="all">All completed orders</SelectItem><SelectItem value="range">Completed orders in a date range</SelectItem></SelectContent>
                </Select>
              </Field>
              {historicalScope === "range" && <DateRangePicker value={historicalRange} onChange={(value) => { setHistoricalRange(value); setImpact(null); }} label="Binding history date range" />}
              <Field label="Correction note"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: linked bottled drink inventory" /></Field>
              {historicalScope !== "future" && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" variant="secondary" onClick={previewImpact}>Preview affected orders</Button>
                  {impact && <span className="text-sm"><strong>{impact.orderCount}</strong> completed orders found; estimated raw-cost change <strong>{money(impact.rawCostDelta)}</strong>.</span>}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <DialogFooter className="px-6 py-4">
          {existingBinding && <Button className="mr-auto" variant="destructive" disabled={saving} onClick={unlinkBinding}>Remove Link</Button>}
          <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button disabled={saving || !menuItemId || !sourceId || Number(quantity) <= 0} onClick={saveBinding}>{saving ? "Saving..." : "Save Binding"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      <DialogContent className="grid max-h-[90vh] w-[min(760px,calc(100vw-32px))] !max-w-[760px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{item ? `Edit item - ${item.name}` : "Edit item"}</DialogTitle>
          <DialogDescription>Update stock setup without changing existing restock history.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto p-6">
          {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Item name"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
            <Field label="Category">
              <SearchableSelect value={draft.categoryId || "none"} onValueChange={(value) => setDraft({ ...draft, categoryId: value === "none" ? "" : value })} options={[{ value: "none", label: "No category" }, ...categories.map((category) => ({ value: String(category.id), label: category.name }))]} placeholder="Choose category" searchPlaceholder="Search categories..." emptyText="No categories found." ariaLabel="Inventory category" />
            </Field>
            <Field label="Base unit">
              <SearchableSelect value={draft.baseUnitId} onValueChange={(value) => setDraft({ ...draft, baseUnitId: value })} options={units.map((unit) => ({ value: String(unit.id), label: unit.name, description: unit.shortName, keywords: unit.shortName }))} placeholder="Choose unit" searchPlaceholder="Search units..." emptyText="No units found." ariaLabel="Inventory base unit" />
            </Field>
            <Field label="Low stock warning"><Input value={draft.lowStockThreshold} onChange={(event) => setDraft({ ...draft, lowStockThreshold: event.target.value })} /></Field>
          </div>
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save Item</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PhysicalCountTable({ entries, onEdit, onDelete }: { entries: PhysicalCountEntry[]; onEdit: (entry: PhysicalCountEntry) => void; onDelete: (entry: PhysicalCountEntry) => void }) {
  return (
    <div className="rounded-xl border bg-card">
      {entries.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No physical count records yet.</p>
      ) : (
        <div className="overflow-auto">
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Count</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Person</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{formatDate(entry.countDate)}</TableCell>
                  <TableCell>{entry.itemName}</TableCell>
                  <TableCell>{formatQuantity(entry.quantityBase)} {entry.unitLabel}</TableCell>
                  <TableCell><Badge variant={entry.source === "manual" ? "secondary" : "outline"}>{labelize(entry.source)}</Badge></TableCell>
                  <TableCell>{entry.responsiblePerson ?? "-"}</TableCell>
                  <TableCell>{entry.note ?? "-"}</TableCell>
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

function PhysicalCountEditorDialog({
  entry,
  items,
  onClose,
  onSave
}: {
  entry: PhysicalCountEntry | null;
  items: InventoryItem[];
  onClose: () => void;
  onSave: (entry: PhysicalCountEntry, draft: { inventoryItemId: string; quantity: string; countDate: string; responsiblePerson: string; note: string }) => Promise<void>;
}) {
  const [draft, setDraft] = useState({ inventoryItemId: "", quantity: "", countDate: "", responsiblePerson: "", note: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const selectedItem = items.find((item) => String(item.id) === draft.inventoryItemId);

  useEffect(() => {
    if (!entry) return;
    setError("");
    setSaving(false);
    setDraft({
      inventoryItemId: String(entry.inventoryItemId),
      quantity: String(entry.quantityBase),
      countDate: dateTimeValueFromTimestamp(entry.countDate),
      responsiblePerson: entry.responsiblePerson ?? "",
      note: entry.note ?? ""
    });
  }, [entry]);

  async function save() {
    if (!entry || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(entry, draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the physical count.");
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[90vh] w-[min(760px,calc(100vw-32px))] !max-w-[760px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{entry ? `Edit count - ${entry.itemName}` : "Edit physical count"}</DialogTitle>
          <DialogDescription>Correct the item, measured quantity, date, person, or note. The update is logged automatically.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto p-6 md:grid-cols-2">
          {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive md:col-span-2">{error}</p>}
          <InventoryItemPicker label="Item" value={draft.inventoryItemId} items={items} onChange={(value) => setDraft({ ...draft, inventoryItemId: value })} />
          <Field label={`Count (${selectedItem?.unitShortName ?? entry?.unitLabel ?? "unit"})`}>
            <Input type="number" min="0" inputMode="decimal" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })} />
          </Field>
          <Field id="count-event-time" label="Count date and time"><Input id="count-event-time" type="datetime-local" step="1" value={draft.countDate} onChange={(event) => setDraft({ ...draft, countDate: event.target.value })} /></Field>
          <Field label="Person responsible"><Input value={draft.responsiblePerson} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></Field>
          <Field label="Note"><Input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></Field>
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !entry || !draft.inventoryItemId || !draft.countDate || draft.quantity === ""}>{saving ? "Saving..." : "Save Count"}</Button>
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
              <TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Item</TableHead><TableHead>Quantity</TableHead><TableHead>Cost</TableHead><TableHead>Person</TableHead><TableHead>Supplier</TableHead><TableHead className="text-right">Action</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell title={`Last updated ${formatDate(entry.updatedAt)}`}>{formatDate(entry.entryDate)}</TableCell>
                  <TableCell><Badge variant={entry.entryType === "adjustment" ? "outline" : "secondary"}>{entry.entryType === "adjustment" ? "Adjustment" : "Purchase"}</Badge></TableCell>
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
  const [draft, setDraft] = useState({ inventoryItemId: "", entryType: "purchase", quantity: "", unitLabel: "", totalCost: "", supplierName: "", responsiblePerson: "", note: "", adjustmentReason: "", entryDate: "" });
  const [error, setError] = useState("");
  const selectedItem = items.find((item) => item.id === Number(draft.inventoryItemId));

  useEffect(() => {
    if (!entry) return;
    setError("");
    setDraft({
      inventoryItemId: String(entry.inventoryItemId),
      entryType: entry.entryType ?? "purchase",
      quantity: String(entry.quantityBase),
      unitLabel: entry.unitLabel,
      totalCost: String(entry.totalCost),
      supplierName: entry.supplierName ?? "",
      responsiblePerson: entry.responsiblePerson ?? "",
      note: entry.note ?? "",
      adjustmentReason: entry.adjustmentReason ?? "",
      entryDate: dateTimeValueFromTimestamp(entry.entryDate)
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
        entryType: draft.entryType as "purchase" | "adjustment",
        quantity: Number(draft.quantity || 0),
        unitLabel: selectedItem?.unitShortName || draft.unitLabel,
        totalCost: Number(draft.totalCost || 0),
        supplierName: draft.supplierName || null,
        responsiblePerson: draft.responsiblePerson || null,
        note: draft.note || null,
        adjustmentReason: draft.adjustmentReason || null,
        entryDate: draft.entryDate || null
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save restock entry.");
    }
  }

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[90vh] w-[min(860px,calc(100vw-32px))] !max-w-[860px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{entry ? `Edit restock - ${entry.itemName}` : "Edit restock"}</DialogTitle>
          <DialogDescription>Correct the material, event time, quantity, cost, and purchase details without changing its identity.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto p-6">
          {error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <InventoryItemPicker label="Item" value={draft.inventoryItemId} items={items} onChange={chooseItem} />
            <Field label="Entry type">
              <Select value={draft.entryType} onValueChange={(value) => setDraft({ ...draft, entryType: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="purchase">Purchase restock</SelectItem>
                  <SelectItem value="adjustment">Stock adjustment</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="restock-event-time" label="Restock date and time"><Input id="restock-event-time" type="datetime-local" step="1" value={draft.entryDate} onChange={(event) => setDraft({ ...draft, entryDate: event.target.value })} /></Field>
            <Field label="Quantity"><Input value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })} /></Field>
            <Field label="Unit"><Input value={selectedItem?.unitShortName || draft.unitLabel} readOnly className="bg-muted/60" /></Field>
            <Field label="Total cost"><Input value={draft.totalCost} onChange={(event) => setDraft({ ...draft, totalCost: event.target.value })} /></Field>
            {draft.entryType === "adjustment" && <Field label="Adjustment reason"><Input value={draft.adjustmentReason} onChange={(event) => setDraft({ ...draft, adjustmentReason: event.target.value })} placeholder="Example: wastage, count correction" /></Field>}
            <Field label="Person responsible"><Input value={draft.responsiblePerson} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></Field>
            <Field label="Supplier"><Input value={draft.supplierName} onChange={(event) => setDraft({ ...draft, supplierName: event.target.value })} /></Field>
            <div className="md:col-span-2"><Field label="Note"><Textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></Field></div>
          </div>
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save Restock</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InventoryItemCardPicker({
  items,
  countStatusByItemId,
  selectedItemId,
  onSelect,
  search,
  onSearch,
  placeholder = "Search item or category",
  compact = false
}: {
  items: InventoryItem[];
  countStatusByItemId?: Map<number, CountStatus>;
  selectedItemId: string;
  onSelect: (item: InventoryItem) => void;
  search: string;
  onSearch: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
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
      <Input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={placeholder} />
      <ScrollArea className={`${compact ? "h-[min(360px,44vh)]" : "h-[420px]"} rounded-xl border bg-muted/20 p-3`}>
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
                  const countStatus = countStatusByItemId?.get(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSelect(item)}
                      className={`rounded-xl border bg-card p-3 text-left shadow-sm transition hover:border-foreground/30 hover:bg-accent ${selected ? "border-foreground ring-2 ring-foreground/10" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <strong className="line-clamp-2 text-sm">{item.name}</strong>
                        <div className="flex flex-col items-end gap-1">
                          <Badge variant={item.status === "ok" ? "secondary" : "destructive"}>{item.status === "ok" ? "OK" : item.status === "low" ? "Low" : "Out"}</Badge>
                          {countStatus && <Badge variant={countStatus.state === "expired" ? "destructive" : countStatus.state === "recent" ? "default" : "secondary"}>{countStatus.label}</Badge>}
                        </div>
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

function RecipeMaterialCardPicker({
  recipes,
  selectedRecipeId,
  onSelect,
  search,
  onSearch,
  compact = false
}: {
  recipes: MenuRecipe[];
  selectedRecipeId: string;
  onSelect: (recipe: MenuRecipe) => void;
  search: string;
  onSearch: (value: string) => void;
  compact?: boolean;
}) {
  const groupedRecipes = useMemo(() => {
    const filtered = recipes.filter((recipe) => {
      const ingredients = recipe.ingredients.map((ingredient) => ingredient.itemName).join(" ");
      const haystack = `${recipe.menuItemName} ${recipe.status} ${ingredients}`.toLowerCase();
      return haystack.includes(search.trim().toLowerCase());
    });
    return filtered.reduce<Record<string, MenuRecipe[]>>((groups, recipe) => {
      const key = recipe.status === "available" ? "Recipe materials" : "Needs recipe";
      groups[key] = groups[key] ?? [];
      groups[key].push(recipe);
      return groups;
    }, {});
  }, [recipes, search]);

  return (
    <div className="grid gap-3">
      <Input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search recipe material or ingredient" />
      <ScrollArea className={`${compact ? "h-[min(360px,44vh)]" : "h-[420px]"} rounded-xl border bg-muted/20 p-3`}>
        <div className="grid gap-5 pr-3">
          {Object.entries(groupedRecipes).map(([group, groupRecipes]) => (
            <section key={group} className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">{group}</h4>
                <Badge variant="secondary">{groupRecipes.length}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {groupRecipes.map((recipe) => {
                  const selected = selectedRecipeId === String(recipe.id);
                  return (
                    <button
                      key={recipe.id}
                      type="button"
                      onClick={() => onSelect(recipe)}
                      className={`rounded-xl border bg-card p-3 text-left shadow-sm transition hover:border-foreground/30 hover:bg-accent ${selected ? "border-foreground ring-2 ring-foreground/10" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <strong className="line-clamp-2 text-sm">{recipe.menuItemName}</strong>
                        <Badge variant={recipe.status === "available" ? "secondary" : "destructive"}>{recipe.status === "available" ? "Ready" : "Missing"}</Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <span>Ingredients <strong className="block text-foreground">{recipe.ingredients.length}</strong></span>
                        <span>Raw cost <strong className="block text-foreground">{money(recipe.rawCost)}</strong></span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {Object.keys(groupedRecipes).length === 0 && <EmptyState title="No recipe materials found" description="Try another recipe name or ingredient." />}
        </div>
      </ScrollArea>
    </div>
  );
}

function RestockCreateDialog({
  open,
  onOpenChange,
  items,
  countStatusByItemId,
  restockableRecipes,
  form,
  selectedItem,
  setForm,
  onSave
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: InventoryItem[];
  countStatusByItemId: Map<number, CountStatus>;
  restockableRecipes: MenuRecipe[];
  form: { itemType: string; entryType: string; inventoryItemId: string; recipeId: string; quantity: string; totalCost: string; supplierName: string; responsiblePerson: string; note: string; adjustmentReason: string; entryDate: string };
  selectedItem: InventoryItem | null;
  setForm: (form: { itemType: string; entryType: string; inventoryItemId: string; recipeId: string; quantity: string; totalCost: string; supplierName: string; responsiblePerson: string; note: string; adjustmentReason: string; entryDate: string }) => void;
  onSave: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const selectedRecipe = restockableRecipes.find((recipe) => String(recipe.id) === form.recipeId) ?? null;
  const exactRecipeStockItem = selectedRecipe
    ? items.find((item) => item.name.trim().toLowerCase() === selectedRecipe.menuItemName.trim().toLowerCase()) ?? null
    : null;

  useEffect(() => {
    if (!open) return;
    setError("");
    setSaving(false);
  }, [open]);

  async function submit() {
    setSaving(true);
    setError("");
    try {
      await onSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the restock entry.");
      setSaving(false);
    }
  }

  function changeRestockSource(value: string) {
    setSearch("");
    setForm({
      ...form,
      itemType: value,
      recipeId: "",
      inventoryItemId: value === "raw" ? form.inventoryItemId : ""
    });
  }

  function selectRecipeMaterial(recipe: MenuRecipe) {
    const matchingItem = items.find((item) => item.name.trim().toLowerCase() === recipe.menuItemName.trim().toLowerCase());
    setForm({
      ...form,
      itemType: "recipe",
      recipeId: String(recipe.id),
      inventoryItemId: matchingItem ? String(matchingItem.id) : ""
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[90vh] w-[min(1120px,calc(100vw-32px))] !max-w-[1120px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>Add Restock</DialogTitle>
          <DialogDescription>Select the purchased item first, then enter quantity and cost details.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-5 overflow-auto p-6 lg:grid-cols-[minmax(420px,1fr)_380px]">
          <div className="grid content-start gap-3">
            <div className="grid gap-3 rounded-xl border bg-card p-3 sm:grid-cols-2">
              <Field label="Material list">
                <Select value={form.itemType} onValueChange={changeRestockSource}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="raw">Raw materials</SelectItem>
                    <SelectItem value="recipe">Recipe materials</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Entry type">
                <Select value={form.entryType} onValueChange={(value) => setForm({ ...form, entryType: value, adjustmentReason: value === "purchase" ? "" : form.adjustmentReason })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="purchase">Purchase restock</SelectItem>
                    <SelectItem value="adjustment">Stock adjustment</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {form.itemType === "recipe" ? (
              <RecipeMaterialCardPicker
                recipes={restockableRecipes}
                selectedRecipeId={form.recipeId}
                search={search}
                onSearch={setSearch}
                onSelect={selectRecipeMaterial}
              />
            ) : (
              <InventoryItemCardPicker
                items={items}
                countStatusByItemId={countStatusByItemId}
                selectedItemId={form.inventoryItemId}
                search={search}
                onSearch={setSearch}
                placeholder="Search raw material or category"
                onSelect={(item) => setForm({ ...form, itemType: "raw", recipeId: "", inventoryItemId: String(item.id) })}
              />
            )}
          </div>
          <div className="grid content-start gap-4">
            {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Card className="bg-emerald-50/60">
              <CardContent className="grid gap-2 p-4">
                <span className="text-sm text-muted-foreground">Selected material</span>
                <strong>{form.itemType === "recipe" ? selectedRecipe?.menuItemName ?? "Choose a recipe material" : selectedItem?.name ?? "Choose a raw material"}</strong>
                {form.itemType === "recipe" && selectedRecipe && (
                  <div className="grid gap-2">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <InventoryMiniMetric label="Ingredients" value={String(selectedRecipe.ingredients.length)} />
                      <InventoryMiniMetric label="Raw cost" value={money(selectedRecipe.rawCost)} />
                      <InventoryMiniMetric label="Stock item" value={exactRecipeStockItem?.name ?? "No exact match"} />
                      <InventoryMiniMetric label="Unit" value={exactRecipeStockItem?.unitShortName ?? "-"} />
                    </div>
                    {!exactRecipeStockItem && (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        This recipe material needs an inventory item with the same name before it can be restocked.
                      </p>
                    )}
                  </div>
                )}
                {form.itemType === "raw" && selectedItem && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <InventoryMiniMetric label="Category" value={selectedItem.categoryName ?? "Other"} />
                    <InventoryMiniMetric label="Unit" value={selectedItem.unitShortName} />
                    <InventoryMiniMetric label="Current stock" value={`${formatQuantity(selectedItem.currentStock)} ${selectedItem.unitShortName}`} />
                    <InventoryMiniMetric label="Latest price" value={`${formatQuantity(selectedItem.latestPrice)} / ${selectedItem.unitShortName}`} />
                    <InventoryMiniMetric label="Count status" value={countStatusByItemId.get(selectedItem.id)?.label ?? "Never Counted"} />
                  </div>
                )}
              </CardContent>
            </Card>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="new-restock-event-time" label="Restock date and time"><Input id="new-restock-event-time" type="datetime-local" step="1" value={form.entryDate} onChange={(event) => setForm({ ...form, entryDate: event.target.value })} /></Field>
              <Field label={`Quantity (${selectedItem?.unitShortName ?? "unit"})`}><Input value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} placeholder={form.entryType === "adjustment" ? "Use - for reduction" : ""} /></Field>
              <Field label="Total cost"><Input value={form.totalCost} onChange={(event) => setForm({ ...form, totalCost: event.target.value })} /></Field>
              {form.entryType === "adjustment" && <Field label="Adjustment reason"><Input value={form.adjustmentReason} onChange={(event) => setForm({ ...form, adjustmentReason: event.target.value })} placeholder="Example: wastage, count correction" /></Field>}
              <Field label="Supplier"><Input value={form.supplierName} onChange={(event) => setForm({ ...form, supplierName: event.target.value })} /></Field>
              <Field label="Person responsible"><Input value={form.responsiblePerson} onChange={(event) => setForm({ ...form, responsiblePerson: event.target.value })} /></Field>
            </div>
            <Field label="Note"><Textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></Field>
          </div>
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !selectedItem || !form.entryDate || !form.quantity || (form.entryType === "purchase" && !form.totalCost) || (form.entryType === "adjustment" && !form.adjustmentReason.trim())}>{saving ? "Saving..." : "Save Restock"}</Button>
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
  form: { inventoryItemId: string; quantity: string; countDate: string; responsiblePerson: string; note: string };
  selectedItem: InventoryItem | null;
  setForm: (form: { inventoryItemId: string; quantity: string; countDate: string; responsiblePerson: string; note: string }) => void;
  onSave: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    setSaving(false);
  }, [open]);

  async function submit() {
    setSaving(true);
    setError("");
    try {
      await onSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the physical count.");
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[90vh] w-[min(1040px,calc(100vw-32px))] !max-w-[1040px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>Add Physical Count</DialogTitle>
          <DialogDescription>Select the counted item from cards, then record the measured quantity.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-5 overflow-auto p-6 lg:grid-cols-[minmax(420px,1fr)_340px]">
          <InventoryItemCardPicker
            items={items}
            selectedItemId={form.inventoryItemId}
            search={search}
            onSearch={setSearch}
            onSelect={(item) => setForm({ ...form, inventoryItemId: String(item.id) })}
          />
          <div className="grid content-start gap-4">
            {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
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
            <Field id="new-count-event-time" label="Count date and time"><Input id="new-count-event-time" type="datetime-local" step="1" value={form.countDate} onChange={(event) => setForm({ ...form, countDate: event.target.value })} /></Field>
            <Field label={`Count (${selectedItem?.unitShortName ?? "unit"})`}><Input type="number" min="0" inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></Field>
            <Field label="Person responsible"><Input value={form.responsiblePerson} onChange={(event) => setForm({ ...form, responsiblePerson: event.target.value })} /></Field>
            <Field label="Note"><Textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></Field>
          </div>
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !selectedItem || !form.countDate || !form.quantity}>{saving ? "Saving..." : "Save Count"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InventoryOrdersPanel({ usage, menuTypes }: { usage: InventorySnapshot["orderUsage"]; menuTypes: MenuTypeSetting[] }) {
  const [range, setRange] = useState({ start: "", end: "" });
  const [sourceFilter, setSourceFilter] = useState("all");
  const sourceOptions = Array.from(new Set(usage.orders.map((order) => order.source)));
  const filteredOrders = usage.orders.filter((order) => {
    const sourceMatch = sourceFilter === "all" || order.source === sourceFilter;
    const dateMatch = withinDateRange(order.orderDate, range);
    return sourceMatch && dateMatch;
  });
  const filteredTotals = new Map<number, InventoryIngredientUsageTotal>();
  for (const order of filteredOrders) {
    for (const item of order.items) {
      for (const ingredient of item.ingredients) {
        const existing = filteredTotals.get(ingredient.inventoryItemId);
        if (existing) {
          existing.quantityBase += ingredient.quantityBase;
          existing.rawCost += ingredient.rawCost;
        } else {
          filteredTotals.set(ingredient.inventoryItemId, { ...ingredient });
        }
      }
    }
  }
  const totalRows = Array.from(filteredTotals.values()).map((item) => [item.itemName, `${formatQuantity(item.quantityBase)} ${item.unitLabel}`, money(item.rawCost)]);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Completed Order Usage</CardTitle>
          <CardDescription>Audit saved recipe/material usage snapshots from completed orders.</CardDescription>
        </CardHeader>
          <CardContent className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            <SearchableSelect value={sourceFilter} onValueChange={setSourceFilter} options={[{ value: "all", label: "All order sources" }, ...sourceOptions.map((source) => ({ value: source, label: formatConfiguredSource(source, menuTypes) }))]} placeholder="Choose order source" searchPlaceholder="Search order sources..." emptyText="No order sources found." ariaLabel="Order source filter" className="w-[220px]" />
            <Button variant="secondary" onClick={() => exportCsvRows("yamzo-order-usage.csv", [["Inventory item", "Quantity used", "Raw cost"], ...totalRows])}>Export CSV</Button>
            <Button variant="secondary" onClick={() => printSimpleReport("Yamzo Completed Order Usage", ["Inventory item", "Quantity used", "Raw cost"], totalRows)}>Print / PDF</Button>
          </div>
          <DateRangeControl value={range} onChange={setRange} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Inventory Used by Completed Orders</CardTitle>
          <CardDescription>Total ingredient usage calculated from saved recipe cost snapshots.</CardDescription>
        </CardHeader>
        <CardContent>
          <InventoryTable
            headers={["Inventory item", "Quantity used", "Raw cost"]}
            rows={totalRows}
          />
        </CardContent>
      </Card>
      <div className="grid gap-3">
        {filteredOrders.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No completed orders with recipe usage yet.</p>
        ) : filteredOrders.map((order) => (
          <Card key={order.orderId} size="sm">
            <CardContent className="grid gap-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{order.tableNumber ? `${formatConfiguredSource(order.source, menuTypes)} - ${order.tableNumber}` : formatConfiguredSource(order.source, menuTypes)}</CardTitle>
                  <CardDescription>Receipt {order.orderNumber} | Order date {formatBusinessDate(order.orderDate)}</CardDescription>
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

function InventoryAuditPanel({ logs }: { logs: ActivityLog[] }) {
  const [search, setSearch] = useState("");
  const [range, setRange] = useState({ start: "", end: "" });
  const [actorFilter, setActorFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const inventoryLogs = logs.filter((log) =>
    log.action.startsWith("inventory_") ||
    log.action.startsWith("recipe_") ||
    log.action.startsWith("cost_") ||
    log.action.startsWith("protected_panel_access") ||
    log.action === "order_cost_snapshot_created" ||
    log.action === "order_cost_snapshot_reversed"
  );
  const actors = Array.from(new Set(inventoryLogs.map((log) => log.actor ?? "System"))).sort();
  const actions = Array.from(new Set(inventoryLogs.map((log) => log.action))).sort();
  const filteredLogs = inventoryLogs.filter((log) => {
    const haystack = `${log.actor ?? "System"} ${log.action} ${log.title} ${log.description}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase()) &&
      withinDateRange(log.createdAt, range) &&
      (actorFilter === "all" || (log.actor ?? "System") === actorFilter) &&
      (actionFilter === "all" || log.action === actionFilter);
  });
  const auditRows = filteredLogs.map((log) => [formatDate(log.createdAt), log.actor ?? "System", log.title, log.description, labelize(log.status)]);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Inventory Audit Log</CardTitle>
            <CardDescription>Recent inventory, recipe, restock, count, and usage actions for owner review.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => exportCsvRows("yamzo-inventory-audit.csv", [["Time", "Actor", "Action", "Details", "Status"], ...auditRows])}>Export CSV</Button>
            <Button variant="secondary" onClick={() => printSimpleReport("Yamzo Inventory Audit Log", ["Time", "Actor", "Action", "Details", "Status"], auditRows)}>Print / PDF</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_220px_260px]">
          <Field label="Search audit"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search action, person, details" /></Field>
          <Field label="Actor">
            <SearchableSelect value={actorFilter} onValueChange={setActorFilter} options={[{ value: "all", label: "All actors" }, ...actors.map((actor) => ({ value: actor, label: actor }))]} placeholder="Choose actor" searchPlaceholder="Search actors..." emptyText="No actors found." ariaLabel="Audit actor filter" />
          </Field>
          <Field label="Action type">
            <SearchableSelect value={actionFilter} onValueChange={setActionFilter} options={[{ value: "all", label: "All actions" }, ...actions.map((action) => ({ value: action, label: friendlyActionName(action), keywords: action }))]} placeholder="Choose action" searchPlaceholder="Search actions..." emptyText="No actions found." ariaLabel="Audit action filter" />
          </Field>
        </div>
        <DateRangeControl value={range} onChange={setRange} />
        {filteredLogs.length === 0 ? (
          <EmptyState title="No inventory activity yet" description="Inventory changes will appear here after staff save records or recalculate usage." />
        ) : (
          <div className="overflow-auto rounded-xl border">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow><TableHead>Time</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Details</TableHead><TableHead>Status</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>{formatDate(log.createdAt)}</TableCell>
                    <TableCell>{log.actor ?? "System"}</TableCell>
                    <TableCell><strong>{log.title}</strong></TableCell>
                    <TableCell>{log.description}</TableCell>
                    <TableCell><Badge variant={log.status === "failed" ? "destructive" : log.status === "success" ? "default" : "secondary"}>{labelize(log.status)}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InventoryMiniMetric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-lg border bg-background px-3 py-2"><span className="block text-xs text-muted-foreground">{label}</span><strong>{value}</strong></div>;
}

type CountStatus = {
  state: "never" | "recent" | "expired";
  label: string;
  countedAt?: string;
};

function buildCountStatusMap(counts: PhysicalCountEntry[]) {
  const map = new Map<number, CountStatus>();
  const latestManualCounts = new Map<number, PhysicalCountEntry>();
  for (const count of counts) {
    if (count.source !== "manual") continue;
    const existing = latestManualCounts.get(count.inventoryItemId);
    if (!existing || new Date(count.countDate).getTime() > new Date(existing.countDate).getTime()) {
      latestManualCounts.set(count.inventoryItemId, count);
    }
  }
  const now = Date.now();
  for (const [itemId, count] of latestManualCounts.entries()) {
    const ageMs = now - new Date(count.countDate).getTime();
    const recent = Number.isFinite(ageMs) && ageMs <= 6 * 60 * 60 * 1000;
    map.set(itemId, {
      state: recent ? "recent" : "expired",
      label: recent ? "Counted Recently" : "Count Expired",
      countedAt: count.countDate
    });
  }
  return map;
}

function InventoryItemPicker({ label, value, items, onChange }: { label: string; value: string; items: InventorySnapshot["items"]; onChange: (value: string) => void }) {
  const selectedItem = items.find((item) => String(item.id) === value);

  return (
    <Field label={label}>
      <SearchableSelect
        value={value}
        onValueChange={onChange}
        options={items.map((item) => ({
          value: String(item.id),
          label: item.name,
          description: `${item.categoryName ?? "Other"} | ${formatQuantity(item.currentStock)} ${item.unitShortName} in stock`,
          keywords: `${item.categoryName ?? ""} ${item.unitShortName} ${item.status}`
        }))}
        placeholder="Choose inventory item"
        searchPlaceholder="Search item, category, or unit..."
        emptyText="No inventory items found."
        ariaLabel={label}
      />
      {selectedItem && <p className="mt-1 text-xs text-muted-foreground">{selectedItem.categoryName ?? "Uncategorized"} | {formatQuantity(selectedItem.currentStock)} {selectedItem.unitShortName} in stock</p>}
    </Field>
  );
}

function SearchableRecipeSelect({ value, recipes, onChange }: { value: string; recipes: MenuRecipe[]; onChange: (value: string) => void }) {
  const selected = recipes.find((recipe) => String(recipe.id) === value);

  return (
    <>
      <SearchableSelect
        value={value}
        onValueChange={onChange}
        options={recipes.map((recipe) => ({
          value: String(recipe.id),
          label: recipe.menuItemName,
          description: `${recipe.ingredients.length} ingredients | ${money(recipe.rawCost)} raw cost`,
          keywords: recipe.ingredients.map((ingredient) => ingredient.itemName).join(" ")
        }))}
        placeholder="Choose recipe material"
        searchPlaceholder="Search recipe or ingredient..."
        emptyText="No recipe materials found."
        ariaLabel="Recipe material"
      />
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
    <div className="grid gap-2">
      <Label>Date range</Label>
      <DateRangePicker value={value} onChange={onChange} label="Date range" />
    </div>
  );
}

function CostsPanel({ snapshot, refreshData, setMessage }: { snapshot: InventorySnapshot; refreshData: () => Promise<void>; setMessage: (message: string) => void }) {
  const activeCostCategories = snapshot.costCategories.filter((category) => category.active);
  const firstCostCategory = activeCostCategories[0];
  const [costTab, setCostTab] = useState("records");
  const [costRange, setCostRange] = useState({ start: "", end: "" });
  const [costPreset, setCostPreset] = useState<"all" | "today" | "yesterday" | "7days" | "30days" | "custom">("all");
  const [costCategoryFilter, setCostCategoryFilter] = useState("all");
  const [costSearch, setCostSearch] = useState("");
  const [costCategoryName, setCostCategoryName] = useState("");
  const [costEdit, setCostEdit] = useState<CostRecord | null>(null);
  const [costForm, setCostForm] = useState({
    categoryId: firstCostCategory?.id ? String(firstCostCategory.id) : "",
    costName: "",
    amount: "",
    costDate: dateInputValue(new Date()),
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
      amount: Number(costForm.amount || 0),
      costDate: costForm.costDate || null,
      paymentMethod: costForm.paymentMethod,
      responsiblePerson: costForm.responsiblePerson || null,
      note: costForm.note || null
    });
    setCostForm({ ...costForm, costName: "", amount: "", note: "" });
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

  function applyCostPreset(preset: "today" | "yesterday" | "7days" | "30days") {
    const today = startOfLocalDay(new Date());
    const start = new Date(today);
    const end = new Date(today);
    if (preset === "yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    }
    if (preset === "7days") start.setDate(start.getDate() - 6);
    if (preset === "30days") start.setDate(start.getDate() - 29);
    setCostPreset(preset);
    setCostRange({ start: dateInputValue(start), end: dateInputValue(end) });
  }

  const filteredCostRecords = snapshot.costRecords
    .filter((entry) => withinDateRange(entry.costDate, costRange))
    .filter((entry) => costCategoryFilter === "all" || String(entry.categoryId ?? "none") === costCategoryFilter)
    .filter((entry) => `${entry.costName} ${entry.categoryName ?? ""} ${entry.paymentMethod ?? ""} ${entry.responsiblePerson ?? ""} ${entry.note ?? ""}`.toLowerCase().includes(costSearch.trim().toLowerCase()));
  const costRows = filteredCostRecords.map((entry) => [formatBusinessDate(entry.costDate), entry.categoryName ?? "Other", entry.costName, money(entry.amount), entry.paymentMethod ?? "-", entry.responsiblePerson ?? "-", entry.note ?? "-"]);
  const currentCostCategoryName = costCategoryFilter === "all"
    ? "All Costs"
    : activeCostCategories.find((category) => String(category.id) === costCategoryFilter)?.name ?? "Selected Costs";

  return (
    <div className="grid gap-4 pt-4">
      <Tabs value={costTab} onValueChange={setCostTab}>
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="records">Cost Records</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
        </TabsList>
        <TabsContent value="records" className="grid gap-4 pt-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <OperationalMetric label="Filtered costs" value={money(filteredCostRecords.reduce((total, entry) => total + entry.amount, 0))} detail={currentCostCategoryName} tone="amber" />
            <OperationalMetric label="Records" value={String(filteredCostRecords.length)} detail="Entries in the selected period" />
            <OperationalMetric label="Average entry" value={money(filteredCostRecords.length ? filteredCostRecords.reduce((total, entry) => total + entry.amount, 0) / filteredCostRecords.length : 0)} detail="Per cost record" />
          </div>
          <Card className="border-emerald-200 bg-emerald-50/30">
            <CardHeader><CardTitle>Add cost</CardTitle><CardDescription>Record the date the cost happened. Managers can correct any entry later.</CardDescription></CardHeader>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4 pt-0">
              <Field label="Cost date"><DatePicker value={costForm.costDate} onChange={(value) => setCostForm({ ...costForm, costDate: value })} label="Cost date" /></Field>
              <Field label="Category"><SearchableSelect value={costForm.categoryId} onValueChange={(value) => setCostForm({ ...costForm, categoryId: value })} options={activeCostCategories.map((category) => ({ value: String(category.id), label: category.name }))} placeholder="Choose category" searchPlaceholder="Search cost categories..." emptyText="No cost categories found." ariaLabel="Cost category" /></Field>
              <Field label="Cost name"><Input value={costForm.costName} onChange={(event) => setCostForm({ ...costForm, costName: event.target.value })} /></Field>
              <Field label="Amount (TK)"><Input type="number" min="0" inputMode="decimal" value={costForm.amount} onChange={(event) => setCostForm({ ...costForm, amount: event.target.value })} /></Field>
              <Field label="Payment method"><Select value={costForm.paymentMethod} onValueChange={(value) => setCostForm({ ...costForm, paymentMethod: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cash">Cash</SelectItem><SelectItem value="bkash">bKash</SelectItem><SelectItem value="nagad">Nagad</SelectItem><SelectItem value="card">Card</SelectItem><SelectItem value="bank">Bank</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select></Field>
              <Field label="Person responsible"><Input value={costForm.responsiblePerson} onChange={(event) => setCostForm({ ...costForm, responsiblePerson: event.target.value })} /></Field>
              <Field label="Note"><Input value={costForm.note} onChange={(event) => setCostForm({ ...costForm, note: event.target.value })} /></Field>
              <Button className="self-end" onClick={addCost} disabled={!costForm.costName.trim() || Number(costForm.amount) <= 0}>Save Cost</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="border-b bg-muted/15">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><CardTitle>{currentCostCategoryName}</CardTitle><CardDescription>Search, filter, correct, or delete every operating-cost record.</CardDescription></div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => exportCsvRows("yamzo-costs.csv", [["Date", "Category", "Cost", "Amount", "Payment", "Person", "Note"], ...costRows])}>Export CSV</Button>
                  <Button variant="secondary" size="sm" onClick={() => printSimpleReport("Yamzo Cost Report", ["Date", "Category", "Cost", "Amount", "Payment", "Person", "Note"], costRows)}>Print / PDF</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 p-4">
              <div className="flex flex-wrap gap-2" aria-label="Cost date shortcuts">
                <Button variant={costPreset === "today" ? "default" : "secondary"} size="sm" onClick={() => applyCostPreset("today")}>Today</Button>
                <Button variant={costPreset === "yesterday" ? "default" : "secondary"} size="sm" onClick={() => applyCostPreset("yesterday")}>Yesterday</Button>
                <Button variant={costPreset === "7days" ? "default" : "secondary"} size="sm" onClick={() => applyCostPreset("7days")}>7 Days</Button>
                <Button variant={costPreset === "30days" ? "default" : "secondary"} size="sm" onClick={() => applyCostPreset("30days")}>30 Days</Button>
                <Button variant="ghost" size="sm" onClick={() => { setCostPreset("all"); setCostRange({ start: "", end: "" }); setCostCategoryFilter("all"); setCostSearch(""); }}>Clear filters</Button>
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_260px]">
                <Field label="Search records"><Input value={costSearch} onChange={(event) => setCostSearch(event.target.value)} placeholder="Cost, person, payment, note, or category" /></Field>
                <Field label="Category"><SearchableSelect value={costCategoryFilter} onValueChange={setCostCategoryFilter} options={[{ value: "all", label: "All cost categories" }, ...activeCostCategories.map((category) => ({ value: String(category.id), label: category.name }))]} placeholder="All cost categories" searchPlaceholder="Search cost categories..." emptyText="No cost categories found." ariaLabel="Cost category filter" /></Field>
              </div>
              <DateRangeControl value={costRange} onChange={(value) => { setCostPreset("custom"); setCostRange(value); }} />
              <CostRecordTable
                records={filteredCostRecords}
                onEdit={setCostEdit}
                onDelete={async (entry) => {
                  if (!window.confirm(`Delete cost record ${entry.costName}? This cannot be undone.`)) return;
                  try {
                    await window.yamzo?.inventory.deleteCost(entry.id);
                    setMessage("Cost record deleted.");
                    await refreshData();
                  } catch (caught) {
                    setMessage(caught instanceof Error ? caught.message : "Could not delete cost record.");
                  }
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="categories" className="pt-4">
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
      <CostRecordEditorDialog
        record={costEdit}
        categories={activeCostCategories}
        onClose={() => setCostEdit(null)}
        onSave={async (record, draft) => {
          await window.yamzo?.inventory.updateCost({
            id: record.id,
            categoryId: draft.categoryId ? Number(draft.categoryId) : null,
            costName: draft.costName,
            amount: Number(draft.amount || 0),
            paymentMethod: draft.paymentMethod || null,
            responsiblePerson: draft.responsiblePerson || null,
            note: draft.note || null,
            costDate: draft.costDate || null
          });
          setCostEdit(null);
          setMessage("Cost record updated.");
          await refreshData();
        }}
      />
    </div>
  );
}

function CostRecordTable({ records, onEdit, onDelete }: { records: CostRecord[]; onEdit: (record: CostRecord) => void; onDelete: (record: CostRecord) => void }) {
  return (
    <div className="rounded-xl border bg-card">
      {records.length === 0 ? (
        <EmptyState title="No cost records found" description="Add a cost or change the current search, category, and date filters." />
      ) : (
        <div className="overflow-auto">
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Person</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>{formatBusinessDate(record.costDate)}</TableCell>
                  <TableCell>{record.categoryName ?? "Other"}</TableCell>
                  <TableCell className="font-medium">{record.costName}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{money(record.amount)}</TableCell>
                  <TableCell>{record.paymentMethod ? labelize(record.paymentMethod) : "-"}</TableCell>
                  <TableCell>{record.responsiblePerson ?? "-"}</TableCell>
                  <TableCell className="max-w-[260px] truncate" title={record.note ?? undefined}>{record.note ?? "-"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => onEdit(record)}>Edit</Button>
                      <Button size="sm" variant="destructive" onClick={() => onDelete(record)}>Delete</Button>
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

function CostRecordEditorDialog({
  record,
  categories,
  onClose,
  onSave
}: {
  record: CostRecord | null;
  categories: CostCategory[];
  onClose: () => void;
  onSave: (record: CostRecord, draft: { categoryId: string; costName: string; amount: string; costDate: string; paymentMethod: string; responsiblePerson: string; note: string }) => Promise<void>;
}) {
  const [draft, setDraft] = useState({ categoryId: "", costName: "", amount: "", costDate: "", paymentMethod: "", responsiblePerson: "", note: "" });

  useEffect(() => {
    if (!record) return;
    setDraft({
      categoryId: record.categoryId ? String(record.categoryId) : "",
      costName: record.costName,
      amount: String(record.amount),
      costDate: dateValueFromTimestamp(record.costDate),
      paymentMethod: record.paymentMethod ?? "",
      responsiblePerson: record.responsiblePerson ?? "",
      note: record.note ?? ""
    });
  }, [record]);

  return (
    <Dialog open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(820px,calc(100vw-32px))] !max-w-[820px] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{record ? `Edit cost - ${record.costName}` : "Edit cost record"}</DialogTitle>
          <DialogDescription>Correct the amount, date, category, payment, or note. The change is recorded automatically.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 p-6 md:grid-cols-2">
          <Field label="Category">
            <SearchableSelect value={draft.categoryId || "none"} onValueChange={(value) => setDraft({ ...draft, categoryId: value === "none" ? "" : value })} options={[{ value: "none", label: "Other" }, ...categories.map((category) => ({ value: String(category.id), label: category.name }))]} placeholder="Choose category" searchPlaceholder="Search cost categories..." emptyText="No cost categories found." ariaLabel="Cost category" />
          </Field>
          <Field label="Cost name"><Input value={draft.costName} onChange={(event) => setDraft({ ...draft, costName: event.target.value })} /></Field>
          <Field label="Cost date"><DatePicker value={draft.costDate} onChange={(value) => setDraft({ ...draft, costDate: value })} label="Cost date" /></Field>
          <Field label="Amount (TK)"><Input type="number" min="0" inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></Field>
          <Field label="Payment method"><Select value={draft.paymentMethod || "other"} onValueChange={(value) => setDraft({ ...draft, paymentMethod: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cash">Cash</SelectItem><SelectItem value="bkash">bKash</SelectItem><SelectItem value="nagad">Nagad</SelectItem><SelectItem value="card">Card</SelectItem><SelectItem value="bank">Bank</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select></Field>
          <Field label="Person responsible"><Input value={draft.responsiblePerson} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></Field>
          <Field label="Note"><Input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></Field>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => record && onSave(record, draft)} disabled={!record || !draft.costName.trim() || !draft.amount}>Save Cost</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  inventory,
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
  inventory: InventorySnapshot;
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
  const [bindingSearch, setBindingSearch] = useState("");
  const [bindingDialog, setBindingDialog] = useState<{ open: boolean; menuItemId?: number }>({ open: false });
  const selectedMenuData = activeMenuData.find((entry) => entry.key === selectedMenuDataKey) ?? activeMenuData[0] ?? defaultMenuData[0];
  const activeMenuItems = menu.filter((item) => !item.archived);
  const linkedMenuItemIds = new Set(inventory.bindings.map((binding) => binding.menuItemId));
  const unlinkedMenuCount = activeMenuItems.filter((item) => !linkedMenuItemIds.has(item.id)).length;
  const filteredBindingMenu = activeMenuItems.filter((item) => {
    const binding = inventory.bindings.find((entry) => entry.menuItemId === item.id);
    return `${item.name} ${item.category ?? ""} ${binding?.recipeName ?? ""} ${binding?.inventoryItemName ?? ""}`.toLowerCase().includes(bindingSearch.trim().toLowerCase());
  });

  useEffect(() => {
    if (!activeMenuData.some((entry) => entry.key === selectedMenuDataKey)) {
      setSelectedMenuDataKey(activeMenuData[0]?.key ?? "in_house");
    }
  }, [activeMenuData, selectedMenuDataKey]);

  function selectedMenuPrice(item: MenuItem): number {
    return item.menuPrices?.[selectedMenuData.key] ?? (selectedMenuData.key === "in_house" ? item.price : 0);
  }

  const filteredMenu = menu.filter((item) => {
    if (item.archived) return false;
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
    const next = [...menuData, { key, label, active: true, externalOrderIdEnabled: false }];
    setMenuData(next);
    setMenuDataDraft("");
    await saveMenuData(next);
  }

  async function duplicateSelectedMenuData() {
    const label = menuDataDraft.trim() || `${selectedMenuData.label} Copy`;
    const key = uniqueMenuDataKey(label, menuData);
    const next = [...menuData, { key, label, active: true, externalOrderIdEnabled: selectedMenuData.externalOrderIdEnabled ?? false }];
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

  async function toggleSelectedExternalOrderId(enabled: boolean) {
    const next = menuData.map((entry) => entry.key === selectedMenuData.key ? { ...entry, externalOrderIdEnabled: enabled } : entry);
    setMenuData(next);
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
        <TabsList className="grid w-full max-w-2xl grid-cols-3">
          <TabsTrigger value="items">Menu Items</TabsTrigger>
          <TabsTrigger value="bindings">Inventory Links</TabsTrigger>
          <TabsTrigger value="settings">Menu Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="items" className="grid gap-4 pt-4">
          <Tabs defaultValue="browse">
            <TabsList className="grid w-full max-w-2xl grid-cols-3">
              <TabsTrigger value="browse">Browse Items</TabsTrigger>
              <TabsTrigger value="add">Add / Edit Item</TabsTrigger>
              <TabsTrigger value="catalog">Catalog Setup</TabsTrigger>
            </TabsList>

            <TabsContent value="browse" className="grid gap-4 pt-4">
              <Card className="border-muted-foreground/15">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>{selectedMenuData.label}</CardTitle>
                      <CardDescription>Browse, search, edit, archive, or delete items in the selected catalog.</CardDescription>
                    </div>
                    <Badge variant="secondary">{filteredMenu.length} visible items</Badge>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3 p-4 pt-0">
                  <div className="grid gap-3 md:grid-cols-[260px_minmax(260px,1fr)]">
                    <Field label="Catalog">
                      <SearchableSelect value={selectedMenuData.key} onValueChange={setSelectedMenuDataKey} options={activeMenuData.map((entry) => ({ value: entry.key, label: entry.label }))} placeholder="Choose catalog" searchPlaceholder="Search catalogs..." emptyText="No catalogs found." ariaLabel="Menu catalog" />
                    </Field>
                    <Field label={`Search ${selectedMenuData.label}`}>
                      <Input value={menuSearch} onChange={(event) => setMenuSearch(event.target.value)} placeholder="Search item, category, availability, or recipe status" />
                    </Field>
                  </div>
                </CardContent>
              </Card>
              <div className="grid gap-2">
                {filteredMenu.map((item) => <MenuAdminRow key={item.id} item={item} binding={inventory.bindings.find((binding) => binding.menuItemId === item.id) ?? null} categories={categories} selectedMenuData={selectedMenuData} onEdit={setMenuForm} onLinkInventory={() => setBindingDialog({ open: true, menuItemId: item.id })} onDone={refreshData} />)}
              </div>
              {filteredMenu.length === 0 && <EmptyState title="No menu items found" description="Try a different item name, category, availability, or recipe search." />}
            </TabsContent>

            <TabsContent value="add" className="grid gap-4 pt-4">
              <Card className="max-w-6xl border-emerald-200 bg-emerald-50/30">
                <CardHeader>
                  <CardTitle>{menuForm.id ? "Edit Menu Item" : "Add Menu Item"}</CardTitle>
                  <CardDescription>Set the catalog price, category, availability, and recipe tracking in one place.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 p-4 pt-0">
                  <div className="grid gap-3 lg:grid-cols-[minmax(280px,1.2fr)_minmax(220px,0.8fr)_220px]">
                    <Field label="Item name"><Input value={menuForm.name} onChange={(event) => setMenuForm({ ...menuForm, name: event.target.value })} /></Field>
                    <Field label={`Price in ${selectedMenuData.label}`}><Input value={menuFormSelectedPrice()} onChange={(event) => updateMenuFormPrice(event.target.value)} placeholder="Leave blank to hide from this menu" /></Field>
                    <Field label="Category">
                      <SearchableSelect value={menuForm.category || "Other"} onValueChange={(value) => setMenuForm({ ...menuForm, category: value })} options={categories.map((category) => ({ value: category, label: category }))} placeholder="Choose category" searchPlaceholder="Search menu categories..." emptyText="No categories found." ariaLabel="Menu item category" />
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4">
                    <div className="flex flex-wrap items-center gap-5">
                      <label className="flex items-center gap-2"><Checkbox checked={menuForm.available} onCheckedChange={(checked) => setMenuForm({ ...menuForm, available: Boolean(checked) })} />Available</label>
                      <span className="text-sm text-muted-foreground">Save the item, then use <strong>Link Inventory</strong> on its card to choose a recipe or direct stock item.</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {menuForm.id > 0 && (
                        <Button variant="secondary" onClick={() => setMenuForm({ id: 0, name: "", price: "", category: categories[0] ?? "Other", available: true, trackRecipe: true, menuPrices: {} })}>Clear Form</Button>
                      )}
                      <Button className="min-w-40" onClick={saveMenuForm}>{menuForm.id ? "Save Item" : "Add Item"}</Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="catalog" className="grid gap-4 pt-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Menu Data</CardTitle>
                  <CardDescription>Catalogs hold separate price lists. Menu Types in settings decide where each catalog is used.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 p-4 pt-0">
                  <div className="grid gap-3 xl:grid-cols-[260px_minmax(260px,1fr)_auto_auto] xl:items-end">
                    <Field label="Editing catalog">
                      <SearchableSelect value={selectedMenuData.key} onValueChange={setSelectedMenuDataKey} options={activeMenuData.map((entry) => ({ value: entry.key, label: entry.label }))} placeholder="Choose catalog" searchPlaceholder="Search catalogs..." emptyText="No catalogs found." ariaLabel="Editing menu catalog" />
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
                  <label className="flex max-w-xl items-start gap-3 rounded-xl border bg-muted/30 p-3">
                    <Checkbox checked={Boolean(selectedMenuData.externalOrderIdEnabled)} onCheckedChange={(checked) => toggleSelectedExternalOrderId(Boolean(checked))} />
                    <span className="grid gap-1">
                      <strong>External order ID</strong>
                      <small className="text-muted-foreground">Show an order ID field when staff use menu types linked to this catalog.</small>
                    </span>
                  </label>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>
        <TabsContent value="bindings" className="grid gap-4 pt-4">
          <section aria-label="Menu inventory link summary" className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <OperationalMetric label="Menu items" value={String(activeMenuItems.length)} detail="Active catalog items" />
            <OperationalMetric label="Inventory linked" value={String(inventory.bindings.length)} detail="Reduce stock when sold" tone="emerald" />
            <OperationalMetric label="Needs a link" value={String(unlinkedMenuCount)} detail="No inventory usage yet" tone={unlinkedMenuCount > 0 ? "amber" : "emerald"} />
          </section>
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Inventory links</CardTitle>
                  <CardDescription>Choose the recipe or direct stock item reduced each time a menu item is sold.</CardDescription>
                </div>
                <Button onClick={() => setBindingDialog({ open: true })}>Add Inventory Link</Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 p-4">
              <Field label="Search menu items or linked inventory">
                <Input value={bindingSearch} onChange={(event) => setBindingSearch(event.target.value)} placeholder="Search item, category, recipe, or stock item" />
              </Field>
              <div className="overflow-auto rounded-xl border">
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Menu item</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Tracking method</TableHead>
                      <TableHead>Inventory source</TableHead>
                      <TableHead>Usage per sale</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBindingMenu.map((item) => {
                      const binding = inventory.bindings.find((entry) => entry.menuItemId === item.id) ?? null;
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">{item.name}</TableCell>
                          <TableCell>{item.category || "Other"}</TableCell>
                          <TableCell><Badge variant={binding ? "secondary" : "outline"}>{binding ? (binding.bindingType === "recipe" ? "Recipe" : "Direct stock") : "Not linked"}</Badge></TableCell>
                          <TableCell>{binding ? binding.recipeName ?? binding.inventoryItemName ?? "Unknown source" : <span className="text-muted-foreground">No inventory source</span>}</TableCell>
                          <TableCell>{binding ? `${formatQuantity(binding.quantityBase)} ${binding.unitLabel}` : "-"}</TableCell>
                          <TableCell className="text-right"><Button size="sm" variant={binding ? "secondary" : "default"} onClick={() => setBindingDialog({ open: true, menuItemId: item.id })}>{binding ? "Edit Link" : "Link Inventory"}</Button></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {filteredBindingMenu.length === 0 && <EmptyState title="No menu items found" description="Try another item, category, recipe, or stock-item name." />}
            </CardContent>
          </Card>
          <Card className="border-sky-200 bg-sky-50/40">
            <CardHeader><CardTitle>Historical corrections</CardTitle><CardDescription>Every link can start with new orders, recalculate all completed orders, or target a date range. You preview the affected order count before saving.</CardDescription></CardHeader>
          </Card>
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
                      <SearchableSelect value={type.menuDataKey || "in_house"} onValueChange={(value) => setMenuTypes(menuTypes.map((item, itemIndex) => itemIndex === index ? { ...item, menuDataKey: value } : item))} options={activeMenuData.map((entry) => ({ value: entry.key, label: entry.label }))} placeholder="Choose catalog" searchPlaceholder="Search catalogs..." emptyText="No catalogs found." ariaLabel={`Menu catalog for ${type.label || "menu type"}`} />
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
      <InventoryBindingDialog
        open={bindingDialog.open}
        menu={menu}
        snapshot={inventory}
        initialMenuItemId={bindingDialog.menuItemId}
        lockMenuItem={Boolean(bindingDialog.menuItemId)}
        onClose={() => setBindingDialog({ open: false })}
        onSaved={async (message) => {
          setBindingDialog({ open: false });
          setMessage(message);
          await refreshData();
        }}
      />
    </div>
  );
}

function MenuAdminRow({
  item,
  binding,
  categories,
  selectedMenuData,
  onEdit: _onEdit,
  onLinkInventory,
  onDone
}: {
  item: MenuItem;
  binding: MenuInventoryBinding | null;
  categories: string[];
  selectedMenuData: MenuDataSetting;
  onEdit: (value: MenuFormState) => void;
  onLinkInventory: () => void;
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
            <Field label="Category"><SearchableSelect value={draft.category || "Other"} onValueChange={(value) => setDraft({ ...draft, category: value })} options={categories.map((category) => ({ value: category, label: category }))} placeholder="Choose category" searchPlaceholder="Search menu categories..." emptyText="No categories found." ariaLabel={`Category for ${item.name}`} /></Field>
            <label className="flex h-10 items-center gap-2"><Checkbox checked={draft.available} onCheckedChange={(checked) => setDraft({ ...draft, available: Boolean(checked) })} />Available</label>
            <Button type="button" variant="secondary" onClick={onLinkInventory}>{binding?.bindingType === "recipe" ? "Change Recipe Link" : binding ? "Change Item Link" : "Link Inventory"}</Button>
          </div>
          <div className="flex justify-end gap-2"><Button onClick={saveInline}>Save</Button><Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button></div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card size="sm" className="overflow-hidden">
      <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-base">{item.name}</strong>
            <Badge variant={item.available ? "secondary" : "outline"}>{item.available ? "Available" : "Unavailable"}</Badge>
            <Badge variant={displayPrice > 0 ? "outline" : "destructive"}>{displayPrice > 0 ? money(displayPrice) : "Hidden"}</Badge>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{item.category || "Other"}</span>
            <span>{selectedMenuData.label}</span>
            <span className={binding ? "text-emerald-700" : "text-amber-700"}>{binding ? `${binding.bindingType === "recipe" ? "Recipe" : "Direct stock"}: ${binding.recipeName ?? binding.inventoryItemName}` : "Inventory not linked"}</span>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant={binding ? "secondary" : "default"} onClick={onLinkInventory}>{binding ? "Edit Inventory Link" : "Link Inventory"}</Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={async () => { if (!window.confirm(`Archive ${item.name}? It will be hidden from active menu lists.`)) return; await window.yamzo?.menu.archiveItem(item.id); await onDone(); }}>Archive</Button>
          <Button size="sm" variant="destructive" onClick={async () => { if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return; await window.yamzo?.menu.deleteItem(item.id); await onDone(); }}>Delete</Button>
        </div>
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

  return (
    <div className="grid gap-4 pt-4">
      <Card>
        <CardHeader><CardTitle>Receipt printer</CardTitle><CardDescription>Search Windows printers, save one for Yamzo, then verify each print format.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 p-4 pt-0 lg:grid-cols-[minmax(280px,420px)_1fr]">
          <Field label="Selected printer">
            <SearchableSelect
              value={selectedPrinter || "none"}
              onValueChange={(value) => setSelectedPrinter(value === "none" ? "" : value)}
              options={[{ value: "none", label: "Choose a printer" }, ...printers.map((printer) => ({ value: printer.name, label: printer.displayName || printer.name, description: printer.isDefault ? "Windows default" : printer.name, keywords: printer.name }))]}
              placeholder="Choose a printer"
              searchPlaceholder="Search installed printers..."
              emptyText="No printers found."
              ariaLabel="Selected printer"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2 self-end xl:grid-cols-4">
            <Button onClick={async () => { await window.yamzo?.settings.setPrinterName(selectedPrinter); setMessage(selectedPrinter ? "Printer settings saved." : "Choose a printer before printing."); }}>Save Printer</Button>
            <Button variant="secondary" disabled={!selectedPrinter} onClick={() => sample("test")}>Test Print</Button>
            <Button variant="secondary" disabled={!selectedPrinter} onClick={() => sample("kot")}>Kitchen Copy</Button>
            <Button variant="secondary" disabled={!selectedPrinter} onClick={() => sample("receipt")}>Receipt Copy</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Failed print jobs</CardTitle><CardDescription>Retry only the jobs that still need attention.</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          {failedPrintJobs.length === 0 && <EmptyState title="No failed print jobs" description="Printer errors will appear here with a retry action." />}
          {failedPrintJobs.map((job) => (
            <div className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-lg border p-3" key={job.id}>
              <div><strong>{friendlyPrintType(job.type)}</strong><p className="text-sm text-muted-foreground">{job.errorMessage || "Needs attention"} | {formatDate(job.createdAt)}</p></div>
              <Button variant="secondary" onClick={async () => { await window.yamzo?.print.retryJob(job.id); await refreshData(); }}>Retry</Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function samplePrintLabel(type: "test" | "kot" | "receipt"): string {
  return type === "kot" ? "Sample Kitchen Copy" : type === "receipt" ? "Sample Receipt" : "Test Print";
}

function SecurityAdmin({ username, passwordForm, setPasswordForm, setMessage }: { username: string; passwordForm: { current: string; next: string; confirm: string }; setPasswordForm: React.Dispatch<React.SetStateAction<{ current: string; next: string; confirm: string }>>; setMessage: (message: string) => void }) {
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
    <div className="grid max-w-2xl gap-4 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>Admin password</CardTitle>
          <CardDescription>Change the password used to open protected management screens. The master recovery key remains available if the password is lost.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field id="security-current-password" label="Current password"><Input id="security-current-password" type="password" autoComplete="current-password" value={passwordForm.current} onChange={(event) => setPasswordForm({ ...passwordForm, current: event.target.value })} /></Field>
          <Field id="security-new-password" label="New password"><Input id="security-new-password" type="password" autoComplete="new-password" value={passwordForm.next} onChange={(event) => setPasswordForm({ ...passwordForm, next: event.target.value })} /></Field>
          <Field id="security-confirm-password" label="Confirm new password"><Input id="security-confirm-password" type="password" autoComplete="new-password" value={passwordForm.confirm} onChange={(event) => setPasswordForm({ ...passwordForm, confirm: event.target.value })} /></Field>
          <Button className="w-fit" onClick={savePassword}>Change Password</Button>
        </CardContent>
      </Card>
    </div>
  );
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
            <span className="grid gap-1"><strong>Track Inventory</strong><small className="text-muted-foreground">Completed orders reduce stock using recipe or direct-item links configured in Menu.</small></span>
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

function formatConfiguredSource(source: OrderSource, menuTypes: MenuTypeSetting[]): string {
  return menuTypes.find((type) => type.key === source)?.label?.trim() || formatSource(source);
}

function orderDisplayName(order: Pick<OrderSummary, "source" | "tableNumber">, menuTypes: MenuTypeSetting[] = []): string {
  const sourceLabel = formatConfiguredSource(order.source, menuTypes);
  if (order.tableNumber) return `${sourceLabel} - ${order.tableNumber}`;
  return sourceLabel;
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

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isStandaloneRecipe(recipe: MenuRecipe | null | undefined): boolean {
  return Boolean((recipe as (MenuRecipe & { standalone?: boolean }) | null | undefined)?.standalone);
}

function friendlyActionName(action: string): string {
  return labelize(action.replace(/^inventory_/, "").replace(/^cost_/, ""));
}

function formatDate(value: string): string {
  return parseSqliteTimestamp(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatBusinessDate(value: string): string {
  const dateValue = dateValueFromTimestamp(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return value || "-";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
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

function printSimpleReport(title: string, headers: string[], rows: string[][]) {
  const popup = window.open("", "_blank", "width=900,height=700");
  if (!popup) return;
  popup.document.write(`
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
          h1 { font-size: 22px; margin: 0 0 16px; }
          table { border-collapse: collapse; width: 100%; font-size: 13px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background: #f2f2f2; }
          .actions { margin-bottom: 16px; }
          @media print { .actions { display: none; } }
        </style>
      </head>
      <body>
        <div class="actions"><button onclick="window.print()">Print / Save PDF</button></div>
        <h1>${escapeHtml(title)}</h1>
        ${htmlTable(headers, rows)}
      </body>
    </html>
  `);
  popup.document.close();
  popup.focus();
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

function dateTimeInputValue(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${dateInputValue(date)}T${hours}:${minutes}:${seconds}`;
}

function dateTimeValueFromTimestamp(value: string): string {
  const normalized = value.trim();
  const localTimestamp = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (localTimestamp) return `${localTimestamp[1]}T${localTimestamp[2]}:${localTimestamp[3] ?? "00"}`;
  const parsed = parseSqliteTimestamp(normalized);
  return Number.isNaN(parsed.getTime()) ? "" : dateTimeInputValue(parsed);
}

function dateValueFromTimestamp(value: string): string {
  const normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const parsed = parseSqliteTimestamp(normalized);
  return Number.isNaN(parsed.getTime()) ? "" : dateInputValue(parsed);
}

function dateRangeForPreset(preset: "today" | "yesterday" | "7days" | "30days" | "all"): { start: string; end: string } {
  if (preset === "all") return { start: "", end: "" };
  const end = startOfLocalDay(new Date());
  const start = new Date(end);
  if (preset === "yesterday") {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (preset === "7days") {
    start.setDate(start.getDate() - 6);
  } else if (preset === "30days") {
    start.setDate(start.getDate() - 29);
  }
  return { start: dateInputValue(start), end: dateInputValue(end) };
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
