import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.homedir(), "AppData", "Roaming", "yamzo-pos", "local-data", "yamzo-pos.sqlite3");

if (!fs.existsSync(dbPath)) {
  console.log(`[cleanup] Runtime database not found: ${dbPath}`);
  process.exit(0);
}

console.error("[cleanup] Order deletion is disabled. This utility no longer changes order data.");
process.exitCode = 1;
