'use strict';
// The installer step of an update on Windows and Linux (knowledge/platforms.md PL-03, PL-04). It
// stands where Squirrel.Mac stands on macOS and speaks the part of Electron's autoUpdater that
// desktop/updater.cjs uses, so the updater's core is one for every platform:
//   setFeedURL({ url })  — the file URL of the update desktop/update-verify.cjs has verified;
//   checkForUpdates()    — stage it, then emit 'update-downloaded' (or 'error');
//   quitAndInstall()     — install now and start the new version;
//   installOnQuit()      — the app is quitting with a staged update: install it as it exits.
//
// Windows: the verified NSIS installer is copied to its own staging folder (the verifier's cache is
// cleaned once the update is handed over) and runs silently in update mode (`/S --updated`) once the
// app is leaving; with `--force-run` it starts the new version. Per-user install, no elevation (PL-01).
// The next launch removes the staging folder.
// Linux AppImage: the verified AppImage is copied beside $APPIMAGE and renamed over it — the running
// copy keeps its own (old) file open, the next launch is the new version. A .deb never gets here:
// apt updates it (the updater is off with reason `package_manager`).
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * deps: { platform ('win32' | 'linux'), app ({ quit, exit, relaunch }), spawn (node:child_process),
 *   fs (node:fs/promises), stagingDir (Windows: a folder this step owns), appImage
 *   (process.env.APPIMAGE on Linux), log }
 */
function createPlatformInstaller(deps) {
  const { platform, app, spawn, fs, stagingDir = '', appImage = '', log = () => {} } = deps;
  if (platform !== 'win32' && platform !== 'linux') throw new Error(`No installer step for ${platform}.`);
  const events = new EventEmitter();
  let file = '';      // the verified update, as a path
  let staged = false; // Windows: the installer is ready to run; Linux: $APPIMAGE already is the new version

  function runInstaller(args) {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }

  async function replaceAppImage() {
    if (!appImage) throw new Error('This copy is not an AppImage.');
    const next = path.join(path.dirname(appImage), `.${path.basename(appImage)}.new`);
    try {
      await fs.copyFile(file, next);
      await fs.chmod(next, 0o755);
      await fs.rename(next, appImage);
    } catch (error) {
      await fs.rm(next, { force: true }).catch(() => {});
      throw error;
    }
  }

  return Object.assign(events, {
    setFeedURL({ url }) {
      if (!/^file:/.test(String(url))) throw new Error('The installer step takes only a verified local file.');
      file = fileURLToPath(url);
      staged = false;
    },

    checkForUpdates() {
      void (async () => {
        if (!file) throw new Error('No verified update was handed over.');
        await fs.access(file);
        if (platform === 'linux') await replaceAppImage();
        else {
          if (!stagingDir) throw new Error('No staging folder for the installer.');
          await fs.rm(stagingDir, { recursive: true, force: true });
          await fs.mkdir(stagingDir, { recursive: true });
          const kept = path.join(stagingDir, path.basename(file));
          await fs.copyFile(file, kept);
          file = kept;
        }
        staged = true;
        events.emit('update-downloaded', {}, '', '');
      })().catch((error) => { staged = false; events.emit('error', error); });
    },

    quitAndInstall() {
      if (!staged) throw new Error('No update is staged.');
      if (platform === 'win32') {
        runInstaller(['/S', '--updated', '--force-run']);
        log({ event: 'update_install', outcome: 'handed_over', step: 'installer' });
        app.quit();
        return;
      }
      // The AppImage on disk is already the new version: start it and leave.
      app.relaunch({ execPath: appImage, args: process.argv.slice(1) });
      app.exit(0);
    },

    /** At launch: what a previous update left (Windows: the installer that ran at the last quit). */
    async clean() {
      if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }).catch(() => {});
    },

    installOnQuit() {
      if (!staged || platform !== 'win32') return;
      runInstaller(['/S', '--updated']);
      log({ event: 'update_install', outcome: 'handed_over', step: 'installer' });
    },
  });
}

/**
 * What this platform's copy updates from and whether it can (pure; desktop/main.cjs passes the
 * process facts in):
 *   fileName(version) — the release file the verifier downloads (dist-mac.mjs / dist-platform.mjs names);
 *   installed — macOS: in /Applications; Windows: the per-user NSIS install (its uninstaller beside
 *     the executable); Linux: an AppImage;
 *   packageManager — a Linux copy that is not an AppImage (the .deb): apt updates it;
 *   writable — the paths this user must be able to write for the update to land.
 */
function updateTarget({ platform, arch, execPath, env = {}, installedOnMac = false, exists = () => false }) {
  if (platform === 'darwin') {
    const bundle = path.resolve(execPath, '..', '..', '..');
    return { fileName: (v) => `Fabric-Inbox-${v}-mac.zip`, installed: installedOnMac, packageManager: false, writable: [bundle, path.dirname(bundle)], runningApp: bundle };
  }
  if (platform === 'win32') {
    const dir = path.win32.dirname(execPath);
    return { fileName: (v) => `Fabric-Inbox-${v}-win-${arch}-setup.exe`, installed: exists(path.win32.join(dir, 'Uninstall Fabric Inbox.exe')),
      packageManager: false, writable: [dir], runningApp: execPath };
  }
  if (platform === 'linux') {
    const appImage = env.APPIMAGE || '';
    return { fileName: (v) => `Fabric-Inbox-${v}-linux-${arch}.AppImage`, installed: !!appImage, packageManager: !appImage,
      writable: appImage ? [appImage, path.posix.dirname(appImage)] : [], runningApp: appImage || execPath, appImage };
  }
  return { fileName: () => '', installed: false, packageManager: false, writable: [], runningApp: execPath };
}

module.exports = { createPlatformInstaller, updateTarget };
