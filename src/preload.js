const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roonMonitor", {
  getState: () => ipcRenderer.invoke("roon:get-state"),
  control: (action) => ipcRenderer.invoke("roon:control", action),
  close: () => ipcRenderer.invoke("window:close"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("roon:state", listener);
    return () => ipcRenderer.removeListener("roon:state", listener);
  }
});
