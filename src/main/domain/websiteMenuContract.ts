import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const WEBSITE_PUBLIC_ID_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const CATALOG_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CONTRACT_ENTRIES = 200;

export interface WebsiteMenuContractEntry {
  websitePublicId: string;
  effectiveUnitPrice: number;
  websiteName: string;
  expectedPosName: string;
}

export interface WebsiteMenuContract {
  schemaVersion: 1;
  catalogDigest: string;
  entries: WebsiteMenuContractEntry[];
}

export interface WebsiteMenuContractBlocker {
  websitePublicId: string;
  effectiveUnitPrice: number;
  expectedPosName: string;
  code:
    | "POS_ITEM_NOT_FOUND"
    | "POS_ITEM_ARCHIVED"
    | "POS_ITEM_UNAVAILABLE"
    | "POS_ITEM_PRICE_MISMATCH"
    | "POS_ITEM_NAME_AMBIGUOUS"
    | "POS_ITEM_REUSED";
  detail: string;
}

export interface WebsiteMenuContractInspection {
  catalogDigest: string;
  entryCount: number;
  readyCount: number;
  canApply: boolean;
  blockers: WebsiteMenuContractBlocker[];
  resolved: Array<WebsiteMenuContractEntry & { menuItemId: number }>;
}

interface MenuItemRow {
  id: number;
  name: string;
  price: number;
  available: number;
  archived: number;
}

export function parseWebsiteMenuContract(value: unknown): WebsiteMenuContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Website menu contract must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1
    || typeof input.catalogDigest !== "string"
    || !CATALOG_DIGEST_PATTERN.test(input.catalogDigest)
    || !Array.isArray(input.entries)
    || input.entries.length < 1
    || input.entries.length > MAX_CONTRACT_ENTRIES
  ) {
    throw new Error("Website menu contract header is invalid.");
  }

  const entries = input.entries.map((entry, index) => parseEntry(entry, index));
  const keys = entries.map((entry) => mappingKey(
    entry.websitePublicId,
    entry.effectiveUnitPrice
  ));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Website menu contract contains duplicate public ID and price pairs.");
  }
  const calculatedDigest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  if (calculatedDigest !== input.catalogDigest) {
    throw new Error("Website menu contract digest does not match its entries.");
  }
  return {
    schemaVersion: 1,
    catalogDigest: input.catalogDigest,
    entries
  };
}

export function inspectWebsiteMenuContract(
  db: Database.Database,
  value: WebsiteMenuContract | unknown
): WebsiteMenuContractInspection {
  const contract = parseWebsiteMenuContract(value);
  const rows = db.prepare(
    "SELECT id, name, price, available, archived FROM menu_items ORDER BY id"
  ).all() as MenuItemRow[];
  const resolved: WebsiteMenuContractInspection["resolved"] = [];
  const blockers: WebsiteMenuContractBlocker[] = [];
  const usedMenuItemIds = new Set<number>();

  for (const entry of contract.entries) {
    const sameName = rows.filter(
      (row) => normalizeMenuName(row.name) === normalizeMenuName(entry.expectedPosName)
    );
    const active = sameName.filter((row) => row.archived === 0);
    if (active.length === 0) {
      blockers.push(blocker(
        entry,
        sameName.length > 0 ? "POS_ITEM_ARCHIVED" : "POS_ITEM_NOT_FOUND",
        sameName.length > 0
          ? "The matching POS item is archived."
          : "No POS item has the contract's expected name."
      ));
      continue;
    }
    if (active.length !== 1) {
      blockers.push(blocker(
        entry,
        "POS_ITEM_NAME_AMBIGUOUS",
        "More than one active POS item has the contract's expected name."
      ));
      continue;
    }
    const row = active[0];
    if (row.available !== 1) {
      blockers.push(blocker(
        entry,
        "POS_ITEM_UNAVAILABLE",
        "The matching POS item is not available for ordering."
      ));
      continue;
    }
    if (row.price !== entry.effectiveUnitPrice) {
      blockers.push(blocker(
        entry,
        "POS_ITEM_PRICE_MISMATCH",
        `Expected ${entry.effectiveUnitPrice} BDT but the POS item is ${row.price} BDT.`
      ));
      continue;
    }
    if (usedMenuItemIds.has(row.id)) {
      blockers.push(blocker(
        entry,
        "POS_ITEM_REUSED",
        "One POS item cannot represent multiple website public ID and price pairs."
      ));
      continue;
    }
    usedMenuItemIds.add(row.id);
    resolved.push({ ...entry, menuItemId: row.id });
  }

  return {
    catalogDigest: contract.catalogDigest,
    entryCount: contract.entries.length,
    readyCount: resolved.length,
    canApply: blockers.length === 0 && resolved.length === contract.entries.length,
    blockers,
    resolved
  };
}

export function applyWebsiteMenuContract(
  db: Database.Database,
  value: WebsiteMenuContract | unknown
): WebsiteMenuContractInspection {
  const contract = parseWebsiteMenuContract(value);
  const inspection = inspectWebsiteMenuContract(db, contract);
  if (!inspection.canApply) {
    const first = inspection.blockers[0];
    throw new Error(
      `Website menu contract is blocked (${first?.code ?? "UNKNOWN"}); ${inspection.blockers.length} item(s) require review.`
    );
  }

  const apply = db.transaction(() => {
    db.prepare("DELETE FROM website_menu_mappings").run();
    const insert = db.prepare(
      `INSERT INTO website_menu_mappings
        (website_public_id, effective_unit_price, menu_item_id, catalog_digest, expected_pos_name)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const entry of inspection.resolved) {
      insert.run(
        entry.websitePublicId,
        entry.effectiveUnitPrice,
        entry.menuItemId,
        contract.catalogDigest,
        entry.expectedPosName
      );
    }
    db.prepare(
      `INSERT INTO website_menu_contract_state
        (singleton_id, catalog_digest, entry_count, applied_at)
       VALUES (1, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(singleton_id) DO UPDATE SET
         catalog_digest = excluded.catalog_digest,
         entry_count = excluded.entry_count,
         applied_at = CURRENT_TIMESTAMP`
    ).run(contract.catalogDigest, contract.entries.length);
  });
  apply();
  return inspection;
}

/**
 * Loads only a complete, currently active contract. Partial/stale mappings are
 * ignored so a website item cannot fall back to a name or local row ID.
 */
export function getActiveWebsiteMenuMappings(
  db: Database.Database
): Map<string, number> {
  const state = db.prepare(
    "SELECT catalog_digest, entry_count FROM website_menu_contract_state WHERE singleton_id = 1"
  ).get() as { catalog_digest: string; entry_count: number } | undefined;
  if (!state || !CATALOG_DIGEST_PATTERN.test(state.catalog_digest)) return new Map();
  const rows = db.prepare(
    `SELECT m.website_public_id, m.effective_unit_price, m.menu_item_id,
            m.expected_pos_name, mi.name AS current_pos_name, mi.price AS current_price
     FROM website_menu_mappings m
     JOIN menu_items mi ON mi.id = m.menu_item_id
     WHERE m.catalog_digest = ? AND mi.archived = 0`
  ).all(state.catalog_digest) as Array<{
    website_public_id: string;
    effective_unit_price: number;
    menu_item_id: number;
    expected_pos_name: string;
    current_pos_name: string;
    current_price: number;
  }>;
  if (rows.length !== state.entry_count) return new Map();
  if (rows.some((row) =>
    row.current_price !== row.effective_unit_price
    || normalizeMenuName(row.current_pos_name) !== normalizeMenuName(row.expected_pos_name)
  )) return new Map();
  return new Map(rows.map((row) => [
    mappingKey(row.website_public_id, row.effective_unit_price),
    row.menu_item_id
  ]));
}

export function resolveWebsiteMenuItemId(
  mappings: ReadonlyMap<string, number>,
  websitePublicId: string,
  effectiveUnitPrice: number
): number | null {
  return mappings.get(mappingKey(websitePublicId, effectiveUnitPrice)) ?? null;
}

function parseEntry(value: unknown, index: number): WebsiteMenuContractEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Website menu contract entry ${index + 1} is invalid.`);
  }
  const entry = value as Record<string, unknown>;
  const websitePublicId = String(entry.websitePublicId ?? "").trim();
  const effectiveUnitPrice = Number(entry.effectiveUnitPrice);
  const websiteName = cleanName(entry.websiteName);
  const expectedPosName = cleanName(entry.expectedPosName);
  if (
    !WEBSITE_PUBLIC_ID_PATTERN.test(websitePublicId)
    || !Number.isSafeInteger(effectiveUnitPrice)
    || effectiveUnitPrice < 0
    || effectiveUnitPrice > 10_000_000
    || !websiteName
    || websiteName.length > 160
    || !expectedPosName
    || expectedPosName.length > 160
  ) {
    throw new Error(`Website menu contract entry ${index + 1} is invalid.`);
  }
  return { websitePublicId, effectiveUnitPrice, websiteName, expectedPosName };
}

function blocker(
  entry: WebsiteMenuContractEntry,
  code: WebsiteMenuContractBlocker["code"],
  detail: string
): WebsiteMenuContractBlocker {
  return {
    websitePublicId: entry.websitePublicId,
    effectiveUnitPrice: entry.effectiveUnitPrice,
    expectedPosName: entry.expectedPosName,
    code,
    detail
  };
}

function cleanName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMenuName(value: string): string {
  return cleanName(value)
    .toLocaleLowerCase("en-US")
    .replace(/sea[\s-]+food/g, "seafood")
    .replace(/\band\b/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mappingKey(websitePublicId: string, effectiveUnitPrice: number): string {
  return `${websitePublicId}\u0000${effectiveUnitPrice}`;
}
