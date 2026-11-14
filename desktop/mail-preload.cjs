'use strict';
// The mail window holds a page per server (B-244). Each page gets these capabilities only: reading (once)
// the setup chosen in the first-run window, hearing that the Mac woke from sleep so it can read new
// mail at once (P1-4), reading and setting this Mac's interface language (L10N-01), so the app's
// menus and windows follow Settings → App → Language, the agent console, and (B-244 D-2) the other
// servers the app holds: their list, their inboxes, their settings lists (S11) and showing one of them. main.cjs answers the
// shown page's main frame (policy.isMailSender), the servers' calls any held server's page at its own
// main frame (policy.heldPageOrigin), and sends the wake signal only to the mail window's pages.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricDesktop', Object.freeze({
  pendingSetup: () => ipcRenderer.invoke('fabric:pending-setup'),
  pendingSetupDone: () => ipcRenderer.invoke('fabric:pending-setup-done'),
  // "system", "en" or "ru"; anything else is kept as "system" (desktop/i18n.cjs).
  locale: () => ipcRenderer.invoke('fabric:locale'),
  setLocale: (choice) => ipcRenderer.invoke('fabric:locale-set', String(choice)),
  // The agent console beside the mail (B-70): whether this app has it, and opening it. No data crosses.
  consoleAvailable: () => ipcRenderer.invoke('fabric:console-available'),
  openConsole: () => ipcRenderer.invoke('fabric:console-open'),
  // The page makes room for the docked console: it says it can, then hears the panel's width (0: none).
  consoleDockReady: () => ipcRenderer.invoke('fabric:console-dock-ready'),
  onConsoleDock: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, width) => callback(Number(width) || 0);
    ipcRenderer.on('fabric:console-dock', listener);
    return () => ipcRenderer.removeListener('fabric:console-dock', listener);
  },
  // B-244 D-2: the servers this app holds ({ origin, label, context, shown }), the other servers' inbox rows
  // ({ servers: [{ origin, label, state, unread }], messages }), and showing one server, at one of its paths.
  servers: () => ipcRenderer.invoke('fabric:servers'),
  otherInbox: () => ipcRenderer.invoke('fabric:other-inbox'),
  showServer: (origin, link) => ipcRenderer.invoke('fabric:show-server', String(origin), link === undefined ? undefined : String(link)),
  // S11 (B-276): Settings under All read the other servers' accounts, addresses or domains
  // ({ kind, servers: [{ origin, label, state, items }] }), and ask whether an agent console session runs before a
  // switch of server would stop it. No data of one server is sent to another.
  otherSettings: (kind) => ipcRenderer.invoke('fabric:other-settings', String(kind)),
  consoleRunning: () => ipcRenderer.invoke('fabric:console-running'),
  // Receive-only: the page passes a callback and gets back its unsubscribe; no data crosses.
  onResume: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('fabric:resumed', listener);
    return () => ipcRenderer.removeListener('fabric:resumed', listener);
  },
}));
