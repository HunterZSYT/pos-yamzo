import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv.includes("--installer") ? "installer" : "dir";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

archivePreviousRelease();
run(npmCommand, ["run", "clean:release"]);
run(npmCommand, ["run", "build"]);
run(npxCommand, ["electron-rebuild", "-f", "-w", "better-sqlite3"]);

const normalArgs = mode === "installer" ? ["electron-builder"] : ["electron-builder", "--dir"];
const normal = runCommand(npxCommand, normalArgs);

if (normal.status === 0) {
  writeReleaseManifest(path.resolve("release"));
  run(npmCommand, ["rebuild", "better-sqlite3"]);
  process.exit(0);
}

const extractedElectron = path.resolve("release", "win-unpacked.tmp");
if (!fs.existsSync(path.join(extractedElectron, "electron.exe"))) {
  run(npmCommand, ["rebuild", "better-sqlite3"]);
  process.exit(normal.status ?? 1);
}

console.warn("[package] Normal electron-builder packaging failed. Retrying with extracted Electron fallback.");
fs.rmSync(path.resolve("release-packaged"), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
const fallbackArgs =
  mode === "installer"
    ? ["electron-builder", "--config", "electron-builder.packaging-fallback.yml"]
    : ["electron-builder", "--dir", "--config", "electron-builder.packaging-fallback.yml"];
const fallback = runCommand(npxCommand, fallbackArgs);
if (fallback.status === 0) {
  writeReleaseManifest(path.resolve("release-packaged"));
}
run(npmCommand, ["rebuild", "better-sqlite3"]);
process.exit(fallback.status ?? 1);

function archivePreviousRelease() {
  const releaseDir = path.resolve("release");
  if (!fs.existsSync(releaseDir)) return;

  const installers = fs
    .readdirSync(releaseDir)
    .filter((name) => /^Yamzo POS Setup .+\.exe$/i.test(name));
  if (!installers.length) return;

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const archiveDir = path.resolve("release-history", stamp);
  if (!archiveDir.startsWith(`${process.cwd()}${path.sep}`)) {
    throw new Error(`Refusing to archive outside project: ${archiveDir}`);
  }
  fs.mkdirSync(archiveDir, { recursive: true });

  for (const installerName of installers) {
    const source = path.join(releaseDir, installerName);
    fs.copyFileSync(source, path.join(archiveDir, installerName));
    const blockMap = `${source}.blockmap`;
    if (fs.existsSync(blockMap)) {
      fs.copyFileSync(blockMap, path.join(archiveDir, path.basename(blockMap)));
    }
    writeChecksum(source, path.join(archiveDir, `${installerName}.sha256.txt`));
  }

  for (const companion of ["latest.yml", "INSTALL-AND-ROLLBACK.txt"]) {
    const source = path.join(releaseDir, companion);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(archiveDir, companion));
  }

  console.log(`[package] Archived previous installer under ${archiveDir}`);
}

function writeReleaseManifest(releaseDir) {
  const installers = fs
    .readdirSync(releaseDir)
    .filter((name) => /^Yamzo POS Setup .+\.exe$/i.test(name));
  for (const installerName of installers) {
    const installerPath = path.join(releaseDir, installerName);
    writeChecksum(installerPath, `${installerPath}.sha256.txt`);
  }

  const instructions = [
    "Yamzo POS store installation and rollback",
    "",
    "Install or upgrade:",
    "1. Close Yamzo POS.",
    "2. Copy the installer and its .sha256.txt file to the store PC.",
    "3. Verify SHA-256, then run the installer. This build is unsigned, so Windows may show an Unknown publisher warning.",
    "4. Launch Yamzo POS. Existing AppData, SQLite, settings, printer configuration, Google tokens, and terminal identity are preserved.",
    "5. Confirm login, Website Connection, printer, KOT, Bill Copy, and diagnostics before enabling Public Live Ordering.",
    "",
    "Rollback:",
    "1. Close Yamzo POS and copy the newest AppData backups folder to a safe location.",
    "2. Uninstall the current application without deleting Yamzo POS AppData.",
    "3. Install the retained previous installer from release-history and verify its SHA-256.",
    "4. If a database migration must be reversed, restore the matching pre-migration SQLite backup only while Yamzo POS is closed.",
    "5. Launch and verify login, orders, inventory, printer, Website Connection, and diagnostics. Keep Public Live Ordering OFF until healthy.",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(releaseDir, "INSTALL-AND-ROLLBACK.txt"), instructions, "utf8");
}

function writeChecksum(sourcePath, targetPath) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex").toUpperCase();
  fs.writeFileSync(targetPath, `${hash} *${path.basename(sourcePath)}\r\n`, "utf8");
}

function run(command, args) {
  const result = runCommand(command, args);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCommand(command, args) {
  if (process.platform !== "win32") {
    return spawnSync(command, args, { stdio: "inherit" });
  }

  // All callers use fixed package-script arguments. Invoking the .cmd file through
  // `call` makes cmd.exe wait for nested npm/npx batch files before returning.
  const commandLine = [command, ...args].join(" ");

  return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `call ${commandLine}`], {
    stdio: "inherit",
  });
}
