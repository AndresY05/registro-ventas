const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  exportCSV: (filename, content) => ipcRenderer.invoke('export:csv', { filename, content }),
  exportBackup: (filename, content) => ipcRenderer.invoke('export:backup', { filename, content }),
  importBackup: () => ipcRenderer.invoke('import:backup')
});
