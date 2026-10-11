'use strict';
// The agent console window (desktop/console.html, B-70): a narrow bridge to the console manager in
// the main process (desktop/console.cjs). Text goes to and from the PTY; nothing else crosses.
const { contextBridge, ipcRenderer } = require('electron');
const listen = (channel, map) => (callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(map(value));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('fabricConsole', Object.freeze({
  state: () => ipcRenderer.invoke('fabric:console-state'),
  locale: () => ipcRenderer.invoke('fabric:console-locale'),
  start: (input) => ipcRenderer.invoke('fabric:console-start', { runtime: String(input.runtime), level: String(input.level), resume: !!input.resume, cols: Number(input.cols), rows: Number(input.rows) }),
  stop: () => ipcRenderer.invoke('fabric:console-stop'),
  write: (data) => ipcRenderer.send('fabric:console-write', String(data)),
  resize: (cols, rows) => ipcRenderer.send('fabric:console-resize', Number(cols), Number(rows)),
  onData: listen('fabric:console-data', (v) => String(v)),
  onState: listen('fabric:console-phase', (v) => v),
}));
