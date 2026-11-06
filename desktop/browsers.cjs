'use strict';
// B-227 (operator, 2026-11-06): a right-click on a link offers each installed browser in the same menu ("Open in
// Safari", "Open in Chrome"…), not a submenu. Found once per launch; each platform's own record of browsers:
// macOS the usual app bundles in /Applications and ~/Applications, Windows the StartMenuInternet registry keys,
// Linux the desktop entries that handle https. Pure apart from the deps main.cjs passes; tests pass fakes.
const path = require('node:path');

/** At most this many browsers in the menu. */
const MAX_BROWSERS = 8;

/** macOS: the bundles looked for, with the name the menu shows. */
const MAC_BROWSERS = [
  ['Safari', 'Safari.app'], ['Chrome', 'Google Chrome.app'], ['Chrome Dev', 'Google Chrome Dev.app'],
  ['Chrome Canary', 'Google Chrome Canary.app'], ['Chromium', 'Chromium.app'], ['Firefox', 'Firefox.app'],
  ['Firefox Developer Edition', 'Firefox Developer Edition.app'], ['Arc', 'Arc.app'], ['Dia', 'Dia.app'],
  ['Brave', 'Brave Browser.app'], ['Edge', 'Microsoft Edge.app'], ['Opera', 'Opera.app'], ['Vivaldi', 'Vivaldi.app'],
  ['Orion', 'Orion.app'], ['Zen', 'Zen.app'], ['DuckDuckGo', 'DuckDuckGo.app'], ['Yandex', 'Yandex.app'],
];

/** A browser: the name the menu shows and how to hand it a URL (file and arguments, run without a shell). */
const browser = (name, file, args) => ({ name, file, args });

async function macBrowsers({ fs, homedir }) {
  const found = [];
  for (const [name, bundle] of MAC_BROWSERS) {
    for (const folder of ['/Applications', homedir ? path.posix.join(homedir, 'Applications') : null].filter(Boolean)) {
      const app = path.posix.join(folder, bundle);
      try { await fs.access(app); found.push(browser(name, '/usr/bin/open', ['-a', app])); break; } catch { /* not here */ }
    }
  }
  return found;
}

/** Windows: `reg query` of one hive's StartMenuInternet clients, as name and command line. */
function parseRegClients(output) {
  const clients = new Map();
  let key = '';
  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const head = /^HKEY_[A-Z_]+\\SOFTWARE\\(?:WOW6432Node\\)?Clients\\StartMenuInternet\\([^\\]+)(\\shell\\open\\command)?$/i.exec(line.trim());
    if (head) { key = head[2] ? `${head[1]}|command` : `${head[1]}|name`; continue; }
    const value = /^\s+\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line);
    if (!value || !key) continue;
    const [id, what] = key.split('|');
    const entry = clients.get(id) || {};
    entry[what] = value[1].trim();
    clients.set(id, entry);
  }
  return [...clients.values()].filter((c) => c.name && c.command);
}
/** The program of a Windows command line: its quoted or first word. */
function commandFile(command) {
  const m = /^"([^"]+)"|^(\S+)/.exec(command.trim());
  return m ? (m[1] || m[2]) : '';
}
async function windowsBrowsers({ execFile }) {
  const found = [];
  for (const hive of ['HKCU', 'HKLM']) {
    let out = '';
    try { out = await execFile('reg', ['query', `${hive}\\SOFTWARE\\Clients\\StartMenuInternet`, '/s']); } catch { continue; }
    for (const c of parseRegClients(out)) {
      const file = commandFile(c.command);
      if (file && !found.some((b) => b.file.toLowerCase() === file.toLowerCase())) found.push(browser(c.name, file, []));
    }
  }
  return found;
}

/** Linux: one desktop entry's name and Exec when it handles https; field codes dropped, %u/%U become the URL. */
function parseDesktopEntry(text) {
  let section = '', name = '', exec = '', mime = '', hidden = false;
  for (const line of String(text).split(/\r?\n/)) {
    const s = /^\[(.+)\]$/.exec(line.trim());
    if (s) { section = s[1]; continue; }
    if (section !== 'Desktop Entry') continue;
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'Name') name = kv[2].trim();
    else if (kv[1] === 'Exec') exec = kv[2].trim();
    else if (kv[1] === 'MimeType') mime = kv[2];
    else if ((kv[1] === 'NoDisplay' || kv[1] === 'Hidden') && kv[2].trim() === 'true') hidden = true;
  }
  if (hidden || !name || !exec || !/(^|;)x-scheme-handler\/https(;|$)/.test(mime)) return null;
  const words = exec.match(/"[^"]*"|\S+/g) || [];
  const args = words.slice(1).map((w) => w.replace(/^"|"$/g, '')).filter((w) => !/^%[fFuUdDnNickvm]$/.test(w));
  return browser(name, words[0].replace(/^"|"$/g, ''), args);
}
async function linuxBrowsers({ fs, homedir }) {
  const found = [];
  const folders = [homedir && path.posix.join(homedir, '.local/share/applications'), '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications'].filter(Boolean);
  for (const folder of folders) {
    let names = [];
    try { names = await fs.readdir(folder); } catch { continue; }
    for (const file of names.filter((n) => n.endsWith('.desktop')).sort()) {
      let text = '';
      try { text = await fs.readFile(path.posix.join(folder, file), 'utf8'); } catch { continue; }
      const b = parseDesktopEntry(text);
      if (b && !found.some((x) => x.name === b.name)) found.push(b);
    }
  }
  return found;
}

/** The installed browsers, at most MAX_BROWSERS; [] when they cannot be read (the menu then offers the default only). */
async function findBrowsers({ platform, fs, homedir, execFile }) {
  try {
    const list = platform === 'darwin' ? await macBrowsers({ fs, homedir })
      : platform === 'win32' ? await windowsBrowsers({ execFile })
        : platform === 'linux' ? await linuxBrowsers({ fs, homedir }) : [];
    return list.slice(0, MAX_BROWSERS);
  } catch { return []; }
}

/** How one browser opens a URL: its file with its arguments and the URL last. */
const openArgs = (b, url) => ({ file: b.file, args: [...b.args, url] });

module.exports = { findBrowsers, openArgs, parseRegClients, parseDesktopEntry, commandFile, MAC_BROWSERS, MAX_BROWSERS };
