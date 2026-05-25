const path = require("path");
const fs = require("fs");
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  systemPreferences
} = require("electron");
const LyricsService = require("./lyrics-service");
const RoonClient = require("./roon-client");
const Store = require("./store");

let mainWindow;
let galleryWindow;
let lyricsWindow;
let roonClient;
let store;
let lyricsService;
let instanceFilePath;
let saveMainBoundsTimer;
let saveGalleryBoundsTimer;
let saveLyricsBoundsTimer;
let activeLyricsKey = "";
let activeLyrics = { trackKey: "", status: "idle", source: "", lines: [], plainLines: [] };

function currentAlbumKey() {
  return roonClient?.state?.playback?.albumKey || "";
}

function isMainRendererFrame(frame) {
  return Boolean(frame && frame.url === `file://${path.join(__dirname, "../renderer/index.html")}`);
}

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
  const rememberedBounds = store?.getSetting("main.windowBounds", {});
  mainWindow = new BrowserWindow({
    ...(Number.isInteger(rememberedBounds.x) && Number.isInteger(rememberedBounds.y)
      ? { x: rememberedBounds.x, y: rememberedBounds.y }
      : {}),
    width: 720,
    height: 268,
    minWidth: 640,
    minHeight: 248,
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
  mainWindow.on("move", saveMainBounds);
  mainWindow.on("close", () => {
    clearTimeout(saveMainBoundsTimer);
    if (store) {
      store.setSetting("main.windowBounds", mainWindow.getBounds());
    }
  });
  mainWindow.on("closed", () => {
    clearTimeout(saveMainBoundsTimer);
    mainWindow = null;
  });
  mainWindow.webContents.once("did-finish-load", sendLyricsVisibility);
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function sendState(state) {
  const output = stateWithLyrics(state);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("roon:state", output);
  }
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send("roon:state", output);
  }
}

function stateWithLyrics(state) {
  const playback = state?.playback || {};
  const trackKey = lyricsService?.trackKey(playback) || "";
  const lyrics =
    trackKey && activeLyrics.trackKey === trackKey
      ? activeLyrics
      : { trackKey, status: trackKey ? "loading" : "idle", source: "", lines: [], plainLines: [] };
  return {
    ...state,
    playback: {
      ...playback,
      lyricData: lyrics
    }
  };
}

function requestLyrics(state) {
  const playback = state?.playback || {};
  const trackKey = lyricsService.trackKey(playback);
  if (!trackKey) {
    activeLyricsKey = "";
    activeLyrics = { trackKey: "", status: "idle", source: "", lines: [], plainLines: [] };
    return;
  }
  if (trackKey === activeLyricsKey) return;

  activeLyricsKey = trackKey;
  activeLyrics = { trackKey, status: "loading", source: "", lines: [], plainLines: [] };
  lyricsService.resolve(playback).then((lyrics) => {
    if (activeLyricsKey !== trackKey) return;
    activeLyrics = lyrics;
    sendState(roonClient.state);
  });
}

function saveMainBounds() {
  if (!store || !mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(saveMainBoundsTimer);
  saveMainBoundsTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      store.setSetting("main.windowBounds", mainWindow.getBounds());
    }
  }, 150);
}

function sendGalleryItems() {
  if (!galleryWindow || galleryWindow.isDestroyed()) return;
  galleryWindow.webContents.send("gallery:items", store.listMediaItems(currentAlbumKey()));
}

function saveGalleryBounds() {
  if (!galleryWindow || galleryWindow.isDestroyed()) return;
  clearTimeout(saveGalleryBoundsTimer);
  saveGalleryBoundsTimer = setTimeout(() => {
    if (galleryWindow && !galleryWindow.isDestroyed()) {
      store.setSetting("gallery.windowBounds", galleryWindow.getBounds());
    }
  }, 150);
}

function createGalleryWindow() {
  if (galleryWindow && !galleryWindow.isDestroyed()) {
    galleryWindow.show();
    galleryWindow.focus();
    sendGalleryItems();
    return;
  }

  const defaultBounds = { width: 920, height: 620 };
  const bounds = store.getSetting("gallery.windowBounds", defaultBounds);
  galleryWindow = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 460,
    title: "Roon Arts",
    backgroundColor: "#10151b",
    vibrancy: "under-window",
    visualEffectState: "active",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  galleryWindow.on("resize", saveGalleryBounds);
  galleryWindow.on("move", saveGalleryBounds);
  galleryWindow.on("close", () => {
    clearTimeout(saveGalleryBoundsTimer);
    store.setSetting("gallery.windowBounds", galleryWindow.getBounds());
  });
  galleryWindow.on("closed", () => {
    clearTimeout(saveGalleryBoundsTimer);
    galleryWindow = null;
  });
  galleryWindow.webContents.once("did-finish-load", sendGalleryItems);
  galleryWindow.loadFile(path.join(__dirname, "../renderer/gallery.html"));
}

function toggleGalleryWindow() {
  if (galleryWindow && !galleryWindow.isDestroyed()) {
    galleryWindow.close();
    return;
  }

  createGalleryWindow();
}

function defaultLyricsBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 760;
  const height = 124;
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 44),
    width,
    height
  };
}

function saveLyricsBounds() {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
  clearTimeout(saveLyricsBoundsTimer);
  saveLyricsBoundsTimer = setTimeout(() => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      store.setSetting("lyrics.windowBounds", lyricsWindow.getBounds());
    }
  }, 150);
}

function sendLyricsVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const visible = Boolean(lyricsWindow && !lyricsWindow.isDestroyed() && lyricsWindow.isVisible());
  mainWindow.webContents.send("lyrics:visibility", visible);
}

function createLyricsWindow() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) return;
  const bounds = store.getSetting("lyrics.windowBounds", defaultLyricsBounds());
  lyricsWindow = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 90,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "Roon Lyrics",
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lyricsWindow.setAlwaysOnTop(true, "floating");
  lyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lyricsWindow.on("move", saveLyricsBounds);
  lyricsWindow.on("resize", saveLyricsBounds);
  lyricsWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      lyricsWindow.hide();
      store.setSetting("lyrics.visible", false);
      sendLyricsVisibility();
    }
  });
  lyricsWindow.on("closed", () => {
    clearTimeout(saveLyricsBoundsTimer);
    lyricsWindow = null;
  });
  lyricsWindow.webContents.once("did-finish-load", () => {
    sendState(roonClient.state);
    if (store.getSetting("lyrics.visible", true)) {
      lyricsWindow.showInactive();
    }
    sendLyricsVisibility();
  });
  lyricsWindow.loadFile(path.join(__dirname, "../renderer/lyrics.html"));
}

function toggleLyricsWindow() {
  createLyricsWindow();
  if (lyricsWindow.isVisible()) {
    lyricsWindow.hide();
    store.setSetting("lyrics.visible", false);
  } else {
    lyricsWindow.showInactive();
    store.setSetting("lyrics.visible", true);
    sendState(roonClient.state);
  }
  sendLyricsVisibility();
}

async function requestSpectrumInputAccess() {
  if (process.platform !== "darwin") {
    return { granted: true, status: "granted" };
  }

  let status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "not-determined") {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    status = granted ? "granted" : systemPreferences.getMediaAccessStatus("microphone");
  }

  return { granted: status === "granted", status };
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isMainRendererFrame(request.frame)) {
      callback({});
      return;
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 }
      });
      if (!sources.length) {
        callback({});
        return;
      }
      callback({ video: sources[0], audio: "loopback" });
    } catch (error) {
      console.warn("Unable to capture system audio:", error.message);
      callback({});
    }
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return (
      permission === "media" &&
      webContents === mainWindow?.webContents &&
      (!details?.mediaType || details.mediaType === "audio")
    );
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === "display-capture") {
      callback(webContents === mainWindow?.webContents);
      return;
    }
    callback(
      permission === "media" &&
        webContents === mainWindow?.webContents &&
        (!details?.mediaTypes || details.mediaTypes.includes("audio"))
    );
  });
  const userDataPath = app.getPath("userData");
  replacePreviousInstance(userDataPath);

  store = new Store(userDataPath);
  store.init();
  lyricsService = new LyricsService({ store });

  roonClient = new RoonClient({
    serverHost: process.env.ROON_HOST || "192.168.11.100",
    store
  });

  ipcMain.handle("roon:get-state", () => stateWithLyrics(roonClient.state));
  ipcMain.handle("roon:control", (_event, action) => roonClient.control(action));
  ipcMain.handle("spectrum:request-input-access", () => requestSpectrumInputAccess());
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:move-main-by", (_event, deltaX, deltaY) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + Math.round(deltaX), y + Math.round(deltaY), false);
  });
  ipcMain.handle("window:move-gallery-by", (_event, deltaX, deltaY) => {
    if (!galleryWindow || galleryWindow.isDestroyed()) return;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const [x, y] = galleryWindow.getPosition();
    galleryWindow.setPosition(x + Math.round(deltaX), y + Math.round(deltaY), false);
  });
  ipcMain.handle("gallery:toggle", () => toggleGalleryWindow());
  ipcMain.handle("lyrics:toggle", () => toggleLyricsWindow());
  ipcMain.handle("lyrics:hide", () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.hide();
      store.setSetting("lyrics.visible", false);
      sendLyricsVisibility();
    }
  });
  ipcMain.handle("gallery:list", () => store.listMediaItems(currentAlbumKey()));
  ipcMain.handle("gallery:import", async () => {
    const result = await dialog.showOpenDialog(galleryWindow || mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Arts and Documents", extensions: ["jpg", "jpeg", "png", "webp", "gif", "pdf"] }
      ]
    });
    if (result.canceled) return store.listMediaItems(currentAlbumKey());
    const playback = roonClient.state.playback || {};
    const items = store.addMediaFiles(result.filePaths, currentAlbumKey(), playback);
    sendGalleryItems();
    return items;
  });
  ipcMain.handle("gallery:open-item", (_event, filePath) => {
    if (!store.hasMediaFile(filePath, currentAlbumKey())) return "Media item is not in the current album.";
    return shell.openPath(filePath);
  });

  roonClient.on("state", (state) => {
    requestLyrics(state);
    sendState(state);
    sendGalleryItems();
  });
  roonClient.on("library-changed", sendGalleryItems);
  createWindow();
  createLyricsWindow();
  roonClient.start();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", removeInstanceFile);
app.on("before-quit", () => {
  app.isQuitting = true;
});

module.exports = { createWindow };
