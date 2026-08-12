import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

const mode = process.argv[2];
if (mode !== "seed" && mode !== "verify") {
  throw new Error("Usage: node scripts/smoke-installed-upgrade.mjs <seed|verify>");
}

const projectRoot = process.cwd();
const qaRoot = path.resolve(".ai-task", "yamzo-overhaul-v2");
const appDataDir = path.join(qaRoot, "gate6-installed-upgrade");
const installedExe = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Programs",
  "yamzo-pos",
  "Yamzo POS.exe",
);

if (!appDataDir.startsWith(`${qaRoot}${path.sep}`)) {
  throw new Error(`Unsafe QA data path: ${appDataDir}`);
}
if (!fs.existsSync(installedExe)) {
  throw new Error(`Installed Yamzo POS executable not found: ${installedExe}`);
}

if (mode === "seed") {
  fs.rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  fs.mkdirSync(path.join(appDataDir, "uploads"), { recursive: true });
}

const probePath = path.join(appDataDir, `probe-${mode}.json`);
fs.rmSync(probePath, { force: true });
const probe = await launchAndProbe(installedExe, appDataDir, probePath);
const databasePath = path.join(appDataDir, "yamzo-pos.sqlite3");
if (!fs.existsSync(databasePath)) throw new Error("Installed app did not create its SQLite database.");

const db = new BetterSqlite3(databasePath);
try {
  if (mode === "seed") {
    db.exec(`
      create table if not exists gate6_preservation_marker (
        marker text primary key,
        created_at text not null
      );
    `);
    db.prepare(`
      insert or replace into gate6_preservation_marker (marker, created_at)
      values ('installer-upgrade-preserved', '2026-08-11T00:00:00.000Z')
    `).run();
    fs.writeFileSync(path.join(appDataDir, "gate6-printer-preservation.txt"), "printer-settings-preserved\n", "utf8");
    fs.writeFileSync(path.join(appDataDir, "gate6-terminal-preservation.protected.json"), "{\"protected\":true}\n", "utf8");
    fs.writeFileSync(path.join(appDataDir, "uploads", "gate6-local-asset.txt"), "local-asset-preserved\n", "utf8");
  }

  const marker = db.prepare("select marker, created_at from gate6_preservation_marker limit 1").get();
  const quickCheck = db.pragma("quick_check", { simple: true });
  const schemaVersion = db.pragma("user_version", { simple: true });
  const filesPreserved = [
    path.join(appDataDir, "gate6-printer-preservation.txt"),
    path.join(appDataDir, "gate6-terminal-preservation.protected.json"),
    path.join(appDataDir, "uploads", "gate6-local-asset.txt"),
  ].every((filePath) => fs.existsSync(filePath));

  if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed: ${quickCheck}`);
  if (marker?.marker !== "installer-upgrade-preserved") throw new Error("Upgrade marker was not preserved.");
  if (!filesPreserved) throw new Error("One or more AppData preservation files are missing.");

  console.log(JSON.stringify({
    mode,
    probeOk: probe.ok,
    phase: probe.phase,
    rendererTitle: probe.snapshot?.title,
    databasePath,
    databaseBytes: fs.statSync(databasePath).size,
    schemaVersion,
    quickCheck,
    marker,
    filesPreserved,
  }, null, 2));
} finally {
  db.close();
}

async function launchAndProbe(exePath, userDataPath, outputPath) {
  const child = spawn(exePath, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      YAMZO_APP_DATA_DIR: userDataPath,
      YAMZO_SMOKE_PROBE: outputPath,
    },
  });

  let result = null;
  const deadline = Date.now() + 25_000;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(outputPath)) {
        result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        break;
      }
      await sleep(250);
    }
  } finally {
    if (!child.killed) child.kill();
    await Promise.race([once(child, "exit"), sleep(5_000)]);
  }

  if (!result?.ok) throw new Error(`Installed app smoke probe failed: ${JSON.stringify(result)}`);
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
