import { app, BrowserWindow, Menu, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database/connection.js";
import { getDatabasePath } from "./paths.js";
import { registerIpc } from "./ipc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

if (process.env.YAMZO_APP_DATA_DIR) {
  app.setPath("userData", process.env.YAMZO_APP_DATA_DIR);
}

function logStartupError(error: unknown): void {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  const logPath = path.join(app.getPath("userData"), "startup-error.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}]\n${message}\n\n`);
  dialog.showErrorBox("Yamzo POS startup error", `${message}\n\nLog: ${logPath}`);
}

function writeSmokeProbe(payload: Record<string, unknown>): void {
  const probePath = process.env.YAMZO_SMOKE_PROBE;
  if (!probePath) {
    return;
  }

  fs.mkdirSync(path.dirname(probePath), { recursive: true });
  fs.writeFileSync(probePath, JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2));
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 720,
    fullscreen: false,
    autoHideMenuBar: true,
    title: "Yamzo POS",
    icon: path.join(__dirname, "../../resources/icons/yamzo.ico"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.maximize();

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeSmokeProbe({
      ok: false,
      phase: "did-fail-load",
      errorCode,
      errorDescription,
      validatedURL
    });
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    if (!process.env.YAMZO_SMOKE_PROBE || !mainWindow) {
      return;
    }

    const snapshot = await mainWindow.webContents.executeJavaScript(`
      ({
        title: document.title,
        bodyText: document.body.innerText,
        hasRootContent: Boolean(document.getElementById('root')?.textContent?.trim()),
        href: location.href
      })
    `);
    writeSmokeProbe({ ok: true, phase: "did-finish-load", snapshot });
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(__dirname, "../../dist/index.html");
    await mainWindow.loadFile(indexPath);
  }
}

process.on("uncaughtException", logStartupError);
process.on("unhandledRejection", logStartupError);

app.whenReady()
  .then(async () => {
    Menu.setApplicationMenu(null);
    const db = openDatabase(getDatabasePath());
    registerIpc(db);
    await createWindow();
  })
  .catch(logStartupError);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
