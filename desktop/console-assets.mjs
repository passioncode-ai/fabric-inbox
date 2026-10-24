// What the agent console (desktop/console.cjs, B-70) needs inside the app, staged by every builder
// from the repository's node_modules: the xterm.js view (console-vendor/) and node-pty's runtime
// files (node_modules/node-pty), nothing else of either package. The pattern is Fabric Dashboards'
// (its scripts/dist-mac.mjs, ADR-0017):
//   macOS: node-pty ships each architecture as a thin binary; each is joined with lipo into one
//          universal file placed in both prebuilds/darwin-* folders (a thin x86_64 file makes macOS
//          warn about Intel support), and spawn-helper gets its executable bit — 1.1.0 ships it 0644.
//   Windows: the conpty prebuild of the target architecture, without .pdb files.
//   Linux: the module node-gyp built during npm ci (build/Release), so the build runs on the
//          target architecture (the platforms and release workflows do).
// The Mac App Store package stages none of it: its sandbox cannot run the person's own CLI.
//
//   node desktop/console-assets.mjs --vendor   copies the view into desktop/console-vendor (for `npm run desktop`)
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(desktop, '..');
function requireThat(condition, message) { if (!condition) throw new Error(message); }

/** The view: xterm.js and its fit addon, scripts and stylesheet only. */
export function stageConsoleView(target, from = root) {
  const out = path.join(target, 'console-vendor');
  mkdirSync(out, { recursive: true });
  const files = [
    ['@xterm/xterm/lib/xterm.js', 'xterm.js'], ['@xterm/xterm/css/xterm.css', 'xterm.css'],
    ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'], ['@xterm/xterm/LICENSE', 'LICENSE-xterm'],
  ];
  for (const [src, name] of files) {
    const file = path.join(from, 'node_modules', src);
    requireThat(existsSync(file), `${src} is not installed; run npm ci first.`);
    cpSync(file, path.join(out, name));
  }
  return out;
}

/** The PTY: node-pty's manifest, licence, lib/ and the binaries of this platform and architecture. */
export function stageConsolePty(target, { platform, arch, from = root, run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }) }) {
  const src = path.join(from, 'node_modules', 'node-pty');
  requireThat(existsSync(path.join(src, 'package.json')), 'node-pty is not installed; run npm ci first.');
  const dest = path.join(target, 'node_modules', 'node-pty');
  mkdirSync(dest, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8'));
  writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, license: manifest.license, main: manifest.main }, null, 2) + '\n');
  cpSync(path.join(src, 'LICENSE'), path.join(dest, 'LICENSE'));
  cpSync(path.join(src, 'lib'), path.join(dest, 'lib'), { recursive: true, filter: (f) => !/\.test\.js(\.map)?$|\.map$/.test(f) });
  if (platform === 'darwin') {
    for (const a of ['arm64', 'x64']) {
      requireThat(existsSync(path.join(src, 'prebuilds', `darwin-${a}`, 'pty.node')), `node-pty has no prebuild for darwin-${a}.`);
      mkdirSync(path.join(dest, 'prebuilds', `darwin-${a}`), { recursive: true });
    }
    for (const file of ['pty.node', 'spawn-helper']) {
      const universal = path.join(dest, 'prebuilds', 'darwin-arm64', file);
      run('lipo', ['-create', path.join(src, 'prebuilds/darwin-arm64', file), path.join(src, 'prebuilds/darwin-x64', file), '-output', universal]);
      requireThat(run('lipo', ['-archs', universal]).trim().split(/\s+/).sort().join(' ') === 'arm64 x86_64', `node-pty ${file} did not become universal.`);
      cpSync(universal, path.join(dest, 'prebuilds', 'darwin-x64', file));
      for (const a of ['arm64', 'x64']) chmodSync(path.join(dest, 'prebuilds', `darwin-${a}`, file), file === 'spawn-helper' ? 0o755 : 0o644);
    }
  } else if (platform === 'win32') {
    const dir = path.join(src, 'prebuilds', `win32-${arch}`);
    requireThat(existsSync(path.join(dir, 'pty.node')), `node-pty has no prebuild for win32-${arch}.`);
    cpSync(dir, path.join(dest, 'prebuilds', `win32-${arch}`), { recursive: true, filter: (f) => !f.endsWith('.pdb') });
  } else if (platform === 'linux') {
    const release = path.join(src, 'build', 'Release');
    requireThat(existsSync(path.join(release, 'pty.node')), 'node-pty was not built for Linux (npm ci runs node-gyp; allowScripts must allow node-pty).');
    mkdirSync(path.join(dest, 'build', 'Release'), { recursive: true });
    for (const f of readdirSync(release)) if (f.endsWith('.node')) cpSync(path.join(release, f), path.join(dest, 'build', 'Release', f));
  } else throw new Error(`No console PTY for ${platform}.`);
  return dest;
}

/**
 * The packager's asar option: node-pty runs from outside app.asar, because it finds its helper by
 * replacing app.asar with app.asar.unpacked in its own path and native code cannot read an asar.
 * `unpackDir` is matched against the path inside the app; the glob 0.15.0 used (`unpack`) was
 * matched against the absolute path, where `**` does not cross a dot folder, and every builder
 * packs under one (macOS `release/.build-tmp`, Windows and Linux `.stage-…`): no 0.15.0 build had
 * app.asar.unpacked (B-84).
 */
export const CONSOLE_ASAR = { unpackDir: path.join('node_modules', 'node-pty') };

/** The files node-pty must find outside app.asar on each platform (paths inside node_modules/node-pty). */
function unpackedFiles(platform, arch) {
  if (platform === 'darwin') return ['arm64', 'x64'].flatMap((a) => [`prebuilds/darwin-${a}/pty.node`, `prebuilds/darwin-${a}/spawn-helper`]);
  // B-102: the console runs on node-pty's own conpty.dll (useConptyDll), which it loads beside conpty.node.
  if (platform === 'win32') return ['pty.node', 'conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((f) => `prebuilds/win32-${arch}/${f}`);
  if (platform === 'linux') return ['build/Release/pty.node'];
  throw new Error(`No console PTY for ${platform}.`);
}

/**
 * Checks a built app's Resources folder: node-pty is in app.asar.unpacked. Every builder calls it
 * with throwOnMissing, so a build whose console could not start fails instead of being released.
 */
export function verifyConsoleUnpacked(resourcesDir, { platform, arch }, { throwOnMissing = false } = {}) {
  const dir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty');
  const missing = unpackedFiles(platform, arch).filter((rel) => !existsSync(path.join(dir, ...rel.split('/'))));
  if (missing.length && throwOnMissing) throw new Error(`The agent console cannot start: app.asar.unpacked lacks node-pty's ${missing.join(', ')} (B-84).`);
  return { missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--vendor')) {
  console.log(stageConsoleView(desktop));
}
