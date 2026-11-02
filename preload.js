
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
  login: () => ipcRenderer.invoke('launcher:login'),
  play: () => ipcRenderer.invoke('launcher:play')
});
