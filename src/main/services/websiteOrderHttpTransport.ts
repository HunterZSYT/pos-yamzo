import {
  createHash,
  randomBytes,
  sign,
  type KeyObject
} from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WebsiteOrderSnapshot,
  WebsiteOrderStatus,
  WebsiteOutboxEvent
} from "../../shared/types.js";
import {
  WebsiteOrderSyncService,
  type WebsiteOrderPullResult,
  type WebsiteOrderSyncTransport
} from "./websiteOrderSync.js";

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SYNC_ORDERS = 50;
const MINOR_UNITS_PER_TAKA = 100;
const TERMINAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEBSITE_PUBLIC_ID_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const SYNC_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

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
    const result = await this.sendJson("/api/pos/orders/sync", {
      cursor,
      limit: Math.max(1, Math.min(50, Math.floor(limit))),
      includeTest: this.includeTestOrders
    });
    if (!isRecord(result) || !Array.isArray(result.orders)) {
      throw new Error("The website returned an invalid synchronized-order response.");
    }
    const nextCursor = result.nextCursor;
    if (
      nextCursor !== null
      && (typeof nextCursor !== "string" || !SYNC_CURSOR_PATTERN.test(nextCursor))
    ) {
      throw new Error("The website returned an invalid sync cursor.");
    }
    return {
      orders: mapSyncedWebsiteOrders(result.orders),
      nextCursor
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
        // Older POS builds could enqueue a status transition. Website Admin is
        // now authoritative, so retire a stale local event without sending it
        // back to the server or allowing it to block print acknowledgements.
        acceptedEventIds.push(event.id);
        continue;
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

/**
 * The Website's signed sync endpoint deliberately returns a database-shaped,
 * snake_case operations payload. Convert it at this trust boundary instead of
 * letting remote JSON masquerade as the POS's local print snapshot.
 */
export function mapSyncedWebsiteOrders(value: unknown): WebsiteOrderSnapshot[] {
  if (!Array.isArray(value) || value.length > MAX_SYNC_ORDERS) {
    throw new Error("The website returned an invalid synchronized-order response.");
  }

  const mapped = value.map((order, index) => mapSyncedWebsiteOrder(order, index));
  if (new Set(mapped.map((order) => order.remoteId)).size !== mapped.length) {
    throw new Error("The website returned duplicate synchronized-order IDs.");
  }
  return mapped;
}

export function mapSyncedWebsiteOrder(
  value: unknown,
  position = 0
): WebsiteOrderSnapshot {
  const order = requireRecord(value, `Synchronized order ${position + 1}`);
  const remoteId = requireUuid(order.order_id, "Website order ID");
  const orderCode = requireText(order.order_reference, "Website order reference", 80);
  const remoteVersion = requirePositiveInteger(order.version, "Website order version", 2_147_483_647);
  const mode = requireOneOf(order.mode, ["live", "test"] as const, "Website order mode");
  requireOneOf(order.locale, ["en", "bn"] as const, "Website order locale");
  const status = mapWebsiteStatus(order.status, orderCode);
  if (order.currency_code !== "BDT") {
    throw new Error(`Website order ${orderCode} uses an unsupported currency.`);
  }

  const contact = requireRecord(order.contact, `Website order ${orderCode} contact`);
  const customerName = requireText(contact.full_name, "Customer name", 120);
  const customerPhone = requirePhone(contact.phone_e164);
  const address = {
    sector: String(requirePositiveInteger(contact.sector_number, "Sector", 99)),
    road: requireText(contact.road_number, "Road", 80),
    house: requireText(contact.house_number, "House", 80),
    flat: requireText(contact.flat_number, "Flat", 80)
  };

  if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 100) {
    throw new Error(`Website order ${orderCode} has an invalid item list.`);
  }
  const items = order.items.map((item, itemIndex) =>
    mapSyncedWebsiteOrderItem(item, orderCode, itemIndex)
  );
  if (new Set(items.map((item) => item.remoteItemId)).size !== items.length) {
    throw new Error(`Website order ${orderCode} contains duplicate item IDs.`);
  }

  const subtotalMinor = requireMinorAmount(order.subtotal_minor, "Website order subtotal");
  const deliveryFeeMinor = requireMinorAmount(order.delivery_fee_minor, "Website order delivery fee");
  const discountMinor = requireMinorAmount(order.discount_minor, "Website order discount");
  const totalMinor = requireMinorAmount(order.grand_total_minor, "Website order total");
  const itemSubtotalMinor = order.items.reduce(
    (sum, item) => sum + requireMinorAmount(
      requireRecord(item, "Website order item").line_total_minor,
      "Website order item total"
    ),
    0
  );
  if (subtotalMinor !== itemSubtotalMinor) {
    throw new Error(`Website order ${orderCode} subtotal does not match its items.`);
  }
  if (
    discountMinor > subtotalMinor + deliveryFeeMinor
    || totalMinor !== subtotalMinor + deliveryFeeMinor - discountMinor
  ) {
    throw new Error(`Website order ${orderCode} total is invalid.`);
  }
  requireNullableTimestamp(order.accepted_at, "Website order acceptance time");
  requireNullableTimestamp(order.completed_at, "Website order completion time");
  requireNullableTimestamp(order.cancelled_at, "Website order cancellation time");
  requireNullableTimestamp(order.archived_at, "Website order archive time");

  return {
    remoteId,
    orderCode,
    remoteVersion,
    status,
    customerName,
    customerPhone,
    address,
    deliveryNote: optionalText(order.customer_note, "Website order note", 500),
    subtotal: minorToWholeTaka(subtotalMinor, "Website order subtotal"),
    deliveryFee: minorToWholeTaka(deliveryFeeMinor, "Website order delivery fee"),
    discount: minorToWholeTaka(discountMinor, "Website order discount"),
    total: minorToWholeTaka(totalMinor, "Website order total"),
    isTest: mode === "test",
    remoteCreatedAt: requireTimestamp(order.placed_at, "Website order placement time"),
    remoteUpdatedAt: requireTimestamp(order.updated_at, "Website order update time"),
    items
  };
}

function mapSyncedWebsiteOrderItem(
  value: unknown,
  orderCode: string,
  position: number
): WebsiteOrderSnapshot["items"][number] {
  const item = requireRecord(value, `Website order ${orderCode} item ${position + 1}`);
  const remoteItemId = requireUuid(item.id, `Website order ${orderCode} item ID`);
  requireNullableUuid(item.source_item_id, `Website order ${orderCode} source item ID`);
  optionalText(item.source_item_slug, `Website order ${orderCode} item slug`, 160);
  const quantity = requirePositiveInteger(item.quantity, `Website order ${orderCode} item quantity`, 99);
  const unitPriceMinor = requireMinorAmount(
    item.unit_price_minor,
    `Website order ${orderCode} item base price`
  );
  const modifierUnitTotalMinor = requireMinorAmount(
    item.modifier_unit_total_minor,
    `Website order ${orderCode} item modifier total`
  );
  const effectiveUnitPriceMinor = requireMinorAmount(
    item.effective_unit_price_minor,
    `Website order ${orderCode} item price`
  );
  const lineTotalMinor = requireMinorAmount(
    item.line_total_minor,
    `Website order ${orderCode} item total`
  );
  if (lineTotalMinor !== quantity * effectiveUnitPriceMinor) {
    throw new Error(`Website order ${orderCode} item total is invalid.`);
  }
  if (effectiveUnitPriceMinor !== unitPriceMinor + modifierUnitTotalMinor) {
    throw new Error(`Website order ${orderCode} item price is invalid.`);
  }

  const sourcePublicKey = item.source_item_public_key;
  const menuItemPublicId = sourcePublicKey === null
    ? `manual_${remoteItemId.replaceAll("-", "")}`
    : requireWebsitePublicId(sourcePublicKey, `Website order ${orderCode} item public ID`);
  const name = requireText(item.name_en, `Website order ${orderCode} item name`, 160);
  requireText(item.name_bn, `Website order ${orderCode} item Bangla name`, 160);
  const customerNote = optionalText(item.customer_note, `Website order ${orderCode} item note`, 300);
  const modifierText = describeModifiers(item.modifiers, orderCode, position);
  const note = joinItemNotes(customerNote, modifierText, orderCode);

  return {
    remoteItemId,
    menuItemPublicId,
    name,
    quantity,
    unitPrice: minorToWholeTaka(effectiveUnitPriceMinor, `Website order ${orderCode} item price`),
    note
  };
}

function describeModifiers(value: unknown, orderCode: string, position: number): string | null {
  if (!Array.isArray(value) || value.length > 40) {
    throw new Error(`Website order ${orderCode} item ${position + 1} modifiers are invalid.`);
  }
  if (value.length === 0) return null;
  const labels = value.map((modifier, modifierIndex) => {
    const item = requireRecord(
      modifier,
      `Website order ${orderCode} item ${position + 1} modifier ${modifierIndex + 1}`
    );
    requireNullableUuid(item.source_option_id, "Website order modifier source option ID");
    requireMinorAmount(item.price_delta_minor, "Website order modifier price");
    const group = requireText(item.group_name_en, "Website order modifier group", 160);
    requireText(item.group_name_bn, "Website order modifier Bangla group", 160);
    const option = requireText(item.option_name_en, "Website order modifier option", 160);
    requireText(item.option_name_bn, "Website order modifier Bangla option", 160);
    return `${group}: ${option}`;
  });
  return `Options: ${labels.join(", ")}`;
}

function joinItemNotes(
  customerNote: string | null,
  modifierText: string | null,
  orderCode: string
): string | null {
  const note = [customerNote, modifierText].filter(Boolean).join(" | ");
  if (!note) return null;
  if (note.length > 12_000) {
    throw new Error(`Website order ${orderCode} item notes are too long.`);
  }
  return note;
}

function mapWebsiteStatus(value: unknown, orderCode: string): WebsiteOrderStatus {
  if (value === "placed" || value === "pending_acceptance") return "pending";
  if (
    value === "accepted"
    || value === "preparing"
    || value === "ready"
    || value === "out_for_delivery"
    || value === "delivered"
    || value === "rejected"
    || value === "cancelled"
  ) {
    return value;
  }
  throw new Error(`Website order ${orderCode} has an invalid incoming status.`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireNullableUuid(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireUuid(value, label);
}

function requireText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid.`);
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) return null;
  return requireText(value, label, maximum);
}

function requirePositiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireMinorAmount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function minorToWholeTaka(value: number, label: string): number {
  if (value % MINOR_UNITS_PER_TAKA !== 0) {
    throw new Error(`${label} cannot be represented by the local POS.`);
  }
  return value / MINOR_UNITS_PER_TAKA;
}

function requireOneOf<T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T[number];
}

function requireWebsitePublicId(value: unknown, label: string): string {
  if (typeof value !== "string" || !WEBSITE_PUBLIC_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requirePhone(value: unknown): string {
  if (typeof value !== "string" || !/^\+8801[3-9]\d{8}$/.test(value)) {
    throw new Error("Customer phone number is invalid.");
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireNullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireTimestamp(value, label);
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
