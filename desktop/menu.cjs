'use strict';
// The application menu per platform. macOS keeps its app menu (About, updates, Settings, Services,
// Hide, Quit) and its Window menu; Windows and Linux get File, Edit, Account, View, Window and Help,
// with no macOS-only roles (services, hide, hideOthers, unhide, front, the Speech submenu) — Electron
// ignores or misplaces them there. Pure: everything it calls is passed in, so tests read the shape.

/**
 * ctx: { t, update: { label, enabled, click }, automatic: { checked, enabled, click },
 *        usage: { checked, enabled, click, about }, openSettings, showServer, showCloudflare,
 *        connectGmail, retry }
 */
function menuTemplate(platform, ctx) {
  const { t } = ctx;
  const mac = platform === 'darwin';
  const updates = [
    { label: ctx.update.label, enabled: ctx.update.enabled, click: ctx.update.click },
    { label: t('Install Updates Automatically'), type: 'checkbox', checked: ctx.automatic.checked, enabled: ctx.automatic.enabled, click: ctx.automatic.click },
  ];
  const usage = [
    { label: t('Share Anonymous Usage Counts'), type: 'checkbox', checked: ctx.usage.checked, enabled: ctx.usage.enabled, click: ctx.usage.click },
    { label: t('About Usage Counts…'), click: ctx.usage.about },
  ];
  const server = [
    { label: t('Settings…'), accelerator: 'CmdOrCtrl+,', click: ctx.openSettings },
    { label: t('Server address…'), click: ctx.showServer },
    { label: t('Connect Cloudflare account…'), click: ctx.showCloudflare },
  ];
  const edit = [{ role: 'undo', label: t('Undo') }, { role: 'redo', label: t('Redo') }, { type: 'separator' },
    { role: 'cut', label: t('Cut') }, { role: 'copy', label: t('Copy') }, { role: 'paste', label: t('Paste') },
    ...(mac ? [{ role: 'pasteAndMatchStyle', label: t('Paste and Match Style') }] : []),
    { role: 'delete', label: t('Delete') }, { role: 'selectAll', label: t('Select All') },
    ...(mac ? [{ type: 'separator' }, { label: t('Speech'), submenu: [{ role: 'startSpeaking', label: t('Start Speaking') }, { role: 'stopSpeaking', label: t('Stop Speaking') }] }] : [])];
  const account = { label: t('Account'), submenu: [{ label: t('Connect Gmail in browser…'), click: ctx.connectGmail }] };
  const view = { label: t('[menu] View'), submenu: [{ label: t('Retry connection'), accelerator: 'CmdOrCtrl+R', click: ctx.retry },
    { role: 'resetZoom', label: t('Actual Size') }, { role: 'zoomIn', label: t('Zoom In') }, { role: 'zoomOut', label: t('Zoom Out') }, { role: 'togglefullscreen', label: t('Toggle Full Screen') }] };
  if (mac) return [
    { label: 'Fabric Inbox', submenu: [{ role: 'about', label: t('About Fabric Inbox') }, ...updates, { type: 'separator' }, ...usage, { type: 'separator' }, ...server,
      { type: 'separator' }, { role: 'services', label: t('Services') }, { role: 'hide', label: t('Hide Fabric Inbox') }, { role: 'hideOthers', label: t('Hide Others') },
      { role: 'unhide', label: t('Show All') }, { type: 'separator' }, { role: 'quit', label: t('Quit Fabric Inbox') }] },
    { label: t('[menu] Edit'), submenu: edit }, account, view,
    { role: 'windowMenu', label: t('Window'), submenu: [{ role: 'minimize', label: t('Minimize') }, { role: 'zoom', label: t('Zoom') }, { type: 'separator' }, { role: 'front', label: t('Bring All to Front') }] },
  ];
  return [
    { label: t('[menu] File'), submenu: [...server, { type: 'separator' }, { role: 'quit', label: t('Quit Fabric Inbox'), accelerator: 'Ctrl+Q' }] },
    { label: t('[menu] Edit'), submenu: edit }, account, view,
    { label: t('Window'), submenu: [{ role: 'minimize', label: t('Minimize') }, { role: 'close', label: t('Close') }] },
    { label: t('[menu] Help'), submenu: [...updates, { type: 'separator' }, ...usage, { type: 'separator' }, { role: 'about', label: t('About Fabric Inbox') }] },
  ];
}

module.exports = { menuTemplate };
