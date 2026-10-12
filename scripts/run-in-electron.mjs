#!/usr/bin/env node
// Runs a Node script inside the app's own Electron, in node mode (ELECTRON_RUN_AS_NODE), so it sees
// the file system an installed copy sees: Electron treats `*.asar` files as folders, and the
// release's update check passed under plain Node while every installed copy failed (B-86).
//
//   node scripts/run-in-electron.mjs scripts/check-update-release.mjs --dir signed --version 0.15.2
//
// The Electron binary is this checkout's (after `npm ci`); a job without node_modules gets exactly
// the version package-lock.json pins, installed into a temporary prefix (never the project tree).
// Exits with the script's own code.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The version package-lock.json pins for electron. */
export function lockedElectronVersion(lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))) {
  const version = lock.packages?.['node_modules/electron']?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('package-lock.json pins no electron version.');
  return version;
}

const resolveElectron = (dir) => {
  try { const bin = createRequire(path.join(dir, 'package.json'))('electron'); return typeof bin === 'string' && existsSync(bin) ? bin : null; } catch { return null; }
};
const npmInstall = (prefix) => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', `electron@${lockedElectronVersion()}`], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The Electron executable: this checkout's, or one installed for this run at the locked version.
 * Electron's binary comes from GitHub, which sometimes answers 504 (B-96), so a failed install is
 * tried again in a fresh folder after 15 s and 30 s before the run is refused.
 */
export function electronBinary({ from = root, install = true, attempts = 3, installInto = npmInstall, resolveIn = resolveElectron, wait = sleep } = {}) {
  const local = resolveIn(from);
  if (local || !install) return local;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const prefix = mkdtempSync(path.join(os.tmpdir(), 'fabric-electron-'));
    try { installInto(prefix); } catch (error) { console.error(`Electron install attempt ${attempt} failed: ${error.message}`); }
    const installed = resolveIn(prefix);
    if (installed) return installed;
    rmSync(prefix, { recursive: true, force: true });
    if (attempt < attempts) wait(15000 * attempt);
  }
  throw new Error(`Electron could not be installed for this run after ${attempts} attempts.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [script, ...args] = process.argv.slice(2);
  if (!script) { console.error('usage: node scripts/run-in-electron.mjs <script> [args…]'); process.exit(2); }
  const bin = electronBinary();
  const result = spawnSync(bin, [script, ...args], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (result.error) { console.error(`Electron did not start: ${result.error.message}`); process.exit(1); }
  process.exit(result.status ?? 1);
}
