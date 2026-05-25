const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const RoonClient = require("./roon-client");
const Store = require("./store");

let mainWindow;
let roonClient;
let instanceFilePath;

function replacePreviousInstance(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  instanceFilePath = path.join(userDataPath, "roon-monitor.pid");

  try {
    const previousPid = Number(fs.readFileSync(instanceFilePath, "utf8").trim());
    if (Number.isInteger(previousPid) && previousPid > 0 && previousPid !== process.pid) {
      process.kill(previousPid, "SIGTERM");
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") {
      console.warn("Unable to close previous instance:", error.message);
    }
  }

  fs.writeFileSync(instanceFilePath, String(process.pid));
}

function removeInstanceFile() {
  if (!instanceFilePath) return;

  try {
    const pid = fs.readFileSync(instanceFilePath, "utf8").trim();
    if (pid === String(process.pid)) {
      fs.rmSync(instanceFilePath, { force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Unable to remove instance file:", error.message);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 248,
    minWidth: 640,
    minHeight: 228,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Roon Monitor",
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function sendState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("roon:state", state);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const userDataPath = app.getPath("userData");
  replacePreviousInstance(userDataPath);

  const store = new Store(userDataPath);
  store.init();

  roonClient = new RoonClient({
    serverHost: process.env.ROON_HOST || "192.168.11.100",
    store
  });

  ipcMain.handle("roon:get-state", () => roonClient.state);
  ipcMain.handle("roon:control", (_event, action) => roonClient.control(action));
  ipcMain.handle("window:close", () => mainWindow?.close());

  roonClient.on("state", sendState);
  createWindow();
  roonClient.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", removeInstanceFile);

module.exports = { createWindow };
