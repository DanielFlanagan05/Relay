const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("relay", {
  call: async (name, input = {}) => {
    const result = await ipcRenderer.invoke("relay:action", name, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  subscribe: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("relay:changed", listener);
    return () => ipcRenderer.removeListener("relay:changed", listener);
  },
});
