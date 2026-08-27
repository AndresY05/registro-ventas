const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
  webSearch: (query) => ipcRenderer.invoke('web:search', query),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  aiTest: (payload) => ipcRenderer.invoke('ai:test', payload),
  ollamaStatus: (payload) => ipcRenderer.invoke('ollama:status', payload),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  wakeSelf: () => ipcRenderer.send('jarvis:wake-self'),
  onWake: (cb) => ipcRenderer.on('app:wake', () => cb()),
  onOmniStatus: (cb) => ipcRenderer.on('app:status', (_e, data) => cb(data))
});
