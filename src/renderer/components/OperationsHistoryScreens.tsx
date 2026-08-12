import { useEffect, useState } from "react";
import type { HistoryRange, KotHistoryEntry, SwapHistoryEntry } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Preset = "today" | "yesterday" | "7days" | "month" | "custom";

export function KitchenKotHistoryScreen() {
  const [range, setRange] = useState<HistoryRange>(() => rangeFor("today"));
  const [preset, setPreset] = useState<Preset>("today");
  const [rows, setRows] = useState<KotHistoryEntry[]>([]);
  useEffect(() => { void window.yamzo?.operations.kotHistory(range).then(setRows); }, [range.startDate, range.endDate]);
  return (
    <HistoryShell title="Kitchen KOT" description="Immutable Kitchen KOT jobs and every audited print attempt." preset={preset} range={range} onPreset={(next) => { setPreset(next); if (next !== "custom") setRange(rangeFor(next)); }} onRange={setRange}>
      <Table>
        <TableHeader><TableRow><TableHead>KOT</TableHead><TableHead>Order</TableHead><TableHead>Items</TableHead><TableHead>Operator / Manager</TableHead><TableHead>Printer</TableHead><TableHead>Attempts</TableHead><TableHead>Status</TableHead><TableHead>Requested</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((row) => <TableRow key={row.printJobId}>
          <TableCell><strong>#{row.printJobId}</strong><span className="block text-xs text-muted-foreground">{label(row.kotType)}</span></TableCell>
          <TableCell><strong>{row.orderNumber}</strong><span className="block text-xs text-muted-foreground">{row.tableNumber ?? label(row.source)} · {row.guestCount} guest{row.guestCount === 1 ? "" : "s"}</span></TableCell>
          <TableCell className="max-w-72 text-xs">{row.items.length ? row.items.join(", ") : "See immutable KOT content"}</TableCell>
          <TableCell>{row.operator}{row.managerName && <span className="block text-xs text-muted-foreground">Manager: {row.managerName}</span>}</TableCell>
          <TableCell>{row.printer ?? "Not selected"}</TableCell>
          <TableCell>{row.successfulPrintCount} successful / {row.attemptCount} total</TableCell>
          <TableCell><Badge variant="outline">{label(row.status)}</Badge>{row.errorMessage && <span className="mt-1 block max-w-48 text-xs text-red-700">{row.errorMessage}</span>}</TableCell>
          <TableCell>{formatDate(row.requestedAt)}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </HistoryShell>
  );
}

export function SwappedOrdersScreen() {
  const [range, setRange] = useState<HistoryRange>(() => rangeFor("today"));
  const [preset, setPreset] = useState<Preset>("today");
  const [rows, setRows] = useState<SwapHistoryEntry[]>([]);
  useEffect(() => { void window.yamzo?.operations.swapHistory(range).then(setRows); }, [range.startDate, range.endDate]);
  return (
    <HistoryShell title="Swapped Orders" description="Post-KOT changes with manager authorization, reasons, and adjustment KOT state." preset={preset} range={range} onPreset={(next) => { setPreset(next); if (next !== "custom") setRange(rangeFor(next)); }} onRange={setRange}>
      <Table>
        <TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Change</TableHead><TableHead>Reason</TableHead><TableHead>Manager</TableHead><TableHead>Operator</TableHead><TableHead>KOT link</TableHead><TableHead>Prints</TableHead><TableHead>Time</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((row) => <TableRow key={row.id}>
          <TableCell><strong>{row.orderNumber}</strong><span className="block text-xs text-muted-foreground">{row.tableNumber ?? label(row.source)}</span></TableCell>
          <TableCell><span className="block">{row.originalQuantity} x {row.originalName}</span><strong className="text-sky-800">→ {row.replacementName ? `${row.replacementQuantity} x ${row.replacementName}` : "Removed"}</strong></TableCell>
          <TableCell className="max-w-64">{row.reason}</TableCell><TableCell>{row.managerName}</TableCell><TableCell>{row.operator}</TableCell>
          <TableCell><span className="block text-xs">Original #{row.originalKotPrintJobId ?? "-"}</span><span className="block text-xs">Adjustment #{row.adjustmentPrintJobId}</span><Badge variant="outline">{label(row.adjustmentStatus)}</Badge></TableCell>
          <TableCell>{row.successfulPrintCount}</TableCell><TableCell>{formatDate(row.createdAt)}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </HistoryShell>
  );
}

function HistoryShell({ title, description, preset, range, onPreset, onRange, children }: { title: string; description: string; preset: Preset; range: HistoryRange; onPreset: (preset: Preset) => void; onRange: (range: HistoryRange) => void; children: React.ReactNode }) {
  return <section className="h-screen overflow-hidden p-4"><Card className="grid h-full grid-rows-[auto_1fr] overflow-hidden py-0"><CardHeader className="border-b py-4"><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription><div className="flex flex-wrap gap-2">{(["today", "yesterday", "7days", "month", "custom"] as Preset[]).map((value) => <Button key={value} size="sm" variant={preset === value ? "default" : "secondary"} onClick={() => onPreset(value)}>{value === "7days" ? "Last 7 Days" : value === "month" ? "This Month" : label(value)}</Button>)}</div>{preset === "custom" && <div className="grid max-w-xl grid-cols-2 gap-3"><div><Label>From</Label><Input type="date" value={range.startDate ?? ""} onChange={(event) => onRange({ ...range, startDate: event.target.value })} /></div><div><Label>To</Label><Input type="date" value={range.endDate ?? ""} onChange={(event) => onRange({ ...range, endDate: event.target.value })} /></div></div>}</CardHeader><ScrollArea><CardContent className="p-4">{children}</CardContent></ScrollArea></Card></section>;
}

function rangeFor(preset: Exclude<Preset, "custom">): HistoryRange {
  const end = new Date();
  const start = new Date(end);
  if (preset === "yesterday") { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
  if (preset === "7days") start.setDate(start.getDate() - 6);
  if (preset === "month") start.setDate(1);
  return { startDate: localDate(start), endDate: localDate(end) };
}
function localDate(value: Date) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function label(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDate(value: string) { const parsed = new Date(value.includes("T") ? value : value.replace(" ", "T")); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value; }
