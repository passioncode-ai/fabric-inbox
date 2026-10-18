'use strict';
// Always on from system start (the organization's lifecycle rule, operator 2026-10-16; LC-07 amended):
// the first launch of an installed copy turns "Open at Login" on, once. After that only the person's
// choice changes it (the app menu, or the system's own settings), and an update keeps it. Every launch
// reads the state, so a login item the system holds for approval is told to the person instead of
// failing in silence.
//
// macOS and Windows use the system's login item (app.setLoginItemSettings). Linux has none, so an
// autostart entry is written to $XDG_CONFIG_HOME/autostart (freedesktop.org Desktop Application
// Autostart). The Mac App Store package and builds from source never register.

const MARKER = 'login-item.json';
const ENTRY = 'fabric-inbox.desktop';

/**
 * deps: { app, fs (promises), path, platform, userData, env, homedir, mas, execPath, log }.
 * Pure of Electron's globals: everything it touches is passed in, so tests drive it.
 */
function createAutostart({ app, fs, path, platform, userData, env = {}, homedir = '', mas = false, execPath = '', log = () => {} }) {
  const marker = path.join(userData, MARKER);
  const autostartDir = path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'autostart');
  const entry = path.join(autostartDir, ENTRY);
  // What starts at login on Linux: the AppImage file itself (the mount point changes each run), or the
  // installed binary of a .deb.
  const linuxExec = env.APPIMAGE || execPath;

  /** Why this copy does not register, or null when it does. */
  function unsupported() {
    if (!app.isPackaged) return 'development';
    if (mas) return 'app_store';
    if (platform === 'darwin' && typeof app.isInApplicationsFolder === 'function' && !app.isInApplicationsFolder()) return 'not_in_applications';
    if (platform === 'linux' && !linuxExec) return 'no_executable';
    if (!['darwin', 'win32', 'linux'].includes(platform)) return 'platform';
    return null;
  }

  async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

  /** { supported, reason?, enabled, needsApproval } — read now, from the system. */
  async function status() {
    const reason = unsupported();
    if (reason) return { supported: false, reason, enabled: false, needsApproval: false };
    if (platform === 'linux') return { supported: true, enabled: await exists(entry), needsApproval: false };
    const settings = app.getLoginItemSettings();
    // macOS 13+: `status` says whether the system holds the item for the person's approval.
    const needsApproval = settings.status === 'requires-approval';
    return { supported: true, enabled: !!settings.openAtLogin || settings.status === 'enabled', needsApproval };
  }

  async function apply(enabled) {
    if (platform === 'linux') {
      if (!enabled) { await fs.rm(entry, { force: true }); return; }
      await fs.mkdir(autostartDir, { recursive: true });
      // Exec is quoted: the AppImage may sit in a folder with a space in its name.
      const quoted = `"${String(linuxExec).replace(/(["`$\\])/g, '\\$1')}"`;
      await fs.writeFile(entry, ['[Desktop Entry]', 'Type=Application', 'Name=Fabric Inbox', `Exec=${quoted}`,
        'X-GNOME-Autostart-enabled=true', 'NoDisplay=false', ''].join('\n'), 'utf8');
      return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled });
  }

  async function readMarker() { try { return JSON.parse(await fs.readFile(marker, 'utf8')); } catch { return null; } }
  async function writeMarker(value) { await fs.writeFile(marker, JSON.stringify(value), 'utf8'); }

  /**
   * At every launch: register once on the first launch of an installed copy, then read the state.
   * Answers the status after it, with `registered: true` on the launch that turned it on.
   */
  async function start() {
    const reason = unsupported();
    if (reason) { log({ event: 'login_item', outcome: 'unsupported', reason }); return { supported: false, reason, enabled: false, needsApproval: false }; }
    let registered = false;
    if (!(await readMarker())) {
      try {
        await apply(true);
        await writeMarker({ registered: true });
        registered = true;
      } catch (error) {
        log({ event: 'login_item', outcome: 'failed', reason: String(error && error.code || 'error') });
      }
    }
    const now = await status();
    log({ event: 'login_item', outcome: now.needsApproval ? 'needs_approval' : now.enabled ? 'on' : 'off', ...(registered ? { registered: true } : {}) });
    return { ...now, registered };
  }

  /** The person's choice from the app menu; kept across launches and updates (the marker stays). */
  async function set(enabled) {
    if (unsupported()) return status();
    await apply(enabled);
    await writeMarker({ registered: true, chosen: enabled ? 'on' : 'off' });
    log({ event: 'login_item', outcome: enabled ? 'on' : 'off', chosen: true });
    return status();
  }

  return { start, status, set };
}

module.exports = { createAutostart, MARKER, ENTRY };
