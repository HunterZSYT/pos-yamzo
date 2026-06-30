import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appData = process.env.YAMZO_APP_DATA_DIR
  ? process.env.YAMZO_APP_DATA_DIR
  : path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Yamzo POS");
const databasePath = path.join(appData, "local-data", "yamzo-pos.sqlite3");
const csvPath = process.argv[2] ?? path.join(process.cwd(), "recipes_item_level_only.csv");

const connectionModule = await import(pathToFileURL(path.join(process.cwd(), "dist-electron", "main", "database", "connection.js")));
const inventoryModule = await import(pathToFileURL(path.join(process.cwd(), "dist-electron", "main", "domain", "inventory.js")));

const db = connectionModule.openDatabase(databasePath);
try {
  const result = inventoryModule.importRecipeInventoryCsv(db, csvPath, "admin");
  console.log(JSON.stringify({ databasePath, csvPath, result }, null, 2));
} finally {
  db.close();
}
