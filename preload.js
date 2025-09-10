const { contextBridge, ipcRenderer } = require("electron");




contextBridge.exposeInMainWorld("ipcRenderer", {
    sendSync: (channel, data) => ipcRenderer.sendSync(channel, data),
    invoke: (channel, data) => ipcRenderer.invoke(channel, data), // async IPC
    on: (channel, listener) => ipcRenderer.on(channel, listener)  // event listener
  })
