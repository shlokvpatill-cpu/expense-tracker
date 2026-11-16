'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('canteenDesktop', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: json => ipcRenderer.invoke('state:save', json),
  putFile: (id, bytes) => ipcRenderer.invoke('file:put', id, bytes),
  getFile: id => ipcRenderer.invoke('file:get', id),
  deleteFile: id => ipcRenderer.invoke('file:delete', id),
  clearFiles: () => ipcRenderer.invoke('file:clear'),
  dataPath: () => ipcRenderer.invoke('data:path'),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  setTheme: theme => ipcRenderer.invoke('theme:set', theme),
  loadCloud: () => ipcRenderer.invoke('cloud:load'),
  saveCloud: json => ipcRenderer.invoke('cloud:save', json),
  excelDefault: () => ipcRenderer.invoke('excel:default'),
  writeExcel: (file, bytes) => ipcRenderer.invoke('excel:write', file, bytes),
  chooseExcel: current => ipcRenderer.invoke('excel:choose', current),
  openExcel: file => ipcRenderer.invoke('excel:open', file)
});
