import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { googleAuthLibrary, type OAuth2Client } from "googleapis-common";
import { google } from "googleapis";
import type {
  GoogleIntegrationErrorCode,
  GoogleOAuthClientInput,
  GoogleReportToolResult,
  GoogleSheetTabListResult,
  GoogleSheetsConnectionResult,
  GoogleSheetsSettings,
  GoogleSheetsSettingsInput,
  GoogleSheetsSyncResult,
  GoogleSheetsSyncStatus,
  GoogleSpreadsheetOption
} from "../../shared/types.js";
import { getSetting, setSetting } from "./settings.js";

export type {
  GoogleReportToolResult,
  GoogleSheetsConnectionResult,
  GoogleSheetsSettings,
  GoogleSheetsSettingsInput,
  GoogleSheetsSyncResult,
  GoogleSheetsSyncStatus
} from "../../shared/types.js";

export const GOOGLE_SHEETS_SETTING_KEY = "googleSheets";
export const GOOGLE_OAUTH_REDIRECT_URI = "http://127.0.0.1:42813/oauth2callback";
export const GOOGLE_APPS_SCRIPT_USER_SETTINGS_URL = "https://script.google.com/home/usersettings";

const GOOGLE_OAUTH_PORT = 42813;
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SCRIPT_SCOPE = "https://www.googleapis.com/auth/script.projects";
const GOOGLE_DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
export const GOOGLE_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GOOGLE_USER_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GOOGLE_SCOPES = [
  GOOGLE_SHEETS_SCOPE,
  GOOGLE_SCRIPT_SCOPE,
  GOOGLE_DRIVE_METADATA_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  GOOGLE_USER_EMAIL_SCOPE
];
const DEFAULT_DEBOUNCE_MS = 1_500;
const WRITE_CHUNK_SIZE = 5_000;

export interface GoogleSheetsConnectOptions {
  openExternal?: (url: string) => Promise<void> | void;
  timeoutMs?: number;
}

export interface GoogleSheetsQueueOptions {
  debounceMs?: number;
}

type SheetValue = string | number | boolean;
type Credentials = OAuth2Client["credentials"];

export interface GoogleSheetDataset {
  headers: string[];
  rows: SheetValue[][];
}

export interface GoogleSheetsSnapshot {
  orders: GoogleSheetDataset;
  orderItems: GoogleSheetDataset;
  costs: GoogleSheetDataset;
}

interface OAuthClientDefinition {
  clientId: string;
  clientSecret: string;
}

interface InternalGoogleSheetsSettings extends GoogleSheetsSettings {
  credentialPath: string;
  tokenPath: string;
}

export interface GoogleIntegrationFailure {
  message: string;
  code: GoogleIntegrationErrorCode;
  actionUrl: string | null;
}

interface QueueState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  requested: boolean;
}

interface SheetMetadata {
  sheetId: number;
  title: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
}

const syncQueues = new WeakMap<Database.Database, QueueState>();

export function getGoogleSheetsSettings(db: Database.Database): GoogleSheetsSettings {
  return toRendererGoogleSheetsSettings(getInternalGoogleSheetsSettings(db));
}

function getInternalGoogleSheetsSettings(db: Database.Database): InternalGoogleSheetsSettings {
  const defaults = defaultGoogleSheetsSettings();
  let stored: Partial<InternalGoogleSheetsSettings> = {};
  try {
    stored = getSetting<Partial<InternalGoogleSheetsSettings>>(db, GOOGLE_SHEETS_SETTING_KEY, {});
  } catch {
    stored = {};
  }

  const tokenPath = normalizeFilePath(stored.tokenPath, defaults.tokenPath);
  const credentialPath = normalizeFilePath(stored.credentialPath, defaults.credentialPath);
  const hasClientCredentials = fs.existsSync(credentialPath);
  const connected = hasClientCredentials && hasUsableTokenFile(tokenPath);
  const enabled = typeof stored.enabled === "boolean" ? stored.enabled : defaults.enabled;
  const savedStatus = isSyncStatus(stored.syncStatus)
    ? stored.syncStatus
    : connected
      ? enabled ? "pending" : "ready"
      : "disconnected";
  const syncStatus = savedStatus === "syncing" ? "pending" : savedStatus;

  return {
    enabled,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
    spreadsheetId: normalizeSpreadsheetId(stored.spreadsheetId ?? defaults.spreadsheetId),
    spreadsheetTitle: nullableText(stored.spreadsheetTitle),
    ordersTab: normalizeSheetTitle(stored.ordersTab, defaults.ordersTab),
    orderItemsTab: normalizeSheetTitle(stored.orderItemsTab, defaults.orderItemsTab),
    costsTab: normalizeSheetTitle(stored.costsTab, defaults.costsTab),
    credentialPath,
    tokenPath,
    clientId: stringValue(stored.clientId),
    hasClientCredentials,
    connectedEmail: connected ? nullableText(stored.connectedEmail) : null,
    connected,
    syncStatus: connected ? syncStatus : "disconnected",
    pending: connected ? (typeof stored.pending === "boolean" ? stored.pending : defaults.pending) : false,
    lastSyncedAt: nullableText(stored.lastSyncedAt),
    lastAttemptAt: nullableText(stored.lastAttemptAt),
    lastError: nullableText(stored.lastError),
    lastErrorCode: isGoogleErrorCode(stored.lastErrorCode) ? stored.lastErrorCode : null,
    lastErrorActionUrl: nullableText(stored.lastErrorActionUrl),
    scriptProjectId: nullableText(stored.scriptProjectId),
    reportToolInstalled: stored.reportToolInstalled === true && Boolean(stored.scriptProjectId)
  };
}

export function setGoogleSheetsSettings(db: Database.Database, input: GoogleSheetsSettingsInput): GoogleSheetsSettings {
  const current = getInternalGoogleSheetsSettings(db);
  const nextEditable = {
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    spreadsheetId: input.spreadsheetId === undefined ? current.spreadsheetId : normalizeSpreadsheetId(input.spreadsheetId),
    ordersTab: input.ordersTab === undefined ? current.ordersTab : normalizeSheetTitle(input.ordersTab, "Orders"),
    orderItemsTab: input.orderItemsTab === undefined ? current.orderItemsTab : normalizeSheetTitle(input.orderItemsTab, "Order Items"),
    costsTab: input.costsTab === undefined ? current.costsTab : normalizeSheetTitle(input.costsTab, "Costs"),
    // Auth file locations are main-process managed. Renderer input can never redirect secret/token storage.
    credentialPath: current.credentialPath,
    tokenPath: current.tokenPath
  };
  validateGoogleSheetsMapping(nextEditable, false);

  const targetChanged = current.spreadsheetId !== nextEditable.spreadsheetId;
  const exportShapeChanged = targetChanged
    || current.ordersTab !== nextEditable.ordersTab
    || current.orderItemsTab !== nextEditable.orderItemsTab
    || current.costsTab !== nextEditable.costsTab;
  const connectionChanged = current.credentialPath !== nextEditable.credentialPath || current.tokenPath !== nextEditable.tokenPath;
  const connected = hasUsableTokenFile(nextEditable.tokenPath);
  const shouldBePending = nextEditable.enabled && connected && (
    exportShapeChanged
    || connectionChanged
    || current.pending
    || !current.enabled
  );
  const next: InternalGoogleSheetsSettings = {
    ...current,
    ...nextEditable,
    spreadsheetTitle: targetChanged ? null : current.spreadsheetTitle,
    connected,
    pending: shouldBePending,
    syncStatus: connected ? (shouldBePending ? "pending" : "ready") : "disconnected",
    lastError: connectionChanged ? null : current.lastError,
    lastErrorCode: connectionChanged ? null : current.lastErrorCode,
    lastErrorActionUrl: connectionChanged ? null : current.lastErrorActionUrl,
    scriptProjectId: targetChanged ? null : current.scriptProjectId,
    reportToolInstalled: targetChanged || exportShapeChanged ? false : current.reportToolInstalled
  };
  persistGoogleSheetsSettings(db, next);
  return getGoogleSheetsSettings(db);
}

export function saveGoogleOAuthClient(db: Database.Database, input: GoogleOAuthClientInput): GoogleSheetsSettings {
  const clientId = String(input?.clientId ?? "").trim();
  if (!looksLikeGoogleClientId(clientId)) {
    throw new Error("Enter a valid Google OAuth web client ID.");
  }

  const current = getInternalGoogleSheetsSettings(db);
  const managedCredentialPath = findManagedCredentialPath();
  let clientSecret = String(input?.clientSecret ?? "").trim();
  if (!clientSecret && current.clientId === clientId && samePath(current.credentialPath, managedCredentialPath) && fs.existsSync(managedCredentialPath)) {
    clientSecret = readGoogleOAuthCredentials(managedCredentialPath).clientSecret;
  }
  if (!clientSecret) {
    throw new Error("Enter the Google OAuth client secret. It is saved only in this Windows user profile.");
  }
  if (clientSecret.length < 8 || clientSecret.length > 512 || /[\r\n]/.test(clientSecret)) {
    throw new Error("The Google OAuth client secret is invalid.");
  }

  const clientChanged = Boolean(current.clientId) && current.clientId !== clientId;
  writeSecretJsonFile(managedCredentialPath, {
    web: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [GOOGLE_OAUTH_REDIRECT_URI]
    }
  });
  if (clientChanged && fs.existsSync(current.tokenPath)) fs.rmSync(current.tokenPath, { force: true });

  persistGoogleSheetsSettings(db, {
    ...current,
    credentialPath: managedCredentialPath,
    clientId,
    hasClientCredentials: true,
    connected: clientChanged ? false : hasUsableTokenFile(current.tokenPath),
    connectedEmail: clientChanged ? null : current.connectedEmail,
    syncStatus: clientChanged ? "disconnected" : current.syncStatus,
    pending: clientChanged ? false : current.pending,
    lastError: null,
    lastErrorCode: null,
    lastErrorActionUrl: null
  });
  return getGoogleSheetsSettings(db);
}

export async function connectGoogleSheets(
  db: Database.Database,
  options: GoogleSheetsConnectOptions = {}
): Promise<GoogleSheetsConnectionResult> {
  const settings = getInternalGoogleSheetsSettings(db);
  const definition = readGoogleOAuthCredentials(settings.credentialPath);
  const auth = new google.auth.OAuth2(definition.clientId, definition.clientSecret, GOOGLE_OAUTH_REDIRECT_URI);
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: googleAuthLibrary.CodeChallengeMethod.S256
  });

  try {
    const code = await waitForOAuthCode(authUrl, state, options);
    const response = await auth.getToken({ code, codeVerifier: verifier, redirect_uri: GOOGLE_OAUTH_REDIRECT_URI });
    const previous = readTokenFile(settings.tokenPath, false);
    const tokens: Credentials = {
      ...previous,
      ...response.tokens,
      refresh_token: response.tokens.refresh_token ?? previous?.refresh_token
    };
    if (!tokens.refresh_token && !tokens.access_token) {
      throw new Error("Google did not return a reusable authorization token. Revoke the old grant and connect again.");
    }
    writeTokenFile(settings.tokenPath, tokens);
    auth.setCredentials(tokens);
    attachTokenPersistence(auth, settings.tokenPath);
    const connectedEmail = await fetchConnectedGoogleEmail(auth);
    let spreadsheetTitle: string | null = null;
    if (settings.spreadsheetId) {
      try {
        spreadsheetTitle = (await fetchSpreadsheetIdentity(auth, settings.spreadsheetId)).title;
      } catch {
        // The connection is still valid. The user can choose another spreadsheet after sign-in.
      }
    }
    const next: InternalGoogleSheetsSettings = {
      ...settings,
      clientId: definition.clientId,
      hasClientCredentials: true,
      connectedEmail,
      spreadsheetTitle,
      connected: true,
      syncStatus: settings.enabled && settings.spreadsheetId ? "pending" : "ready",
      pending: settings.enabled && Boolean(settings.spreadsheetId),
      lastError: null,
      lastErrorCode: null,
      lastErrorActionUrl: null
    };
    persistGoogleSheetsSettings(db, next);
    return {
      settings: getGoogleSheetsSettings(db),
      spreadsheetTitle,
      connectedEmail,
      redirectUri: GOOGLE_OAUTH_REDIRECT_URI
    };
  } catch (error) {
    const failure = describeGoogleError(error);
    persistGoogleSheetsSettings(db, {
      ...settings,
      connected: hasUsableTokenFile(settings.tokenPath),
      syncStatus: "error",
      pending: settings.enabled,
      lastError: failure.message,
      lastErrorCode: failure.code,
      lastErrorActionUrl: failure.actionUrl,
      lastAttemptAt: new Date().toISOString()
    });
    throw new Error(failure.message);
  }
}

export function disconnectGoogle(db: Database.Database): GoogleSheetsSettings {
  const settings = getInternalGoogleSheetsSettings(db);
  if (fs.existsSync(settings.tokenPath)) fs.rmSync(settings.tokenPath, { force: true });
  persistGoogleSheetsSettings(db, {
    ...settings,
    connected: false,
    connectedEmail: null,
    syncStatus: "disconnected",
    pending: false,
    lastError: null,
    lastErrorCode: null,
    lastErrorActionUrl: null
  });
  return getGoogleSheetsSettings(db);
}

export async function listGoogleSpreadsheets(db: Database.Database): Promise<GoogleSpreadsheetOption[]> {
  const settings = getInternalGoogleSheetsSettings(db);
  try {
    const auth = loadAuthorizedGoogleClient(settings);
    await assertGoogleOAuthScopes(auth, [GOOGLE_DRIVE_METADATA_SCOPE]);
    const drive = google.drive({ version: "v3", auth });
    const files: GoogleSpreadsheetOption[] = [];
    let pageToken: string | undefined;
    do {
      const response = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
        orderBy: "modifiedTime desc",
        pageSize: 100,
        pageToken,
        spaces: "drive",
        fields: "nextPageToken,files(id,name,modifiedTime,webViewLink)"
      });
      for (const file of response.data.files ?? []) {
        if (!file.id || !file.name) continue;
        files.push({
          id: file.id,
          name: file.name,
          modifiedTime: file.modifiedTime ?? null,
          webViewLink: file.webViewLink ?? null
        });
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken && files.length < 1_000);
    return files;
  } catch (error) {
    throwPersistedGoogleFailure(db, settings, error);
  }
}

export async function listGoogleSheetTabs(
  db: Database.Database,
  spreadsheetIdInput?: string
): Promise<GoogleSheetTabListResult> {
  const settings = getInternalGoogleSheetsSettings(db);
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput ?? settings.spreadsheetId);
  if (!looksLikeSpreadsheetId(spreadsheetId)) throw new Error("Choose a valid Google spreadsheet first.");
  try {
    const auth = loadAuthorizedGoogleClient(settings);
    await assertGoogleOAuthScopes(auth, [GOOGLE_SHEETS_SCOPE]);
    const sheets = google.sheets({ version: "v4", auth });
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
      fields: "spreadsheetId,properties(title),sheets(properties(sheetId,title,index,hidden))"
    });
    const spreadsheetTitle = response.data.properties?.title || "Google spreadsheet";
    const tabs = (response.data.sheets ?? []).flatMap((sheet) => {
      const properties = sheet.properties;
      if (properties?.sheetId === undefined || properties.sheetId === null || !properties.title) return [];
      return [{
        id: properties.sheetId,
        title: properties.title,
        index: properties.index ?? 0,
        hidden: properties.hidden === true
      }];
    }).sort((left, right) => left.index - right.index);

    if (spreadsheetId === settings.spreadsheetId) {
      persistGoogleSheetsSettings(db, {
        ...settings,
        spreadsheetTitle,
        lastError: null,
        lastErrorCode: null,
        lastErrorActionUrl: null
      });
    }
    return { spreadsheetId, spreadsheetTitle, tabs };
  } catch (error) {
    throwPersistedGoogleFailure(db, settings, error);
  }
}

export function getAuthorizedGoogleClient(db: Database.Database): OAuth2Client {
  return loadAuthorizedGoogleClient(getInternalGoogleSheetsSettings(db));
}

export async function ensureConnectedGoogleEmail(
  db: Database.Database,
  auth = getAuthorizedGoogleClient(db)
): Promise<string> {
  const settings = getInternalGoogleSheetsSettings(db);
  if (settings.connectedEmail) return settings.connectedEmail;
  const connectedEmail = await fetchConnectedGoogleEmail(auth);
  persistGoogleSheetsSettings(db, { ...settings, connectedEmail });
  return connectedEmail;
}

export async function syncGoogleSheets(db: Database.Database): Promise<GoogleSheetsSyncResult> {
  const settings = getInternalGoogleSheetsSettings(db);
  validateGoogleSheetsTarget(settings);
  const attemptAt = new Date().toISOString();
  persistGoogleSheetsSettings(db, {
    ...settings,
    syncStatus: "syncing",
    pending: true,
    lastAttemptAt: attemptAt,
    lastError: null
  });

  try {
    const auth = loadAuthorizedGoogleClient(settings);
    const snapshot = buildGoogleSheetsSnapshot(db);
    const identity = await reconcileGoogleSheets(auth, settings, snapshot);
    const syncedAt = new Date().toISOString();
    persistGoogleSheetsSettings(db, {
      ...getInternalGoogleSheetsSettings(db),
      connected: true,
      syncStatus: "synced",
      pending: false,
      spreadsheetTitle: identity.title,
      lastSyncedAt: syncedAt,
      lastAttemptAt: attemptAt,
      lastError: null,
      lastErrorCode: null,
      lastErrorActionUrl: null
    });
    return {
      spreadsheetId: settings.spreadsheetId,
      spreadsheetTitle: identity.title,
      orders: snapshot.orders.rows.length,
      orderItems: snapshot.orderItems.rows.length,
      costs: snapshot.costs.rows.length,
      syncedAt
    };
  } catch (error) {
    const failure = describeGoogleError(error);
    persistGoogleSheetsSettings(db, {
      ...getInternalGoogleSheetsSettings(db),
      syncStatus: "error",
      pending: true,
      lastAttemptAt: attemptAt,
      lastError: failure.message,
      lastErrorCode: failure.code,
      lastErrorActionUrl: failure.actionUrl
    });
    throw new Error(failure.message);
  }
}

export function markGoogleSheetsSyncPending(db: Database.Database): GoogleSheetsSettings {
  const settings = getInternalGoogleSheetsSettings(db);
  if (!settings.enabled) return settings;
  const next: InternalGoogleSheetsSettings = {
    ...settings,
    pending: true,
    syncStatus: settings.connected ? "pending" : "disconnected"
  };
  persistGoogleSheetsSettings(db, next);
  return getGoogleSheetsSettings(db);
}

export function queueGoogleSheetsSync(db: Database.Database, options: GoogleSheetsQueueOptions = {}): void {
  const settings = markGoogleSheetsSyncPending(db);
  if (!settings.enabled || !settings.connected) return;
  const state = syncQueues.get(db) ?? { timer: null, running: false, requested: false };
  state.requested = true;
  if (state.timer) clearTimeout(state.timer);
  const debounceMs = Math.max(0, Number(options.debounceMs ?? DEFAULT_DEBOUNCE_MS) || 0);
  state.timer = setTimeout(() => {
    state.timer = null;
    void drainGoogleSheetsQueue(db, state);
  }, debounceMs);
  state.timer.unref?.();
  syncQueues.set(db, state);
}

export async function flushGoogleSheetsSyncQueue(db: Database.Database): Promise<void> {
  const state = syncQueues.get(db);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  await drainGoogleSheetsQueue(db, state);
}

export async function installGoogleReportTool(db: Database.Database): Promise<GoogleReportToolResult> {
  const settings = getInternalGoogleSheetsSettings(db);
  validateGoogleSheetsTarget(settings);
  const auth = loadAuthorizedGoogleClient(settings);
  await assertGoogleOAuthScopes(auth, [GOOGLE_SCRIPT_SCOPE]);
  const scriptApi = google.script({ version: "v1", auth });
  let scriptProjectId = settings.scriptProjectId;

  try {
    if (!scriptProjectId) {
      const created = await scriptApi.projects.create({
        requestBody: {
          parentId: settings.spreadsheetId,
          title: "Yamzo Reports"
        }
      });
      scriptProjectId = created.data.scriptId ?? null;
    }
    if (!scriptProjectId) throw new Error("Google did not return an Apps Script project ID.");

    const files = readGoogleAppsScriptFiles(settings);
    await scriptApi.projects.updateContent({
      scriptId: scriptProjectId,
      requestBody: { files }
    });
    const installedAt = new Date().toISOString();
    persistGoogleSheetsSettings(db, {
      ...getInternalGoogleSheetsSettings(db),
      scriptProjectId,
      reportToolInstalled: true,
      lastError: null,
      lastErrorCode: null,
      lastErrorActionUrl: null
    });
    return {
      scriptProjectId,
      editorUrl: `https://script.google.com/home/projects/${encodeURIComponent(scriptProjectId)}/edit`,
      installedAt
    };
  } catch (error) {
    const failure = describeGoogleError(error);
    persistGoogleSheetsSettings(db, {
      ...getInternalGoogleSheetsSettings(db),
      reportToolInstalled: false,
      lastError: failure.message,
      lastErrorCode: failure.code,
      lastErrorActionUrl: failure.actionUrl
    });
    throw new Error(failure.message);
  }
}

export function buildGoogleSheetsSnapshot(db: Database.Database): GoogleSheetsSnapshot {
  const orderDateExpression = databaseHasColumn(db, "orders", "order_date") ? "o.order_date" : "substr(o.created_at, 1, 10)";
  const orderRows = db.prepare(
    `SELECT o.id, o.order_number, ${orderDateExpression} AS order_date, o.created_at, o.updated_at,
            o.status, o.source, o.external_order_id, o.table_number, o.note, o.discount,
            o.first_kitchen_sent_at, o.kitchen_completed_at, o.settled_at,
            COALESCE(items.subtotal, 0) AS subtotal,
            MAX(COALESCE(items.subtotal, 0) - o.discount, 0) AS total,
            COALESCE(items.item_count, 0) AS item_count,
            COALESCE(payments.paid_amount, 0) AS paid_amount,
            COALESCE(payments.payment_methods, '') AS payment_methods
     FROM orders o
     LEFT JOIN (
       SELECT order_id,
              SUM(CASE WHEN status = 'active' THEN quantity * unit_price ELSE 0 END) AS subtotal,
              SUM(CASE WHEN status = 'active' THEN quantity ELSE 0 END) AS item_count
       FROM order_items
       GROUP BY order_id
     ) items ON items.order_id = o.id
     LEFT JOIN (
       SELECT order_id,
              SUM(amount) AS paid_amount,
              group_concat(method || ': ' || printf('%.2f', amount), ', ') AS payment_methods
       FROM payments
       GROUP BY order_id
     ) payments ON payments.order_id = o.id
     ORDER BY date(${orderDateExpression}), o.id`
  ).all() as Array<Record<string, unknown>>;

  const orderItemRows = db.prepare(
    `SELECT oi.id, oi.order_id, o.order_number, ${orderDateExpression} AS order_date,
            oi.status, oi.menu_item_id, oi.name, oi.quantity, oi.unit_price,
            oi.quantity * oi.unit_price AS line_total, oi.parcel, oi.kitchen_sent_at,
            oi.note, oi.void_reason, oi.created_at
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     ORDER BY date(${orderDateExpression}), oi.order_id, oi.id`
  ).all() as Array<Record<string, unknown>>;

  const costRows = db.prepare(
    `SELECT cr.id, cr.cost_date, cc.name AS category_name, cr.cost_name, cr.quantity,
            cr.amount, cr.payment_method, cr.responsible_person, cr.note,
            cr.created_at, cr.updated_at
     FROM cost_records cr
     LEFT JOIN cost_categories cc ON cc.id = cr.cost_category_id
     ORDER BY date(cr.cost_date), cr.id`
  ).all() as Array<Record<string, unknown>>;

  const ordersHeaders = [
    "POS Order ID", "Order Number", "Order Date", "Created At", "Updated At", "Status", "Source",
    "External Order ID", "Table", "Subtotal", "Discount", "Total", "Payment Methods", "Paid Amount",
    "Item Count", "Kitchen Started At", "Kitchen Completed At", "Settled At", "Note"
  ];
  const orderItemsHeaders = [
    "POS Order Item ID", "POS Order ID", "Order Number", "Order Date", "Status", "Menu Item ID",
    "Item Name", "Quantity", "Unit Price", "Line Total", "Parcel", "Kitchen Sent At", "Note",
    "Void Reason", "Created At"
  ];
  const costsHeaders = [
    "POS Cost ID", "Cost Date", "Category", "Cost Name", "Quantity", "Amount", "Payment Method",
    "Responsible Person", "Note", "Created At", "Updated At"
  ];

  return {
    orders: {
      headers: ordersHeaders,
      rows: orderRows.map((row) => [
        numberValue(row.id), textValue(row.order_number), dateValue(row.order_date), textValue(row.created_at),
        textValue(row.updated_at), textValue(row.status), textValue(row.source), textValue(row.external_order_id),
        textValue(row.table_number), numberValue(row.subtotal), numberValue(row.discount), numberValue(row.total),
        textValue(row.payment_methods), numberValue(row.paid_amount), numberValue(row.item_count),
        textValue(row.first_kitchen_sent_at), textValue(row.kitchen_completed_at), textValue(row.settled_at), textValue(row.note)
      ])
    },
    orderItems: {
      headers: orderItemsHeaders,
      rows: orderItemRows.map((row) => [
        numberValue(row.id), numberValue(row.order_id), textValue(row.order_number), dateValue(row.order_date),
        textValue(row.status), numberValue(row.menu_item_id), textValue(row.name), numberValue(row.quantity),
        numberValue(row.unit_price), numberValue(row.line_total), Boolean(Number(row.parcel)),
        textValue(row.kitchen_sent_at), textValue(row.note), textValue(row.void_reason), textValue(row.created_at)
      ])
    },
    costs: {
      headers: costsHeaders,
      rows: costRows.map((row) => [
        numberValue(row.id), dateValue(row.cost_date), textValue(row.category_name), textValue(row.cost_name),
        numberValue(row.quantity), numberValue(row.amount), textValue(row.payment_method),
        textValue(row.responsible_person), textValue(row.note), textValue(row.created_at), textValue(row.updated_at)
      ])
    }
  };
}

export function parseGoogleOAuthCredentials(raw: string): OAuthClientDefinition {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Google OAuth credential file is empty.");
  if (!trimmed.startsWith("{")) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 2 || !looksLikeGoogleClientId(lines[0]) || !lines[1]) {
      throw new Error("Google OAuth credentials must contain client ID on the first line and client secret on the second line.");
    }
    return { clientId: lines[0], clientSecret: lines[1] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Google OAuth credential JSON is invalid.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Google OAuth credential JSON is invalid.");
  const root = parsed as Record<string, unknown>;
  const selected = objectValue(root.installed) ?? objectValue(root.web) ?? root;
  const clientId = stringValue(selected.client_id);
  const clientSecret = stringValue(selected.client_secret);
  if (!looksLikeGoogleClientId(clientId) || !clientSecret) {
    throw new Error("Google OAuth credential JSON does not contain a valid client ID and client secret.");
  }
  const redirectUris = Array.isArray(selected.redirect_uris)
    ? selected.redirect_uris.filter((value): value is string => typeof value === "string")
    : [];
  if (root.web && redirectUris.length > 0 && !redirectUris.includes(GOOGLE_OAUTH_REDIRECT_URI)) {
    throw new Error(`The OAuth client must authorize the exact redirect URI ${GOOGLE_OAUTH_REDIRECT_URI}.`);
  }
  return { clientId, clientSecret };
}

function defaultGoogleSheetsSettings(): InternalGoogleSheetsSettings {
  const tokenPath = findDefaultTokenPath();
  const credentialPath = findDefaultCredentialPath();
  const hasClientCredentials = fs.existsSync(credentialPath);
  const connected = hasClientCredentials && hasUsableTokenFile(tokenPath);
  return {
    enabled: false,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
    spreadsheetId: "",
    spreadsheetTitle: null,
    ordersTab: "Orders",
    orderItemsTab: "Order Items",
    costsTab: "Costs",
    credentialPath,
    tokenPath,
    clientId: "",
    hasClientCredentials,
    connectedEmail: null,
    connected,
    syncStatus: connected ? "ready" : "disconnected",
    pending: false,
    lastSyncedAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorActionUrl: null,
    scriptProjectId: null,
    reportToolInstalled: false
  };
}

function findDefaultCredentialPath(): string {
  const configured = process.env.YAMZO_GOOGLE_CREDENTIALS?.trim();
  if (configured) return path.resolve(configured);
  return findManagedCredentialPath();
}

function findManagedCredentialPath(): string {
  const appDataOverride = process.env.YAMZO_APP_DATA_DIR?.trim();
  if (appDataOverride) return path.join(path.resolve(appDataOverride), "google-oauth-client.json");
  const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Yamzo POS", "local-data", "google-oauth-client.json");
}

function findDefaultTokenPath(): string {
  const configured = process.env.YAMZO_GOOGLE_TOKEN?.trim();
  if (configured) return path.resolve(configured);
  const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
  const appDataOverride = process.env.YAMZO_APP_DATA_DIR?.trim();
  const candidates = [
    appDataOverride ? path.join(path.resolve(appDataOverride), "google-sheets-token.json") : "",
    path.join(appData, "yamzo-pos", "local-data", "google-sheets-token.json"),
    path.join(appData, "Yamzo POS", "local-data", "google-sheets-token.json")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[candidates.length - 1];
}

function persistGoogleSheetsSettings(db: Database.Database, settings: InternalGoogleSheetsSettings): void {
  setSetting(db, GOOGLE_SHEETS_SETTING_KEY, settings);
}

function toRendererGoogleSheetsSettings(settings: InternalGoogleSheetsSettings): GoogleSheetsSettings {
  const { credentialPath: _credentialPath, tokenPath: _tokenPath, ...rendererSettings } = settings;
  return rendererSettings;
}

function readGoogleOAuthCredentials(credentialPath: string): OAuthClientDefinition {
  if (!fs.existsSync(credentialPath)) {
    throw new Error("Save the Google OAuth client ID and client secret in Admin before connecting.");
  }
  try {
    return parseGoogleOAuthCredentials(fs.readFileSync(credentialPath, "utf8"));
  } catch (error) {
    throw new Error(safeGoogleError(error));
  }
}

function loadAuthorizedGoogleClient(settings: InternalGoogleSheetsSettings): OAuth2Client {
  const definition = readGoogleOAuthCredentials(settings.credentialPath);
  const token = readTokenFile(settings.tokenPath, true);
  const auth = new google.auth.OAuth2(definition.clientId, definition.clientSecret, GOOGLE_OAUTH_REDIRECT_URI);
  auth.setCredentials(token!);
  attachTokenPersistence(auth, settings.tokenPath);
  return auth;
}

function readTokenFile(tokenPath: string, required: boolean): Credentials | null {
  if (!fs.existsSync(tokenPath)) {
    if (required) throw new Error("Google is not connected. Use Connect Google in Admin first.");
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as Credentials;
    if (!parsed || typeof parsed !== "object" || (!parsed.refresh_token && !parsed.access_token)) throw new Error("invalid");
    return parsed;
  } catch {
    if (required) throw new Error("The saved Google authorization is invalid. Connect Google again.");
    return null;
  }
}

function writeTokenFile(tokenPath: string, token: Credentials): void {
  writeSecretJsonFile(tokenPath, token);
}

function writeSecretJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      // Windows may refuse replacing an existing file with rename. Copying the fully-written
      // temporary file still prevents a partial token from being observed.
      if (!fs.existsSync(filePath)) throw error;
      fs.copyFileSync(temporary, filePath);
      fs.unlinkSync(temporary);
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows ACLs are managed by the user's profile; chmod is best effort.
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function attachTokenPersistence(auth: OAuth2Client, tokenPath: string): void {
  auth.on("tokens", (tokens) => {
    const current = readTokenFile(tokenPath, false) ?? {};
    writeTokenFile(tokenPath, {
      ...current,
      ...tokens,
      refresh_token: tokens.refresh_token ?? current.refresh_token
    });
  });
}

async function waitForOAuthCode(
  authUrl: string,
  expectedState: string,
  options: GoogleSheetsConnectOptions
): Promise<string> {
  const timeoutMs = Math.max(30_000, Math.min(10 * 60_000, options.timeoutMs ?? 3 * 60_000));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(code!);
    };
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${GOOGLE_OAUTH_PORT}`}`);
      if (requestUrl.pathname !== "/oauth2callback") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Not found");
        return;
      }
      const state = requestUrl.searchParams.get("state");
      const oauthError = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      if (state !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Authorization state did not match. Return to Yamzo POS and try again.");
        finish(new Error("Google authorization state did not match. Try connecting again."));
        return;
      }
      if (oauthError || !code) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Google authorization was not completed. You can close this window.");
        finish(new Error(oauthError === "access_denied" ? "Google authorization was cancelled." : "Google authorization did not return a code."));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"
      });
      response.end("<!doctype html><meta charset=\"utf-8\"><title>Yamzo connected</title><style>body{font:16px system-ui;background:#10271f;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:460px;padding:36px;border:1px solid #315748;border-radius:20px;background:#17372b}h1{margin-top:0}</style><div class=\"card\"><h1>Google Sheets connected</h1><p>Authorization is complete. You can close this window and return to Yamzo POS.</p></div>");
      finish(null, code);
    });
    const timeout = setTimeout(() => finish(new Error("Google authorization timed out. Try Connect again.")), timeoutMs);
    server.once("error", (error: NodeJS.ErrnoException) => {
      const message = error.code === "EADDRINUSE"
        ? `The Google authorization callback port ${GOOGLE_OAUTH_PORT} is already in use. Close the previous authorization window and try again.`
        : "The local Google authorization callback could not start.";
      finish(new Error(message));
    });
    server.listen(GOOGLE_OAUTH_PORT, "127.0.0.1", async () => {
      try {
        if (options.openExternal) await options.openExternal(authUrl);
        else {
          const { shell } = await import("electron");
          await shell.openExternal(authUrl);
        }
      } catch {
        finish(new Error("The Google sign-in page could not be opened."));
      }
    });
  });
}

async function fetchSpreadsheetIdentity(auth: OAuth2Client, spreadsheetId: string): Promise<{ title: string }> {
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
    fields: "spreadsheetId,properties(title)"
  });
  return { title: response.data.properties?.title || "Google spreadsheet" };
}

async function fetchConnectedGoogleEmail(auth: OAuth2Client): Promise<string> {
  await assertGoogleOAuthScopes(auth, [GOOGLE_USER_EMAIL_SCOPE]);
  const oauth2 = google.oauth2({ version: "v2", auth });
  const response = await oauth2.userinfo.get();
  const email = String(response.data.email ?? "").trim().toLocaleLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Google did not provide the connected account email. Reconnect Google and allow email identity access.");
  }
  return email;
}

async function reconcileGoogleSheets(
  auth: OAuth2Client,
  settings: GoogleSheetsSettings,
  snapshot: GoogleSheetsSnapshot
): Promise<{ title: string }> {
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.get({
    spreadsheetId: settings.spreadsheetId,
    includeGridData: false,
    fields: "properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount,frozenRowCount)))"
  });
  const title = response.data.properties?.title || "Google spreadsheet";
  const initial = toSheetMetadata(response.data.sheets ?? []);
  const targets = [
    { title: settings.ordersTab, data: snapshot.orders, hidden: false },
    { title: settings.orderItemsTab, data: snapshot.orderItems, hidden: true },
    { title: settings.costsTab, data: snapshot.costs, hidden: false }
  ];
  const missing = targets.filter((target) => !initial.has(target.title));
  if (missing.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: settings.spreadsheetId,
      requestBody: {
        requests: missing.map((target) => ({
          addSheet: {
            properties: {
              title: target.title,
              hidden: target.hidden,
              gridProperties: {
                rowCount: Math.max(1_000, target.data.rows.length + 1),
                columnCount: Math.max(26, target.data.headers.length),
                frozenRowCount: 1
              }
            }
          }
        }))
      }
    });
  }

  const refreshed = await sheets.spreadsheets.get({
    spreadsheetId: settings.spreadsheetId,
    includeGridData: false,
    fields: "sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount,frozenRowCount)))"
  });
  const metadata = toSheetMetadata(refreshed.data.sheets ?? []);
  const propertyRequests: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const sheet = metadata.get(target.title);
    if (!sheet) throw new Error(`Google Sheets did not create the ${target.title} tab.`);
    const neededRows = Math.max(sheet.rowCount, target.data.rows.length + 1, 2);
    const neededColumns = Math.max(sheet.columnCount, target.data.headers.length);
    propertyRequests.push({
      updateSheetProperties: {
        properties: {
          sheetId: sheet.sheetId,
          hidden: target.hidden,
          gridProperties: {
            rowCount: neededRows,
            columnCount: neededColumns,
            frozenRowCount: 1
          }
        },
        fields: "hidden,gridProperties(rowCount,columnCount,frozenRowCount)"
      }
    });
    propertyRequests.push({
      repeatCell: {
        range: {
          sheetId: sheet.sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: target.data.headers.length
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.071, green: 0.216, blue: 0.165 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP"
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)"
      }
    });
    propertyRequests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: sheet.sheetId,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: target.data.headers.length
        }
      }
    });
  }
  if (propertyRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: settings.spreadsheetId,
      requestBody: { requests: propertyRequests }
    });
  }

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId: settings.spreadsheetId,
    requestBody: {
      ranges: targets.map((target) => `${quoteSheetTitle(target.title)}!A2:${columnName(target.data.headers.length)}`)
    }
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: settings.spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: targets.map((target) => ({
        range: `${quoteSheetTitle(target.title)}!A1:${columnName(target.data.headers.length)}1`,
        majorDimension: "ROWS",
        values: [target.data.headers]
      }))
    }
  });
  for (const target of targets) {
    for (let offset = 0; offset < target.data.rows.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = target.data.rows.slice(offset, offset + WRITE_CHUNK_SIZE);
      const startRow = offset + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: settings.spreadsheetId,
        range: `${quoteSheetTitle(target.title)}!A${startRow}:${columnName(target.data.headers.length)}${startRow + chunk.length - 1}`,
        valueInputOption: "RAW",
        requestBody: { majorDimension: "ROWS", values: chunk }
      });
    }
  }
  return { title };
}

function toSheetMetadata(sheets: Array<{ properties?: { sheetId?: number | null; title?: string | null; hidden?: boolean | null; gridProperties?: { rowCount?: number | null; columnCount?: number | null } | null } | null }>): Map<string, SheetMetadata> {
  const metadata = new Map<string, SheetMetadata>();
  for (const sheet of sheets) {
    const properties = sheet.properties;
    if (properties?.sheetId === undefined || properties.sheetId === null || !properties.title) continue;
    metadata.set(properties.title, {
      sheetId: properties.sheetId,
      title: properties.title,
      hidden: properties.hidden === true,
      rowCount: properties.gridProperties?.rowCount ?? 1_000,
      columnCount: properties.gridProperties?.columnCount ?? 26
    });
  }
  return metadata;
}

async function drainGoogleSheetsQueue(db: Database.Database, state: QueueState): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    while (state.requested) {
      state.requested = false;
      try {
        await syncGoogleSheets(db);
      } catch {
        // Best-effort background sync: status and sanitized error are persisted by syncGoogleSheets.
      }
    }
  } finally {
    state.running = false;
  }
}

export async function assertGoogleOAuthScopes(auth: OAuth2Client, requiredScopes: string[]): Promise<void> {
  const access = await auth.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) throw new Error("Google authorization could not be refreshed. Connect Google Sheets again.");
  const information = await auth.getTokenInfo(token);
  const granted = new Set(information.scopes ?? []);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new Error("Reconnect Google to grant the required permission for this feature.");
  }
}

function readGoogleAppsScriptFiles(settings: GoogleSheetsSettings): Array<{ name: string; type: "SERVER_JS" | "HTML" | "JSON"; source: string }> {
  const directory = resolveGoogleAppsScriptDirectory();
  const code = fs.readFileSync(path.join(directory, "Code.gs"), "utf8")
    .replace("__YAMZO_ORDERS_TAB_JSON__", () => JSON.stringify(settings.ordersTab))
    .replace("__YAMZO_ORDER_ITEMS_TAB_JSON__", () => JSON.stringify(settings.orderItemsTab))
    .replace("__YAMZO_COSTS_TAB_JSON__", () => JSON.stringify(settings.costsTab));
  return [
    { name: "Code", type: "SERVER_JS", source: code },
    { name: "ReportDialog", type: "HTML", source: fs.readFileSync(path.join(directory, "ReportDialog.html"), "utf8") },
    { name: "appsscript", type: "JSON", source: fs.readFileSync(path.join(directory, "appsscript.json"), "utf8") }
  ];
}

function resolveGoogleAppsScriptDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.resolve(moduleDirectory, "../../../resources/google-apps-script"),
    path.resolve(process.cwd(), "resources/google-apps-script"),
    resourcesPath ? path.join(resourcesPath, "resources", "google-apps-script") : ""
  ].filter(Boolean);
  const directory = candidates.find((candidate) => fs.existsSync(path.join(candidate, "Code.gs")));
  if (!directory) throw new Error("The bundled Yamzo Google report tool files were not found.");
  return directory;
}

function validateGoogleSheetsTarget(settings: Pick<GoogleSheetsSettings, "spreadsheetId" | "ordersTab" | "orderItemsTab" | "costsTab">): void {
  validateGoogleSheetsMapping(settings, true);
}

function validateGoogleSheetsMapping(
  settings: Pick<GoogleSheetsSettings, "spreadsheetId" | "ordersTab" | "orderItemsTab" | "costsTab">,
  requireSpreadsheet: boolean
): void {
  if ((requireSpreadsheet || settings.spreadsheetId) && !looksLikeSpreadsheetId(settings.spreadsheetId)) {
    throw new Error("Enter a valid Google spreadsheet ID or URL.");
  }
  const titles = [settings.ordersTab, settings.orderItemsTab, settings.costsTab];
  if (new Set(titles.map((title) => title.toLocaleLowerCase())).size !== titles.length) {
    throw new Error("Orders, Order Items, and Costs must use different tab names.");
  }
}

function normalizeSpreadsheetId(value: string): string {
  const text = String(value ?? "").trim();
  const fromUrl = text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1];
  return fromUrl ?? text;
}

function looksLikeSpreadsheetId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9_-]{20,}$/.test(value);
}

function normalizeSheetTitle(value: unknown, fallback: string): string {
  const title = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (title.length > 100 || /[\\/?*\[\]:]/.test(title)) {
    throw new Error(`The Google Sheets tab name \"${title.slice(0, 40)}\" is invalid.`);
  }
  return title;
}

function normalizeFilePath(value: unknown, fallback: string): string {
  const selected = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return path.resolve(selected);
}

function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function columnName(columnCount: number): string {
  let value = Math.max(1, columnCount);
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function databaseHasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function hasUsableTokenFile(tokenPath: string): boolean {
  return readTokenFile(tokenPath, false) !== null;
}

export function safeGoogleError(error: unknown): string {
  return describeGoogleError(error).message;
}

export function describeGoogleError(error: unknown): GoogleIntegrationFailure {
  const original = error instanceof Error ? error.message : String(error || "Google Sheets operation failed.");
  let message = original
    .replace(
      /["']?(client[_-]?secret|refresh[_-]?token|access[_-]?token|id[_-]?token)["']?\s*[:=]\s*["']?[^"',}\]\s&]+["']?/gi,
      "$1=[redacted]"
    )
    .replace(/\b\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com\b/gi, "[OAuth client]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .slice(0, 500);
  let code: GoogleIntegrationErrorCode = "google_request_failed";
  let actionUrl: string | null = null;
  if (/not enabled the Apps Script API|script\.google\.com\/home\/usersettings/i.test(message)) {
    code = "apps_script_user_setting_disabled";
    actionUrl = GOOGLE_APPS_SCRIPT_USER_SETTINGS_URL;
    message = "Apps Script access is disabled for this Google account. Open Apps Script settings, enable Google Apps Script API access, wait a few minutes, then retry.";
  } else if (/credential|client ID and client secret|OAuth client ID/i.test(message) && /save|missing|not found|enter/i.test(message)) {
    code = "credentials_missing";
  } else if (/invalid_grant|expired or was revoked/i.test(message)) {
    code = "authorization_expired";
    message = "Google authorization expired or was revoked. Connect Google again.";
  } else if (/invalid_client/i.test(message)) {
    code = "invalid_client";
    message = "Google rejected the OAuth client. Check the client ID and secret, then connect again.";
  } else if (/insufficient.*scope|insufficient permission|required permission|permission/i.test(message)) {
    code = "permission_missing";
    message = "Google authorization is missing a required permission. Connect Google again.";
  } else if (/not connected|authorization.*invalid|authorization.*required/i.test(message)) {
    code = "authorization_required";
  } else if (/spreadsheet|requested entity was not found/i.test(message) && /invalid|not found|choose|valid|requested entity/i.test(message)) {
    code = "invalid_spreadsheet";
  }
  return { message: message || "Google operation failed.", code, actionUrl };
}

function throwPersistedGoogleFailure(db: Database.Database, settings: InternalGoogleSheetsSettings, error: unknown): never {
  const failure = describeGoogleError(error);
  persistGoogleSheetsSettings(db, {
    ...settings,
    lastAttemptAt: new Date().toISOString(),
    lastError: failure.message,
    lastErrorCode: failure.code,
    lastErrorActionUrl: failure.actionUrl
  });
  throw new Error(failure.message);
}

function isSyncStatus(value: unknown): value is GoogleSheetsSyncStatus {
  return ["disconnected", "ready", "pending", "syncing", "synced", "error"].includes(String(value));
}

function isGoogleErrorCode(value: unknown): value is GoogleIntegrationErrorCode {
  return [
    "apps_script_user_setting_disabled",
    "credentials_missing",
    "authorization_required",
    "authorization_expired",
    "permission_missing",
    "invalid_client",
    "invalid_spreadsheet",
    "google_request_failed"
  ].includes(String(value));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

function looksLikeGoogleClientId(value: string): boolean {
  return /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function textValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function dateValue(value: unknown): string {
  return textValue(value).slice(0, 10);
}
