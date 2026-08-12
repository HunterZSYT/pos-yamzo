import { createHash, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { openDatabase } from "../dist-electron/main/database/connection.js";
import { setSetting } from "../dist-electron/main/services/settings.js";
import { provisionWebsiteTerminalIdentity } from "../dist-electron/main/services/websiteTerminalCredentials.js";

const registrationCode = process.argv[2]?.trim();
const expectedTerminalCode = process.argv[3]?.trim();
const baseUrl = process.argv[4]?.trim() || "https://yamzouttara.com";
if (!/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(registrationCode ?? "")) {
  throw new Error("A valid short-lived registration code is required.");
}
if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(expectedTerminalCode ?? "")) {
  throw new Error("A valid expected TEST terminal code is required.");
}

const qaRoot = path.resolve(".ai-task", "yamzo-overhaul-v2");
const userDataPath = path.join(qaRoot, "gate6-registration");
if (!userDataPath.startsWith(`${qaRoot}${path.sep}`)) throw new Error("Unsafe QA data path.");
fs.rmSync(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
fs.mkdirSync(userDataPath, { recursive: true });

const protectedValues = new Map();
const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => {
    const handle = randomBytes(32).toString("hex");
    protectedValues.set(handle, value);
    return Buffer.from(handle, "utf8");
  },
  decryptString: (value) => {
    const decrypted = protectedValues.get(value.toString("utf8"));
    if (!decrypted) throw new Error("Protected QA terminal key is unavailable.");
    return decrypted;
  },
};

const context = await postRegistration(baseUrl, { registrationCode });
if (context?.terminal?.code !== expectedTerminalCode || context?.terminal?.mode !== "test") {
  throw new Error("Registration context did not return the expected TEST terminal.");
}

const provisioned = provisionWebsiteTerminalIdentity({
  terminalCode: expectedTerminalCode,
  userDataPath,
  protector,
});
const registration = await postRegistration(baseUrl, {
  registrationCode,
  publicKey: provisioned.identity.registration.publicKeyBase64Url,
});
if (
  registration?.terminal?.code !== expectedTerminalCode
  || registration?.terminal?.mode !== "test"
  || registration?.terminal?.publicKeyFingerprint !== provisioned.identity.registration.publicKeyFingerprint
) {
  throw new Error("Registration redemption did not match the locally generated terminal identity.");
}

const databasePath = path.join(userDataPath, "yamzo-pos.sqlite3");
const db = openDatabase(databasePath);
let supabase = null;
let channel = null;
try {
  setSetting(db, "websiteConnection", {
    baseUrl: `${new URL(baseUrl).origin}/`,
    terminalCode: expectedTerminalCode,
    includeTestOrders: true,
  });
  const firstSync = await signedPost("/api/pos/orders/sync", { cursor: null, limit: 50, includeTest: true });
  const restartSync = await signedPost("/api/pos/orders/sync", { cursor: null, limit: 50, includeTest: true });

  let offlineFailedClosed = false;
  try {
    await signedPost("/api/pos/orders/sync", { cursor: null, limit: 50, includeTest: true }, "http://127.0.0.1:9");
  } catch {
    offlineFailedClosed = true;
  }
  if (!offlineFailedClosed) throw new Error("Offline recovery probe did not fail closed.");
  const recoveredSync = await signedPost("/api/pos/orders/sync", { cursor: null, limit: 50, includeTest: true });

  const sessionResponse = await signedPost("/api/pos/realtime/token", {});
  const session = sessionResponse.realtime;
  if (!session?.supabaseUrl || !session?.publishableKey || !session?.accessToken || !session?.topic || !session?.event) {
    throw new Error("Realtime session response was incomplete.");
  }
  supabase = createClient(session.supabaseUrl, session.publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    realtime: { params: { eventsPerSecond: 2 } },
  });
  await supabase.realtime.setAuth(session.accessToken);
  channel = supabase.channel(session.topic, { config: { private: true } });
  const realtimeStatus = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime subscription timed out.")), 15_000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve(status);
      } else if (["TIMED_OUT", "CHANNEL_ERROR", "CLOSED"].includes(status)) {
        clearTimeout(timer);
        reject(new Error(`Realtime subscription failed: ${status}`));
      }
    });
  });

  console.log(JSON.stringify({
    terminalCode: expectedTerminalCode,
    mode: "TEST",
    registration: "redeemed",
    firstSync: { orderCount: firstSync.orders?.length ?? -1, hasCursor: Boolean(firstSync.nextCursor) },
    restartSync: { orderCount: restartSync.orders?.length ?? -1, hasCursor: Boolean(restartSync.nextCursor) },
    offlineFailedClosed,
    recoveredSync: { orderCount: recoveredSync.orders?.length ?? -1, hasCursor: Boolean(recoveredSync.nextCursor) },
    realtimeStatus,
    sqliteQuickCheck: db.pragma("quick_check", { simple: true }),
  }, null, 2));
} finally {
  if (supabase && channel) await supabase.removeChannel(channel);
  db.close();
}

async function postRegistration(origin, payload) {
  const response = await fetch(new URL("/api/pos/register", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") throw new Error("Registration response was not JSON.");
  const body = await response.json();
  if (!response.ok) throw new Error(`Registration failed with HTTP ${response.status}.`);
  return body;
}

async function signedPost(pathname, payload, origin = baseUrl) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = ["v1", "POST", pathname, expectedTerminalCode, timestamp, nonce, bodyHash].join("\n");
  const signature = sign(null, Buffer.from(canonical, "utf8"), provisioned.identity.privateKey).toString("base64url");
  const response = await fetch(new URL(pathname, origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-yamzo-terminal": expectedTerminalCode,
      "x-yamzo-timestamp": timestamp,
      "x-yamzo-nonce": nonce,
      "x-yamzo-body-sha256": bodyHash,
      "x-yamzo-signature": signature,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await response.text();
  if (responseText.length > 1024 * 1024) throw new Error("Signed response was too large.");
  const result = JSON.parse(responseText);
  if (!response.ok) throw new Error(`Signed request failed with HTTP ${response.status}.`);
  return result;
}
