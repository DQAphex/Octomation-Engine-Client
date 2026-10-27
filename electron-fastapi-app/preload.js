const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: () => process.versions.electron,
  stopFastAPI: () => ipcRenderer.invoke('stop-fastapi'),
  restartFastAPI: () => ipcRenderer.invoke('restart-fastapi'),
  getFastApiPort: () => ipcRenderer.invoke('get-fastapi-port'),
  getAvailablePlugins: () => ipcRenderer.invoke('get-available-plugins'),
  downloadPlugin: (pluginId) => ipcRenderer.invoke('download-plugin', pluginId),
  onPortUpdate: (callback) => {
    ipcRenderer.removeAllListeners('fastapi-port');
    ipcRenderer.on('fastapi-port', (_event, port) => callback(port));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.removeAllListeners('fastapi-status');
    ipcRenderer.on('fastapi-status', (_event, status) => callback(status));
  },
  onPidUpdate: (callback) => {
    ipcRenderer.removeAllListeners('fastapi-pid');
    ipcRenderer.on('fastapi-pid', (_event, pid) => callback(pid));
  }
});
