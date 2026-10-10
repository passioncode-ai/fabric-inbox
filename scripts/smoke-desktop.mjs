// Smoke test of a built desktop app on Windows or Linux (knowledge/platforms.md PL-08): start it with
// a throwaway profile (LC-14), wait for its first launch events on stderr (desktop/log.cjs echoes
// each JSON line there), and stop it. Passes when the app reached `profile_sweep` (it runs before any
// window) and nothing refused it; fails with the reason otherwise.
//
//   node scripts/smoke-desktop.mjs --exe "<path to the executable>" [--timeout 60] [-- <extra app args>]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseSmokeArgs(argv) {
  const out = { exe: '', timeout: 60, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { out.extra = argv.slice(i + 1); break; }
    if (argv[i] === '--exe') out.exe = argv[++i];
    else if (argv[i] === '--timeout') out.timeout = Number(argv[++i]);
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!out.exe) throw new Error('--exe is required');
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout must be seconds');
  return out;
}

/** Reads the app's JSON lines: the verdict once one is reached, else null. */
export function verdictOf(lines) {
  const events = [];
  for (const line of lines) {
    const at = line.indexOf('{');
    if (at === -1) continue;
    try { const e = JSON.parse(line.slice(at)); if (e && typeof e.event === 'string') events.push(e); } catch { /* not ours */ }
  }
  const refused = events.find((e) => e.event === 'key_store_refused');
  if (refused) return { ok: false, reason: `the app refused to run: no system key store (${refused.backend})`, events: events.map((e) => e.event) };
  const sweep = events.find((e) => e.event === 'profile_sweep');
  if (sweep) return sweep.outcome === 'ok' ? { ok: true, events: events.map((e) => e.event) } : { ok: false, reason: `profile_sweep ${sweep.outcome}`, events: events.map((e) => e.event) };
  return null;
}

export async function smoke({ exe, timeout, extra }) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fabric-smoke-'));
  const child = spawn(exe, [`--user-data-dir=${profile}`, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const lines = [];
  let buffer = '';
  const take = (chunk) => { buffer += chunk.toString('utf8'); const parts = buffer.split(/\r?\n/); buffer = parts.pop(); lines.push(...parts); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const deadline = Date.now() + timeout * 1000;
  let verdict = null;
  while (Date.now() < deadline && !verdict && !exited) {
    await new Promise((r) => setTimeout(r, 250));
    verdict = verdictOf(lines);
  }
  verdict ??= verdictOf(lines) ?? { ok: false, reason: exited ? `the app exited (${exited.code ?? exited.signal}) before it started` : `no launch event within ${timeout} s`, events: [] };
  // Stop the whole tree: Electron's helpers are its children.
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  return { ...verdict, tail: lines.slice(-20) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await smoke(parseSmokeArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: result.ok, reason: result.reason ?? null, events: result.events }, null, 2));
  if (!result.ok) { console.error(result.tail.join('\n')); process.exit(1); }
}
