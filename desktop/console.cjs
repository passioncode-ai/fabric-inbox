'use strict';
// The agent console (board B-70; SCN-078): the person's own coding agent — Claude Code or Codex,
// found on the login shell's PATH — runs in a terminal beside the mail, already connected to this
// server's MCP, so anything the app does can be done by talking to it. The same pattern as Fabric
// Dashboards' console (its ADR-0017): a PTY in the main process (node-pty) and an xterm.js view.
//
// Inbox's MCP is a remote server behind Cloudflare Access, so each session gets its own agent key,
// made through the owner's signed-in session (the route Agent access uses) and revoked when the
// session ends. The key reaches the agent only through its environment: the MCP config the agent
// reads names `${VAR}`s (Claude Code and Codex both expand them), so no file holds a secret. A key
// a crashed session left behind is revoked at the next start (`leftovers`).
//
// Everything outside (node-pty, fetch through the session, files, the clock) is passed in, so this
// file runs in tests without Electron.
const path = require('node:path');
const crypto = require('node:crypto');

const RING_BYTES = 1024 * 1024;
const STOP_GRACE_MS = 2000;
const LEVELS = ['read', 'mail', 'admin'];

/**
 * node-pty's spawn options for this platform. On Windows the PTY runs on the conpty.dll node-pty
 * ships (`useConptyDll`): without it, stopping a session forks node-pty's process-list helper with
 * `child_process.fork`, which in the packaged app (the RunAsNode fuse off) starts a second copy of
 * Fabric Inbox instead of Node (B-102).
 */
function ptyOptions(platform, options) {
  return platform === 'win32' ? { ...options, useConptyDll: true } : options;
}

/** The agents the console can open, in the order offered. `args` builds the command line. */
const RUNTIMES = [
  {
    id: 'claude', name: 'Claude Code', bin: 'claude',
    // --mcp-config=<file> joined, so the next argument is never taken as a second file; strict:
    // only this server, whatever the person's own config holds.
    args: ({ configPath, brief, resume }) => [...(resume ? ['--continue'] : []), `--mcp-config=${configPath}`, '--strict-mcp-config', '--append-system-prompt', brief],
  },
  {
    id: 'codex', name: 'Codex', bin: 'codex',
    args: ({ mcpUrl, env, resume }) => [...(resume ? ['resume', '--last'] : []),
      '-c', `mcp_servers.fabric_inbox.url=${JSON.stringify(mcpUrl)}`,
      '-c', `mcp_servers.fabric_inbox.env_http_headers={ "CF-Access-Client-Id" = "${env.id}", "CF-Access-Client-Secret" = "${env.secret}" }`],
  },
];

/** What the agent is told first: where it is and how to work. Short: a launcher may cap arguments. */
function briefFor(origin) {
  return [
    `You are working in the person's Fabric Inbox (${new URL(origin).host}) through its MCP server "fabric-inbox".`,
    'Everything the app does is a tool there: start with list_accounts. Changes that cannot be undone take a second call with a confirmation code; ask the person first.',
    'Never send mail to anyone unless the person asks you to send.',
  ].join(' ');
}

/** Directories searched beside the login PATH (the app is not started from a shell). */
function searchPath(platform, env, loginPath) {
  const home = env.HOME || env.USERPROFILE || '';
  const extra = platform === 'win32'
    ? [path.win32.join(env.APPDATA || '', 'npm'), path.win32.join(env.LOCALAPPDATA || '', 'Programs')]
    : [path.posix.join(home, '.local/bin'), path.posix.join(home, '.claude/local'), path.posix.join(home, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const sep = platform === 'win32' ? ';' : ':';
  return [...new Set([...(loginPath || env.PATH || env.Path || '').split(sep), ...extra].filter(Boolean))];
}

/** Finds each runtime's executable; `exists(file)` says whether a file is executable. */
function findRuntimes({ platform = process.platform, env = process.env, loginPath, exists }) {
  const dirs = searchPath(platform, env, loginPath);
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return RUNTIMES.map((r) => {
    for (const dir of dirs) for (const ext of exts) {
      const file = join(dir, r.bin + ext);
      if (exists(file)) return { id: r.id, name: r.name, file };
    }
    return null;
  }).filter(Boolean);
}

/** The environment of the agent: the app's, without what would turn Electron into Node, plus the key. */
function sessionEnv(base, { loginPath, names, key, origin }) {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return { ...env, ...(loginPath ? { PATH: loginPath } : {}), TERM: 'xterm-256color', COLORTERM: 'truecolor',
    FABRIC_INBOX_SERVER: origin, [names.id]: key.clientId, [names.secret]: key.clientSecret };
}

/** The MCP config Claude Code reads: the URL and `${VAR}` references only, never the key itself. */
function mcpConfig(mcpUrl, names) {
  return { mcpServers: { 'fabric-inbox': { type: 'http', url: mcpUrl,
    headers: { 'CF-Access-Client-Id': `\${${names.id}}`, 'CF-Access-Client-Secret': `\${${names.secret}}` } } } };
}

/** A ring of the last RING_BYTES of output, replayed to a view that opens later. */
function ring(limit = RING_BYTES) {
  let chunks = []; let size = 0;
  return {
    push(data) { chunks.push(data); size += data.length; while (size > limit && chunks.length > 1) size -= chunks.shift().length; },
    text() { return chunks.join(''); },
  };
}

/**
 * One console at a time. deps: { pty: { spawn(file, args, opts) }, fs (node:fs/promises), dir
 * (a 0700 folder the app owns), mint(input) → { ok, data: { key, clientSecret } }, revoke(id) →
 * boolean, origin, mcpUrl, cwd, loginPath, env, platform, kill(pid, signal), now, log, onData(text),
 * onState(state) }.
 */
function createConsole(deps) {
  const { pty, fs, dir, mint, revoke, origin, mcpUrl, cwd, loginPath, env = process.env, platform = process.platform,
    kill = (pid, signal) => process.kill(pid, signal), log = () => {}, onData = () => {}, onState = () => {}, setTimer = setTimeout } = deps;
  let session = null;
  let starting = false;   // a start between its first await and its session (bug hunt 2026-10-12: two keys, two agents)
  let state = { phase: 'idle' };
  const out = ring();
  const set = (next) => { state = next; onState(state); };
  const leftoversFile = path.join(dir, 'keys.json');

  // keys.json: the key ids a session made and has not revoked yet, each with the server it belongs to
  // (a bare id is from before 0.16). A key is revoked only through its own server's session.
  async function remember(entries) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.writeFile(leftoversFile, JSON.stringify(entries), { mode: 0o600 }); }
  async function recorded() {
    try {
      const list = JSON.parse(await fs.readFile(leftoversFile, 'utf8'));
      return Array.isArray(list) ? list.map((e) => (typeof e === 'string' ? { id: e, origin: null } : e)).filter((e) => e && typeof e.id === 'string') : [];
    } catch { return []; }
  }
  const stored = (entries) => entries.map((e) => (e.origin === null ? e.id : e));

  /** Ends exactly this session (an older child's exit never ends a newer one): revoke, clean up, tell. */
  async function end(s, reason, code) {
    if (!s || session !== s) return;
    session = null;
    const revoked = await revoke(s.keyId).catch(() => false);
    if (revoked) await remember(stored((await recorded()).filter((e) => e.id !== s.keyId))).catch(() => {});
    await fs.rm(s.folder, { recursive: true, force: true }).catch(() => {});
    log({ event: 'console', outcome: 'ended', runtime: s.runtime, reason, code: code ?? null, revoked });
    set({ phase: 'ended', reason, code: code ?? null, runtime: s.runtime, keyRevoked: revoked });
    s.resolveEnded();
  }
  const newSession = (fields) => { const s = { ...fields }; s.ended = new Promise((resolve) => { s.resolveEnded = resolve; }); return s; };

  async function startOnce({ runtime, spec, level, resume, cols, rows }) {
    set({ phase: 'starting', runtime: spec.id });
    // A key an earlier session could not revoke (a crash, a forced quit) goes before a new one is made.
    await this.leftovers().catch(() => {});
    const minted = await mint({ name: `Agent console (${spec.name})`, level, send: level === 'read' ? 'drafts' : 'send', dailySendLimit: 50, duration: '30d' });
    if (!minted.ok) { set({ phase: 'idle', error: minted.signIn ? 'sign_in' : 'key', detail: minted.error || null }); return { ok: false, error: minted.signIn ? 'sign_in' : 'key', detail: minted.error }; }
    const key = { id: minted.data.key.id, clientId: minted.data.key.clientId, clientSecret: minted.data.clientSecret };
    await remember(stored([...(await recorded()), { id: key.id, origin }])).catch(() => {});
    const tag = crypto.randomBytes(6).toString('hex').toUpperCase();
    const names = { id: `FABRIC_INBOX_CONSOLE_ID_${tag}`, secret: `FABRIC_INBOX_CONSOLE_SECRET_${tag}` };
    const folder = path.join(dir, `session-${tag.toLowerCase()}`);
    // From here on the key exists: whatever fails ends this session, which revokes it (bug hunt 2026-10-12:
    // a failed write left the view stuck on "starting" and the key live).
    const pending = newSession({ keyId: key.id, folder, runtime: spec.id, level });
    session = pending;
    let child;
    try {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const configPath = path.join(folder, 'mcp.json');
      await fs.writeFile(configPath, JSON.stringify(mcpConfig(mcpUrl, names), null, 2), { mode: 0o600 });
      child = pty.spawn(runtime.file, spec.args({ configPath, brief: briefFor(origin), mcpUrl, env: names, resume }), ptyOptions(platform, {
        name: 'xterm-256color', cols: Math.max(2, Math.min(1000, cols | 0)), rows: Math.max(1, Math.min(500, rows | 0)), cwd,
        env: sessionEnv(env, { loginPath, names, key, origin }),
      }));
    } catch (error) {
      await end(pending, 'spawn_failed');
      set({ phase: 'idle', error: 'spawn', detail: String(error && error.message || error) });
      return { ok: false, error: 'spawn', detail: String(error && error.message || error) };
    }
    pending.child = child;
    child.onData((data) => { out.push(data); onData(data); });
    child.onExit(({ exitCode }) => { void end(pending, pending.stopping ? 'stopped' : 'exited', exitCode); });
    log({ event: 'console', outcome: 'started', runtime: spec.id, level, resume });
    set({ phase: 'running', runtime: spec.id, level });
    return { ok: true };
  }

  return {
    state: () => state,
    output: () => out.text(),

    /** Opens the agent: a key for this session, its config, then the PTY. */
    async start({ runtime, level = 'admin', resume = false, cols = 100, rows = 30 }) {
      if (session || starting) return { ok: false, error: 'running' };
      if (!LEVELS.includes(level)) return { ok: false, error: 'level' };
      const spec = RUNTIMES.find((r) => r.id === runtime?.id);
      if (!spec || !runtime.file) return { ok: false, error: 'runtime' };
      starting = true;
      try { return await startOnce.call(this, { runtime, spec, level, resume, cols, rows }); }
      finally { starting = false; }
    },

    write(data) { if (session && session.child && typeof data === 'string' && data.length <= 1024 * 1024) session.child.write(data); },
    resize(cols, rows) { if (session && session.child) session.child.resize(Math.max(2, Math.min(1000, cols | 0)), Math.max(1, Math.min(500, rows | 0))); },

    /** Hang up the agent's whole process group, then kill it if it is still there (PL-07: taskkill on Windows). */
    /**
     * Hangs up the agent; with `wait`, resolves once its key is revoked (or after `timeoutMs`), so a
     * quit or a server switch can wait for it (bug hunt 2026-10-12: quitting left a 30-day key live).
     */
    async stop({ wait = false, timeoutMs = 5000 } = {}) {
      const s = session;
      if (!s || !s.child) return;
      s.stopping = true;
      const pid = s.child.pid;
      try {
        if (platform === 'win32') s.child.kill();
        else kill(-pid, 'SIGHUP');
      } catch { try { s.child.kill(); } catch { /* gone */ } }
      setTimer(() => { if (session === s) { try { s.child.kill('SIGKILL'); } catch { /* gone */ } } }, STOP_GRACE_MS);
      if (wait) await Promise.race([s.ended, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    },

    /** At start: keys of sessions the app could not end (a crash, a forced quit) are revoked. */
    async leftovers() {
      const entries = await recorded();
      const kept = [];
      let revoked = 0;
      for (const e of entries) {
        // Another server's key is revoked when that server is current; this session cannot reach it.
        if (e.origin && e.origin !== origin) { kept.push(e); continue; }
        if (session && session.keyId === e.id) { kept.push(e); continue; }
        if (await revoke(e.id).catch(() => false)) revoked++; else kept.push(e);
      }
      if (entries.length) { await remember(stored(kept)).catch(() => {}); log({ event: 'console', outcome: 'leftovers', revoked, kept: kept.length }); }
      return { revoked, kept: kept.length };
    },

    running: () => !!(session && session.child),
  };
}

/** What the launch check (B-105) runs in a PTY: a fixed echo, nothing the person's machine supplies. */
const PTY_CHECK_TOKEN = 'fabric-pty-ok';
function ptyCheckCommand(platform, env = process.env) {
  return platform === 'win32'
    ? { file: path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', `echo ${PTY_CHECK_TOKEN}`] }
    : { file: '/bin/sh', args: ['-c', `echo ${PTY_CHECK_TOKEN}`] };
}
/** What the stop half of the check (B-102) runs: a shell that waits until it is stopped. */
function ptyHoldCommand(platform, env = process.env) {
  return platform === 'win32'
    ? { file: path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/k'] }
    : { file: '/bin/sh', args: ['-c', 'exec sleep 60'] };
}

/** Runs `command` in a PTY; resolves with what it printed and how it ended, or `timeout`. */
function runInPty(pty, platform, env, { file, args }, { timeoutMs, setTimer, clearTimer, onSpawn = () => {} }) {
  return new Promise((resolve) => {
    let child, out = '', done = false;
    const finish = (result) => { if (done) return; done = true; clearTimer(timer); resolve({ out, ...result }); };
    const timer = setTimer(() => { try { child && child.kill(); } catch { /* gone */ } finish({ timeout: true }); }, timeoutMs);
    try {
      child = pty.spawn(file, args, ptyOptions(platform, { name: 'xterm-256color', cols: 80, rows: 24, cwd: platform === 'win32' ? (env.SystemRoot || 'C:\\') : '/', env: { PATH: env.PATH || '' } }));
    } catch (error) { finish({ spawnError: String(error && error.message || error).slice(0, 120) }); return; }
    child.onData((data) => { out += data; });
    child.onExit(({ exitCode }) => finish({ exitCode }));
    onSpawn(child);
  });
}

/**
 * B-105, B-102: proves a built app runs the agent console's PTY as the console does. First a fixed
 * echo must print its token and exit by itself; then a waiting shell is stopped the way Stop stops a
 * session and must end with no process forked meanwhile (on Windows a fork starts a second app).
 * Answers ok, or failed with a short reason (load, spawn, no output, no exit, stop: ...).
 * `childProcess` is the module node-pty forks through; its `fork` is counted during the stop.
 */
async function checkPty({ loadPty, platform = process.platform, env = process.env, timeoutMs = 15_000, setTimer = setTimeout, clearTimer = clearTimeout, childProcess = require('node:child_process') }) {
  let pty;
  try { pty = loadPty(); } catch (error) { return { outcome: 'failed', reason: `load: ${String(error && error.message || error).slice(0, 120)}` }; }
  const timing = { timeoutMs, setTimer, clearTimer };
  const echo = await runInPty(pty, platform, env, ptyCheckCommand(platform, env), timing);
  if (echo.spawnError) return { outcome: 'failed', reason: `spawn: ${echo.spawnError}` };
  const printed = echo.out.includes(PTY_CHECK_TOKEN);
  if (echo.timeout) return { outcome: 'failed', reason: printed ? 'no exit' : 'no output' };
  if (!printed) return { outcome: 'failed', reason: 'no output' };
  if (echo.exitCode !== 0) return { outcome: 'failed', reason: `exit ${echo.exitCode}` };

  const fork = childProcess.fork;
  let forks = 0;
  childProcess.fork = function counted(...args) { forks++; return fork.apply(this, args); };
  try {
    const held = await runInPty(pty, platform, env, ptyHoldCommand(platform, env), { ...timing, onSpawn: (child) => setTimer(() => { try { child.kill(); } catch { /* gone */ } }, 500) });
    if (held.spawnError) return { outcome: 'failed', reason: `stop: spawn: ${held.spawnError}` };
    if (forks) return { outcome: 'failed', reason: `stop: forked ${forks}` };
    if (held.timeout) return { outcome: 'failed', reason: 'stop: no exit' };
  } finally { childProcess.fork = fork; }
  return { outcome: 'ok' };
}

module.exports = { createConsole, findRuntimes, searchPath, sessionEnv, mcpConfig, briefFor, ring, checkPty, ptyCheckCommand, ptyHoldCommand, ptyOptions, PTY_CHECK_TOKEN, RUNTIMES, LEVELS };
