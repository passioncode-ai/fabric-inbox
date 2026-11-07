'use strict';
// B-233 (SCN-099): the All Servers window's narrow bridge; every read and every switch is the main process's.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricAll', Object.freeze({
  locale: () => ipcRenderer.invoke('fabric:all-locale'),
  read: () => ipcRenderer.invoke('fabric:all-read'),
  open: (origin, link) => ipcRenderer.invoke('fabric:all-open', { origin, link }),
  signIn: (origin) => ipcRenderer.invoke('fabric:all-sign-in', origin),
}));
