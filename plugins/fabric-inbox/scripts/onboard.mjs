#!/usr/bin/env node
// Fabric Inbox connected to a coding agent by the agent itself (agents first, board B-79; guide:
// docs/agents/onboard.md in passioncode-ai/fabric-inbox). The person does only what is theirs: sign
// in to Fabric Inbox and allow the key. No dependency: it runs from the plugin as installed.
//
//   node onboard.mjs connect  [--level read|mail|admin] [--send] [--client NAME] [--client-id ID]
//   node onboard.mjs register [--name fabric-inbox] [--scope user|local|project] [--replace]
//   node onboard.mjs prove
//   node onboard.mjs status   [--json]
//   node onboard.mjs forget   (removes the stored key and record; the key itself is revoked in the app)
//
// --json makes every step a JSON line ({ step, outcome, detail, human? }) for a launcher that runs
// Inbox as one step of a family setup (B-81). The agent key goes from the app straight into the
// system's key store and is read back only by headers.mjs (Claude Code's headersHelper); it never
// reaches an argument, stdout, Claude Code's config or the record.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyStore, OnboardError, readRecord, recordPath } from './headers.mjs';

export { keyStore, OnboardError, readRecord, recordPath };
const LEVELS = ['read', 'mail', 'admin'];

const run = (file, args, { input } = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
    (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout))));
  if (input !== undefined) child.stdin.end(input);
});

export function writeRecord(record, file = recordPath()) {
  for (const key of Object.keys(record)) if (/secret|token/i.test(key)) throw new Error(`The record must not hold ${key}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------- step: the key

/** Opens a link with the system's own handler (the Fabric Inbox app owns fabric-inbox://). */
function openLink(link) {
  const [file, args] = process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', link]] : ['xdg-open', [link]];
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Asks the signed-in app for a key (ADR-0115 connect link): a one-shot listener on this machine
 * receives it after the person allows. The key goes straight into the key store.
 */
export async function stepConnect(opts, { say, store = keyStore(), open = openLink, timeoutMs = 180000 } = {}) {
  const level = opts.level || 'mail';
  if (!LEVELS.includes(level)) throw new OnboardError('level', `--level is ${LEVELS.join(', ')}.`);
  const client = String(opts.client || 'Claude Code (onboard)').slice(0, 80);
  const clientId = String(opts['client-id'] || 'claude-code');
  const state = randomBytes(24).toString('base64url');
  let finish;
  const answered = new Promise((resolve) => { finish = resolve; });
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/fabric-inbox/callback') { res.writeHead(404).end(); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let value = null;
      try { value = JSON.parse(body); } catch { /* answered below */ }
      if (!value || value.state !== state) { res.writeHead(400).end(); return; }
      res.writeHead(204).end();
      finish(value);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const link = `fabric-inbox://connect?${new URLSearchParams({ client, client_id: clientId, level, send: opts.send ? 'send' : 'drafts', state,
    callback: `http://127.0.0.1:${port}/fabric-inbox/callback` })}`;
  say({ step: 'connect', outcome: 'waiting', detail: `Asked Fabric Inbox for a ${level} key`,
    human: 'Fabric Inbox asks whether to give this agent a key: check the name and the level, then choose Allow.' });
  open(link);
  const timer = setTimeout(() => finish({ outcome: 'failed', error: 'timeout' }), timeoutMs);
  const answer = await answered;
  clearTimeout(timer);
  server.close();
  if (answer.outcome === 'denied') throw new OnboardError('denied', 'The person chose Deny; no key was made.');
  if (answer.outcome !== 'connected') {
    const why = { timeout: 'Nobody answered within 3 minutes. Is Fabric Inbox installed and signed in?', no_server: 'Fabric Inbox has no server yet: enter it and sign in first.',
      not_answered: 'The prompt closed without an answer.', listener_is_self: 'The callback was taken by Fabric Inbox itself.' }[answer.error] || `Fabric Inbox could not make the key (${answer.error}).`;
    throw new OnboardError(answer.error || 'failed', why);
  }
  const host = new URL(answer.server).host;
  await store.put(host, { clientId: answer.key.clientId, clientSecret: answer.clientSecret });
  if (!(await store.get(host))) throw new OnboardError('key_store', 'The key could not be read back from the key store; it was not kept. Revoke it in Settings → Agent access.');
  const record = { ...readRecord(), server: answer.server, mcpUrl: answer.mcpUrl,
    key: { id: answer.key.id, clientId: answer.key.clientId, level: answer.key.level, send: answer.key.send, expiresAt: answer.key.expiresAt } };
  writeRecord(record);
  say({ step: 'connect', outcome: 'done', detail: `Key ${answer.key.id} (${answer.key.level}, ${answer.key.send}) kept in the system key store` });
  return record;
}

// ---------------------------------------------------------------- step: register and prove

/** Where the headers helper is kept: beside the record, so a plugin update never moves it. */
export const helperPath = (record = recordPath()) => path.join(path.dirname(record), 'headers.mjs');
export function headersCommand(server, node = process.execPath, helper = helperPath()) {
  const quote = (v) => (process.platform === 'win32' ? `"${v}"` : `'${String(v).replace(/'/g, "'\\''")}'`);
  return `${quote(node)} ${quote(helper)} --server ${quote(server)}`;
}

/** Claude Code's MCP entry for the server: the URL and a headersHelper, never the secret itself. */
export function mcpEntry(record) {
  if (!record.mcpUrl || !record.server) throw new OnboardError('no_key', 'No key yet: run connect first.');
  return { type: 'http', url: record.mcpUrl, headersHelper: headersCommand(record.server) };
}

export async function stepRegister(opts, { say, exec = run } = {}) {
  const record = readRecord();
  const entry = mcpEntry(record);
  const name = opts.name || 'fabric-inbox';
  mkdirSync(path.dirname(helperPath()), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./headers.mjs', import.meta.url)), helperPath());
  const scope = opts.scope || 'user';
  // An entry of that name is replaced only when it is this server's, or when asked: never someone else's.
  const existing = await exec('claude', ['mcp', 'get', name]).catch(() => '');
  if (existing && !existing.includes(entry.url) && !opts.replace) {
    throw new OnboardError('exists', `Claude Code already has an MCP server named "${name}" for another address. Pass --name with another name, or --replace.`);
  }
  if (existing) await exec('claude', ['mcp', 'remove', '--scope', scope, name]).catch(() => {});
  try { await exec('claude', ['mcp', 'add-json', '--scope', scope, name, JSON.stringify(entry)]); }
  catch (error) {
    throw new OnboardError('register', `claude mcp add-json failed (${String(error.stderr || error.message).trim().slice(0, 200)}). For another MCP client, use: ${JSON.stringify(entry)}`);
  }
  writeRecord({ ...record, registered: { client: 'claude-code', name, scope } });
  say({ step: 'register', outcome: 'done', detail: `Claude Code knows "${name}" (${scope} scope); its headers come from the key store` });
  return entry;
}

/**
 * One JSON-RPC request over MCP's streamable HTTP: the answer is JSON, or server-sent events whose
 * data lines carry it. No SDK, so this file runs from the plugin with nothing installed.
 */
export async function rpc(url, headers, body, session, doFetch = fetch) {
  const response = await doFetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify(body) });
  if (response.status >= 300 && response.status < 400) throw new OnboardError('prove', `The server redirected (${response.status}); is the key wrong or expired?`);
  if (response.status === 202) return { result: null, session: response.headers.get('mcp-session-id') || session };
  if (!response.ok) throw new OnboardError('prove', `The server answered ${response.status}${response.status === 401 || response.status === 403 ? ' (the key is not accepted)' : ''}.`);
  const text = await response.text();
  const json = (response.headers.get('content-type') || '').includes('text/event-stream')
    ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === body.id)
    : JSON.parse(text);
  if (!json) throw new OnboardError('prove', 'The server sent no answer.');
  if (json.error) throw new OnboardError('prove', `The server refused ${body.method}: ${json.error.message}`);
  return { result: json.result, session: response.headers.get('mcp-session-id') || session };
}

export async function stepProve(_opts, { say, store = keyStore(), doFetch = fetch } = {}) {
  const record = readRecord();
  if (!record.mcpUrl) throw new OnboardError('no_key', 'No key yet: run connect first.');
  const key = await store.get(new URL(record.server).host);
  if (!key) throw new OnboardError('no_key', 'The key is not in the key store: run connect again.');
  const h = { 'CF-Access-Client-Id': key.clientId, 'CF-Access-Client-Secret': key.clientSecret };
  let { session } = await rpc(record.mcpUrl, h, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fabric-inbox-onboard', version: '1' } } }, undefined, doFetch);
  ({ session } = await rpc(record.mcpUrl, h, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, doFetch));
  const list = await rpc(record.mcpUrl, h, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session, doFetch);
  const call = await rpc(record.mcpUrl, h, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } }, session, doFetch);
  if (call.result?.isError) throw new OnboardError('prove', 'list_accounts answered with an error.');
  const text = (call.result?.content || []).map((c) => c.text || '').join('');
  let accounts = null;
  try { accounts = JSON.parse(text).accounts?.length ?? null; } catch { /* counted as unknown */ }
  const tools = list.result?.tools?.length ?? 0;
  say({ step: 'prove', outcome: 'done', detail: `${tools} tools; list_accounts answered${accounts === null ? '' : ` with ${accounts} accounts`}` });
  return { tools, accounts };
}

/** Where this machine stands, step by step, for a person or a launcher. Never a secret. */
export async function status({ store = keyStore(), exec = run } = {}) {
  const record = readRecord();
  const steps = [];
  steps.push({ step: 'server', outcome: record.server ? 'done' : 'todo', detail: record.server || null });
  const key = record.server ? await store.get(new URL(record.server).host) : null;
  steps.push({ step: 'connect', outcome: record.key && key ? 'done' : 'todo', detail: record.key ? `${record.key.id} (${record.key.level})` : null });
  let registered = false;
  if (record.registered) {
    const list = await exec('claude', ['mcp', 'get', record.registered.name]).catch(() => '');
    registered = list.includes(record.mcpUrl || '\u0000');
  }
  steps.push({ step: 'register', outcome: registered ? 'done' : 'todo', detail: record.registered ? record.registered.name : null });
  return { record: recordPath(), steps };
}

// ---------------------------------------------------------------- command line

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
    if (!m) throw new OnboardError('usage', `Unexpected argument ${rest[i]}`);
    const [, key, inline] = m;
    if (key === 'token') throw new OnboardError('usage', 'The token is never an argument: use the hidden prompt, or --token-env NAME.');
    if (['json', 'send', 'replace'].includes(key)) opts[key] = true;
    else opts[key] = inline ?? rest[++i];
  }
  return { command, opts };
}

export function sayer(opts) {
  return (event) => {
    if (opts.json) { process.stdout.write(JSON.stringify(event) + '\n'); return; }
    process.stderr.write(`${event.outcome === 'done' ? '✓' : event.outcome === 'failed' ? '✗' : '…'} ${event.step}: ${event.detail ?? ''}\n`);
    if (event.human) process.stderr.write(`  → You: ${event.human}\n`);
  };
}

/** Runs one command; `extra` lets the repository's onboard.mjs add its own (server). */
export async function main(argv = process.argv.slice(2), extra = {}) {
  let command = argv[0];
  let say = sayer({});
  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    const opts = parsed.opts;
    say = sayer(opts);
    if (command === 'status') { const s = await status(); if (opts.json) process.stdout.write(JSON.stringify(s) + '\n'); else for (const x of s.steps) say(x); return; }
    if (extra[command]) await extra[command](opts, { say });
    else if (command === 'connect') await stepConnect(opts, { say });
    else if (command === 'register') await stepRegister(opts, { say });
    else if (command === 'prove') await stepProve(opts, { say });
    else if (command === 'forget') {
      const record = readRecord();
      if (record.server) await keyStore().remove(new URL(record.server).host);
      rmSync(recordPath(), { force: true });
      say({ step: 'forget', outcome: 'done', detail: 'Removed the stored key and record. Revoke the key itself in Settings → Agent access.' });
    } else throw new OnboardError('usage', `Commands: ${[...Object.keys(extra), 'connect', 'register', 'prove', 'status', 'forget'].join(', ')} (docs/agents/onboard.md).`);
  } catch (error) {
    const code = error instanceof OnboardError ? error.code : 'unexpected';
    say({ step: command || 'onboard', outcome: 'failed', detail: error.message, code, ...(error.human ? { human: error.human } : {}) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
