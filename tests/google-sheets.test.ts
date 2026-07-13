import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../src/main/database/connection";
import { addCostRecord } from "../src/main/domain/inventory";
import { addOrderItem, createOrder, settleOrder } from "../src/main/domain/orders";
import {
  buildGoogleSheetsSnapshot,
  describeGoogleError,
  getGoogleSheetsSettings,
  parseGoogleOAuthCredentials,
  safeGoogleError,
  saveGoogleOAuthClient,
  setGoogleSheetsSettings
} from "../src/main/services/googleSheets";

let db: Database.Database | null = null;
let temporaryDirectory = "";
let previousTokenPath: string | undefined;
let previousCredentialPath: string | undefined;
let previousAppDataPath: string | undefined;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yamzo-google-sheets-"));
  previousTokenPath = process.env.YAMZO_GOOGLE_TOKEN;
  previousCredentialPath = process.env.YAMZO_GOOGLE_CREDENTIALS;
  previousAppDataPath = process.env.YAMZO_APP_DATA_DIR;
  process.env.YAMZO_GOOGLE_TOKEN = path.join(temporaryDirectory, "token.json");
  process.env.YAMZO_GOOGLE_CREDENTIALS = path.join(temporaryDirectory, "credentials.txt");
  process.env.YAMZO_APP_DATA_DIR = temporaryDirectory;
});

afterEach(() => {
  db?.close();
  db = null;
  if (previousTokenPath === undefined) delete process.env.YAMZO_GOOGLE_TOKEN;
  else process.env.YAMZO_GOOGLE_TOKEN = previousTokenPath;
  if (previousCredentialPath === undefined) delete process.env.YAMZO_GOOGLE_CREDENTIALS;
  else process.env.YAMZO_GOOGLE_CREDENTIALS = previousCredentialPath;
  if (previousAppDataPath === undefined) delete process.env.YAMZO_APP_DATA_DIR;
  else process.env.YAMZO_APP_DATA_DIR = previousAppDataPath;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("Google Sheets export", () => {
  it("parses supported credential files and rejects a mismatched web redirect URI", () => {
    const plain = parseGoogleOAuthCredentials("123456789-yamzo_client.apps.googleusercontent.com\nlocal-test-secret");
    expect(plain.clientId).toContain(".apps.googleusercontent.com");

    expect(() => parseGoogleOAuthCredentials(JSON.stringify({
      web: {
        client_id: "123456789-yamzo_client.apps.googleusercontent.com",
        client_secret: "local-test-secret",
        redirect_uris: ["http://localhost:3000/callback"]
      }
    }))).toThrow("http://127.0.0.1:42813/oauth2callback");
  });

  it("reports a connection only when local client credentials and a token both exist", () => {
    fs.writeFileSync(process.env.YAMZO_GOOGLE_CREDENTIALS!, "123456789-yamzo_client.apps.googleusercontent.com\nlocal-test-secret");
    fs.writeFileSync(process.env.YAMZO_GOOGLE_TOKEN!, JSON.stringify({ refresh_token: "local-test-refresh-token" }));
    db = openMemoryDatabase();

    expect(getGoogleSheetsSettings(db)).toMatchObject({
      enabled: false,
      connected: true,
      pending: false,
      syncStatus: "ready",
      ordersTab: "Orders",
      orderItemsTab: "Order Items",
      costsTab: "Costs"
    });
    expect(getGoogleSheetsSettings(db).redirectUri).toBe("http://127.0.0.1:42813/oauth2callback");

    expect(setGoogleSheetsSettings(db, { enabled: false })).toMatchObject({
      enabled: false,
      connected: true,
      pending: false,
      syncStatus: "ready"
    });
  });

  it("saves a managed OAuth client without returning the secret and sanitizes Apps Script access errors", () => {
    db = openMemoryDatabase();
    const saved = saveGoogleOAuthClient(db, {
      clientId: "123456789-yamzo_client.apps.googleusercontent.com",
      clientSecret: "local-test-secret"
    });
    expect(saved).toMatchObject({
      clientId: "123456789-yamzo_client.apps.googleusercontent.com",
      hasClientCredentials: true,
      connected: false
    });
    expect(saved).not.toHaveProperty("credentialPath");
    expect(saved).not.toHaveProperty("tokenPath");
    expect(JSON.stringify(saved)).not.toContain("local-test-secret");
    expect(fs.readFileSync(path.join(temporaryDirectory, "google-oauth-client.json"), "utf8")).toContain("local-test-secret");
    expect(saveGoogleOAuthClient(db, {
      clientId: "123456789-yamzo_client.apps.googleusercontent.com"
    }).hasClientCredentials).toBe(true);
    expect(fs.readFileSync(path.join(temporaryDirectory, "google-oauth-client.json"), "utf8")).toContain("local-test-secret");
    const rendererResult = setGoogleSheetsSettings(db, {
      credentialPath: path.join(temporaryDirectory, "renderer-selected-secret.txt"),
      tokenPath: path.join(temporaryDirectory, "renderer-selected-token.json")
    } as never);
    expect(rendererResult).not.toHaveProperty("credentialPath");
    expect(rendererResult).not.toHaveProperty("tokenPath");
    expect(safeGoogleError(new Error(
      "User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings"
    ))).toContain("Apps Script access is disabled");
    expect(describeGoogleError(new Error(
      "User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings"
    ))).toMatchObject({
      code: "apps_script_user_setting_disabled",
      actionUrl: "https://script.google.com/home/usersettings"
    });
    expect(safeGoogleError(new Error('{"client_secret":"REDACTED_test-secret-fixture","access_token":"also-private"}')))
      .not.toMatch(/REDACTED_test-secret-fixture|also-private/);
  });

  it("builds a complete source-of-truth snapshot for multiple orders and costs", () => {
    db = openMemoryDatabase();
    const firstMenuId = Number(db.prepare("INSERT INTO menu_items (name, price) VALUES ('Chicken Momo', 220)").run().lastInsertRowid);
    const secondMenuId = Number(db.prepare("INSERT INTO menu_items (name, price) VALUES ('7 Up', 60)").run().lastInsertRowid);

    const settled = createOrder(db, { source: "in_house", tableNumber: "Table 4", orderDate: "2026-07-10" });
    addOrderItem(db, settled.id, { menuItemId: firstMenuId, quantity: 2 });
    addOrderItem(db, settled.id, { menuItemId: secondMenuId, quantity: 1, parcel: true });
    settleOrder(db, settled.id, "cash", 500);

    const open = createOrder(db, {
      source: "foodpanda",
      externalOrderId: "FP-LOCAL-002",
      orderDate: "2026-07-11"
    });
    addOrderItem(db, open.id, { menuItemId: firstMenuId, quantity: 1 });

    const category = db.prepare("SELECT id FROM cost_categories ORDER BY id LIMIT 1").get() as { id: number };
    addCostRecord(db, {
      categoryId: category.id,
      costName: "Test gas refill",
      amount: 850,
      paymentMethod: "cash",
      responsiblePerson: "Manager",
      costDate: "2026-07-11"
    });

    const snapshot = buildGoogleSheetsSnapshot(db);
    expect(snapshot.orders.rows).toHaveLength(2);
    expect(snapshot.orderItems.rows).toHaveLength(3);
    expect(snapshot.costs.rows).toHaveLength(1);

    const orderNumberIndex = snapshot.orders.headers.indexOf("Order Number");
    const orderDateIndex = snapshot.orders.headers.indexOf("Order Date");
    const externalIdIndex = snapshot.orders.headers.indexOf("External Order ID");
    const totalIndex = snapshot.orders.headers.indexOf("Total");
    expect(snapshot.orders.rows[0][orderNumberIndex]).toBe(settled.orderNumber);
    expect(snapshot.orders.rows[0][orderDateIndex]).toBe("2026-07-10");
    expect(snapshot.orders.rows[0][totalIndex]).toBe(500);
    expect(snapshot.orders.rows[1][externalIdIndex]).toBe("FP-LOCAL-002");
    expect(snapshot.costs.rows[0][snapshot.costs.headers.indexOf("Amount")]).toBe(850);
  });
});
