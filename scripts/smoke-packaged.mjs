import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const candidates = [
  path.resolve("release", "win-unpacked", "Yamzo POS.exe"),
  path.resolve("release-packaged", "win-unpacked", "Yamzo POS.exe")
];
const exePath = candidates.find((candidate) => fs.existsSync(candidate));
const outDir = path.resolve(".ai-task", "packaged-smoke");
const probePath = path.join(outDir, "probe.json");
const appDataDir = path.join(outDir, "user-data");

if (!exePath) {
  throw new Error(`Packaged executable not found. Checked: ${candidates.join(", ")}`);
}

fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
fs.mkdirSync(outDir, { recursive: true });

const child = spawn(exePath, [], {
  detached: false,
  stdio: "ignore",
  env: {
    ...process.env,
    YAMZO_APP_DATA_DIR: appDataDir,
    YAMZO_SMOKE_PROBE: probePath
  }
});

const timeoutMs = 20000;
const startedAt = Date.now();
let result = null;

try {
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(probePath)) {
      result = JSON.parse(fs.readFileSync(probePath, "utf8"));
      break;
    }
    await sleep(500);
  }
} finally {
  try {
    child.kill();
  } catch {
    // The app may already have exited.
  }
}

if (!result) {
  throw new Error(`Packaged app did not write smoke probe within ${timeoutMs}ms`);
}

if (!result.ok) {
  throw new Error(`Packaged app load failed: ${JSON.stringify(result, null, 2)}`);
}

const text = result.snapshot?.bodyText ?? "";
const required = ["Yamzo POS", "Username", "Password", "Login"];
const missing = required.filter((token) => !text.includes(token));

if (missing.length) {
  throw new Error(`Packaged renderer missing expected text: ${missing.join(", ")}\n${JSON.stringify(result, null, 2)}`);
}

console.log(JSON.stringify(result, null, 2));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
