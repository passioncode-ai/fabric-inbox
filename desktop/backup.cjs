'use strict';
// A copy of the app's own settings outside its profile (docs/desktop-data-and-updates.md).
//
// Everything a person connects — Gmail accounts, Cloudflare accounts and tokens, addresses,
// agents, agent keys, rules, mail — lives on their server, in their Cloudflare account, and is
// untouched by removing the app. What lives on the Mac is the server's address
// (`<userData>/server.json`), the sign-in cookie and unsent drafts. Dragging the app to the Trash
// keeps all of it; an uninstaller that also removes `~/Library/Application Support/Fabric Inbox`
// used to take the server's address with it, so a reinstall started from the welcome screen.
//
// The server's address is therefore also kept in the folder every PassionCode app shares,
// `<appData>/PassionCode/backups/fabric-inbox.json`, rewritten whenever it is saved and read back
// when `server.json` is missing. It holds no secret: the address of a server behind Cloudflare
// Access, which still asks the person to sign in.
const path = require('node:path');

const backupFile = (appData) => path.join(appData, 'PassionCode', 'backups', 'fabric-inbox.json');

/** Writes the copy atomically. Never throws; returns whether it was written. */
async function saveBackup({ fs, appData, config, now = Date.now, log = () => {} }) {
  const target = backupFile(appData);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const value = { version: 1, app: 'Fabric Inbox', server: { origin: config.origin, accessOrigin: config.accessOrigin || '' }, savedAt: new Date(now()).toISOString() };
    await fs.writeFile(`${target}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
    return true;
  } catch (error) {
    log({ event: 'settings_backup', outcome: 'not_written', code: error && error.code || 'error' });
    return false;
  }
}

/** The saved server settings, checked by `validate` (policy.validateConfig), or null. */
async function readBackup({ fs, appData, validate }) {
  try {
    const value = JSON.parse(await fs.readFile(backupFile(appData), 'utf8'));
    if (!value || value.version !== 1 || !value.server) return null;
    return validate({ origin: value.server.origin, accessOrigin: value.server.accessOrigin || '' });
  } catch { return null; }
}

module.exports = { backupFile, saveBackup, readBackup };
