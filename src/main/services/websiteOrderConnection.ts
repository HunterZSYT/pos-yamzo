import type Database from "better-sqlite3";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type {
  WebsiteConnectionDiagnostics,
  WebsiteConnectionSettings,
  WebsiteConnectionStatus,
  WebsiteRealtimeSession
} from "../../shared/types.js";
import { getSetting, setSetting } from "./settings.js";
import {
  WebsiteOrderHttpTransport,
  loadWebsiteOrderHttpConfig,
  type WebsiteOrderHttpConfig,
  type WebsiteOrderSchedulerDependencies
} from "./websiteOrderHttpTransport.js";
import { WebsiteOrderSyncService, type WebsiteOrderSyncResult } from "./websiteOrderSync.js";
import { printPendingWebsiteInitialKots } from "./websiteInitialKot.js";
import type { WebsiteTerminalProvisioningResult } from "./websiteTerminalCredentials.js";

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface WebsiteOrderConnectionDependencies extends WebsiteOrderSchedulerDependencies {
  onStatusChanged?(status: WebsiteConnectionStatus): void;
  onOrdersChanged?(): void;
  now?: () => number;
  rotateTerminalIdentity?(terminalCode: string): WebsiteTerminalProvisioningResult;
  provisionTerminalIdentity?(terminalCode: string): WebsiteTerminalProvisioningResult;
  restorePreviousTerminalIdentity?(terminalCode: string, backupPath: string): void;
}

export class WebsiteOrderConnectionManager {
  private readonly now: () => number;
  private transport: WebsiteOrderHttpTransport | null = null;
  private syncService: WebsiteOrderSyncService | null = null;
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private syncPromise: Promise<WebsiteOrderSyncResult> | null = null;
  private stopped = true;
  private intentionallyDisconnected = false;
  private reconnectAttempt = 0;
  private realtimeSession: WebsiteRealtimeSession | null = null;
  private connection: WebsiteConnectionStatus["connection"] = "disconnected";
  private realtime: WebsiteConnectionStatus["realtime"] = "offline";
  private errors: string[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly dependencies: WebsiteOrderConnectionDependencies,
    private readonly intervalMs = DEFAULT_SYNC_INTERVAL_MS
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.intentionallyDisconnected = false;
    this.syncTimer = setInterval(
      () => void this.syncNow("periodic").catch(() => undefined),
      Math.max(2_000, this.intervalMs)
    );
    void this.reconnect();
  }

  stop(): void {
    this.stopped = true;
    this.intentionallyDisconnected = true;
    this.clearTimers();
    this.teardownRealtime();
    this.transport = null;
    this.syncService = null;
    this.connection = "disconnected";
    this.realtime = "offline";
    this.emitStatus();
  }

  async reconnect(): Promise<WebsiteConnectionStatus> {
    if (this.stopped) this.stopped = false;
    this.intentionallyDisconnected = false;
    this.clearReconnectTimers();
    this.teardownRealtime();
    this.connection = "reconnecting";
    this.realtime = "reconnecting";
    this.errors = [];
    this.emitStatus();

    let config: WebsiteOrderHttpConfig | null;
    try {
      config = this.loadConfig();
    } catch (error) {
      this.connection = "error";
      this.realtime = "offline";
      this.setError(error);
      return this.getStatus();
    }
    if (!config) {
      this.connection = "disconnected";
      this.realtime = "offline";
      this.setError("Yamzo Website Connection is not configured.");
      return this.getStatus();
    }

    this.transport = new WebsiteOrderHttpTransport(config);
    this.syncService = new WebsiteOrderSyncService(this.db, this.transport);
    try {
      await this.syncNow("reconnect");
    } catch {
      this.scheduleReconnect();
      return this.getStatus();
    }

    await this.connectRealtime();
    return this.getStatus();
  }

  disconnect(): WebsiteConnectionStatus {
    this.intentionallyDisconnected = true;
    this.clearReconnectTimers();
    this.teardownRealtime();
    this.transport = null;
    this.syncService = null;
    this.connection = "disconnected";
    this.realtime = "offline";
    this.errors = [];
    this.emitStatus();
    return this.getStatus();
  }

  async testConnection(): Promise<WebsiteConnectionStatus> {
    if (!this.syncService || this.intentionallyDisconnected) {
      await this.reconnect();
    } else {
      await this.syncNow("manual");
      if (this.realtime !== "connected") await this.connectRealtime();
    }
    return this.getStatus();
  }

  async registerTerminal(baseUrlInput: string, registrationCodeInput: string): Promise<WebsiteConnectionStatus> {
    if (!this.dependencies.provisionTerminalIdentity) {
      throw new Error("Store terminal registration is unavailable in this build.");
    }
    const baseUrl = normalizeRegistrationBaseUrl(baseUrlInput);
    const registrationCode = registrationCodeInput.trim().toUpperCase();
    if (!/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(registrationCode)) {
      throw new Error("Enter the 8-character one-time registration code from Website Admin.");
    }

    const context = await postRegistration(baseUrl, { registrationCode });
    const terminal = parseRegistrationContext(context);
    const provisioned = this.dependencies.provisionTerminalIdentity(terminal.code);
    const registered = parseRegistrationResult(await postRegistration(baseUrl, {
      registrationCode,
      publicKey: provisioned.identity.registration.publicKeyBase64Url
    }));
    if (
      registered.code !== terminal.code
      || registered.publicKeyFingerprint !== provisioned.identity.registration.publicKeyFingerprint
    ) {
      throw new Error("The website returned an invalid terminal registration result.");
    }

    setSetting(this.db, "websiteConnection", {
      baseUrl,
      terminalCode: registered.code,
      includeTestOrders: registered.mode === "test"
    } satisfies WebsiteConnectionSettings);
    this.intentionallyDisconnected = false;
    return this.reconnect();
  }

  async rotateTerminalKey(): Promise<WebsiteConnectionStatus> {
    if (!this.dependencies.rotateTerminalIdentity || !this.dependencies.restorePreviousTerminalIdentity) {
      throw new Error("Terminal-key rotation is unavailable in this build.");
    }
    if (!this.transport || this.intentionallyDisconnected) await this.reconnect();
    const activeConfig = this.loadConfig();
    const oldTransport = this.transport;
    if (!activeConfig || !oldTransport) {
      throw new Error("Reconnect the Yamzo Website Connection before rotating its key.");
    }

    const rotated = this.dependencies.rotateTerminalIdentity(activeConfig.terminalCode);
    if (!rotated.previousCredentialBackupPath) {
      throw new Error("The previous terminal key backup was not created.");
    }
    const newTransport = new WebsiteOrderHttpTransport({
      ...activeConfig,
      terminalPrivateKey: rotated.identity.privateKey
    });

    try {
      await oldTransport.rotateTerminalKey(
        rotated.identity.registration.publicKeyBase64Url,
        rotated.identity.registration.publicKeyFingerprint
      );
    } catch (rotationError) {
      const newKeyAccepted = await newTransport.requestRealtimeSession()
        .then(() => true)
        .catch(() => false);
      if (!newKeyAccepted) {
        const oldKeyStillAccepted = await oldTransport.requestRealtimeSession()
          .then(() => true)
          .catch(() => false);
        if (oldKeyStillAccepted) {
          this.dependencies.restorePreviousTerminalIdentity(
            activeConfig.terminalCode,
            rotated.previousCredentialBackupPath
          );
          throw rotationError;
        }
        throw new Error(
          "Terminal key rotation could not be confirmed. The new key and protected recovery backup were retained; reconnect after network service returns."
        );
      }
    }

    this.transport = newTransport;
    this.syncService = new WebsiteOrderSyncService(this.db, newTransport);
    await this.reconnect();
    return this.getStatus();
  }

  async syncNow(reason: "startup" | "periodic" | "reconnect" | "manual" | "realtime" = "manual"):
    Promise<WebsiteOrderSyncResult> {
    if (this.syncPromise) return this.syncPromise;
    if (!this.syncService || this.intentionallyDisconnected) {
      throw new Error("Yamzo Website Connection is disconnected.");
    }

    this.syncPromise = this.syncService.syncOnce()
      .then(async (result) => {
        await printPendingWebsiteInitialKots(this.db);
        this.connection = "connected";
        this.reconnectAttempt = 0;
        this.errors = [];
        if (result.inserted > 0 || result.updated > 0) {
          this.dependencies.onOrdersChanged?.();
        }
        this.emitStatus();
        return result;
      })
      .catch((error: unknown) => {
        this.connection = isOfflineError(error) ? "offline" : "error";
        this.setError(error);
        throw error;
      })
      .finally(() => {
        this.syncPromise = null;
      });
    return this.syncPromise;
  }

  getStatus(): WebsiteConnectionStatus {
    const persisted = getSetting<WebsiteConnectionSettings | null>(
      this.db,
      "websiteConnection",
      null
    );
    const config = safeConfigSummary(process.env, persisted);
    const sync = this.db.prepare(
      "SELECT last_synced_at FROM website_sync_cursors WHERE stream = 'orders'"
    ).get() as { last_synced_at: string | null } | undefined;
    const latest = this.db.prepare(
      `SELECT order_code, received_at FROM website_orders
       ORDER BY datetime(received_at) DESC, remote_id DESC LIMIT 1`
    ).get() as { order_code: string; received_at: string } | undefined;
    const menuIssues = this.db.prepare(
      `SELECT COUNT(*) AS count FROM website_order_items item
       JOIN website_orders remote ON remote.remote_id = item.website_order_id
       WHERE item.menu_item_id IS NULL
         AND remote.status IN ('pending', 'accepted', 'preparing', 'ready', 'out_for_delivery')`
    ).get() as { count: number };
    const terminal = this.realtimeSession?.terminal ?? null;
    return {
      configured: Boolean(config.baseUrl && config.terminalCode),
      connection: this.connection,
      realtime: this.realtime,
      terminalName: terminal?.name ?? null,
      terminalCode: terminal?.code ?? config.terminalCode,
      environment: terminal?.mode ?? (config.includeTestOrders ? "test" : null),
      lastHeartbeatAt: terminal?.lastHeartbeatAt ?? null,
      lastSyncAt: sync?.last_synced_at ?? null,
      lastWebsiteOrder: latest
        ? { reference: latest.order_code, receivedAt: latest.received_at }
        : null,
      menuReconciliation: {
        status: menuIssues.count === 0 ? "ready" : "issues",
        issueCount: menuIssues.count
      },
      terminalKey: terminalKeyStatus(terminal, this.now()),
      errors: [...this.errors]
    };
  }

  getDiagnostics(): WebsiteConnectionDiagnostics {
    const status = this.getStatus();
    const persisted = getSetting<WebsiteConnectionSettings | null>(
      this.db,
      "websiteConnection",
      null
    );
    const config = safeConfigSummary(process.env, persisted);
    const cursor = this.db.prepare(
      "SELECT cursor FROM website_sync_cursors WHERE stream = 'orders'"
    ).get() as { cursor: string | null } | undefined;
    const outbox = this.db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM website_sync_outbox`
    ).get() as { pending: number | null; failed: number | null };
    const initialKot = this.db.prepare(
      "SELECT COUNT(*) AS count FROM website_initial_kots WHERE state <> 'confirmed'"
    ).get() as { count: number };
    return {
      ...status,
      baseUrl: config.baseUrl,
      syncCursorPresent: Boolean(cursor?.cursor),
      pendingLocalEvents: outbox.pending ?? 0,
      failedLocalEvents: outbox.failed ?? 0,
      pendingInitialKotCount: initialKot.count,
      generatedAt: new Date(this.now()).toISOString()
    };
  }

  private loadConfig(): WebsiteOrderHttpConfig | null {
    return loadWebsiteOrderHttpConfig(
      process.env,
      this.dependencies.loadTerminalPrivateKey,
      getSetting<WebsiteConnectionSettings | null>(this.db, "websiteConnection", null)
    );
  }

  private async connectRealtime(): Promise<void> {
    if (!this.transport || this.intentionallyDisconnected || this.stopped) return;
    this.teardownRealtime();
    this.realtime = "reconnecting";
    this.emitStatus();
    try {
      const session = await this.transport.requestRealtimeSession();
      if (this.intentionallyDisconnected || this.stopped) return;
      this.realtimeSession = session;
      const supabase = createClient(session.supabaseUrl, session.publishableKey, {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false
        },
        realtime: {
          params: { eventsPerSecond: 2 }
        }
      });
      await supabase.realtime.setAuth(session.accessToken);
      const channel = supabase
        .channel(session.topic, { config: { private: true } })
        .on("broadcast", { event: session.event }, () => {
          void this.syncNow("realtime").catch(() => undefined);
        });
      this.supabase = supabase;
      this.channel = channel;
      channel.subscribe((status) => {
        if (this.channel !== channel || this.intentionallyDisconnected || this.stopped) return;
        if (status === "SUBSCRIBED") {
          this.realtime = "connected";
          this.reconnectAttempt = 0;
          this.errors = [];
          this.emitStatus();
          void this.syncNow("reconnect").catch(() => undefined);
          return;
        }
        if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
          this.realtime = "offline";
          this.setError(`Realtime ${status.toLowerCase().replaceAll("_", " ")}.`);
          this.scheduleReconnect();
        }
      });
      const refreshDelay = Math.max(
        60_000,
        Date.parse(session.expiresAt) - this.now() - TOKEN_REFRESH_MARGIN_MS
      );
      this.tokenRefreshTimer = setTimeout(() => void this.connectRealtime(), refreshDelay);
    } catch (error) {
      this.realtime = "offline";
      this.setError(error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyDisconnected || this.stopped) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      2_000 * (2 ** Math.min(this.reconnectAttempt - 1, 5))
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private teardownRealtime(): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = null;
    const supabase = this.supabase;
    const channel = this.channel;
    this.supabase = null;
    this.channel = null;
    this.realtimeSession = null;
    if (supabase && channel) void supabase.removeChannel(channel);
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.reconnectTimer = null;
    this.tokenRefreshTimer = null;
  }

  private clearTimers(): void {
    this.clearReconnectTimers();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  private setError(error: unknown): void {
    const message = safeError(error);
    this.errors = [message];
    this.emitStatus();
  }

  private emitStatus(): void {
    this.dependencies.onStatusChanged?.(this.getStatus());
  }
}

function normalizeRegistrationBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Yamzo website URL.");
  }
  const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localDevelopment) || url.username || url.password) {
    throw new Error("Terminal registration requires the HTTPS Yamzo website URL.");
  }
  return `${url.origin}/`;
}

async function postRegistration(
  baseUrl: string,
  payload: { registrationCode: string; publicKey?: string }
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/pos/register", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error("The Yamzo website registration service could not be reached.");
  }
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw new Error("The Yamzo website returned an invalid registration response.");
  }
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("The Yamzo website registration response is too large.");
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("The Yamzo website returned an invalid registration response.");
  }
  if (!response.ok) throw new Error("The one-time registration code is invalid or expired.");
  return result;
}

function parseRegistrationContext(value: unknown): {
  code: string;
  mode: "test" | "live";
} {
  const terminal = value && typeof value === "object" && "terminal" in value
    ? (value as { terminal?: unknown }).terminal
    : null;
  if (!terminal || typeof terminal !== "object") {
    throw new Error("The website returned an invalid terminal registration context.");
  }
  const data = terminal as Record<string, unknown>;
  if (
    typeof data.code !== "string"
    || !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(data.code)
    || (data.mode !== "test" && data.mode !== "live")
  ) {
    throw new Error("The website returned an invalid terminal registration context.");
  }
  return { code: data.code, mode: data.mode };
}

function parseRegistrationResult(value: unknown): {
  code: string;
  mode: "test" | "live";
  publicKeyFingerprint: string;
} {
  const context = parseRegistrationContext(value);
  const terminal = (value as { terminal: Record<string, unknown> }).terminal;
  if (
    typeof terminal.publicKeyFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(terminal.publicKeyFingerprint)
  ) {
    throw new Error("The website returned an invalid terminal signing-key confirmation.");
  }
  return { ...context, publicKeyFingerprint: terminal.publicKeyFingerprint };
}

function safeConfigSummary(
  environment: NodeJS.ProcessEnv,
  persisted: WebsiteConnectionSettings | null
) {
  return {
    baseUrl: environment.YAMZO_WEBSITE_API_URL?.trim() || persisted?.baseUrl.trim() || null,
    terminalCode: environment.YAMZO_POS_TERMINAL_CODE?.trim() || persisted?.terminalCode.trim() || null,
    includeTestOrders: environment.YAMZO_POS_INCLUDE_TEST_ORDERS === undefined
      ? Boolean(persisted?.includeTestOrders)
      : ["1", "true", "yes"].includes(
          environment.YAMZO_POS_INCLUDE_TEST_ORDERS.trim().toLowerCase()
        )
  };
}

function terminalKeyStatus(
  terminal: WebsiteRealtimeSession["terminal"] | null,
  now: number
): WebsiteConnectionStatus["terminalKey"] {
  if (!terminal) return { status: "unknown", rotatedAt: null, expiresAt: null };
  const expires = terminal.keyExpiresAt ? Date.parse(terminal.keyExpiresAt) : Number.POSITIVE_INFINITY;
  const remaining = expires - now;
  return {
    status: remaining <= 0
      ? "rotation_required"
      : remaining <= 14 * 24 * 60 * 60_000
        ? "expiring"
        : "valid",
    rotatedAt: terminal.keyRotatedAt,
    expiresAt: terminal.keyExpiresAt
  };
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(?:eyJ|sb_secret_|service_role)[A-Za-z0-9._-]*/gi, "[redacted]")
    .slice(0, 240) || "The Yamzo Website Connection encountered an unknown error.";
}

function isOfflineError(error: unknown): boolean {
  return error instanceof Error && /could not be reached|network|offline|timeout/i.test(error.message);
}
