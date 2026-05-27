const path = require("path");
const fs = require("fs");
const {
  app,
  BrowserWindow,
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
let detailWindowMode = "";
let latestSpectrumSnapshot = { trackKey: "", status: "WAITING PCM", frames: [] };
let pendingSpectrumFrames = new Map();
let spectrumFlushTimer;
let lastMainCoverAlbumKey;
let lastMainCoverDataUrl;
let lastGalleryAlbumKey = "";

function spectrumTrackKeyFor(playback = {}) {
  if (!playback.title || playback.state === "idle") return "";
  return [
    playback.title || "",
    playback.artist || "",
    playback.album || "",
    Math.round(playback.length || 0)
  ].join("|");
}

function currentAlbumKey() {
  return roonClient?.state?.playback?.albumKey || "";
}

function waitForProcessExit(pid, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          resolve();
          return;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

async function replacePreviousInstance(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  instanceFilePath = path.join(userDataPath, "roon-monitor.pid");

  try {
    const previousPid = Number(fs.readFileSync(instanceFilePath, "utf8").trim());
    if (Number.isInteger(previousPid) && previousPid > 0 && previousPid !== process.pid) {
      process.kill(previousPid, "SIGTERM");
      await waitForProcessExit(previousPid);
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
    const playback = output.playback || {};
    const coverChanged =
      playback.albumKey !== lastMainCoverAlbumKey ||
      playback.imageDataUrl !== lastMainCoverDataUrl;
    lastMainCoverAlbumKey = playback.albumKey;
    lastMainCoverDataUrl = playback.imageDataUrl;
    mainWindow.webContents.send(
      "roon:state",
      coverChanged
        ? output
        : {
            ...output,
            playback: {
              ...playback,
              imageDataUrl: undefined,
              imageUnchanged: true
            }
          }
    );
  }
  const lightweightOutput = {
    ...output,
    playback: {
      ...output.playback,
      imageDataUrl: undefined
    }
  };
  if (
    galleryWindow &&
    !galleryWindow.isDestroyed() &&
    (detailWindowMode === "info" || detailWindowMode === "spectrum")
  ) {
    galleryWindow.webContents.send("roon:state", lightweightOutput);
  }
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send("roon:state", lightweightOutput);
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
      spectrumKey: spectrumTrackKeyFor(playback),
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

function sendGalleryItems(force = false) {
  if (!galleryWindow || galleryWindow.isDestroyed() || detailWindowMode !== "gallery") return;
  const albumKey = currentAlbumKey();
  if (!force && lastGalleryAlbumKey === albumKey) return;
  lastGalleryAlbumKey = albumKey;
  galleryWindow.webContents.send("gallery:items", store.listMediaItems(albumKey));
}

function sendSpectrumContent() {
  if (!galleryWindow || galleryWindow.isDestroyed() || detailWindowMode !== "spectrum") return;
  const state = stateWithLyrics(roonClient.state);
  galleryWindow.webContents.send("roon:state", {
    ...state,
    playback: { ...state.playback, imageDataUrl: undefined }
  });
  galleryWindow.webContents.send("spectrum:snapshot", latestSpectrumSnapshot);
}

function sendInfoContent() {
  if (!galleryWindow || galleryWindow.isDestroyed() || detailWindowMode !== "info") return;
  const state = stateWithLyrics(roonClient.state);
  galleryWindow.webContents.send("roon:state", {
    ...state,
    playback: { ...state.playback, imageDataUrl: undefined }
  });
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

function loadDetailWindow(mode) {
  const title = mode === "spectrum" ? "Roon Spectrum" : mode === "info" ? "Roon Playing" : "Roon Arts";
  const fileName = mode === "spectrum" ? "spectrum.html" : mode === "info" ? "info.html" : "gallery.html";
  const sendContent =
    mode === "spectrum"
      ? sendSpectrumContent
      : mode === "info"
        ? sendInfoContent
        : () => sendGalleryItems(true);
  detailWindowMode = mode;
  galleryWindow.setTitle(title);
  galleryWindow.webContents.once("did-finish-load", sendContent);
  galleryWindow.loadFile(path.join(__dirname, `../renderer/${fileName}`));
}

function createGalleryWindow(mode) {
  if (galleryWindow && !galleryWindow.isDestroyed()) {
    galleryWindow.show();
    galleryWindow.focus();
    if (mode !== detailWindowMode) {
      loadDetailWindow(mode);
    } else if (mode === "spectrum") {
      sendSpectrumContent();
    } else if (mode === "info") {
      sendInfoContent();
    } else {
      sendGalleryItems(true);
    }
    return;
  }

  const defaultBounds = { width: 920, height: 620 };
  const bounds = store.getSetting("gallery.windowBounds", defaultBounds);
  galleryWindow = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 460,
    title: mode === "spectrum" ? "Roon Spectrum" : mode === "info" ? "Roon Playing" : "Roon Arts",
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
    detailWindowMode = "";
  });
  loadDetailWindow(mode);
}

function toggleDetailWindow(mode, spectrumSnapshot) {
  if (mode === "spectrum" && spectrumSnapshot) {
    latestSpectrumSnapshot = spectrumSnapshot;
  }

  if (galleryWindow && !galleryWindow.isDestroyed()) {
    if (detailWindowMode === mode) {
      galleryWindow.close();
    } else {
      createGalleryWindow(mode);
    }
    return;
  }

  createGalleryWindow(mode);
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

function flushSpectrumFrames() {
  clearTimeout(spectrumFlushTimer);
  spectrumFlushTimer = null;
  if (!store || !pendingSpectrumFrames.size) return;
  const groups = new Map();
  for (const { trackKey, frame } of pendingSpectrumFrames.values()) {
    if (!groups.has(trackKey)) groups.set(trackKey, []);
    groups.get(trackKey).push(frame);
  }
  pendingSpectrumFrames = new Map();
  for (const [trackKey, frames] of groups) {
    store.saveSpectrumFrames(trackKey, frames);
  }
}

function queueSpectrumFrame(trackKey, frame) {
  const bucket = Math.max(0, Math.floor(Number(frame.position) * 10));
  pendingSpectrumFrames.set(`${trackKey}|${bucket}`, { trackKey, frame });
  if (!spectrumFlushTimer) {
    spectrumFlushTimer = setTimeout(flushSpectrumFrames, 400);
  }
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return (
      permission === "media" &&
      webContents === mainWindow?.webContents &&
      (!details?.mediaType || details.mediaType === "audio")
    );
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      permission === "media" &&
        webContents === mainWindow?.webContents &&
        (!details?.mediaTypes || details.mediaTypes.includes("audio"))
    );
  });
  const userDataPath = app.getPath("userData");
  await replacePreviousInstance(userDataPath);

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
  ipcMain.handle("spectrum:list-frames", (_event, trackKey) => store.listSpectrumFrames(trackKey));
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.on("window:move-main-by", (_event, deltaX, deltaY) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + Math.round(deltaX), y + Math.round(deltaY), false);
  });
  ipcMain.on("window:move-gallery-by", (_event, deltaX, deltaY) => {
    if (!galleryWindow || galleryWindow.isDestroyed()) return;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const [x, y] = galleryWindow.getPosition();
    galleryWindow.setPosition(x + Math.round(deltaX), y + Math.round(deltaY), false);
  });
  ipcMain.handle("gallery:toggle", () => toggleDetailWindow("gallery"));
  ipcMain.handle("info:toggle", () => toggleDetailWindow("info"));
  ipcMain.handle("spectrum:toggle", (_event, snapshot) => toggleDetailWindow("spectrum", snapshot));
  ipcMain.on("spectrum:frame", (event, frame) => {
    if (event.sender !== mainWindow?.webContents) return;
    const trackKey = spectrumTrackKeyFor(roonClient.state.playback);
    if (trackKey && frame?.trackKey === trackKey) {
      queueSpectrumFrame(trackKey, frame);
    }
    if (galleryWindow && !galleryWindow.isDestroyed() && detailWindowMode === "spectrum") {
      galleryWindow.webContents.send("spectrum:frame", frame);
    }
  });
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
    sendGalleryItems(true);
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
  roonClient.on("library-changed", () => sendGalleryItems(true));
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
  flushSpectrumFrames();
  app.isQuitting = true;
});

module.exports = { createWindow };
