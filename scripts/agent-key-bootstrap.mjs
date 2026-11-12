#!/usr/bin/env node
// B-218: the first Admin agent key of a server, made with the Cloudflare token of the server's account, with no person
// signing in. It does what `POST /api/agent-keys` does (workers/routes/agent-keys.ts) and nothing more: an Access
// service token, that token in the server's agents policy (keeping the owner's sign-in policies), the key in
// config/agent-keys.json in the server's bucket (createdBy "account-token"), and, with --standing, the key's standing
// (B-215) with its People record line. The key's three values go to Project Observatory's vault on stdin; only the
// key's id is printed. A token Cloudflare made but the server's record could not take is deleted again.
//
//   OBSERVATORY_VAULT_ONLY=1 python3 "$(project-observatory full-path)/tools/use_secret.py" run --vault-only --env prod \
//     <project> CLOUDFLARE_API_TOKEN -- env CLOUDFLARE_ACCOUNT_ID=<account> \
//     node scripts/agent-key-bootstrap.mjs --host <server host> --bucket <bucket> --name <key name> --vault <project/env> \
//       [--standing people,keys] [--duration 8760h]
//
// The vault slots are FABRIC_INBOX_MCP_URL, FABRIC_INBOX_CLIENT_ID and FABRIC_INBOX_CLIENT_SECRET (--slot-prefix
// changes FABRIC_INBOX_ for a second server in one project). --vault-host <ssh host> puts them in the vault of another
// machine or space instead (its own `vault.py put`, the value on ssh's stdin, never in its argv): a Studio space gets
// its own key without the value passing through this machine's vault. Seen working 2026-11-07, moving mailboxes to an
// organization's server (fabric-inbox docs/handoffs/2026-11-08-studio-move.md).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditEntry, KEYS_OBJECT } from './agent-standing.mjs';

export const MAX_KEYS = 50;
const STANDINGS = ['people', 'keys'];
const DURATIONS = new Set(['8760h', '17520h', '2160h', '720h', 'forever']);

/** The server's agents policy name for an Access application (workers/mcp/access.ts policyName). */
export const policyName = (aud) => `Fabric Inbox agents ${aud.slice(0, 12)}`;

/** The Access application that protects the host: by its domain, its self-hosted domains or its destinations. */
export function findApp(apps, host) {
  return apps.find((a) => a.domain === host || (a.self_hosted_domains ?? []).includes(host) || (a.destinations ?? []).some((d) => d.uri === host)) ?? null;
}

/** The agents policy's body with one more token, every token it already names kept. */
export function policyBody(aud, existing, tokenId) {
  const ids = [...new Set([...(existing?.include ?? []).map((r) => r.service_token?.token_id).filter(Boolean), tokenId])];
  return { name: policyName(aud), decision: 'non_identity', include: ids.map((id) => ({ service_token: { token_id: id } })) };
}

/**
 * The application's policies with the agents policy added after the owner's own; null when it is already there.
 * An application with no policy of its own is refused: a server always has its owner's sign-in policy, and adding
 * only the agents' one would leave the owner out.
 */
export function appPolicies(app, policyId) {
  const current = (app.policies ?? []).map((p, i) => ({ id: p.id, precedence: p.precedence ?? i + 1 }));
  if (current.some((p) => p.id === policyId)) return null;
  if (!current.length) throw new Error('The server\'s Access application has no sign-in policy of its own; left unchanged');
  return [...current, { id: policyId, precedence: Math.max(...current.map((p) => p.precedence)) + 1 }];
}

/** The keys record with the new key, as the server writes it; refused past MAX_KEYS or for a name already used. */
export function addKey(record, token, { name, standing = [] }, now = new Date()) {
  const keys = Array.isArray(record?.keys) ? record.keys : [];
  if (keys.length >= MAX_KEYS) throw new Error(`At most ${MAX_KEYS} agent keys; revoke one first`);
  if (keys.some((k) => k?.name === name)) throw new Error(`A key named "${name}" is already on this server; choose another name or revoke it first`);
  const given = STANDINGS.filter((s) => standing.includes(s));
  const key = {
    id: token.id, clientId: token.client_id, name, level: 'admin', send: 'send', dailySendLimit: 50,
    createdAt: now.toISOString(), expiresAt: token.expires_at ?? null, accounts: null, createdBy: 'account-token',
    ...(given.length ? { standing: given } : {}),
  };
  return { record: { ...(record ?? {}), keys: [...keys, key] }, key };
}

export function parseArgs(argv) {
  const out = { duration: '8760h', standing: [], slotPrefix: 'FABRIC_INBOX_' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--host') out.host = value;
    else if (flag === '--bucket') out.bucket = value;
    else if (flag === '--name') out.name = value;
    else if (flag === '--vault') out.vault = value;
    else if (flag === '--duration') out.duration = value;
    else if (flag === '--standing') out.standing = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--slot-prefix') out.slotPrefix = value;
    else if (flag === '--vault-host') out.vaultHost = value;
    else if (flag === '--token' || flag === '--secret') throw new Error(`${flag} is refused: a secret is never an argument`);
    else throw new Error(`Unknown argument ${flag}`);
    i++;
  }
  for (const need of ['host', 'bucket', 'name', 'vault']) if (!out[need]) throw new Error(`--${need} is required`);
  if (!/^[a-z0-9.-]+$/i.test(out.host)) throw new Error('--host is a host name, without a scheme or path');
  if (!/^[a-z0-9-]+\/[a-z]+$/i.test(out.vault)) throw new Error('--vault is <project>/<env>');
  if (!DURATIONS.has(out.duration)) throw new Error(`--duration is one of ${[...DURATIONS].join(', ')}`);
  const unknown = out.standing.filter((s) => !STANDINGS.includes(s));
  if (unknown.length) throw new Error(`--standing takes ${STANDINGS.join(',')}; not ${unknown.join(',')}`);
  if (!/^[A-Z][A-Z0-9_]*_$/.test(out.slotPrefix)) throw new Error('--slot-prefix is upper case and ends with _');
  if (out.vaultHost !== undefined && !/^[a-z0-9][a-z0-9.-]*$/i.test(out.vaultHost)) throw new Error('--vault-host is an ssh host name from ~/.ssh/config');
  return out;
}

function wrangler(args, input) {
  return spawnSync('npx', ['--no-install', 'wrangler', ...args], { encoding: 'utf8', input, env: process.env, maxBuffer: 16 * 1024 * 1024 });
}
function putObject(bucket, key, value) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-key-bootstrap-'));
  try {
    const file = join(dir, 'object.json');
    writeFileSync(file, JSON.stringify(value));
    const r = wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--file', file, '--content-type', 'application/json']);
    if (r.status !== 0) throw new Error(`writing ${key}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function readKeys(bucket) {
  const r = wrangler(['r2', 'object', 'get', `${bucket}/${KEYS_OBJECT}`, '--remote', '--pipe']);
  if (r.status === 0) return JSON.parse(r.stdout);
  if (/not found|does not exist|NoSuchKey|10007/i.test(r.stderr + r.stdout)) return { keys: [] };
  throw new Error(`reading ${KEYS_OBJECT}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
}
/** The command that puts one slot: this machine's vault, or with vaultHost the vault of that ssh host (a login shell, so
 *  its own `project-observatory` is found). Names only; the value goes on stdin. */
export function vaultPutCommand(project, env, slot, vaultHost) {
  if (vaultHost) {
    return ['ssh', ['-o', 'BatchMode=yes', vaultHost, 'zsh', '-lc',
      `'OBSERVATORY_VAULT_ONLY=1 python3 "$(project-observatory full-path)/tools/vault.py" put ${project} ${env} ${slot}'`]];
  }
  const engine = execFileSync('project-observatory', ['full-path'], { encoding: 'utf8' }).trim();
  return ['python3', [join(engine, 'tools', 'vault.py'), 'put', project, env, slot]];
}
const vaultPut = (project, env, slot, value, vaultHost) => new Promise((resolve, reject) => {
  const [cmd, args] = vaultPutCommand(project, env, slot, vaultHost);
  const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, OBSERVATORY_VAULT_ONLY: '1' } });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`vault put ${slot}: ${err.trim().slice(0, 200)}`))));
  child.stdin.end(value);
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID come from the environment (use_secret.py run)');
  const api = async (path, init = {}) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init,
      // Cloudflare refuses a request with no User-Agent (error 1010; docs/agents, 0e5e837).
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'fabric-inbox-agent-key-bootstrap' },
      body: init.body ? JSON.stringify(init.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
    return j.result;
  };
  const app = findApp(await api(`/accounts/${account}/access/apps?per_page=100`), opts.host);
  if (!app) throw new Error(`No Access application protects ${opts.host} in this account`);
  // The record first, so a failure before the token exists leaves nothing behind.
  const record = readKeys(opts.bucket);
  addKey(record, { id: 'check', client_id: 'check' }, opts);
  const made = await api(`/accounts/${account}/access/service_tokens`, { method: 'POST', body: { name: `Fabric Inbox agent: ${opts.name}`.slice(0, 120), duration: opts.duration } });
  try {
    const policies = await api(`/accounts/${account}/access/policies?per_page=100`);
    const existing = policies.find((p) => p.name === policyName(app.aud)) ?? null;
    const body = policyBody(app.aud, existing, made.id);
    const policy = existing ? await api(`/accounts/${account}/access/policies/${existing.id}`, { method: 'PUT', body }) : await api(`/accounts/${account}/access/policies`, { method: 'POST', body });
    const full = await api(`/accounts/${account}/access/apps/${app.id}`);
    const next = appPolicies(full, policy.id);
    if (next) {
      const readOnly = new Set(['id', 'uid', 'aud', 'created_at', 'updated_at', 'policies']);
      const rest = Object.fromEntries(Object.entries(full).filter(([k]) => !readOnly.has(k)));
      const saved = await api(`/accounts/${account}/access/apps/${app.id}`, { method: 'PUT', body: { ...rest, policies: next } });
      const kept = new Set((saved.policies ?? []).map((p) => p.id));
      if (next.some((p) => !kept.has(p.id))) throw new Error('Cloudflare dropped one of the application\'s policies');
    }
    const { record: written, key } = addKey(readKeys(opts.bucket), made, opts);
    putObject(opts.bucket, KEYS_OBJECT, written);
    if (key.standing) {
      const line = auditEntry({ event: 'key_standing_set', keyId: key.id, name: key.name, standing: key.standing, previous: [] });
      putObject(opts.bucket, line.key, line.body);
    }
    const [project, env] = opts.vault.split('/');
    await vaultPut(project, env, `${opts.slotPrefix}MCP_URL`, `https://${opts.host}/mcp`, opts.vaultHost);
    await vaultPut(project, env, `${opts.slotPrefix}CLIENT_ID`, made.client_id, opts.vaultHost);
    await vaultPut(project, env, `${opts.slotPrefix}CLIENT_SECRET`, made.client_secret, opts.vaultHost);
    console.log(JSON.stringify({ event: 'agent_key_bootstrapped', key: key.id, name: key.name, level: key.level, standing: key.standing ?? [], expiresAt: key.expiresAt, vault: opts.vault, vaultHost: opts.vaultHost ?? null, slots: `${opts.slotPrefix}{MCP_URL,CLIENT_ID,CLIENT_SECRET}` }));
  } catch (error) {
    await api(`/accounts/${account}/access/service_tokens/${made.id}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error(JSON.stringify({ event: 'agent_key_bootstrap_failed', error: String(error?.message ?? error).slice(0, 400) })); process.exit(1); });
}
