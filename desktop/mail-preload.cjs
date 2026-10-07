'use strict';
// The mail window loads the configured server. It gets exactly three capabilities: reading (once)
// the setup chosen in the first-run window, hearing that the Mac woke from sleep so it can read new
// mail at once (P1-4), and reading and setting this Mac's interface language (L10N-01), so the
// app's menus and windows follow Settings → App → Language. main.cjs answers only the configured
// origin's main frame (policy.isMailSender) and sends the wake signal only to the mail window.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricDesktop', Object.freeze({
  pendingSetup: () => ipcRenderer.invoke('fabric:pending-setup'),
  pendingSetupDone: () => ipcRenderer.invoke('fabric:pending-setup-done'),
  // "system", "en" or "ru"; anything else is kept as "system" (desktop/i18n.cjs).
  locale: () => ipcRenderer.invoke('fabric:locale'),
  setLocale: (choice) => ipcRenderer.invoke('fabric:locale-set', String(choice)),
  // Receive-only: the page passes a callback and gets back its unsubscribe; no data crosses.
  onResume: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('fabric:resumed', listener);
    return () => ipcRenderer.removeListener('fabric:resumed', listener);
  },
}));
