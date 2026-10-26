// Narrow API, never expose ipcRenderer or arbitrary filesystem access.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("prbotDesktop", Object.freeze({
  chooseWorkspace: () => ipcRenderer.invoke("prbot:choose-workspace"),
}));
