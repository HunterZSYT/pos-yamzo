import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv.includes("--installer") ? "installer" : "dir";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

run(npmCommand, ["run", "clean:release"]);
run(npmCommand, ["run", "build"]);
run(npxCommand, ["electron-rebuild", "-f", "-w", "better-sqlite3"]);

const normalArgs = mode === "installer" ? ["electron-builder"] : ["electron-builder", "--dir"];
const normal = runCommand(npxCommand, normalArgs);

if (normal.status === 0) {
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
run(npmCommand, ["rebuild", "better-sqlite3"]);
process.exit(fallback.status ?? 1);

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
