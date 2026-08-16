import { app, BrowserWindow, Menu, dialog, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database/connection.js";
import { getDatabasePath } from "./paths.js";
import { registerIpc } from "./ipc.js";
import { startDailyEmailScheduler } from "./services/email.js";
import { acceptWebsiteOrderFromGateway } from "./services/websiteOrderHttpTransport.js";
import { WebsiteOrderConnectionManager } from "./services/websiteOrderConnection.js";
import {
  loadWebsiteTerminalIdentity,
  parseWebsiteTerminalProvisioningCommand,
  provisionWebsiteTerminalIdentity,
  restorePreviousWebsiteTerminalIdentity,
  type WebsiteTerminalCredentialProtector
} from "./services/websiteTerminalCredentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let stopDailyEmailScheduler: (() => void) | null = null;
let websiteOrderConnectionManager: WebsiteOrderConnectionManager | null = null;

const websiteTerminalCredentialProtector: WebsiteTerminalCredentialProtector = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value)
};

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
    show: false,
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

  const focusRenderer = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.focus();
    mainWindow.webContents.focus();
  };

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) {
      return;
    }
    mainWindow.show();
    mainWindow.maximize();
    setImmediate(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!mainWindow.isMaximized()) mainWindow.maximize();
      focusRenderer();
    });
  });
  mainWindow.on("focus", () => {
    mainWindow?.webContents.focus();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

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
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeSmokeProbe({
      ok: true,
      phase: "did-finish-load",
      snapshot,
      window: { maximized: mainWindow.isMaximized(), bounds: mainWindow.getBounds() }
    });
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
    const provisioningCommand = parseWebsiteTerminalProvisioningCommand(process.argv);
    if (provisioningCommand) {
      const result = provisionWebsiteTerminalIdentity({
        terminalCode: provisioningCommand.terminalCode,
        userDataPath: app.getPath("userData"),
        protector: websiteTerminalCredentialProtector,
        rotate: provisioningCommand.rotate
      });
      // The command returns public registration material and paths only. The
      // decrypted private key is never printed, logged, or exposed to preload.
      console.log(JSON.stringify({
        ok: true,
        created: result.created,
        rotated: provisioningCommand.rotate,
        registration: result.identity.registration,
        registrationFilePath: result.registrationFilePath,
        previousCredentialBackupPath: result.previousCredentialBackupPath
      }, null, 2));
      app.quit();
      return;
    }

    const db = openDatabase(getDatabasePath());
    const websiteOrderDependencies = {
      loadTerminalPrivateKey: (terminalCode: string) => loadWebsiteTerminalIdentity({
        terminalCode,
        userDataPath: app.getPath("userData"),
        protector: websiteTerminalCredentialProtector
      }).privateKey,
      rotateTerminalIdentity: (terminalCode: string) => provisionWebsiteTerminalIdentity({
        terminalCode,
        userDataPath: app.getPath("userData"),
        protector: websiteTerminalCredentialProtector,
        rotate: true
      }),
      provisionTerminalIdentity: (terminalCode: string) => provisionWebsiteTerminalIdentity({
        terminalCode,
        userDataPath: app.getPath("userData"),
        protector: websiteTerminalCredentialProtector,
        rotate: false
      }),
      restorePreviousTerminalIdentity: (terminalCode: string, backupPath: string) => {
        restorePreviousWebsiteTerminalIdentity({
          terminalCode,
          userDataPath: app.getPath("userData"),
          protector: websiteTerminalCredentialProtector,
          previousCredentialBackupPath: backupPath
        });
      }
    };
    websiteOrderConnectionManager = new WebsiteOrderConnectionManager(db, {
      ...websiteOrderDependencies,
      onStatusChanged: (status) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("websiteConnection:statusChanged", status);
        }
      },
      onOrdersChanged: () => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("websiteOrders:changed");
        }
      }
    });
    registerIpc(db, {
      acceptWebsiteOrder: (remoteId, expectedVersion) => acceptWebsiteOrderFromGateway(
        db,
        websiteOrderDependencies,
        remoteId,
        expectedVersion
      ),
      websiteConnection: websiteOrderConnectionManager
    });
    stopDailyEmailScheduler = startDailyEmailScheduler(db);
    await createWindow();
    websiteOrderConnectionManager.start();
  })
  .catch(logStartupError);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopDailyEmailScheduler?.();
  stopDailyEmailScheduler = null;
  websiteOrderConnectionManager?.stop();
  websiteOrderConnectionManager = null;
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
