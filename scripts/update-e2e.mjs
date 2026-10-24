// End-to-end update of a built Linux AppImage (B-105, LC-16): start an earlier release with a throwaway
// profile (LC-14), wait until it has found, downloaded and verified the newest published release
// (`update_check` ready: the verified AppImage is already in place of the running file), quit it the
// way logout does (SIGTERM), start the same file again, and pass only when that launch reports the
// update installed (`update_install` installed, running the new version). The AppImage's sandbox
// warning (B-99) is a modal no CI session answers, so the profile starts with it dismissed.
//
//   node scripts/update-e2e.mjs --exe <old.AppImage> --to <new version> [--timeout 600]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseUpdateArgs(argv) {
  const out = { exe: '', to: '', timeout: 600 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exe') out.exe = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
    else if (argv[i] === '--timeout') out.timeout = Number(argv[++i]);
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!out.exe) throw new Error('--exe is required');
  if (!/^\d+\.\d+\.\d+$/.test(out.to)) throw new Error('--to must be a version such as 1.2.3');
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout must be seconds');
  return out;
}

/** The app's JSON lines (desktop/log.cjs echoes each on stderr), in order. */
export function eventsOf(lines) {
  const events = [];
  for (const line of lines) {
    const at = line.indexOf('{');
    if (at === -1) continue;
    try { const e = JSON.parse(line.slice(at)); if (e && typeof e.event === 'string') events.push(e); } catch { /* not ours */ }
  }
  return events;
}

/** First launch: ready for `to`, refused for a reason that will not pass by waiting, or not yet (null). */
export function readyVerdict(events, to) {
  for (const e of events) {
    if (e.event === 'key_store_refused') return { ok: false, reason: `the app refused to run: no system key store (${e.backend})` };
    if (e.event === 'update_check' && e.outcome === 'ready') return e.version === to ? { ok: true } : { ok: false, reason: `it readied ${e.version}, not ${to}` };
    if (e.event === 'update_check' && ['not_replaceable', 'not_in_applications', 'install_failed'].includes(e.reason || e.outcome))
      return { ok: false, reason: `update_check ${e.outcome} ${e.reason || ''}`.trim() };
  }
  return null;
}

/** Second launch: the update the first one readied is installed and running. */
export function installedVerdict(events, to) {
  const done = events.find((e) => e.event === 'update_install');
  if (!done) return null;
  return done.outcome === 'installed' && done.version === to && done.running === to ? { ok: true }
    : { ok: false, reason: `update_install ${done.outcome} (version ${done.version}, running ${done.running})` };
}

function launch(exe, profile) {
  const child = spawn(exe, [`--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const lines = [];
  let buffer = '';
  const take = (chunk) => { buffer += chunk.toString('utf8'); const parts = buffer.split(/\r?\n/); buffer = parts.pop(); lines.push(...parts); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, lines, exited };
}

async function until(run, verdictFn, seconds) {
  const deadline = Date.now() + seconds * 1000;
  let done = false;
  run.exited.then(() => { done = true; });
  while (Date.now() < deadline) {
    const verdict = verdictFn(eventsOf(run.lines));
    if (verdict) return verdict;
    if (done) return { ok: false, reason: 'the app exited first' };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: `nothing within ${seconds} s` };
}

async function stop(run, seconds = 60) {
  try { process.kill(run.child.pid, 'SIGTERM'); } catch { /* gone */ }
  const ended = await Promise.race([run.exited, new Promise((r) => setTimeout(() => r(null), seconds * 1000))]);
  if (!ended) try { process.kill(-run.child.pid, 'SIGKILL'); } catch { /* gone */ }
  else try { process.kill(-run.child.pid, 'SIGTERM'); } catch { /* helpers gone */ }
  return ended;
}

export async function updateEndToEnd({ exe, to, timeout }) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'fabric-update-'));
  writeFileSync(path.join(profile, 'sandbox-warning'), 'off\n'); // desktop/policy.cjs SANDBOX_WARNING_FILE
  const tail = (run) => run.lines.filter((l) => l.includes('"event"')).slice(-20);
  try {
    const first = launch(exe, profile);
    const ready = await until(first, (events) => readyVerdict(events, to), timeout);
    const firstEnd = await stop(first);
    if (!ready.ok) return { ok: false, stage: 'ready', reason: ready.reason, tail: tail(first) };
    if (!firstEnd) return { ok: false, stage: 'quit', reason: 'the app did not quit on SIGTERM within 60 s', tail: tail(first) };
    const second = launch(exe, profile);
    const installed = await until(second, (events) => installedVerdict(events, to), 120);
    await stop(second);
    return installed.ok ? { ok: true, events: eventsOf([...first.lines, ...second.lines]).map((e) => e.event) }
      : { ok: false, stage: 'installed', reason: installed.reason, tail: tail(second) };
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await updateEndToEnd(parseUpdateArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: result.ok, stage: result.stage ?? null, reason: result.reason ?? null, events: result.events ?? null }, null, 2));
  if (!result.ok) { console.error((result.tail || []).join('\n')); process.exit(1); }
}
