import {
  createHash,
  randomBytes,
  sign,
  type KeyObject
} from "node:crypto";
import type Database from "better-sqlite3";
import type { WebsiteOrderSnapshot, WebsiteOutboxEvent } from "../../shared/types.js";
import {
  WebsiteOrderSyncService,
  type WebsiteOrderPullResult,
  type WebsiteOrderSyncTransport
} from "./websiteOrderSync.js";

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TERMINAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WebsiteOrderHttpConfig {
  baseUrl: string;
  terminalCode: string;
  /** Decrypted only inside Electron's main process from the OS-protected store. */
  terminalPrivateKey: KeyObject;
  includeTestOrders: boolean;
}

export interface WebsiteOrderSchedulerDependencies {
  loadTerminalPrivateKey(terminalCode: string): KeyObject;
}

interface WebsiteOrderHttpDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonceBytes?: () => Buffer;
}

interface SignedRequestHeaders {
  [header: string]: string;
  "content-type": "application/json";
  "x-yamzo-terminal": string;
  "x-yamzo-timestamp": string;
  "x-yamzo-nonce": string;
  "x-yamzo-body-sha256": string;
  "x-yamzo-signature": string;
}

export class WebsiteOrderHttpTransport implements WebsiteOrderSyncTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly nonceBytes: () => Buffer;
  private readonly baseUrl: string;
  private readonly terminalCode: string;
  private readonly terminalPrivateKey: KeyObject;
  private readonly includeTestOrders: boolean;

  constructor(
    config: WebsiteOrderHttpConfig,
    dependencies: WebsiteOrderHttpDependencies = {}
  ) {
    validateConfig(config);
    this.baseUrl = config.baseUrl;
    this.terminalCode = config.terminalCode;
    this.terminalPrivateKey = config.terminalPrivateKey;
    this.includeTestOrders = config.includeTestOrders;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.nonceBytes = dependencies.nonceBytes ?? (() => randomBytes(18));
  }

  async pullOrders(cursor: string | null, limit: number): Promise<WebsiteOrderPullResult> {
    const result = await this.sendJson("/api/pos/orders/claim", {
      cursor,
      limit: Math.max(1, Math.min(10, Math.floor(limit))),
      includeTest: this.includeTestOrders
    });
    if (!isRecord(result) || !Array.isArray(result.orders)) {
      throw new Error("The website returned an invalid claimed-order response.");
    }
    const nextCursor = result.nextCursor;
    if (nextCursor !== null && typeof nextCursor !== "string") {
      throw new Error("The website returned an invalid sync cursor.");
    }
    return {
      orders: result.orders as WebsiteOrderSnapshot[],
      nextCursor: nextCursor ?? null
    };
  }

  async pushEvents(events: WebsiteOutboxEvent[]): Promise<{ acceptedEventIds: number[] }> {
    const acceptedEventIds: number[] = [];
    for (const event of events) {
      if (!UUID_PATTERN.test(event.eventKey) || !UUID_PATTERN.test(event.remoteOrderId)) {
        throw new Error("A local website sync event has an invalid durable identity.");
      }

      if (event.eventType === "print.ack") {
        const print = printAckPayload(event);
        await this.sendJson("/api/pos/print/ack", {
          eventKey: event.eventKey,
          orderId: event.remoteOrderId,
          ...print
        });
      } else if (event.eventType.startsWith("order.")) {
        const transition = transitionPayload(event);
        await this.sendJson("/api/pos/orders/transition", {
          eventKey: event.eventKey,
          orderId: event.remoteOrderId,
          ...transition
        });
      } else {
        throw new Error(`Unsupported local website sync event: ${event.eventType}`);
      }
      acceptedEventIds.push(event.id);
    }
    return { acceptedEventIds };
  }

  private async sendJson(pathname: string, payload: Record<string, unknown>): Promise<unknown> {
    const url = new URL(pathname, this.baseUrl);
    const body = JSON.stringify(payload);
    const headers = buildSignedRequestHeaders(
      { terminalCode: this.terminalCode },
      this.terminalPrivateKey,
      pathname,
      body,
      Math.floor(this.now() / 1000),
      this.nonceBytes()
    );

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new Error("The Yamzo website order service could not be reached.");
    }

    const responseContentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (responseContentType !== "application/json") {
      throw new Error("The Yamzo website order service returned an invalid response type.");
    }
    const responseText = await readBoundedResponseText(response);

    let value: unknown;
    try {
      value = responseText ? JSON.parse(responseText) as unknown : null;
    } catch {
      throw new Error("The Yamzo website order service returned invalid JSON.");
    }
    if (!response.ok) {
      const remoteCode = isRecord(value) && typeof value.error === "string"
        ? value.error.replace(/[^A-Z0-9_:-]/gi, "").slice(0, 80)
        : "REMOTE_REQUEST_FAILED";
      throw new Error(`Website order sync failed (${response.status}:${remoteCode}).`);
    }
    return value;
  }
}

export function loadWebsiteOrderHttpConfig(
  environment: NodeJS.ProcessEnv,
  loadTerminalPrivateKey: (terminalCode: string) => KeyObject
): WebsiteOrderHttpConfig | null {
  const baseUrl = environment.YAMZO_WEBSITE_API_URL?.trim() ?? "";
  const terminalCode = environment.YAMZO_POS_TERMINAL_CODE?.trim() ?? "";
  const configuredCount = [baseUrl, terminalCode].filter(Boolean).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== 2) {
    throw new Error("Website order sync configuration is incomplete.");
  }
  const config = {
    baseUrl,
    terminalCode,
    terminalPrivateKey: loadTerminalPrivateKey(terminalCode),
    includeTestOrders: ["1", "true", "yes"].includes(
      environment.YAMZO_POS_INCLUDE_TEST_ORDERS?.trim().toLowerCase() ?? ""
    )
  };
  validateConfig(config);
  return config;
}

export function startWebsiteOrderSyncScheduler(
  db: Database.Database,
  dependencies: WebsiteOrderSchedulerDependencies,
  intervalMs = DEFAULT_SYNC_INTERVAL_MS
): () => void {
  let config: WebsiteOrderHttpConfig | null;
  try {
    config = loadWebsiteOrderHttpConfig(
      process.env,
      dependencies.loadTerminalPrivateKey
    );
  } catch (error) {
    console.error(
      "[website-orders] Sync disabled:",
      error instanceof Error ? error.message : "invalid configuration"
    );
    return () => undefined;
  }
  if (!config) return () => undefined;

  const service = new WebsiteOrderSyncService(db, new WebsiteOrderHttpTransport(config));
  let running = false;
  let stopped = false;
  const sync = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await service.syncOnce();
    } catch (error) {
      // Messages produced by the transport contain only a status and bounded
      // error code; raw credentials and remote response bodies are never logged.
      console.error(
        "[website-orders] Sync failed:",
        error instanceof Error ? error.message : "unknown error"
      );
    } finally {
      running = false;
    }
  };

  void sync();
  const timer = setInterval(() => void sync(), Math.max(2_000, intervalMs));
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function buildSignedRequestHeaders(
  config: Pick<WebsiteOrderHttpConfig, "terminalCode">,
  terminalPrivateKey: KeyObject,
  pathname: string,
  body: string,
  timestamp: number,
  nonceSource: Buffer
): SignedRequestHeaders {
  const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const nonce = nonceSource.toString("base64url");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) {
    throw new Error("The POS request nonce is invalid.");
  }
  const canonical = [
    "v1",
    "POST",
    pathname,
    config.terminalCode,
    String(timestamp),
    nonce,
    bodySha256
  ].join("\n");
  if (
    terminalPrivateKey.type !== "private"
    || terminalPrivateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("The POS terminal signing key is invalid.");
  }
  const signature = sign(
    null,
    Buffer.from(canonical, "utf8"),
    terminalPrivateKey
  ).toString("base64url");

  return {
    "content-type": "application/json",
    "x-yamzo-terminal": config.terminalCode,
    "x-yamzo-timestamp": String(timestamp),
    "x-yamzo-nonce": nonce,
    "x-yamzo-body-sha256": bodySha256,
    "x-yamzo-signature": signature
  };
}

function validateConfig(config: WebsiteOrderHttpConfig): void {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error("YAMZO_WEBSITE_API_URL is invalid.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Website order sync requires HTTPS except on loopback development URLs.");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("YAMZO_WEBSITE_API_URL must be an origin without credentials, query, or path.");
  }
  if (!TERMINAL_CODE_PATTERN.test(config.terminalCode)) {
    throw new Error("YAMZO_POS_TERMINAL_CODE is invalid.");
  }
  if (
    config.terminalPrivateKey.type !== "private"
    || config.terminalPrivateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("The protected POS terminal signing key is invalid.");
  }
}

function transitionPayload(event: WebsiteOutboxEvent): {
  toStatus: string;
  expectedVersion: number;
  note: string | null;
} {
  const status = event.payload.status;
  const expectedVersion = event.payload.expectedVersion;
  if (
    typeof status !== "string"
    || event.eventType !== `order.${status}`
    || !["accepted", "preparing", "ready", "out_for_delivery", "delivered", "rejected", "cancelled"].includes(status)
    || !Number.isInteger(expectedVersion)
    || Number(expectedVersion) < 1
  ) {
    throw new Error(`Local website order event ${event.id} is invalid.`);
  }
  const reason = event.payload.reason;
  return {
    toStatus: status,
    expectedVersion: Number(expectedVersion),
    note: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null
  };
}

function printAckPayload(event: WebsiteOutboxEvent): {
  kind: "customer_receipt" | "kitchen_copy";
  succeeded: boolean;
  errorCode: string | null;
} {
  const kind = event.payload.kind;
  const succeeded = event.payload.succeeded;
  const errorCode = event.payload.errorCode;
  if (
    (kind !== "customer_receipt" && kind !== "kitchen_copy")
    || typeof succeeded !== "boolean"
    || (!succeeded && (typeof errorCode !== "string" || !/^[A-Z0-9_:-]{1,80}$/.test(errorCode)))
  ) {
    throw new Error(`Local website print event ${event.id} is invalid.`);
  }
  return {
    kind,
    succeeded,
    errorCode: succeeded ? null : String(errorCode)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The Yamzo website order service returned an oversized response.");
      }
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      );
    } catch {
      throw new Error("The Yamzo website order service returned invalid text.");
    }
  } finally {
    reader.releaseLock();
  }
}
