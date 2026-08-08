import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../src/main/database/connection";
import {
  applyWebsiteMenuContract,
  getActiveWebsiteMenuMappings,
  inspectWebsiteMenuContract,
  parseWebsiteMenuContract,
  resolveWebsiteMenuItemId,
  type WebsiteMenuContractEntry
} from "../src/main/domain/websiteMenuContract";

let db: Database.Database;

beforeEach(() => {
  db = openMemoryDatabase();
});

describe("website menu contract", () => {
  it("ships a valid canonical catalog including price-specific package variants", () => {
    const canonical = parseWebsiteMenuContract(JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "resources", "website-menu-contract.json"),
      "utf8"
    )));
    expect(canonical.entries).toHaveLength(52);
    expect(canonical.entries.filter(
      (entry) => entry.websitePublicId === "menu_item_naga_shingara"
    ).map((entry) => entry.effectiveUnitPrice)).toEqual([60, 110, 200]);
  });

  it("binds the same website public ID to exact variant prices and active POS items", () => {
    const regularId = addMenuItem("Naga Shingara Regular Pack", 60);
    const familyId = addMenuItem("Naga Shingara Family Pack", 110);
    const entries: WebsiteMenuContractEntry[] = [
      {
        websitePublicId: "menu_item_naga_shingara",
        effectiveUnitPrice: 60,
        websiteName: "Naga Shingara",
        expectedPosName: "Naga Shingara Regular Pack"
      },
      {
        websitePublicId: "menu_item_naga_shingara",
        effectiveUnitPrice: 110,
        websiteName: "Naga Shingara",
        expectedPosName: "Naga Shingara Family Pack"
      }
    ];

    const report = applyWebsiteMenuContract(db, contract(entries));
    expect(report).toMatchObject({ canApply: true, entryCount: 2, readyCount: 2 });
    const mappings = getActiveWebsiteMenuMappings(db);
    expect(resolveWebsiteMenuItemId(mappings, "menu_item_naga_shingara", 60)).toBe(regularId);
    expect(resolveWebsiteMenuItemId(mappings, "menu_item_naga_shingara", 110)).toBe(familyId);
    expect(resolveWebsiteMenuItemId(mappings, "menu_item_naga_shingara", 200)).toBeNull();
  });

  it("reports archived, unavailable, missing, and price-mismatched POS items without applying", () => {
    addMenuItem("Archived Item", 100, { archived: true, available: false });
    addMenuItem("Unavailable Item", 200, { available: false });
    addMenuItem("Wrong Price Item", 999);
    const entries: WebsiteMenuContractEntry[] = [
      entry("menu_item_archived", 100, "Archived Item"),
      entry("menu_item_unavailable", 200, "Unavailable Item"),
      entry("menu_item_wrong_price", 300, "Wrong Price Item"),
      entry("menu_item_missing", 400, "Missing Item")
    ];
    const report = inspectWebsiteMenuContract(db, contract(entries));

    expect(report.canApply).toBe(false);
    expect(report.blockers.map((blocker) => blocker.code)).toEqual([
      "POS_ITEM_ARCHIVED",
      "POS_ITEM_UNAVAILABLE",
      "POS_ITEM_PRICE_MISMATCH",
      "POS_ITEM_NOT_FOUND"
    ]);
    expect(() => applyWebsiteMenuContract(db, contract(entries))).toThrow(/blocked/i);
    expect(getActiveWebsiteMenuMappings(db).size).toBe(0);
  });

  it("rejects a tampered catalog and fails closed if an applied mapping becomes incomplete", () => {
    addMenuItem("Chicken Momo", 195);
    const value = contract([
      entry("menu_item_chicken_momo", 195, "Chicken Momo")
    ]);
    expect(() => parseWebsiteMenuContract({
      ...value,
      entries: [{ ...value.entries[0], effectiveUnitPrice: 1 }]
    })).toThrow(/digest/i);

    applyWebsiteMenuContract(db, value);
    db.prepare("DELETE FROM website_menu_mappings").run();
    expect(getActiveWebsiteMenuMappings(db).size).toBe(0);
  });

  function addMenuItem(
    name: string,
    price: number,
    state: { available?: boolean; archived?: boolean } = {}
  ): number {
    return Number(db.prepare(
      `INSERT INTO menu_items (name, price, category, track_recipe, available, archived)
       VALUES (?, ?, 'Test', 1, ?, ?)`
    ).run(
      name,
      price,
      state.available === false ? 0 : 1,
      state.archived === true ? 1 : 0
    ).lastInsertRowid);
  }
});

function entry(
  websitePublicId: string,
  effectiveUnitPrice: number,
  name: string
): WebsiteMenuContractEntry {
  return {
    websitePublicId,
    effectiveUnitPrice,
    websiteName: name,
    expectedPosName: name
  };
}

function contract(entries: WebsiteMenuContractEntry[]) {
  return {
    schemaVersion: 1 as const,
    catalogDigest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries
  };
}
