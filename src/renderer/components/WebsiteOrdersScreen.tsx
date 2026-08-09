import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, PackageCheck, RefreshCw, TestTube2, Truck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  WebsiteOrderDetail,
  WebsiteOrderPrintKind,
  WebsiteOrderStatus,
  WebsiteOrderSummary
} from "../../shared/types";

const ACTIVE_STATUSES: WebsiteOrderStatus[] = ["accepted", "preparing", "ready", "out_for_delivery"];
const CLOSED_STATUSES: WebsiteOrderStatus[] = ["delivered", "rejected", "cancelled"];
const SCREEN_POLL_MS = 10_000;

interface WebsiteOrdersScreenProps {
  onMessage?: (message: string) => void;
}

/**
 * A local, read-only projection of Website Admin orders. The terminal is
 * deliberately incapable of accepting, rejecting, editing, or transitioning
 * the remote order. Its only write is a local print job and print receipt.
 */
export function WebsiteOrdersScreen({ onMessage }: WebsiteOrdersScreenProps) {
  const [orders, setOrders] = useState<WebsiteOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WebsiteOrderDetail | null>(null);
  const [busyPrint, setBusyPrint] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!window.yamzo?.websiteOrders) {
      setError("Website order integration is unavailable in this build.");
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      setOrders(await window.yamzo.websiteOrders.list());
      setError("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), SCREEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function viewOrder(remoteId: string) {
    if (!window.yamzo?.websiteOrders) return;
    try {
      setSelected(await window.yamzo.websiteOrders.detail(remoteId));
      setError("");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function queueAndPrint(order: WebsiteOrderSummary | WebsiteOrderDetail, kind: WebsiteOrderPrintKind | "both") {
    if (!window.yamzo?.websiteOrders || !window.yamzo?.print) return;
    setBusyPrint(`${order.remoteId}:${kind}`);
    try {
      const batch = await window.yamzo.websiteOrders.queuePrint(order.remoteId, kind);
      const outcomes = await Promise.all(batch.jobs.map(async (job) => ({
        kind: job.kind,
        printed: await window.yamzo!.print.printJob(job.id)
      })));
      const failed = outcomes.filter((outcome) => !outcome.printed);
      const printedLabels = outcomes
        .filter((outcome) => outcome.printed)
        .map((outcome) => printLabel(outcome.kind));
      const failureMessage = failed.length > 0 ? ` ${failed.map((outcome) => printLabel(outcome.kind)).join(" and ")} need${failed.length === 1 ? "s" : ""} retry.` : "";
      onMessage?.(`${batch.websiteOrder.orderCode}: ${printedLabels.length > 0 ? `${printedLabels.join(" and ")} printed.` : "Copies were queued."}${failureMessage}`);
      if (selected?.remoteId === batch.websiteOrder.remoteId) {
        setSelected(await window.yamzo.websiteOrders.detail(batch.websiteOrder.remoteId));
      }
      await refresh(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyPrint(null);
    }
  }

  const active = orders.filter((order) => ACTIVE_STATUSES.includes(order.status));
  const pending = orders.filter((order) => order.status === "pending");
  const history = orders.filter((order) => CLOSED_STATUSES.includes(order.status));

  return (
    <section className="h-screen overflow-hidden p-4">
      <Card className="h-full overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="flex items-center gap-2"><PackageCheck className="size-5 text-emerald-700" /> Website Orders</CardTitle>
                <Badge variant="outline" className="border-emerald-300 text-emerald-800">Read-only mirror</Badge>
              </div>
              <CardDescription>Website Admin owns every edit and status. This POS only prints the latest synced snapshot.</CardDescription>
            </div>
            <Button variant="secondary" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
            </Button>
          </div>
        </CardHeader>
        <ScrollArea className="h-[calc(100vh-112px)]">
          <CardContent className="grid gap-6 p-4">
            {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</p>}
            <OrderSection
              title="Print queue"
              description="Accepted website orders stay in sync here. Printing never changes the website order."
              orders={active}
              busyPrint={busyPrint}
              onView={viewOrder}
              onPrint={queueAndPrint}
            />
            {pending.length > 0 && (
              <OrderSection
                title="Awaiting Website Admin"
                description="These orders are waiting for an admin decision and cannot be printed from the POS."
                orders={pending}
                busyPrint={busyPrint}
                onView={viewOrder}
                onPrint={queueAndPrint}
              />
            )}
            <OrderSection
              title="Completed on Website"
              description="Delivered, rejected, and cancelled states are mirrored from Website Admin. Delivered orders remain reprintable."
              orders={history}
              busyPrint={busyPrint}
              onView={viewOrder}
              onPrint={queueAndPrint}
            />
          </CardContent>
        </ScrollArea>
      </Card>

      <OrderDetailDialog
        order={selected}
        busyPrint={busyPrint}
        onOpenChange={(open) => !open && setSelected(null)}
        onPrint={queueAndPrint}
      />
    </section>
  );
}

/**
 * Delivered web orders are shown beside local completed orders without being
 * coerced into a local OrderSummary. This makes the authority boundary visible
 * and keeps financial, inventory, and status data owned by Website Admin.
 */
export function WebsiteCompletedOrdersPanel({
  orders,
  onRefresh,
  onMessage
}: {
  orders: WebsiteOrderSummary[];
  onRefresh: () => void | Promise<void>;
  onMessage?: (message: string) => void;
}) {
  const [selected, setSelected] = useState<WebsiteOrderDetail | null>(null);
  const [busyPrint, setBusyPrint] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function viewOrder(remoteId: string) {
    if (!window.yamzo?.websiteOrders) return;
    try {
      setSelected(await window.yamzo.websiteOrders.detail(remoteId));
      setError("");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function queueAndPrint(order: WebsiteOrderSummary | WebsiteOrderDetail, kind: WebsiteOrderPrintKind | "both") {
    if (!window.yamzo?.websiteOrders || !window.yamzo?.print) return;
    setBusyPrint(`${order.remoteId}:${kind}`);
    try {
      const batch = await window.yamzo.websiteOrders.queuePrint(order.remoteId, kind);
      const outcomes = await Promise.all(batch.jobs.map(async (job) => ({
        kind: job.kind,
        printed: await window.yamzo!.print.printJob(job.id)
      })));
      const failed = outcomes.filter((outcome) => !outcome.printed);
      const printed = outcomes.filter((outcome) => outcome.printed).map((outcome) => printLabel(outcome.kind));
      onMessage?.(`${batch.websiteOrder.orderCode}: ${printed.length > 0 ? `${printed.join(" and ")} printed.` : "Copies were queued."}${failed.length > 0 ? ` ${failed.map((outcome) => printLabel(outcome.kind)).join(" and ")} need${failed.length === 1 ? "s" : ""} retry.` : ""}`);
      if (selected?.remoteId === batch.websiteOrder.remoteId) {
        setSelected(await window.yamzo.websiteOrders.detail(batch.websiteOrder.remoteId));
      }
      await onRefresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyPrint(null);
    }
  }

  return (
    <section className="grid gap-3 border-t pt-6" aria-labelledby="completed-website-orders">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="completed-website-orders" className="flex items-center gap-2 text-base font-semibold">Delivered website orders <Badge variant="outline" className="border-sky-300 text-sky-800">Website / read-only</Badge> <span className="text-muted-foreground">({orders.length})</span></h2>
          <p className="text-sm text-muted-foreground">Authoritative delivery status and order data stay on the website. The POS can only view and reprint the synced snapshot.</p>
        </div>
      </div>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</p>}
      {orders.length === 0 ? (
        <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">No delivered website orders have been synced to this POS yet.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {orders.map((order) => (
            <Card key={order.remoteId} className="overflow-hidden border-sky-200 bg-gradient-to-br from-white to-sky-50/60 shadow-sm">
              <CardHeader className="border-b bg-white/70">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex flex-wrap items-center gap-2"><span className="truncate">{order.orderCode}</span>{order.isTest && <Badge variant="outline" className="border-violet-300 text-violet-800"><TestTube2 /> Test</Badge>}</CardTitle>
                    <CardDescription>Website v{order.remoteVersion} · {relativeTime(order.updatedAt)}</CardDescription>
                  </div>
                  <Badge variant="secondary"><Check /> Delivered</Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3 p-4 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-sky-50 p-2"><span className="block text-xs text-sky-800">Items</span><strong>{order.itemCount}</strong></div>
                  <div className="rounded-lg bg-emerald-50 p-2 text-emerald-950"><span className="block text-xs text-emerald-700">Website total</span><strong>{formatTk(order.total)}</strong></div>
                </div>
                <p className="truncate text-xs text-muted-foreground">{order.itemPreview.join(", ")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => void viewOrder(order.remoteId)}>View</Button>
                  <Button disabled={busyPrint === `${order.remoteId}:both`} onClick={() => void queueAndPrint(order, "both")}>{busyPrint === `${order.remoteId}:both` ? "Printing..." : "Reprint copies"}</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <OrderDetailDialog
        order={selected}
        busyPrint={busyPrint}
        onOpenChange={(open) => !open && setSelected(null)}
        onPrint={queueAndPrint}
      />
    </section>
  );
}

function OrderSection({
  title,
  description,
  orders,
  busyPrint,
  onView,
  onPrint
}: {
  title: string;
  description: string;
  orders: WebsiteOrderSummary[];
  busyPrint: string | null;
  onView: (remoteId: string) => void | Promise<void>;
  onPrint: (order: WebsiteOrderSummary, kind: WebsiteOrderPrintKind | "both") => void | Promise<void>;
}) {
  return (
    <section className="grid gap-3" aria-labelledby={`website-orders-${title.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`}>
      <div>
        <h2 id={`website-orders-${title.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`} className="text-base font-semibold">{title} <span className="text-muted-foreground">({orders.length})</span></h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {orders.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No website orders in this section.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(310px,1fr))] gap-4">
          {orders.map((order) => {
            const printable = isPrintable(order.status);
            const printing = busyPrint === `${order.remoteId}:both`;
            return (
              <Card key={order.remoteId} className={order.status === "pending" ? "border-slate-300 bg-slate-50/50" : order.status === "accepted" ? "border-emerald-300 bg-emerald-50/40" : ""}>
                <CardHeader className="border-b">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate">{order.orderCode}</CardTitle>
                      <CardDescription>{relativeTime(order.updatedAt)} · Website v{order.remoteVersion}</CardDescription>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {order.isTest && <Badge variant="outline" className="border-violet-300 text-violet-800"><TestTube2 /> Test</Badge>}
                      <StatusBadge status={order.status} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0 text-sm text-muted-foreground">
                      <p>{order.itemCount} items</p>
                      <p className="truncate">{order.itemPreview.join(", ")}</p>
                    </div>
                    <strong className="shrink-0 text-lg">{formatTk(order.total)}</strong>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => void onView(order.remoteId)}>Open</Button>
                    {printable && (
                      <Button disabled={printing} onClick={() => void onPrint(order, "both")}>
                        {printing ? "Printing..." : "Print copies"}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function OrderDetailDialog({
  order,
  busyPrint,
  onOpenChange,
  onPrint
}: {
  order: WebsiteOrderDetail | null;
  busyPrint: string | null;
  onOpenChange: (open: boolean) => void;
  onPrint: (order: WebsiteOrderDetail, kind: WebsiteOrderPrintKind | "both") => void | Promise<void>;
}) {
  const printable = order ? isPrintable(order.status) : false;
  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">{order?.orderCode} {order && <StatusBadge status={order.status} />}</DialogTitle>
          <DialogDescription>Website version {order?.remoteVersion ?? "-"} · read-only POS snapshot</DialogDescription>
        </DialogHeader>
        {order && (
          <ScrollArea className="max-h-[58vh] pr-3">
            <div className="grid gap-4">
              <div className="rounded-xl border bg-muted/30 p-3 text-sm">
                <p className="font-medium">Delivery address</p>
                <p>Flat {order.address.flat}, House {order.address.house}, Road {order.address.road}, Sector {order.address.sector}</p>
                <p className="mt-1 text-muted-foreground">{order.customerName} · {order.customerPhone}</p>
                {order.deliveryNote && <p className="mt-1 text-muted-foreground">{order.deliveryNote}</p>}
              </div>
              <div className="grid gap-2">
                {order.items.map((item) => (
                  <div key={item.id} className="grid grid-cols-[1fr_auto] gap-3 rounded-xl border p-3 text-sm">
                    <div>
                      <p className="font-medium">{item.quantity} x {item.name}</p>
                      {item.note && <p className="text-muted-foreground">{item.note}</p>}
                    </div>
                    <span>{formatTk(item.quantity * item.unitPrice)}</span>
                  </div>
                ))}
              </div>
              <div className="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm">
                <span>Subtotal</span><span className="text-right">{formatTk(order.subtotal)}</span>
                <span>Delivery fee</span><span className="text-right">{formatTk(order.deliveryFee)}</span>
                <span>Discount</span><span className="text-right">-{formatTk(order.discount)}</span>
                <strong>Total</strong><strong className="text-right">{formatTk(order.total)}</strong>
              </div>
            </div>
          </ScrollArea>
        )}
        <DialogFooter className="flex-wrap sm:justify-between">
          <p className="mr-auto text-xs text-muted-foreground">Status and order changes are managed in Website Admin.</p>
          {order && printable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busyPrint === `${order.remoteId}:kitchen_copy`} onClick={() => void onPrint(order, "kitchen_copy")}>Kitchen copy</Button>
              <Button variant="outline" disabled={busyPrint === `${order.remoteId}:customer_receipt`} onClick={() => void onPrint(order, "customer_receipt")}>Receipt</Button>
              <Button disabled={busyPrint === `${order.remoteId}:both`} onClick={() => void onPrint(order, "both")}>Print both</Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: WebsiteOrderStatus }) {
  const destructive = status === "rejected" || status === "cancelled";
  const complete = status === "delivered" || status === "ready";
  return (
    <Badge variant={destructive ? "destructive" : complete ? "secondary" : status === "accepted" ? "default" : "outline"}>
      {destructive ? <X /> : complete ? <Check /> : status === "out_for_delivery" ? <Truck /> : status === "accepted" ? <PackageCheck /> : <Clock3 />} {statusLabel(status)}
    </Badge>
  );
}

function isPrintable(status: WebsiteOrderStatus): boolean {
  return status === "accepted"
    || status === "preparing"
    || status === "ready"
    || status === "out_for_delivery"
    || status === "delivered";
}

function printLabel(kind: WebsiteOrderPrintKind): string {
  return kind === "kitchen_copy" ? "Kitchen copy" : "Receipt";
}

function statusLabel(status: WebsiteOrderStatus): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatTk(value: number): string {
  return `Tk${value.toLocaleString("en-BD")}`;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const delta = Date.now() - timestamp;
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat("en-BD", { dateStyle: "medium", timeZone: "Asia/Dhaka" }).format(timestamp);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Could not update the local website-order mirror.";
}
