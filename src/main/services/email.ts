import type Database from "better-sqlite3";
import fs from "node:fs";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import type { EmailSettings, GmailOAuthConfig } from "../../shared/types.js";
import { getSalesSummary } from "../domain/reports.js";

export function getEmailSettings(db: Database.Database): EmailSettings {
  const row = db.prepare("SELECT * FROM email_settings WHERE id = 1").get() as
    | {
        enabled: number;
        recipient_email: string | null;
        send_daily_summary: number;
        send_each_settled_order: number;
        credential_path: string | null;
        token_path: string | null;
      }
    | undefined;
  return {
    enabled: row?.enabled === 1,
    recipientEmail: row?.recipient_email ?? "",
    sendDailySummary: row?.send_daily_summary === 1,
    sendEachSettledOrder: row?.send_each_settled_order === 1,
    credentialPath: row?.credential_path ?? "",
    tokenPath: row?.token_path ?? ""
  };
}

export function saveEmailSettings(db: Database.Database, settings: EmailSettings): void {
  db.prepare(
    `INSERT INTO email_settings
      (id, enabled, recipient_email, send_daily_summary, send_each_settled_order, credential_path, token_path, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       recipient_email = excluded.recipient_email,
       send_daily_summary = excluded.send_daily_summary,
       send_each_settled_order = excluded.send_each_settled_order,
       credential_path = excluded.credential_path,
       token_path = excluded.token_path,
       updated_at = CURRENT_TIMESTAMP`
  ).run(
    settings.enabled ? 1 : 0,
    settings.recipientEmail || null,
    settings.sendDailySummary ? 1 : 0,
    settings.sendEachSettledOrder ? 1 : 0,
    settings.credentialPath || null,
    settings.tokenPath || null
  );
}

export function clearGmailAuth(db: Database.Database): void {
  const settings = getEmailSettings(db);
  if (settings.tokenPath && fs.existsSync(settings.tokenPath)) {
    fs.rmSync(settings.tokenPath, { force: true });
  }
  saveEmailSettings(db, { ...settings, tokenPath: "" });
}

export function buildDailySalesEmail(db: Database.Database, dateLabel = new Date().toISOString().slice(0, 10)): string {
  const summary = getSalesSummary(db);
  const lines = [
    `Yamzo Daily Sales Summary - ${dateLabel}`,
    "",
    `Total sales: ${summary.totalSales} TK`,
    `Total orders: ${summary.totalOrders}`,
    `Discount total: ${summary.discountTotal} TK`,
    `Void/cancel total: ${summary.voidTotal} TK`,
    "",
    "Payment breakdown:",
    ...Object.entries(summary.paymentBreakdown).map(([method, total]) => `- ${method}: ${total} TK`),
    "",
    "Source breakdown:",
    ...Object.entries(summary.sourceBreakdown).map(([source, count]) => `- ${source}: ${count}`),
    "",
    "Top selling items:",
    ...summary.topItems.map((item) => `- ${item.name}: ${item.quantity} (${item.total} TK)`)
  ];
  return lines.join("\n");
}

export function createGmailAuthUrl(config: GmailOAuthConfig): string {
  const oauth2 = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.send"]
  });
}

export async function sendDailySalesEmail(db: Database.Database): Promise<void> {
  const settings = getEmailSettings(db);
  if (!settings.enabled || !settings.recipientEmail) {
    throw new Error("Email notifications are disabled or recipient email is missing.");
  }
  if (!settings.credentialPath || !settings.tokenPath) {
    throw new Error("Gmail credential path or token path is missing.");
  }
  const credential = readJson<GmailOAuthConfig>(settings.credentialPath);
  const token = readJson<{ refresh_token?: string; access_token?: string }>(settings.tokenPath);
  const oauth2 = new google.auth.OAuth2(credential.clientId, credential.clientSecret, credential.redirectUri);
  oauth2.setCredentials(token);
  const accessToken = await oauth2.getAccessToken();
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: settings.recipientEmail,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      refreshToken: token.refresh_token,
      accessToken: accessToken.token ?? token.access_token
    }
  });
  await transporter.sendMail({
    from: settings.recipientEmail,
    to: settings.recipientEmail,
    subject: "Yamzo Daily Sales Summary",
    text: buildDailySalesEmail(db)
  });
}

function readJson<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required local auth file does not exist: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
