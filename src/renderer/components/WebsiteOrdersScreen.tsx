import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, Check, Clock3, PackageCheck, RefreshCw, TestTube2, Truck, X } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type {
  WebsiteOrderAcceptance,
  WebsiteOrderDetail,
  WebsiteOrderStatus,
  WebsiteOrderSummary
} from "../../shared/types";

const ACTIVE_STATUSES: WebsiteOrderStatus[] = ["pending", "accepted", "preparing", "ready", "out_for_delivery"];
const SCREEN_POLL_MS = 10_000;
const ALERT_POLL_MS = 8_000;

interface WebsiteOrdersScreenProps {
  onPosDataChanged?: () => void | Promise<void>;
  onMessage?: (message: string) => void;
}

export function WebsiteOrdersScreen({ onPosDataChanged, onMessage }: WebsiteOrdersScreenProps) {
  const [orders, setOrders] = useState<WebsiteOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WebsiteOrderDetail | null>(null);
  const [rejectTarget, setRejectTarget] = useState<WebsiteOrderSummary | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<WebsiteOrderSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
    setBusyId(remoteId);
    try {
      setSelected(await window.yamzo.websiteOrders.detail(remoteId));
      setError("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function accept(remoteId: string) {
    if (!window.yamzo?.websiteOrders) return;
    setBusyId(remoteId);
    try {
      const result = await window.yamzo.websiteOrders.accept(remoteId);
      const printMessage = await printAcceptedOrder(result);
      onMessage?.(printMessage);
      setSelected(result.websiteOrder);
      await Promise.all([refresh(true), Promise.resolve(onPosDataChanged?.())]);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function reject() {
    if (!rejectTarget || !window.yamzo?.websiteOrders) return;
    setBusyId(rejectTarget.remoteId);
    try {
      await window.yamzo.websiteOrders.reject(rejectTarget.remoteId, rejectReason);
      onMessage?.(`${rejectTarget.orderCode} rejected.`);
      setRejectTarget(null);
      setRejectReason("");
      await refresh(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function move(order: WebsiteOrderSummary, status: Exclude<WebsiteOrderStatus, "pending" | "accepted" | "rejected">) {
    if (!window.yamzo?.websiteOrders) return;
    setBusyId(order.remoteId);
    try {
      const changed = await window.yamzo.websiteOrders.transition(order.remoteId, status);
      onMessage?.(`${order.orderCode} marked ${statusLabel(changed.status).toLowerCase()}.`);
      if (selected?.remoteId === order.remoteId) setSelected(changed);
      await refresh(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteTestOrder() {
    if (!deleteTarget || !window.yamzo?.websiteOrders) return;
    setBusyId(deleteTarget.remoteId);
    try {
      await window.yamzo.websiteOrders.deleteTest(deleteTarget.remoteId);
      onMessage?.(`${deleteTarget.orderCode} test data permanently deleted.`);
      if (selected?.remoteId === deleteTarget.remoteId) setSelected(null);
      setDeleteTarget(null);
      await Promise.all([refresh(true), Promise.resolve(onPosDataChanged?.())]);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  const active = orders.filter((order) => ACTIVE_STATUSES.includes(order.status));
  const history = orders.filter((order) => !ACTIVE_STATUSES.includes(order.status));

  return (
    <section className="h-screen overflow-hidden p-4">
      <Card className="h-full overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2"><BellRing className="size-5 text-amber-600" /> Website Orders</CardTitle>
              <CardDescription>Accept incoming orders, print both copies, and keep customer status current.</CardDescription>
            </div>
            <Button variant="secondary" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
            </Button>
          </div>
        </CardHeader>
        <ScrollArea className="h-[calc(100vh-112px)]">
          <CardContent className="grid gap-5 p-4">
            {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</p>}
            <OrderSection
              title="Active queue"
              description="Pending orders appear first. Acceptance creates one POS order, one kitchen copy, and one delivery slip."
              orders={active}
              busyId={busyId}
              onView={viewOrder}
              onAccept={accept}
              onReject={(order) => { setRejectTarget(order); setRejectReason(""); }}
              onMove={move}
              onDeleteTest={setDeleteTarget}
            />
            <OrderSection
              title="Recent history"
              description="Completed, rejected, and cancelled website orders."
              orders={history}
              busyId={busyId}
              onView={viewOrder}
              onAccept={accept}
              onReject={(order) => { setRejectTarget(order); setRejectReason(""); }}
              onMove={move}
              onDeleteTest={setDeleteTarget}
            />
          </CardContent>
        </ScrollArea>
      </Card>

      <OrderDetailDialog order={selected} onOpenChange={(open) => !open && setSelected(null)} />

      <Dialog open={Boolean(rejectTarget)} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejectTarget?.orderCode}</DialogTitle>
            <DialogDescription>The customer will see this reason after the next successful website sync.</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Rejection reason"
            placeholder="For example: Outside delivery hours"
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Keep order</Button>
            <Button variant="destructive" disabled={!rejectReason.trim() || busyId === rejectTarget?.remoteId} onClick={() => void reject()}>
              Reject order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete test order?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the test inbox record, linked POS order, print jobs, and local sync events. Live orders cannot use this action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void deleteTestOrder()}>Delete forever</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

interface IncomingAlertProps extends WebsiteOrdersScreenProps {
  enabled: boolean;
  onReview: () => void;
}

export function WebsiteOrderIncomingAlert({ enabled, onReview, onPosDataChanged, onMessage }: IncomingAlertProps) {
  const [order, setOrder] = useState<WebsiteOrderSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const dismissed = useRef(new Set<string>());
  const notified = useRef(new Set<string>());

  const poll = useCallback(async () => {
    if (!enabled || !window.yamzo?.websiteOrders) return;
    try {
      const pending = await window.yamzo.websiteOrders.list(["pending"]);
      const next = pending.find((candidate) => !dismissed.current.has(candidate.remoteId)) ?? null;
      setOrder(next);
      if (next && !notified.current.has(next.remoteId)) {
        notified.current.add(next.remoteId);
        void playBoundedOrderChime();
      }
    } catch {
      // The full Website Orders screen owns visible sync errors; the global alert remains quiet.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setOrder(null);
      return;
    }
    void poll();
    const timer = window.setInterval(() => void poll(), ALERT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, poll]);

  async function accept() {
    if (!order || !window.yamzo?.websiteOrders) return;
    setBusy(true);
    try {
      const result = await window.yamzo.websiteOrders.accept(order.remoteId);
      onMessage?.(await printAcceptedOrder(result));
      dismissed.current.add(order.remoteId);
      setOrder(null);
      await Promise.resolve(onPosDataChanged?.());
    } catch (reason) {
      onMessage?.(errorMessage(reason));
      dismissed.current.add(order.remoteId);
      setOrder(null);
      onReview();
    } finally {
      setBusy(false);
    }
  }

  function review() {
    if (order) dismissed.current.add(order.remoteId);
    setOrder(null);
    onReview();
  }

  return (
    <AlertDialog open={Boolean(order)}>
      <AlertDialogContent className="max-w-md border-amber-300 bg-amber-50 ring-amber-300">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-xl"><BellRing className="size-6 text-amber-600" /> New website order</AlertDialogTitle>
          <AlertDialogDescription className="text-left text-stone-700">
            <span className="block font-semibold text-stone-950">{order?.orderCode} · {order?.customerName}</span>
            <span className="mt-1 block">{order?.itemCount} items · {formatTk(order?.total ?? 0)}{order?.isTest ? " · Test mode" : ""}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={review}>Review queue</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void accept(); }}>
            {busy ? "Accepting…" : "Accept & print"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function OrderSection({ title, description, orders, busyId, onView, onAccept, onReject, onMove, onDeleteTest }: {
  title: string;
  description: string;
  orders: WebsiteOrderSummary[];
  busyId: string | null;
  onView: (remoteId: string) => void | Promise<void>;
  onAccept: (remoteId: string) => void | Promise<void>;
  onReject: (order: WebsiteOrderSummary) => void;
  onMove: (order: WebsiteOrderSummary, status: Exclude<WebsiteOrderStatus, "pending" | "accepted" | "rejected">) => void | Promise<void>;
  onDeleteTest: (order: WebsiteOrderSummary) => void;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="text-base font-semibold">{title} <span className="text-muted-foreground">({orders.length})</span></h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {orders.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No website orders in this section.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(310px,1fr))] gap-4">
          {orders.map((order) => (
            <Card key={order.remoteId} className={order.status === "pending" ? "border-amber-300 bg-amber-50/40" : ""}>
              <CardHeader className="border-b">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{order.orderCode}</CardTitle>
                    <CardDescription>{order.customerName} · {relativeTime(order.remoteCreatedAt)}</CardDescription>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {order.isTest && <Badge variant="outline" className="border-violet-300 text-violet-800"><TestTube2 /> Test</Badge>}
                    <StatusBadge status={order.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex items-end justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    <p>{order.itemCount} items</p>
                    <p className="line-clamp-1">{order.itemPreview.join(", ")}</p>
                  </div>
                  <strong className="text-lg">{formatTk(order.total)}</strong>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busyId === order.remoteId} onClick={() => void onView(order.remoteId)}>Details</Button>
                  {order.status === "pending" && <Button disabled={busyId === order.remoteId} onClick={() => void onAccept(order.remoteId)}>Accept & print</Button>}
                  {order.status === "pending" && <Button variant="destructive" disabled={busyId === order.remoteId} onClick={() => onReject(order)}>Reject</Button>}
                  {order.status === "accepted" && <Button disabled={busyId === order.remoteId} onClick={() => void onMove(order, "preparing")}><Clock3 /> Preparing</Button>}
                  {order.status === "preparing" && <Button disabled={busyId === order.remoteId} onClick={() => void onMove(order, "ready")}><PackageCheck /> Ready</Button>}
                  {order.status === "ready" && <Button disabled={busyId === order.remoteId} onClick={() => void onMove(order, "out_for_delivery")}><Truck /> Out for delivery</Button>}
                  {(order.status === "ready" || order.status === "out_for_delivery") && <Button variant="secondary" disabled={busyId === order.remoteId} onClick={() => void onMove(order, "delivered")}><Check /> Delivered</Button>}
                  {order.isTest && <Button variant="destructive" disabled={busyId === order.remoteId} onClick={() => onDeleteTest(order)}>Delete test</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function OrderDetailDialog({ order, onOpenChange }: { order: WebsiteOrderDetail | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">{order?.orderCode} {order && <StatusBadge status={order.status} />}</DialogTitle>
          <DialogDescription>{order?.customerName} · {order?.customerPhone}</DialogDescription>
        </DialogHeader>
        {order && (
          <ScrollArea className="max-h-[65vh] pr-3">
            <div className="grid gap-4">
              <div className="rounded-xl border bg-muted/30 p-3 text-sm">
                <p className="font-medium">Delivery address</p>
                <p>Flat {order.address.flat}, House {order.address.house}, Road {order.address.road}, Sector {order.address.sector}</p>
                {order.deliveryNote && <p className="mt-1 text-muted-foreground">{order.deliveryNote}</p>}
              </div>
              <div className="grid gap-2">
                {order.items.map((item) => (
                  <div key={item.id} className="grid grid-cols-[1fr_auto] gap-3 rounded-xl border p-3 text-sm">
                    <div>
                      <p className="font-medium">{item.quantity} × {item.name}</p>
                      {item.note && <p className="text-muted-foreground">{item.note}</p>}
                      {!item.mapped && <p className="text-red-700">Not mapped to a POS menu item</p>}
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
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: WebsiteOrderStatus }) {
  const destructive = status === "rejected" || status === "cancelled";
  const complete = status === "delivered" || status === "ready";
  return (
    <Badge variant={destructive ? "destructive" : complete ? "secondary" : status === "pending" ? "default" : "outline"}>
      {destructive ? <X /> : complete ? <Check /> : <Clock3 />} {statusLabel(status)}
    </Badge>
  );
}

async function printAcceptedOrder(result: WebsiteOrderAcceptance): Promise<string> {
  if (result.alreadyAccepted) return `${result.websiteOrder.orderCode} was already accepted; no duplicate copies were printed.`;
  const print = window.yamzo?.print;
  if (!print) return `${result.websiteOrder.orderCode} accepted. Print jobs are queued for retry.`;
  const kitchenPrinted = await print.printJob(result.kitchenPrintJobId);
  const deliveryPrinted = await print.printJob(result.deliveryPrintJobId);
  if (kitchenPrinted && deliveryPrinted) return `${result.websiteOrder.orderCode} accepted; kitchen and delivery copies printed.`;
  if (!kitchenPrinted && !deliveryPrinted) return `${result.websiteOrder.orderCode} accepted; both print jobs need retry.`;
  return `${result.websiteOrder.orderCode} accepted; ${kitchenPrinted ? "delivery" : "kitchen"} copy needs retry.`;
}

async function playBoundedOrderChime(): Promise<void> {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  try {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.7);
    gain.connect(context.destination);
    const first = context.createOscillator();
    first.type = "sine";
    first.frequency.value = 660;
    first.connect(gain);
    first.start(context.currentTime);
    first.stop(context.currentTime + 0.24);
    const second = context.createOscillator();
    second.type = "sine";
    second.frequency.value = 880;
    second.connect(gain);
    second.start(context.currentTime + 0.28);
    second.stop(context.currentTime + 0.68);
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  } catch {
    // Audio is optional and may be blocked by the host until another user gesture.
  } finally {
    await context.close().catch(() => undefined);
  }
}

function statusLabel(status: WebsiteOrderStatus): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTk(value: number): string {
  return `${Math.round(value).toLocaleString("en-BD")} TK`;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(timestamp).toLocaleDateString("en-BD");
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Website order action failed.";
}
