import { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getPrintJob, markPrintJobFailed, markPrintJobPrinted, markPrintJobRetry } from "./printQueue.js";

const execFileAsync = promisify(execFile);
const REVIEW_URL = "https://www.facebook.com/yamzo.uttara/reviews";

export interface PrinterInfo {
  name: string;
  displayName: string;
  status: number;
  isDefault: boolean;
}

export async function listWindowsPrinters(): Promise<PrinterInfo[]> {
  const probe = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    const printers = await probe.webContents.getPrintersAsync();
    return printers.map((printer) => {
      const extended = printer as typeof printer & { status?: number; isDefault?: boolean };
      return {
      name: printer.name,
      displayName: printer.displayName,
      status: extended.status ?? 0,
      isDefault: extended.isDefault ?? false
      };
    });
  } finally {
    probe.destroy();
  }
}

export async function printJob(db: Database.Database, id: number): Promise<boolean> {
  const job = getPrintJob(db, id);
  try {
    await printPlainText(job.content, job.printer ?? undefined);
    markPrintJobPrinted(db, id);
    return true;
  } catch (error) {
    markPrintJobFailed(db, id, error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function retryPrintJob(db: Database.Database, id: number): Promise<boolean> {
  markPrintJobRetry(db, id);
  return printJob(db, id);
}

export async function printPlainText(content: string, printer?: string): Promise<void> {
  if (process.platform === "win32" && printer) {
    const port = await getWindowsPrinterPort(printer);
    if (port && /^COM\d+:?$/i.test(port)) {
      await printEscPosToComPort(content, port);
      return;
    }
  }

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const html = renderReceiptHtml(content);
  const pageHeight = receiptPageHeightMicrons(content);
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const resolvedPrinter = await resolvePrinterName(win, printer);
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        {
          silent: true,
          printBackground: false,
          deviceName: resolvedPrinter,
          margins: { marginType: "none" },
          pageSize: { width: 80000, height: pageHeight }
        },
        (success, failureReason) => {
          if (success) {
            resolve();
          } else {
            reject(new Error(failureReason || "Printing failed."));
          }
        }
      );
    });
  } finally {
    win.destroy();
  }
}

async function getWindowsPrinterPort(printer: string): Promise<string | null> {
  const command = `$printer = Get-Printer -Name ${powershellString(printer)} -ErrorAction Stop; $printer.PortName`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function printEscPosToComPort(content: string, port: string): Promise<void> {
  const normalizedPort = port.endsWith(":") ? port : `${port}:`;
  const bytes = Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from([0x1b, 0x33, 0x36]),
    await encodeEscPosContent(content),
    Buffer.from("\r\n\r\n", "ascii"),
    Buffer.from([0x1b, 0x64, 0x06]),
    Buffer.from([0x1d, 0x56, 0x01])
  ]);
  const file = path.join(os.tmpdir(), `yamzo-print-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  await fs.writeFile(file, bytes);
  try {
    await execFileAsync("cmd.exe", ["/d", "/c", "copy", "/b", file, normalizedPort], {
      windowsHide: true
    });
  } finally {
    await fs.rm(file, { force: true });
  }
}

async function encodeEscPosContent(content: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "[[YAMZO_LOGO]]") {
      chunks.push(await brandHeaderBytes());
    } else if (line.trim() === "[[YAMZO_REVIEW_QR]]") {
      chunks.push(reviewQrBytes());
    } else if (isReceiptTitle(line)) {
      chunks.push(receiptTitleBytes(line.trim()));
    } else if (line.trim().startsWith("TOTAL:")) {
      chunks.push(totalLineBytes(line));
    } else {
      chunks.push(Buffer.from(`${line}\r\n`, "utf8"));
    }
  }
  return Buffer.concat(chunks);
}

async function brandHeaderBytes(): Promise<Buffer> {
  const logoAsset = await readBundledBrandAsset("yamzo-receipt-logo.escpos.bin");
  if (logoAsset) {
    return Buffer.concat([
      Buffer.from([0x1b, 0x61, 0x01]),
      logoAsset,
      Buffer.from("\r\n", "ascii"),
      Buffer.from([0x1b, 0x61, 0x00])
    ]);
  }
  return textBrandHeaderBytes();
}

function textBrandHeaderBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x1b, 0x61, 0x01]),
    Buffer.from([0x1b, 0x45, 0x01]),
    Buffer.from([0x1d, 0x21, 0x11]),
    Buffer.from("YAMZO\r\n", "ascii"),
    Buffer.from([0x1d, 0x21, 0x00]),
    Buffer.from("Taste The Fun, Dive Into Flavour\r\n\r\n", "ascii"),
    Buffer.from([0x1b, 0x45, 0x00]),
    Buffer.from([0x1b, 0x61, 0x00])
  ]);
}

function isReceiptTitle(line: string): boolean {
  return ["RECEIPT", "BILL COPY", "RECEIPT REPRINT", "KITCHEN COPY"].includes(line.trim());
}

function receiptTitleBytes(title: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x1b, 0x61, 0x01]),
    Buffer.from([0x1b, 0x45, 0x01]),
    Buffer.from([0x1b, 0x21, 0x10]),
    Buffer.from(`${title}\r\n`, "ascii"),
    Buffer.from([0x1b, 0x21, 0x00]),
    Buffer.from([0x1b, 0x45, 0x00]),
    Buffer.from([0x1b, 0x61, 0x00])
  ]);
}

function totalLineBytes(line: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x1b, 0x45, 0x01]),
    Buffer.from(`${line}\r\n`, "utf8"),
    Buffer.from([0x1b, 0x45, 0x00])
  ]);
}

function reviewQrBytes(): Buffer {
  const data = Buffer.from(REVIEW_URL, "ascii");
  const storeLength = data.length + 3;
  return Buffer.concat([
    Buffer.from([0x1b, 0x61, 0x01]),
    Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x05]),
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
    Buffer.from([0x1d, 0x28, 0x6b, storeLength & 0xff, (storeLength >> 8) & 0xff, 0x31, 0x50, 0x30]),
    data,
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
    Buffer.from("\r\n", "ascii"),
    Buffer.from([0x1b, 0x61, 0x00])
  ]);
}

async function readBundledBrandAsset(fileName: string): Promise<Buffer | null> {
  const candidates = [
    path.join(process.cwd(), "resources", "brand", fileName),
    path.join(process.resourcesPath || "", "resources", "brand", fileName),
    path.join(process.resourcesPath || "", "app.asar", "resources", "brand", fileName)
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate);
    } catch {
      // Try the next known runtime location, then fall back to text branding.
    }
  }
  return null;
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function receiptPageHeightMicrons(content: string): number {
  const lineCount = Math.max(content.split("\n").length + 8, 24);
  const heightMillimeters = Math.min(Math.max(lineCount * 6, 120), 300);
  return Math.round(heightMillimeters * 1000);
}

async function resolvePrinterName(win: BrowserWindow, printer?: string): Promise<string> {
  if (!printer?.trim()) {
    throw new Error("No receipt printer selected.");
  }
  const printers = await win.webContents.getPrintersAsync();
  const selected = printer.trim();
  const match = printers.find((item) => item.name === selected || item.displayName === selected);
  if (!match) {
    throw new Error(`Selected printer was not found: ${selected}`);
  }
  return match.name;
}

export function renderReceiptHtml(content: string): string {
  const previewContent = content
    .replaceAll("[[YAMZO_LOGO]]", "YAMZO\nTaste The Fun, Dive Into Flavour")
    .replaceAll("[[YAMZO_REVIEW_QR]]", "[Review QR]");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { margin: 0; size: 80mm auto; }
    body { width: 72mm; margin: 0; padding: 5mm 4mm 16mm; font-family: Consolas, monospace; font-size: 16px; line-height: 1.8; color: #000; }
    pre { white-space: pre-wrap; margin: 0; }
  </style>
</head>
<body><pre>${escapeHtml(previewContent)}</pre></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
