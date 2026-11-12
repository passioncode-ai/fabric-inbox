'use strict';
// B-244 D-4 (SCN-099): the Rename Server window's narrow bridge; the name is saved by the main process (servers.cjs).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricRename', Object.freeze({
  locale: () => ipcRenderer.invoke('fabric:rename-locale'),
  // { host, label, max }: the server being renamed, the name it has now ('' for none) and the longest name kept.
  state: () => ipcRenderer.invoke('fabric:rename-state'),
  save: (label) => ipcRenderer.invoke('fabric:rename-save', String(label)),
  close: () => ipcRenderer.invoke('fabric:rename-close'),
}));
