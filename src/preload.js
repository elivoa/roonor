const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roonMonitor", {
  getState: () => ipcRenderer.invoke("roon:get-state"),
  control: (action) => ipcRenderer.invoke("roon:control", action),
  requestSpectrumInputAccess: () => ipcRenderer.invoke("spectrum:request-input-access"),
  close: () => ipcRenderer.invoke("window:close"),
  moveMainWindowBy: (deltaX, deltaY) =>
    ipcRenderer.invoke("window:move-main-by", deltaX, deltaY),
  moveGalleryWindowBy: (deltaX, deltaY) =>
    ipcRenderer.invoke("window:move-gallery-by", deltaX, deltaY),
  toggleGallery: () => ipcRenderer.invoke("gallery:toggle"),
  toggleLyrics: () => ipcRenderer.invoke("lyrics:toggle"),
  hideLyrics: () => ipcRenderer.invoke("lyrics:hide"),
  listGalleryItems: () => ipcRenderer.invoke("gallery:list"),
  importGalleryItems: () => ipcRenderer.invoke("gallery:import"),
  openGalleryItem: (filePath) => ipcRenderer.invoke("gallery:open-item", filePath),
  onGalleryItems: (callback) => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on("gallery:items", listener);
    return () => ipcRenderer.removeListener("gallery:items", listener);
  },
  onSpectrumFrame: (callback) => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on("spectrum:frame", listener);
    return () => ipcRenderer.removeListener("spectrum:frame", listener);
  },
  onLyricsVisibility: (callback) => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on("lyrics:visibility", listener);
    return () => ipcRenderer.removeListener("lyrics:visibility", listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("roon:state", listener);
    return () => ipcRenderer.removeListener("roon:state", listener);
  }
});
