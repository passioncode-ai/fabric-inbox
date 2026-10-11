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
  let state = { phase: 'idle' };
  const out = ring();
  const set = (next) => { state = next; onState(state); };
  const leftoversFile = path.join(dir, 'keys.json');

  async function remember(ids) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.writeFile(leftoversFile, JSON.stringify(ids), { mode: 0o600 }); }
  async function recorded() { try { return JSON.parse(await fs.readFile(leftoversFile, 'utf8')); } catch { return []; } }

  async function end(reason, code) {
    if (!session) return;
    const s = session; session = null;
    const revoked = await revoke(s.keyId).catch(() => false);
    if (revoked) await remember((await recorded()).filter((id) => id !== s.keyId)).catch(() => {});
    await fs.rm(s.folder, { recursive: true, force: true }).catch(() => {});
    log({ event: 'console', outcome: 'ended', runtime: s.runtime, reason, code: code ?? null, revoked });
    set({ phase: 'ended', reason, code: code ?? null, runtime: s.runtime, keyRevoked: revoked });
  }

  return {
    state: () => state,
    output: () => out.text(),

    /** Opens the agent: a key for this session, its config, then the PTY. */
    async start({ runtime, level = 'admin', resume = false, cols = 100, rows = 30 }) {
      if (session) return { ok: false, error: 'running' };
      if (!LEVELS.includes(level)) return { ok: false, error: 'level' };
      const spec = RUNTIMES.find((r) => r.id === runtime?.id);
      if (!spec || !runtime.file) return { ok: false, error: 'runtime' };
      set({ phase: 'starting', runtime: spec.id });
      // A key an earlier session could not revoke (a crash, a forced quit) goes before a new one is made.
      await this.leftovers().catch(() => {});
      const minted = await mint({ name: `Agent console (${spec.name})`, level, send: level === 'read' ? 'drafts' : 'send', dailySendLimit: 50, duration: '30d' });
      if (!minted.ok) { set({ phase: 'idle', error: minted.signIn ? 'sign_in' : 'key', detail: minted.error || null }); return { ok: false, error: minted.signIn ? 'sign_in' : 'key', detail: minted.error }; }
      const key = { id: minted.data.key.id, clientId: minted.data.key.clientId, clientSecret: minted.data.clientSecret };
      await remember([...(await recorded()), key.id]).catch(() => {});
      const tag = crypto.randomBytes(6).toString('hex').toUpperCase();
      const names = { id: `FABRIC_INBOX_CONSOLE_ID_${tag}`, secret: `FABRIC_INBOX_CONSOLE_SECRET_${tag}` };
      const folder = path.join(dir, `session-${tag.toLowerCase()}`);
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const configPath = path.join(folder, 'mcp.json');
      await fs.writeFile(configPath, JSON.stringify(mcpConfig(mcpUrl, names), null, 2), { mode: 0o600 });
      let child;
      try {
        child = pty.spawn(runtime.file, spec.args({ configPath, brief: briefFor(origin), mcpUrl, env: names, resume }), {
          name: 'xterm-256color', cols: Math.max(2, Math.min(1000, cols | 0)), rows: Math.max(1, Math.min(500, rows | 0)), cwd,
          env: sessionEnv(env, { loginPath, names, key, origin }),
        });
      } catch (error) {
        session = { keyId: key.id, folder, runtime: spec.id };
        await end('spawn_failed');
        return { ok: false, error: 'spawn', detail: String(error && error.message || error) };
      }
      session = { child, keyId: key.id, folder, runtime: spec.id, level };
      child.onData((data) => { out.push(data); onData(data); });
      child.onExit(({ exitCode }) => { void end(session?.stopping ? 'stopped' : 'exited', exitCode); });
      log({ event: 'console', outcome: 'started', runtime: spec.id, level, resume });
      set({ phase: 'running', runtime: spec.id, level });
      return { ok: true };
    },

    write(data) { if (session && typeof data === 'string' && data.length <= 1024 * 1024) session.child.write(data); },
    resize(cols, rows) { if (session) session.child.resize(Math.max(2, Math.min(1000, cols | 0)), Math.max(1, Math.min(500, rows | 0))); },

    /** Hang up the agent's whole process group, then kill it if it is still there (PL-07: taskkill on Windows). */
    async stop() {
      if (!session) return;
      session.stopping = true;
      const pid = session.child.pid;
      try {
        if (platform === 'win32') session.child.kill();
        else kill(-pid, 'SIGHUP');
      } catch { try { session.child.kill(); } catch { /* gone */ } }
      setTimer(() => { if (session && session.child.pid === pid) { try { session.child.kill('SIGKILL'); } catch { /* gone */ } } }, STOP_GRACE_MS);
    },

    /** At start: keys of sessions the app could not end (a crash, a forced quit) are revoked. */
    async leftovers() {
      const ids = await recorded();
      const kept = [];
      for (const id of ids) if (!(await revoke(id).catch(() => false))) kept.push(id);
      if (ids.length) { await remember(kept).catch(() => {}); log({ event: 'console', outcome: 'leftovers', revoked: ids.length - kept.length, kept: kept.length }); }
      return { revoked: ids.length - kept.length, kept: kept.length };
    },

    running: () => !!session,
  };
}

module.exports = { createConsole, findRuntimes, searchPath, sessionEnv, mcpConfig, briefFor, ring, RUNTIMES, LEVELS };
