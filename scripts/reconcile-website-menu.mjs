import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const apply = process.argv.includes("--apply");
const defaultDatabasePath = process.env.YAMZO_APP_DATA_DIR
  ? path.join(process.env.YAMZO_APP_DATA_DIR, "yamzo-pos.sqlite3")
  : path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "yamzo-pos",
      "local-data",
      "yamzo-pos.sqlite3"
    );
const databasePath = path.resolve(
  argumentValue("--database=") ?? defaultDatabasePath
);
const contractPath = path.resolve(
  argumentValue("--contract=") ?? "resources/website-menu-contract.json"
);

if (!fs.existsSync(databasePath)) throw new Error(`POS database not found: ${databasePath}`);
if (!fs.existsSync(contractPath)) throw new Error(`Website menu contract not found: ${contractPath}`);

const contractModule = await import(pathToFileURL(
  path.join(process.cwd(), "dist-electron", "main", "domain", "websiteMenuContract.js")
));
const contract = contractModule.parseWebsiteMenuContract(
  JSON.parse(fs.readFileSync(contractPath, "utf8"))
);

if (!apply) {
  const db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    const report = contractModule.inspectWebsiteMenuContract(db, contract);
    console.log(JSON.stringify({ mode: "dry-run", databasePath, contractPath, report }, null, 2));
    if (!report.canApply) process.exitCode = 2;
  } finally {
    db.close();
  }
} else {
  const connectionModule = await import(pathToFileURL(
    path.join(process.cwd(), "dist-electron", "main", "database", "connection.js")
  ));
  const db = connectionModule.openDatabase(databasePath);
  try {
    const report = contractModule.inspectWebsiteMenuContract(db, contract);
    if (!report.canApply) {
      console.log(JSON.stringify({ mode: "apply-blocked", databasePath, contractPath, report }, null, 2));
      process.exitCode = 2;
    } else {
      const backupPath = createBackup(db, databasePath);
      const applied = contractModule.applyWebsiteMenuContract(db, contract);
      console.log(JSON.stringify({
        mode: "applied",
        databasePath,
        contractPath,
        backupPath,
        report: applied
      }, null, 2));
    }
  } finally {
    db.close();
  }
}

function argumentValue(prefix) {
  const matches = process.argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`Specify ${prefix} only once.`);
  return matches[0]?.slice(prefix.length) || null;
}

function createBackup(db, sourcePath) {
  const backupDirectory = path.join(path.dirname(sourcePath), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.Z]/g, "").replace("T", "-");
  let backupPath = path.join(backupDirectory, `yamzo-pos-pre-website-menu-${timestamp}.sqlite3`);
  let suffix = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(backupDirectory, `yamzo-pos-pre-website-menu-${timestamp}-${suffix}.sqlite3`);
    suffix += 1;
  }
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  return backupPath;
}
