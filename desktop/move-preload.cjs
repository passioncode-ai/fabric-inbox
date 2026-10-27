'use strict';
// B-158 M1 step 3d (SCN-094): the move window's narrow bridge; every effect is the main process's (desktop/move.cjs).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricMove', Object.freeze({
  locale: () => ipcRenderer.invoke('fabric:move-locale'),
  state: () => ipcRenderer.invoke('fabric:move-state'),
  preview: (address) => ipcRenderer.invoke('fabric:move-preview', address),
  start: (address, to) => ipcRenderer.invoke('fabric:move-start', { address, to }),
  continue: () => ipcRenderer.invoke('fabric:move-continue'),
  waitLonger: () => ipcRenderer.invoke('fabric:move-wait'),
  putBack: () => ipcRenderer.invoke('fabric:move-back'),
  chooseAgent: () => ipcRenderer.invoke('fabric:move-agent'),
  showTarget: () => ipcRenderer.invoke('fabric:move-show-target'),
  dismiss: () => ipcRenderer.invoke('fabric:move-dismiss'),
  onProgress: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('fabric:move-progress', listener);
    return () => ipcRenderer.removeListener('fabric:move-progress', listener);
  },
}));
