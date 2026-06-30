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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  BrandingSettings,
  EmailSettings,
  ActivityLog,
  InventorySnapshot,
  MenuImportResult,
  MenuItem,
  OrderDetail,
  OrderLine,
  OrderSource,
  OrderSummary,
  PaymentMethod,
  PrintJob,
  SalesSummary
} from "../../shared/types";
import { demoMenu, demoOrders, demoSummary } from "../data/demo";

type Screen = "newOrder" | "editOrder" | "openOrders" | "completedOrders" | "cancelledOrders" | "reports" | "admin";
type AdminTab = "menu" | "inventory" | "receipt" | "printer" | "email" | "app" | "adminSettings" | "activity";
type DiscountMode = "tk" | "percent";
type OrderLane = "newOrder" | "openOrders";
type PrintConfirm = { type: "kitchen" | "bill"; orderId: number; orderNumber: string } | null;
type NoteEdit = { line: OrderLine; draft: string } | null;
type ProtectedScreen = "completedOrders" | "cancelledOrders" | "admin";

interface PrinterOption {
  name: string;
  displayName: string;
  isDefault: boolean;
}

const sources: Array<{ value: OrderSource; label: string }> = [
  { value: "in_house", label: "Dine-in" },
  { value: "parcel", label: "Parcel" },
  { value: "delivery", label: "Delivery" },
  { value: "foodpanda", label: "Foodpanda" },
  { value: "foodie", label: "Foodie" },
  { value: "other", label: "Other" }
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
  priceHistory: [],
  costCategories: [],
  costRecords: [],
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
  const [adminTab, setAdminTab] = useState<AdminTab>("menu");
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
  const [selectedHost, setSelectedHost] = useState("Cashier");
  const [hostDraft, setHostDraft] = useState("");
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
  const [menuForm, setMenuForm] = useState({ id: 0, name: "", price: "", category: "", available: true });
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
  const isExternalOrder = ["foodpanda", "foodie", "other"].includes(source);
  const canPrintKitchen = !isExternalOrder || externalKitchenEnabled;
  const needsDineInTable = source === "in_house" && !tableNumber.trim();
  const failedPrintJobs = printJobs.filter((job) => job.status === "failed" || job.status === "retry");
  const completedOrders = history.filter((order) => order.status === "settled");
  const cancelledOrders = history.filter((order) => order.status === "cancelled");
  const openOrderByTable = useMemo(() => {
    const map = new Map<string, OrderSummary>();
    for (const order of openOrders) {
      if (order.source === "in_house" && order.tableNumber) {
        map.set(order.tableNumber, order);
      }
    }
    return map;
  }, [openOrders]);

  async function refreshData() {
    if (!window.yamzo) return;
    const [menuRows, openRows, historyRows, sales, jobs, email, receipt, inventory, inventoryData, printerName, tableCount, hosts, activity] = await Promise.all([
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
    setSource("in_house");
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
    if (source === "in_house" && !tableNumber.trim()) {
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
    const created = await window.yamzo.orders.create({ source, tableNumber: tableNumber || undefined, note: orderNote || undefined });
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
    const nextTable = nextSource === "in_house" ? tableNumber : "";
    if (nextSource !== "in_house") setTableNumber("");
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
    await window.yamzo.menu.saveItem({
      id: menuForm.id || undefined,
      name: menuForm.name,
      price: Number(menuForm.price),
      category: menuForm.category || null,
      available: menuForm.available
    });
    setMenuForm({ id: 0, name: "", price: "", category: "", available: true });
    setMessage("Menu item saved.");
    await refreshData();
  }

  async function chooseReceiptImage(type: "logoPath" | "qrPath") {
    const picked = (await window.yamzo?.settings.chooseImage()) ?? "";
    if (picked) setBranding((current) => ({ ...current, [type]: picked, [type === "logoPath" ? "showLogo" : "showQr"]: true }));
  }

  async function saveAppSettings(nextTables = totalTables) {
    await window.yamzo?.settings.setInventoryTracking(trackInventory);
    await window.yamzo?.settings.setTotalTables(nextTables);
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
      <aside className="flex min-h-0 flex-col gap-3 bg-stone-950 p-5 text-stone-50">
        <h1 className="mb-5 text-3xl font-semibold tracking-tight">Yamzo</h1>
        <SideNav active={screen === "newOrder" || (screen === "editOrder" && orderLane === "newOrder")} onClick={startFreshOrder}>New Order</SideNav>
        <SideNav active={screen === "openOrders" || (screen === "editOrder" && orderLane === "openOrders")} onClick={() => setScreen("openOrders")}>Open Orders</SideNav>
        <SideNav active={screen === "completedOrders"} onClick={() => void goProtectedScreen("completedOrders")}>Completed Orders</SideNav>
        <SideNav active={screen === "cancelledOrders"} onClick={() => void goProtectedScreen("cancelledOrders")}>Cancelled Orders</SideNav>
        <SideNav active={screen === "reports"} onClick={() => setScreen("reports")}>Reports</SideNav>
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
                {sources.map((item) => (
                  <Button key={item.value} variant={source === item.value ? "default" : "outline"} size="lg" onClick={() => chooseSource(item.value)}>
                    {item.label}
                  </Button>
                ))}
                </div>
              </div>
              {source === "in_house" && (
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
              <ScrollArea className="min-h-0 flex-1 rounded-xl border bg-white p-3">
                <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3 pr-3">
                  {menu.map((item) => (
                    <button
                      key={item.id}
                      className="grid min-h-[96px] rounded-xl border bg-card p-3 text-left shadow-sm transition hover:border-primary/60 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={!item.available || needsDineInTable}
                      onClick={() => addMenuItem(item)}
                    >
                      <strong className="line-clamp-2 text-sm leading-snug">{item.name}</strong>
                      <span className="text-xs text-muted-foreground">{item.category || "Menu"}</span>
                      <span className="self-end text-sm font-bold text-primary">{money(item.price)}</span>
                    </button>
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
              {message && <p className="rounded-lg border bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{message}</p>}
            </CardContent>
          </Card>
        </section>
      )}

      {screen === "openOrders" && <OrdersScreen title="Open Orders" description="Running orders ready to resume." orders={openOrders} onRefresh={refreshData} onResume={loadOrder} onDone={markKitchenDelivered} onRestart={restartKitchenTimer} onBatchDone={markKitchenBatchDelivered} onBatchRestart={restartKitchenBatchTimer} onDoneAll={markAllRunningDelivered} />}
      {screen === "completedOrders" && <OrdersScreen title="Completed Orders" description="Settled orders for audit and staff corrections." orders={completedOrders} onRefresh={refreshData} onResume={reopenHistoryOrder} resumeLabel="Edit" onView={viewHistoryOrder} onClearHistory={clearClosedOrderHistory} />}
      {screen === "cancelledOrders" && <OrdersScreen title="Cancelled Orders" description="Cancelled orders kept for audit." orders={cancelledOrders} onRefresh={refreshData} onView={viewHistoryOrder} onClearHistory={clearClosedOrderHistory} />}
      {screen === "reports" && <ContentShell title="Reports"><BusinessSummary summary={summary} /></ContentShell>}
      {screen === "admin" && (
        <ContentShell title="Admin" description="Business summary and restaurant settings." action={<Button variant="secondary" onClick={refreshData}>Refresh</Button>}>
          <BusinessSummary summary={summary} />
          <Tabs value={adminTab} onValueChange={(value) => setAdminTab(value as AdminTab)} className="min-h-0">
            <TabsList className="grid w-full max-w-6xl grid-cols-4 lg:grid-cols-8">
              <TabsTrigger value="menu">Menu Items</TabsTrigger>
              <TabsTrigger value="inventory">Inventory</TabsTrigger>
              <TabsTrigger value="receipt">Receipt Settings</TabsTrigger>
              <TabsTrigger value="printer">Printer Settings</TabsTrigger>
              <TabsTrigger value="email">Email Notifications</TabsTrigger>
              <TabsTrigger value="app">App Settings</TabsTrigger>
              <TabsTrigger value="adminSettings">Admin Settings</TabsTrigger>
              <TabsTrigger value="activity">Activity Log</TabsTrigger>
            </TabsList>
            <TabsContent value="menu"><MenuAdmin menu={menu} menuForm={menuForm} setMenuForm={setMenuForm} saveMenuForm={saveMenuForm} importMenuCsv={importMenuCsv} downloadSampleCsv={downloadSampleCsv} refreshData={refreshData} /></TabsContent>
            <TabsContent value="inventory"><InventoryAdmin snapshot={inventorySnapshot} refreshData={refreshData} setMessage={setMessage} /></TabsContent>
            <TabsContent value="receipt"><ReceiptAdmin branding={branding} setBranding={setBranding} chooseReceiptImage={chooseReceiptImage} setMessage={setMessage} /></TabsContent>
            <TabsContent value="printer"><PrinterAdmin selectedPrinter={selectedPrinter} setSelectedPrinter={setSelectedPrinter} printers={printers} failedPrintJobs={failedPrintJobs} refreshData={refreshData} setMessage={setMessage} /></TabsContent>
            <TabsContent value="email"><EmailAdmin emailSettings={emailSettings} setEmailSettings={setEmailSettings} emailPreview={emailPreview} setEmailPreview={setEmailPreview} showEmailAdvanced={showEmailAdvanced} setShowEmailAdvanced={setShowEmailAdvanced} setMessage={setMessage} /></TabsContent>
            <TabsContent value="app"><AppSettings trackInventory={trackInventory} setTrackInventory={setTrackInventory} totalTables={totalTables} setTotalTables={setTotalTables} saveAppSettings={saveAppSettings} hostNames={hostNames} hostDraft={hostDraft} setHostDraft={setHostDraft} saveHostNames={saveHostNames} /></TabsContent>
            <TabsContent value="adminSettings"><AdminSettings username={username} passwordForm={passwordForm} setPasswordForm={setPasswordForm} setMessage={setMessage} /></TabsContent>
            <TabsContent value="activity"><ActivityLogAdmin logs={activityLogs} refreshData={refreshData} /></TabsContent>
          </Tabs>
          {message && <p className="rounded-lg border bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{message}</p>}
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
          {message && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</p>}
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
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-slate-100 p-3"><span className="block text-xs text-muted-foreground">Items</span><strong>{historyView.itemCount}</strong></div>
                <div className="rounded-lg bg-emerald-50 p-3 text-emerald-950"><span className="block text-xs text-emerald-700">Total</span><strong>{money(historyView.total)}</strong></div>
                <div className="rounded-lg bg-amber-50 p-3 text-amber-950"><span className="block text-xs text-amber-700">Kitchen time</span><strong>{kitchenElapsed(historyView)}</strong></div>
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
    </main>
  );
}

function SideNav({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <Button variant={active ? "default" : "ghost"} size="lg" className="justify-start text-base" onClick={onClick}>{children}</Button>;
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

function OrdersScreen({ title, description, orders, onRefresh, onResume, resumeLabel = "Resume", onView, onDone, onRestart, onBatchDone, onBatchRestart, onDoneAll, onClearHistory }: { title: string; description: string; orders: OrderSummary[]; onRefresh: () => void; onResume?: (orderId: number) => void; resumeLabel?: string; onView?: (orderId: number) => void; onDone?: (orderId: number) => void; onRestart?: (orderId: number) => void; onBatchDone?: (ticketId: number) => void; onBatchRestart?: (ticketId: number) => void; onDoneAll?: () => void; onClearHistory?: () => void }) {
  return (
    <ContentShell
      title={title}
      description={description}
      action={<div className="flex gap-2"><Button variant="secondary" onClick={onRefresh}>Refresh</Button>{onDoneAll && <Button onClick={onDoneAll}>Done All</Button>}{onClearHistory && <Button variant="destructive" onClick={onClearHistory}>Delete History</Button>}</div>}
    >
      <OrderList orders={orders} showResume={Boolean(onResume)} resumeLabel={resumeLabel} onResume={onResume} onView={onView} onDone={onDone} onRestart={onRestart} onBatchDone={onBatchDone} onBatchRestart={onBatchRestart} />
    </ContentShell>
  );
}

function OrderList({ orders, showResume = false, resumeLabel = "Resume", onResume, onView, onDone, onRestart, onBatchDone, onBatchRestart }: { orders: OrderSummary[]; showResume?: boolean; resumeLabel?: string; onResume?: (orderId: number) => void; onView?: (orderId: number) => void; onDone?: (orderId: number) => void; onRestart?: (orderId: number) => void; onBatchDone?: (ticketId: number) => void; onBatchRestart?: (ticketId: number) => void }) {
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

function Metric({ label, value }: { label: string; value: string | number }) {
  return <Card><CardContent className="grid gap-1 p-4"><span className="text-sm text-muted-foreground">{label}</span><strong className="text-2xl">{value}</strong></CardContent></Card>;
}

function ReportBlock({ title, rows }: { title: string; rows: string[] }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent className="grid gap-2">{rows.length === 0 ? <p className="text-sm text-muted-foreground">No data yet.</p> : rows.map((row) => <span key={row} className="text-sm">{row}</span>)}</CardContent></Card>;
}

function InventoryAdmin({ snapshot, refreshData, setMessage }: { snapshot: InventorySnapshot; refreshData: () => Promise<void>; setMessage: (message: string) => void }) {
  const firstItem = snapshot.items[0];
  const firstUnit = snapshot.units[0];
  const firstCategory = snapshot.categories[0];
  const firstCostCategory = snapshot.costCategories[0];
  const [itemForm, setItemForm] = useState({
    name: "",
    categoryId: firstCategory?.id ? String(firstCategory.id) : "",
    baseUnitId: firstUnit?.id ? String(firstUnit.id) : "",
    lowStockThreshold: "1000"
  });
  const [restockForm, setRestockForm] = useState({
    inventoryItemId: firstItem?.id ? String(firstItem.id) : "",
    quantity: "",
    totalCost: "",
    supplierName: "",
    responsiblePerson: "",
    note: ""
  });
  const [priceForm, setPriceForm] = useState({
    inventoryItemId: firstItem?.id ? String(firstItem.id) : "",
    pricePerBase: "",
    responsiblePerson: "",
    note: ""
  });
  const [costForm, setCostForm] = useState({
    categoryId: firstCostCategory?.id ? String(firstCostCategory.id) : "",
    costName: "",
    amount: "",
    paymentMethod: "cash",
    responsiblePerson: "",
    note: ""
  });
  const [categoryName, setCategoryName] = useState("");
  const [costCategoryName, setCostCategoryName] = useState("");

  useEffect(() => {
    if (!itemForm.baseUnitId && snapshot.units[0]) setItemForm((current) => ({ ...current, baseUnitId: String(snapshot.units[0].id) }));
    if (!itemForm.categoryId && snapshot.categories[0]) setItemForm((current) => ({ ...current, categoryId: String(snapshot.categories[0].id) }));
    if (!restockForm.inventoryItemId && snapshot.items[0]) setRestockForm((current) => ({ ...current, inventoryItemId: String(snapshot.items[0].id) }));
    if (!priceForm.inventoryItemId && snapshot.items[0]) setPriceForm((current) => ({ ...current, inventoryItemId: String(snapshot.items[0].id) }));
    if (!costForm.categoryId && snapshot.costCategories[0]) setCostForm((current) => ({ ...current, categoryId: String(snapshot.costCategories[0].id) }));
  }, [snapshot]);

  async function importInventoryCsv() {
    const result = await window.yamzo?.inventory.chooseAndImportCsv();
    if (!result) return;
    if (result.cancelled) {
      setMessage("Inventory import cancelled.");
      return;
    }
    setMessage(`${result.recipesImported} recipes imported, ${result.recipesUpdated} updated, ${result.inventoryItemsCreated} inventory items created, ${result.menuItemsCreated} menu items added.`);
    await refreshData();
  }

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
    setItemForm({ ...itemForm, name: "" });
    setMessage("Inventory item saved.");
    await refreshData();
  }

  async function addRestock() {
    await window.yamzo?.inventory.addRestock({
      inventoryItemId: Number(restockForm.inventoryItemId),
      quantity: Number(restockForm.quantity || 0),
      totalCost: Number(restockForm.totalCost || 0),
      supplierName: restockForm.supplierName || null,
      responsiblePerson: restockForm.responsiblePerson || null,
      note: restockForm.note || null
    });
    setRestockForm({ ...restockForm, quantity: "", totalCost: "", supplierName: "", note: "" });
    setMessage("Restock entry saved.");
    await refreshData();
  }

  async function addPrice() {
    await window.yamzo?.inventory.addPrice({
      inventoryItemId: Number(priceForm.inventoryItemId),
      pricePerBase: Number(priceForm.pricePerBase || 0),
      responsiblePerson: priceForm.responsiblePerson || null,
      note: priceForm.note || null
    });
    setPriceForm({ ...priceForm, pricePerBase: "", note: "" });
    setMessage("Price record saved.");
    await refreshData();
  }

  async function addCost() {
    await window.yamzo?.inventory.addCost({
      categoryId: costForm.categoryId ? Number(costForm.categoryId) : null,
      costName: costForm.costName,
      amount: Number(costForm.amount || 0),
      paymentMethod: costForm.paymentMethod,
      responsiblePerson: costForm.responsiblePerson || null,
      note: costForm.note || null
    });
    setCostForm({ ...costForm, costName: "", amount: "", note: "" });
    setMessage("Cost record saved.");
    await refreshData();
  }

  async function addCategory() {
    await window.yamzo?.inventory.saveCategory({ name: categoryName, active: true });
    setCategoryName("");
    setMessage("Inventory category saved.");
    await refreshData();
  }

  async function addCostCategory() {
    await window.yamzo?.inventory.saveCostCategory({ name: costCategoryName, active: true });
    setCostCategoryName("");
    setMessage("Cost category saved.");
    await refreshData();
  }

  return (
    <div className="grid gap-4 pt-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Metric label="Inventory Value" value={money(snapshot.status.totalInventoryValue)} />
        <Metric label="Inventory Items" value={snapshot.status.inventoryItemCount} />
        <Metric label="Recipes Ready" value={snapshot.status.recipeAvailableCount} />
        <Metric label="Missing Recipes" value={snapshot.status.missingRecipeCount} />
        <Metric label="Low Stock" value={snapshot.status.lowStockCount} />
        <Metric label="Net Profit Estimate" value={money(snapshot.profit.netProfit)} />
      </div>
      <Tabs defaultValue="status">
        <TabsList className="grid w-full grid-cols-4 lg:grid-cols-8">
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="recipes">Recipes</TabsTrigger>
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="restock">Restock</TabsTrigger>
          <TabsTrigger value="prices">Prices</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="profit">Profit</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="status" className="grid gap-4 pt-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Low Stock</CardTitle><CardDescription>Items that need attention.</CardDescription></CardHeader>
              <CardContent className="grid gap-2">
                {snapshot.status.lowStockItems.length === 0 ? <p className="text-sm text-muted-foreground">No low stock items.</p> : snapshot.status.lowStockItems.map((item) => (
                  <InventoryListRow key={item.id} title={item.name} meta={`${formatQuantity(item.currentStock)} ${item.unitShortName} left | ${item.categoryName ?? "Other"}`} badge={item.status === "out" ? "Out of Stock" : "Low Stock"} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Missing Recipes</CardTitle><CardDescription>Menu items without ingredient recipes.</CardDescription></CardHeader>
              <CardContent className="grid gap-2">
                {snapshot.status.missingRecipes.length === 0 ? <p className="text-sm text-muted-foreground">All menu items have recipes.</p> : snapshot.status.missingRecipes.map((item) => (
                  <InventoryListRow key={item.menuItemId} title={item.name} meta={money(item.price)} badge="Recipe Not Available" />
                ))}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Recent Restocks</CardTitle></CardHeader>
            <CardContent className="grid gap-2">
              {snapshot.status.recentRestocks.length === 0 ? <p className="text-sm text-muted-foreground">No restocks recorded yet.</p> : snapshot.status.recentRestocks.map((entry) => (
                <InventoryListRow key={entry.id} title={entry.itemName} meta={`${formatQuantity(entry.quantityBase)} ${entry.unitLabel} | ${money(entry.totalCost)} | ${formatDate(entry.entryDate)}`} />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="recipes" className="grid gap-3 pt-4">
          {snapshot.recipes.map((recipe) => (
            <Card key={recipe.menuItemId} size="sm">
              <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_180px_180px_180px] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><strong>{recipe.menuItemName}</strong><Badge variant={recipe.status === "available" ? "default" : "destructive"}>{recipe.status === "available" ? "Recipe Available" : "Recipe Not Available"}</Badge></div>
                  <p className="text-sm text-muted-foreground">{recipe.ingredients.length === 0 ? "No ingredients added." : recipe.ingredients.map((item) => item.itemName).join(", ")}</p>
                </div>
                <span>Raw cost: <strong>{money(recipe.rawCost)}</strong></span>
                <span>Profit: <strong>{money(recipe.estimatedProfit)}</strong></span>
                <span>Margin: <strong>{recipe.profitMargin}%</strong></span>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="items" className="grid gap-4 pt-4">
          <Card>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
              <Field label="Item name"><Input value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} /></Field>
              <Field label="Category"><Select value={itemForm.categoryId} onValueChange={(value) => setItemForm({ ...itemForm, categoryId: value })}><SelectTrigger><SelectValue placeholder="Choose category" /></SelectTrigger><SelectContent>{snapshot.categories.map((category) => <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Base unit"><Select value={itemForm.baseUnitId} onValueChange={(value) => setItemForm({ ...itemForm, baseUnitId: value })}><SelectTrigger><SelectValue placeholder="Choose unit" /></SelectTrigger><SelectContent>{snapshot.units.map((unit) => <SelectItem key={unit.id} value={String(unit.id)}>{unit.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Low stock warning"><Input value={itemForm.lowStockThreshold} onChange={(event) => setItemForm({ ...itemForm, lowStockThreshold: event.target.value })} /></Field>
              <Button className="self-end" onClick={saveItem}>Save Item</Button>
            </CardContent>
          </Card>
          <InventoryTable
            headers={["Item", "Category", "Stock", "Latest Price", "Value", "Status"]}
            rows={snapshot.items.map((item) => [
              item.name,
              item.categoryName ?? "Other",
              `${formatQuantity(item.currentStock)} ${item.unitShortName}`,
              `${formatQuantity(item.latestPrice)} / ${item.unitShortName}`,
              money(item.estimatedValue),
              item.status === "ok" ? "OK" : item.status === "low" ? "Low Stock" : "Out of Stock"
            ])}
          />
        </TabsContent>

        <TabsContent value="restock" className="grid gap-4 pt-4">
          <Card>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
              <InventoryItemSelect label="Item" value={restockForm.inventoryItemId} items={snapshot.items} onChange={(value) => setRestockForm({ ...restockForm, inventoryItemId: value })} />
              <Field label="Quantity"><Input value={restockForm.quantity} onChange={(event) => setRestockForm({ ...restockForm, quantity: event.target.value })} /></Field>
              <Field label="Total cost"><Input value={restockForm.totalCost} onChange={(event) => setRestockForm({ ...restockForm, totalCost: event.target.value })} /></Field>
              <Field label="Supplier"><Input value={restockForm.supplierName} onChange={(event) => setRestockForm({ ...restockForm, supplierName: event.target.value })} /></Field>
              <Field label="Person responsible"><Input value={restockForm.responsiblePerson} onChange={(event) => setRestockForm({ ...restockForm, responsiblePerson: event.target.value })} /></Field>
              <Field label="Note"><Input value={restockForm.note} onChange={(event) => setRestockForm({ ...restockForm, note: event.target.value })} /></Field>
              <Button className="self-end" onClick={addRestock} disabled={!restockForm.inventoryItemId}>Add Restock</Button>
            </CardContent>
          </Card>
          <InventoryTable headers={["Date", "Item", "Quantity", "Cost", "Person", "Supplier"]} rows={snapshot.restocks.map((entry) => [formatDate(entry.entryDate), entry.itemName, `${formatQuantity(entry.quantityBase)} ${entry.unitLabel}`, money(entry.totalCost), entry.responsiblePerson ?? "-", entry.supplierName ?? "-"])} />
        </TabsContent>

        <TabsContent value="prices" className="grid gap-4 pt-4">
          <Card>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
              <InventoryItemSelect label="Item" value={priceForm.inventoryItemId} items={snapshot.items} onChange={(value) => setPriceForm({ ...priceForm, inventoryItemId: value })} />
              <Field label="Price per base unit"><Input value={priceForm.pricePerBase} onChange={(event) => setPriceForm({ ...priceForm, pricePerBase: event.target.value })} /></Field>
              <Field label="Person responsible"><Input value={priceForm.responsiblePerson} onChange={(event) => setPriceForm({ ...priceForm, responsiblePerson: event.target.value })} /></Field>
              <Field label="Note"><Input value={priceForm.note} onChange={(event) => setPriceForm({ ...priceForm, note: event.target.value })} /></Field>
              <Button className="self-end" onClick={addPrice} disabled={!priceForm.inventoryItemId}>Add Price Record</Button>
            </CardContent>
          </Card>
          <InventoryTable headers={["Date", "Item", "Price", "Person", "Note"]} rows={snapshot.priceHistory.map((entry) => [formatDate(entry.effectiveAt), entry.itemName, String(entry.pricePerBase), entry.responsiblePerson ?? "-", entry.note ?? "-"])} />
        </TabsContent>

        <TabsContent value="costs" className="grid gap-4 pt-4">
          <Card>
            <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
              <Field label="Category"><Select value={costForm.categoryId} onValueChange={(value) => setCostForm({ ...costForm, categoryId: value })}><SelectTrigger><SelectValue placeholder="Choose category" /></SelectTrigger><SelectContent>{snapshot.costCategories.map((category) => <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Cost name"><Input value={costForm.costName} onChange={(event) => setCostForm({ ...costForm, costName: event.target.value })} /></Field>
              <Field label="Amount"><Input value={costForm.amount} onChange={(event) => setCostForm({ ...costForm, amount: event.target.value })} /></Field>
              <Field label="Payment method"><Input value={costForm.paymentMethod} onChange={(event) => setCostForm({ ...costForm, paymentMethod: event.target.value })} /></Field>
              <Field label="Person responsible"><Input value={costForm.responsiblePerson} onChange={(event) => setCostForm({ ...costForm, responsiblePerson: event.target.value })} /></Field>
              <Field label="Note"><Input value={costForm.note} onChange={(event) => setCostForm({ ...costForm, note: event.target.value })} /></Field>
              <Button className="self-end" onClick={addCost}>Add Cost Record</Button>
            </CardContent>
          </Card>
          <InventoryTable headers={["Date", "Category", "Cost", "Amount", "Person", "Note"]} rows={snapshot.costRecords.map((entry) => [formatDate(entry.costDate), entry.categoryName ?? "Other", entry.costName, money(entry.amount), entry.responsiblePerson ?? "-", entry.note ?? "-"])} />
        </TabsContent>

        <TabsContent value="profit" className="grid gap-4 pt-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <Metric label="Revenue" value={money(snapshot.profit.revenue)} />
            <Metric label="Raw Cost" value={money(snapshot.profit.rawCost)} />
            <Metric label="Gross Profit" value={money(snapshot.profit.grossProfit)} />
            <Metric label="Other Costs" value={money(snapshot.profit.otherCost)} />
            <Metric label="Net Profit" value={money(snapshot.profit.netProfit)} />
            <Metric label="Missing Recipes" value={snapshot.profit.missingRecipeCount} />
          </div>
          <InventoryTable headers={["Item", "Revenue", "Raw Cost", "Profit"]} rows={snapshot.profit.topProfitItems.map((item) => [item.name, money(item.revenue), money(item.rawCost), money(item.profit)])} />
        </TabsContent>

        <TabsContent value="settings" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Import Recipes</CardTitle><CardDescription>Choose a recipe CSV and review the import summary after it finishes.</CardDescription></CardHeader>
            <CardContent className="flex flex-wrap gap-2"><Button onClick={importInventoryCsv}>Import Recipe CSV</Button><Button variant="secondary" onClick={refreshData}>Refresh Inventory</Button></CardContent>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Inventory Categories</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <div className="grid grid-cols-[1fr_auto] gap-2"><Input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Example: Beverage" /><Button onClick={addCategory} disabled={!categoryName.trim()}>Add Category</Button></div>
                <div className="flex flex-wrap gap-2">{snapshot.categories.map((category) => <Badge key={category.id} variant="secondary">{category.name}</Badge>)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Cost Categories</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <div className="grid grid-cols-[1fr_auto] gap-2"><Input value={costCategoryName} onChange={(event) => setCostCategoryName(event.target.value)} placeholder="Example: Marketing" /><Button onClick={addCostCategory} disabled={!costCategoryName.trim()}>Add Cost Category</Button></div>
                <div className="flex flex-wrap gap-2">{snapshot.costCategories.map((category) => <Badge key={category.id} variant="secondary">{category.name}</Badge>)}</div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InventoryItemSelect({ label, value, items, onChange }: { label: string; value: string; items: InventorySnapshot["items"]; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Choose item" /></SelectTrigger>
        <SelectContent>{items.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
}

function InventoryListRow({ title, meta, badge }: { title: string; meta: string; badge?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border bg-white px-3 py-2">
      <span className="min-w-0"><strong className="block truncate">{title}</strong><small className="text-muted-foreground">{meta}</small></span>
      {badge && <Badge variant={badge.includes("Out") || badge.includes("Not") ? "destructive" : "secondary"}>{badge}</Badge>}
    </div>
  );
}

function InventoryTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <Card>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No records yet.</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-muted/60 text-left">
                <tr>{headers.map((header) => <th className="border-b px-4 py-3 font-semibold" key={header}>{header}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr className="border-b last:border-b-0" key={`${row.join("-")}-${rowIndex}`}>{row.map((cell, cellIndex) => <td className="px-4 py-3" key={`${cell}-${cellIndex}`}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MenuAdmin({ menu, menuForm, setMenuForm, saveMenuForm, importMenuCsv, downloadSampleCsv, refreshData }: { menu: MenuItem[]; menuForm: { id: number; name: string; price: string; category: string; available: boolean }; setMenuForm: (value: { id: number; name: string; price: string; category: string; available: boolean }) => void; saveMenuForm: () => void; importMenuCsv: () => void; downloadSampleCsv: () => void; refreshData: () => void }) {
  return (
    <div className="grid gap-4 pt-4">
      <div className="flex flex-wrap gap-2"><Button onClick={importMenuCsv}>Import CSV</Button><Button variant="secondary" onClick={downloadSampleCsv}>Download sample CSV format</Button></div>
      <Card>
        <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 p-4">
          <Field label="Item name"><Input value={menuForm.name} onChange={(event) => setMenuForm({ ...menuForm, name: event.target.value })} /></Field>
          <Field label="Price"><Input value={menuForm.price} onChange={(event) => setMenuForm({ ...menuForm, price: event.target.value })} /></Field>
          <Field label="Category"><Input value={menuForm.category} onChange={(event) => setMenuForm({ ...menuForm, category: event.target.value })} /></Field>
          <label className="flex items-center gap-2 self-end"><Checkbox checked={menuForm.available} onCheckedChange={(checked) => setMenuForm({ ...menuForm, available: Boolean(checked) })} />Available</label>
          <Button className="self-end" onClick={saveMenuForm}>{menuForm.id ? "Save Item" : "Add Item"}</Button>
        </CardContent>
      </Card>
      <div className="grid gap-2">
        {menu.map((item) => <MenuAdminRow key={item.id} item={item} onEdit={setMenuForm} onDone={refreshData} />)}
      </div>
    </div>
  );
}

function MenuAdminRow({ item, onEdit: _onEdit, onDone }: { item: MenuItem; onEdit: (value: { id: number; name: string; price: string; category: string; available: boolean }) => void; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: item.name, price: String(item.price), category: item.category ?? "", available: item.available });
  async function saveInline() {
    await window.yamzo?.menu.saveItem({ id: item.id, name: draft.name, price: Number(draft.price), category: draft.category || null, available: draft.available });
    setEditing(false);
    await onDone();
  }
  if (editing) {
    return (
      <Card size="sm">
        <CardContent className="grid grid-cols-[1.4fr_120px_1fr_auto_auto] items-end gap-2 p-3">
          <Field label="Item"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <Field label="Price"><Input value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} /></Field>
          <Field label="Category"><Input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></Field>
          <label className="flex h-10 items-center gap-2"><Checkbox checked={draft.available} onCheckedChange={(checked) => setDraft({ ...draft, available: Boolean(checked) })} />Available</label>
          <div className="flex gap-2"><Button onClick={saveInline}>Save</Button><Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button></div>
        </CardContent>
      </Card>
    );
  }
  return <Card size="sm"><CardContent className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 p-3"><div className="min-w-0"><strong>{item.name}</strong><p className="text-sm text-muted-foreground">{item.category || "Menu"} | {money(item.price)} | {item.available ? "Available" : "Unavailable"}</p></div><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button variant="secondary" onClick={async () => { await window.yamzo?.menu.archiveItem(item.id); await onDone(); }}>Archive</Button><Button variant="destructive" onClick={async () => { await window.yamzo?.menu.deleteItem(item.id); await onDone(); }}>Delete</Button></CardContent></Card>;
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
  totalTables,
  setTotalTables,
  saveAppSettings,
  hostNames,
  hostDraft,
  setHostDraft,
  saveHostNames
}: {
  trackInventory: boolean;
  setTrackInventory: (value: boolean) => void;
  totalTables: number;
  setTotalTables: (value: number) => void;
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
          <Separator />
          <Field label="Total Tables"><Input type="number" min="1" max="200" value={totalTables} onChange={(event) => setTotalTables(Number(event.target.value || 10))} /></Field>
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
  return sources.find((item) => item.value === source)?.label ?? labelize(source);
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
