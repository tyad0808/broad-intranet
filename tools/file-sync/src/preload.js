// 창(화면)에서 쓸 수 있는 기능만 골라서 연다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: patch => ipcRenderer.invoke('save-config', patch),
  chooseFolder: current => ipcRenderer.invoke('choose-folder', current),
  testSource: dir => ipcRenderer.invoke('test-source', dir),
  openFile: id => ipcRenderer.invoke('open-file', id),
  showInFolder: id => ipcRenderer.invoke('show-in-folder', id),
  openDest: () => ipcRenderer.invoke('open-dest'),
  markSeen: id => ipcRenderer.invoke('mark-seen', id),
  markDone: (id, done) => ipcRenderer.invoke('mark-done', id, done),
  checkNow: () => ipcRenderer.invoke('check-now'),
  togglePause: () => ipcRenderer.invoke('toggle-pause'),
  importAll: () => ipcRenderer.invoke('import-all'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  onChime: cb => ipcRenderer.on('chime', (_e, o) => cb(o)),
});
