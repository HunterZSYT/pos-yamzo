import { app } from "electron";
import path from "node:path";

export function getAppDataDir(): string {
  const configured = process.env.YAMZO_APP_DATA_DIR;
  if (configured && configured.trim()) {
    return configured;
  }

  return path.join(app.getPath("userData"), "local-data");
}

export function getDatabasePath(): string {
  return path.join(getAppDataDir(), "yamzo-pos.sqlite3");
}
