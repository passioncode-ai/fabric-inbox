#!/usr/bin/env node
// B-215: give people mailboxes on a shared Fabric Inbox server, take them back, and issue agent keys, from a script,
// over the server's own agent protocol (/mcp) with an Admin agent key. Each act is the tool an agent would call:
// list_members, save_member, remove_member, sync_member_sign_in, create_agent_key. A key the owner let manage people
// or keys (Settings → Agent access, or scripts/agent-standing.mjs) confirms these with its own code, so nothing waits
// for a person; otherwise the script says the act waits for the owner's approval and exits 3.
//
//   FABRIC_INBOX_MCP_URL=https://<server>/mcp FABRIC_INBOX_CLIENT_ID=… FABRIC_INBOX_CLIENT_SECRET=… \
//     node scripts/members.mjs <command> …
//
//   list                                            who is on the list, what they reach, whether they can sign in
//   grant <email> --mailbox a,b [--read b] [--agents a]   a member with these mailboxes (read: read only; agents: also
//                                                   choose the mailbox's agent); a mailbox is cloudflare:<address>,
//                                                   gmail:<id>, or a bare address
//   remove <email>                                  takes the person off the list and out of the sign-in
//   sign-in                                         lets the listed people through the sign-in again
//   key <name> --level read|mail|admin [--mailbox a,b] [--duration 30d|90d|1y] [--send drafts|send]
//       --vault <project>/<env>                     issues a key and puts FABRIC_INBOX_MCP_URL, FABRIC_INBOX_CLIENT_ID
//                                                   and FABRIC_INBOX_CLIENT_SECRET into Project Observatory's vault
//                                                   (vault.py put, value on stdin); the secret is never printed
//
// Run the credentials through the vault, never in argv:
//   OBSERVATORY_VAULT_ONLY=1 python3 "$(project-observatory full-path)/tools/use_secret.py" run --vault-only --env prod \
//     <project> FABRIC_INBOX_MCP_URL FABRIC_INBOX_CLIENT_ID FABRIC_INBOX_CLIENT_SECRET -- node scripts/members.mjs list
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VAULT_SLOTS = ['FABRIC_INBOX_MCP_URL', 'FABRIC_INBOX_CLIENT_ID', 'FABRIC_INBOX_CLIENT_SECRET'];

/** The command line as a command, its positional words and its options; an unknown option is refused. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const known = new Set(['--mailbox', '--read', '--agents', '--level', '--duration', '--send', '--vault', '--role']);
  const words = [], options = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { words.push(a); continue; }
    if (!known.has(a)) throw new UsageError(`Unknown option ${a}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${a} needs a value`);
    options[a.slice(2)] = value;
  }
  return { command, words, options };
}

export class UsageError extends Error {}
const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
/** A bare address is a Cloudflare mailbox, as the server's own list names it. */
export const mailboxId = (x) => (x.includes(':') ? x : `cloudflare:${x}`).toLowerCase();

/** The tool call and its arguments for a command, or a usage error. */
export function planOf({ command, words, options }) {
  switch (command) {
    case 'list': return { tool: 'list_members', args: {} };
    case 'sign-in': return { tool: 'sync_member_sign_in', args: {} };
    case 'remove':
      if (words.length !== 1) throw new UsageError('remove <email>');
      return { tool: 'remove_member', args: { email: words[0] } };
    case 'grant': {
      if (words.length !== 1) throw new UsageError('grant <email> --mailbox a,b [--read b] [--agents a]');
      const role = options.role ?? 'member';
      if (role === 'admin') return { tool: 'save_member', args: { email: words[0], role: 'admin' } };
      const accounts = list(options.mailbox).map(mailboxId);
      if (!accounts.length) throw new UsageError('A member needs at least one --mailbox');
      const readOnly = list(options.read).map(mailboxId), chooseAgent = list(options.agents).map(mailboxId);
      const stray = [...readOnly, ...chooseAgent].filter((m) => !accounts.includes(m));
      if (stray.length) throw new UsageError(`--read and --agents name only --mailbox mailboxes: ${stray.join(', ')}`);
      return { tool: 'save_member', args: { email: words[0], role: 'member', accounts, ...(readOnly.length ? { readOnly } : {}), ...(chooseAgent.length ? { chooseAgent } : {}) } };
    }
    case 'key': {
      if (words.length !== 1) throw new UsageError('key <name> --level read|mail|admin --vault <project>/<env>');
      if (!['read', 'mail', 'admin'].includes(options.level)) throw new UsageError('--level read, mail or admin');
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(options.vault ?? '')) throw new UsageError('--vault <project>/<env>: the key goes into the vault, never to the screen');
      const accounts = list(options.mailbox).map(mailboxId);
      return { tool: 'create_agent_key', vault: options.vault, args: { name: words[0], level: options.level, ...(accounts.length ? { accounts } : {}),
        ...(options.duration ? { duration: options.duration } : {}), ...(options.send ? { send: options.send } : {}) } };
    }
    default: throw new UsageError('Commands: list, grant, remove, sign-in, key');
  }
}

/**
 * Calls a tool and, when it answers with its own confirmation code, calls it again with the code (the key's own
 * confirmation). An act that waits for the owner's approval is returned as it is, never retried.
 */
export async function runTool(call, tool, args) {
  const first = await call(tool, args);
  if (first?.needsConfirmation && first.confirm) return { done: true, answer: await call(tool, { ...args, confirm: first.confirm }) };
  if (first?.needsApproval) return { done: false, answer: first };
  return { done: !first?.error, answer: first };
}

/** An MCP client over streamable HTTP with an Access service token; the secret stays in a header. */
export function mcpClient(url, clientId, clientSecret, fetcher = fetch) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret };
  const parse = async (r) => {
    const text = await r.text();
    if (!r.ok) throw new Error(`The server answered ${r.status}${r.status === 403 ? ': the key is not let in (wrong, revoked or expired)' : ''}`);
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line ? line.slice(5) : text);
  };
  let id = 0, ready = null;
  const post = (body) => fetcher(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const start = async () => {
    const r = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fabric-inbox-members', version: '1' } } });
    const session = r.headers.get('mcp-session-id');
    await parse(r);
    if (session) headers['mcp-session-id'] = session;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  };
  return async (tool, args) => {
    ready ??= start();
    await ready;
    const j = await parse(await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }));
    if (j.error) return { error: j.error.message ?? String(j.error) };
    const content = j.result?.structuredContent ?? j.result?.content?.[0]?.text;
    const value = typeof content === 'string' ? (() => { try { return JSON.parse(content); } catch { return { text: content }; } })() : content;
    return j.result?.isError && value && !value.error ? { error: value.text ?? 'refused' } : value;
  };
}

/** Puts one value into Project Observatory's vault on stdin; nothing of it reaches argv, the screen or a log. */
export function vaultPut(project, env, name, value) {
  const engine = execFileSync('project-observatory', ['full-path'], { encoding: 'utf8' }).trim();
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [join(engine, 'tools', 'vault.py'), 'put', project, env, name], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, OBSERVATORY_VAULT_ONLY: '1' } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`vault.py put ${name} failed (${code}): ${err.trim().slice(0, 300)}`))));
    child.stdin.end(value);
  });
}

async function main() {
  let plan;
  try { plan = planOf(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exit(2); }
  const url = process.env.FABRIC_INBOX_MCP_URL, clientId = process.env.FABRIC_INBOX_CLIENT_ID, secret = process.env.FABRIC_INBOX_CLIENT_SECRET;
  if (!url || !clientId || !secret) { console.error(`Set ${VAULT_SLOTS.join(', ')} (through use_secret.py run, never in argv).`); process.exit(2); }
  const call = mcpClient(url, clientId, secret);
  const { done, answer } = await runTool(call, plan.tool, plan.args);
  if (!done) {
    console.error(answer?.needsApproval ? `Waits for the owner's approval in Settings → Agent access: ${answer.summary}` : `Refused: ${answer?.error ?? JSON.stringify(answer)}`);
    process.exit(answer?.needsApproval ? 3 : 1);
  }
  if (plan.vault) {
    const [project, env] = plan.vault.split('/');
    const values = { FABRIC_INBOX_MCP_URL: answer.mcpUrl, FABRIC_INBOX_CLIENT_ID: answer.key?.clientId, FABRIC_INBOX_CLIENT_SECRET: answer.clientSecret };
    if (Object.values(values).some((v) => !v)) { console.error('The server answered without the key\'s values; revoke it in Agent access and try again.'); process.exit(1); }
    for (const name of VAULT_SLOTS) await vaultPut(project, env, name, values[name]);
    console.log(JSON.stringify({ key: answer.key.id, name: answer.key.name, level: answer.key.level, accounts: answer.key.accounts, expiresAt: answer.key.expiresAt, vault: `${project}/${env}`, slots: VAULT_SLOTS }));
    return;
  }
  console.log(JSON.stringify(answer, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
