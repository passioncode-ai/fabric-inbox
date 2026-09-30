'use strict';
// The mail window loads the configured server. It gets exactly one capability:
// reading (once) the setup chosen in the first-run window. main.cjs answers only
// the configured origin's main frame (policy.isMailSender).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricDesktop', Object.freeze({
  pendingSetup: () => ipcRenderer.invoke('fabric:pending-setup'),
  pendingSetupDone: () => ipcRenderer.invoke('fabric:pending-setup-done'),
}));
