'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricSetup', Object.freeze({
  state: () => ipcRenderer.invoke('fabric:setup-state'),
  save: (origin, accessOrigin) => ipcRenderer.invoke('fabric:setup-save', { origin, accessOrigin }),
  retry: () => ipcRenderer.invoke('fabric:setup-retry'),
  openFile: () => ipcRenderer.invoke('fabric:setup-open-file'),
  connect: (id) => ipcRenderer.invoke('fabric:setup-connect', id),
  // Creating a server in the person's own Cloudflare account (CF-5).
  cloudflare: Object.freeze({
    intro: () => ipcRenderer.invoke('fabric:cf-intro'),
    openTokenPage: () => ipcRenderer.invoke('fabric:cf-open-token-page'),
    check: (token) => ipcRenderer.invoke('fabric:cf-check', token),
    inspect: (accountId) => ipcRenderer.invoke('fabric:cf-inspect', accountId),
    deploy: (input) => ipcRenderer.invoke('fabric:cf-deploy', input),
    onStep: (callback) => {
      const listener = (_event, step) => callback({ id: String(step.id), label: String(step.label), outcome: String(step.outcome), detail: String(step.detail) });
      ipcRenderer.on('fabric:cf-step', listener);
      return () => ipcRenderer.removeListener('fabric:cf-step', listener);
    },
  }),
}));
