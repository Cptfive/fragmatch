import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fragbotBridge", {
  getState: () => ipcRenderer.invoke("bridge:get-state"),
  pair: code => ipcRenderer.invoke("bridge:pair", code),
  unpair: () => ipcRenderer.invoke("bridge:unpair"),
  reconnectMeld: () => ipcRenderer.invoke("bridge:reconnect-meld"),
  reconnectCloud: () => ipcRenderer.invoke("bridge:reconnect-cloud"),
  setAutoStart: enabled => ipcRenderer.invoke("bridge:set-autostart", Boolean(enabled)),
  openDashboard: () => ipcRenderer.invoke("bridge:open-dashboard"),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("bridge:state", listener);
    return () => ipcRenderer.removeListener("bridge:state", listener);
  },
  onLog: callback => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on("bridge:log", listener);
    return () => ipcRenderer.removeListener("bridge:log", listener);
  }
});
