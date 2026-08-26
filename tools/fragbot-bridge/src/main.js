import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, shell } from "electron";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { Logger } from "./lib/logger.js";
import { SettingsStore } from "./lib/settings.js";
import { MeldClient } from "./bridge/meld-client.js";
import { CommandRouter, CAPABILITIES } from "./bridge/command-router.js";
import { CloudClient } from "./bridge/cloud-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const BRIDGE_VERSION = packageJson.version;
const API_BASE = process.env.FRAGBOT_API_BASE || "https://fragbot.tech";

let windowRef = null;
let tray = null;
let logger, settings, meldClient, cloudClient;

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else app.on("second-instance", () => showWindow());

app.whenReady().then(() => {
  logger = new Logger(path.join(app.getPath("userData"), "logs"));
  settings = new SettingsStore({ userDataDir: app.getPath("userData"), safeStorage });
  meldClient = new MeldClient({ logger });
  const commandRouter = new CommandRouter({ meldClient, logger });
  cloudClient = new CloudClient({ logger, settings, meldClient, commandRouter, bridgeVersion: BRIDGE_VERSION, apiBase: API_BASE });

  createWindow();
  createTray();
  wireState();
  meldClient.start();
  cloudClient.start();
  logger.info("FRAGBOT Bridge started", { version: BRIDGE_VERSION, deviceId: settings.deviceId, hostname: os.hostname() });
});

app.on("window-all-closed", event => event?.preventDefault?.());
app.on("before-quit", () => {
  app.isQuitting = true;
  meldClient?.stop();
  cloudClient?.stop();
});

function createWindow() {
  windowRef = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 650,
    minHeight: 500,
    title: "FRAGBOT Bridge",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowRef.setMenuBarVisibility(false);
  windowRef.loadFile(path.join(__dirname, "renderer", "index.html"));
  windowRef.on("close", event => {
    if (!app.isQuitting) {
      event.preventDefault();
      windowRef.hide();
    }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("FRAGBOT Bridge");
  tray.on("double-click", showWindow);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const state = getState();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.cloudConnected ? "FRAGBOT: Connected" : "FRAGBOT: Disconnected", enabled: false },
    { label: state.meld.connected ? "Meld: Connected" : "Meld: Disconnected", enabled: false },
    { type: "separator" },
    { label: "Open FRAGBOT Bridge", click: showWindow },
    { label: "Open fragbot.tech/meld", click: () => shell.openExternal("https://fragbot.tech/meld") },
    { type: "separator" },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { label: "Reconnect Meld", click: () => meldClient.reconnectNow() },
    { label: "Reconnect FRAGBOT", click: () => cloudClient.reconnectNow() },
    { type: "separator" },
    { label: "Exit", click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function showWindow() {
  if (!windowRef) return;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.show();
  windowRef.focus();
}

function wireState() {
  const push = () => {
    const state = getState();
    rebuildTrayMenu();
    windowRef?.webContents?.send("bridge:state", state);
  };
  meldClient.on("connected", push);
  meldClient.on("disconnected", push);
  meldClient.on("status", push);
  cloudClient.on("connection", push);
  cloudClient.on("pairing", push);
  logger.onLine(line => windowRef?.webContents?.send("bridge:log", line));
}

function getState() {
  return {
    version: BRIDGE_VERSION,
    deviceId: settings?.deviceId || null,
    deviceName: os.hostname(),
    paired: settings?.paired || false,
    account: settings?.account || null,
    cloudConnected: cloudClient?.connected || false,
    meld: meldClient?.getStatus?.() || { connected: false },
    resources: meldClient?.getResources?.() || { scenes: [], layers: [], tracks: [], effects: [] },
    capabilities: CAPABILITIES,
    autoStart: app.getLoginItemSettings().openAtLogin
  };
}

ipcMain.handle("bridge:get-state", () => getState());
ipcMain.handle("bridge:pair", async (_event, code) => {
  try { return { ok: true, result: await cloudClient.pair(code) }; }
  catch (err) {
    logger.warn("Pairing failed", { code: err.code, error: err.message });
    return { ok: false, error: { code: err.code || "PAIR_FAILED", message: err.message } };
  }
});
ipcMain.handle("bridge:unpair", () => { cloudClient.unpair(); return { ok: true }; });
ipcMain.handle("bridge:reconnect-meld", () => { meldClient.reconnectNow(); return { ok: true }; });
ipcMain.handle("bridge:reconnect-cloud", () => { cloudClient.reconnectNow(); return { ok: true }; });
ipcMain.handle("bridge:set-autostart", (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  rebuildTrayMenu();
  return { ok: true, enabled };
});
ipcMain.handle("bridge:open-dashboard", () => { shell.openExternal("https://fragbot.tech/meld"); return { ok: true }; });
