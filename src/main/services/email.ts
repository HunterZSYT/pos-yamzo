import type Database from "better-sqlite3";
import { google } from "googleapis";
import type {
  EmailSendResult,
  EmailSettings,
  EmailSettingsInput
} from "../../shared/types.js";
import { getSalesSummary } from "../domain/reports.js";
import { getMenuTypes } from "./settings.js";
import {
  assertGoogleOAuthScopes,
  disconnectGoogle,
  ensureConnectedGoogleEmail,
  getAuthorizedGoogleClient,
  getGoogleSheetsSettings,
  GOOGLE_GMAIL_SEND_SCOPE,
  safeGoogleError
} from "./googleSheets.js";

const DEFAULT_DAILY_SEND_TIME = "22:00";
const SCHEDULER_INTERVAL_MS = 60_000;
const runningScheduledSends = new WeakSet<Database.Database>();

interface EmailSettingsRow {
  enabled: number;
  recipient_email: string | null;
  send_daily_summary: number;
  send_each_settled_order: number;
  send_time: string | null;
  last_daily_summary_date: string | null;
  last_daily_summary_sent_at: string | null;
  last_error: string | null;
}

export interface ScheduledEmailCheckOptions {
  now?: Date;
  send?: (db: Database.Database, dateLabel: string) => Promise<EmailSendResult>;
}

export function getEmailSettings(db: Database.Database): EmailSettings {
  const row = db.prepare("SELECT * FROM email_settings WHERE id = 1").get() as EmailSettingsRow | undefined;
  const googleSettings = getGoogleSheetsSettings(db);
  return {
    enabled: row?.enabled === 1,
    recipientEmail: row?.recipient_email ?? "",
    sendDailySummary: row?.send_daily_summary === 1,
    sendEachSettledOrder: row?.send_each_settled_order === 1,
    sendTime: normalizeSendTime(row?.send_time),
    connectedEmail: googleSettings.connectedEmail,
    lastDailySummaryDate: row?.last_daily_summary_date ?? null,
    lastDailySummarySentAt: row?.last_daily_summary_sent_at ?? null,
    lastError: row?.last_error ?? null
  };
}

export function saveEmailSettings(db: Database.Database, input: EmailSettingsInput): EmailSettings {
  const current = getEmailSettings(db);
  const recipientEmail = input.recipientEmail === undefined
    ? current.recipientEmail
    : normalizeEmail(input.recipientEmail);
  if (recipientEmail && !isValidEmail(recipientEmail)) throw new Error("Enter a valid summary recipient email address.");
  const sendTime = input.sendTime === undefined ? normalizeSendTime(current.sendTime) : normalizeSendTime(input.sendTime, true);
  const next = {
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    recipientEmail,
    sendDailySummary: input.sendDailySummary === undefined ? current.sendDailySummary : Boolean(input.sendDailySummary),
    sendEachSettledOrder: input.sendEachSettledOrder === undefined
      ? current.sendEachSettledOrder
      : Boolean(input.sendEachSettledOrder),
    sendTime
  };
  if (next.enabled && next.sendDailySummary && !next.recipientEmail) {
    throw new Error("Enter the email address that should receive the daily summary.");
  }

  db.prepare(
    `INSERT INTO email_settings
      (id, enabled, recipient_email, send_daily_summary, send_each_settled_order, send_time, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       recipient_email = excluded.recipient_email,
       send_daily_summary = excluded.send_daily_summary,
       send_each_settled_order = excluded.send_each_settled_order,
       send_time = excluded.send_time,
       updated_at = CURRENT_TIMESTAMP`
  ).run(
    next.enabled ? 1 : 0,
    next.recipientEmail || null,
    next.sendDailySummary ? 1 : 0,
    next.sendEachSettledOrder ? 1 : 0,
    next.sendTime
  );
  return getEmailSettings(db);
}

/** @deprecated Google Sheets and Gmail now share one managed Google connection. */
export function clearGmailAuth(db: Database.Database): void {
  disconnectGoogle(db);
  setEmailDeliveryState(db, { lastError: null });
}

export function buildDailySalesEmail(db: Database.Database, dateLabel = localBusinessDate()): string {
  const summary = getSalesSummary(db, { startDate: dateLabel, endDate: dateLabel });
  const sourceLabels = new Map(getMenuTypes(db).map((source) => [source.key, source.label]));
  const lines = [
    `Yamzo Daily Sales Summary - ${dateLabel}`,
    "",
    `Net sales: ${summary.netSales} TK`,
    `Gross sales: ${summary.grossSales} TK`,
    `Completed orders: ${summary.totalOrders}`,
    `Average order: ${summary.averageOrderValue} TK`,
    `Discount total: ${summary.discountTotal} TK`,
    `Commission total: ${summary.commissionTotal} TK`,
    `Recorded costs: ${summary.recordedCostTotal} TK`,
    `Operating profit: ${summary.operatingProfit} TK`,
    "",
    "Payment breakdown:",
    ...nonEmptyLines(Object.entries(summary.paymentBreakdown).map(([method, total]) => `- ${method}: ${total} TK`)),
    "",
    "Order sources:",
    ...nonEmptyLines(summary.sourceTotals.map((source) =>
      `- ${sourceLabels.get(source.source) ?? humanizeSource(source.source)}: ${source.orders} orders, ${source.netSales} TK net`)),
    "",
    "Top-selling items:",
    ...nonEmptyLines(summary.topItems.map((item) => `- ${item.name}: ${item.quantity} (${item.total} TK)`))
  ];
  return lines.join("\n");
}

export async function sendDailySalesEmail(
  db: Database.Database,
  dateLabel = localBusinessDate()
): Promise<EmailSendResult> {
  const settings = getEmailSettings(db);
  if (!settings.recipientEmail) throw new Error("Enter the email address that should receive the daily summary.");
  if (!isValidEmail(settings.recipientEmail)) throw new Error("The summary recipient email address is invalid.");

  try {
    const auth = getAuthorizedGoogleClient(db);
    await assertGoogleOAuthScopes(auth, [GOOGLE_GMAIL_SEND_SCOPE]);
    const connectedEmail = await ensureConnectedGoogleEmail(db, auth);
    const gmail = google.gmail({ version: "v1", auth });
    const sentAt = new Date().toISOString();
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: buildRawEmail({
          from: connectedEmail,
          to: settings.recipientEmail,
          subject: `Yamzo Daily Sales Summary - ${dateLabel}`,
          text: buildDailySalesEmail(db, dateLabel)
        })
      }
    });
    setEmailDeliveryState(db, { lastError: null });
    return { recipientEmail: settings.recipientEmail, connectedEmail, sentAt };
  } catch (error) {
    const message = safeGoogleError(error);
    setEmailDeliveryState(db, { lastError: message });
    throw new Error(message);
  }
}

export async function runScheduledDailyEmail(
  db: Database.Database,
  options: ScheduledEmailCheckOptions = {}
): Promise<boolean> {
  const settings = getEmailSettings(db);
  if (!settings.enabled || !settings.sendDailySummary || !settings.recipientEmail) return false;
  const now = options.now ?? new Date();
  const businessDate = localBusinessDate(now);
  if (settings.lastDailySummaryDate === businessDate) return false;
  if (localMinutes(now) < timeToMinutes(normalizeSendTime(settings.sendTime))) return false;
  if (runningScheduledSends.has(db)) return false;

  runningScheduledSends.add(db);
  try {
    const result = await (options.send ?? sendDailySalesEmail)(db, businessDate);
    setEmailDeliveryState(db, {
      lastDailySummaryDate: businessDate,
      lastDailySummarySentAt: result.sentAt,
      lastError: null
    });
    return true;
  } catch (error) {
    setEmailDeliveryState(db, { lastError: safeGoogleError(error) });
    throw error;
  } finally {
    runningScheduledSends.delete(db);
  }
}

export function startDailyEmailScheduler(db: Database.Database): () => void {
  const check = () => {
    void runScheduledDailyEmail(db).catch(() => {
      // Delivery errors are persisted for the Admin status card and retried on the next interval.
    });
  };
  check();
  const timer = setInterval(check, SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function localBusinessDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setEmailDeliveryState(
  db: Database.Database,
  state: {
    lastDailySummaryDate?: string | null;
    lastDailySummarySentAt?: string | null;
    lastError?: string | null;
  }
): void {
  const assignments: string[] = [];
  const values: Array<string | null> = [];
  if (state.lastDailySummaryDate !== undefined) {
    assignments.push("last_daily_summary_date = ?");
    values.push(state.lastDailySummaryDate);
  }
  if (state.lastDailySummarySentAt !== undefined) {
    assignments.push("last_daily_summary_sent_at = ?");
    values.push(state.lastDailySummarySentAt);
  }
  if (state.lastError !== undefined) {
    assignments.push("last_error = ?");
    values.push(state.lastError);
  }
  if (assignments.length === 0) return;
  db.prepare(`UPDATE email_settings SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
    .run(...values);
}

function buildRawEmail(input: { from: string; to: string; subject: string; text: string }): string {
  for (const value of [input.from, input.to, input.subject]) {
    if (/[\r\n]/.test(value)) throw new Error("Email headers cannot contain line breaks.");
  }
  const mime = [
    `From: Yamzo POS <${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeSendTime(value: unknown, strict = false): string {
  const text = String(value ?? "").trim();
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) return text;
  if (strict) throw new Error("Choose a valid daily summary time.");
  return DEFAULT_DAILY_SEND_TIME;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function localMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

function nonEmptyLines(lines: string[]): string[] {
  return lines.length > 0 ? lines : ["- None"];
}

function humanizeSource(source: string): string {
  return source
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toLocaleUpperCase());
}
