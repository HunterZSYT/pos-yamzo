import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv.includes("--installer") ? "installer" : "dir";

run("npm", ["run", "clean:release"]);
run("npm", ["run", "build"]);
run("npx", ["electron-rebuild", "-f", "-w", "better-sqlite3"]);

const normalArgs = mode === "installer" ? ["electron-builder"] : ["electron-builder", "--dir"];
const normal = spawnSync("npx", normalArgs, { stdio: "inherit", shell: true });

if (normal.status === 0) {
  run("npm", ["rebuild", "better-sqlite3"]);
  run("node", ["scripts/clear-runtime-order-data.mjs"]);
  process.exit(0);
}

const extractedElectron = path.resolve("release", "win-unpacked.tmp");
if (!fs.existsSync(path.join(extractedElectron, "electron.exe"))) {
  run("npm", ["rebuild", "better-sqlite3"]);
  process.exit(normal.status ?? 1);
}

console.warn("[package] Normal electron-builder packaging failed. Retrying with extracted Electron fallback.");
fs.rmSync(path.resolve("release-packaged"), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
const fallbackArgs =
  mode === "installer"
    ? ["electron-builder", "--config", "electron-builder.packaging-fallback.yml"]
    : ["electron-builder", "--dir", "--config", "electron-builder.packaging-fallback.yml"];
const fallback = spawnSync("npx", fallbackArgs, { stdio: "inherit", shell: true });
run("npm", ["rebuild", "better-sqlite3"]);
run("node", ["scripts/clear-runtime-order-data.mjs"]);
process.exit(fallback.status ?? 1);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
