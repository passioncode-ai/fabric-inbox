#!/usr/bin/env node
// B-215: what an Admin agent key may do without the owner's approval (people: a member's mailboxes and sign-in;
// keys: issuing and revoking keys), set by whoever holds the Cloudflare token of the server's account. That token
// already owns the server (it deploys its code and reads its storage), so it may make the owner's choice of Settings →
// Agent access, with no person clicking. It writes the same record the app writes (config/agent-keys.json in the
// server's R2 bucket) and one line of the People record (audit/, actor "account-token"). No agent tool reaches this.
//
//   OBSERVATORY_VAULT_ONLY=1 python3 "$(project-observatory full-path)/tools/use_secret.py" run --vault-only --env prod \
//     <project> CLOUDFLARE_API_TOKEN -- env CLOUDFLARE_ACCOUNT_ID=<account> \
//     node scripts/agent-standing.mjs --bucket <bucket> [--key <key id> (--set people,keys | --clear)]
//
// Without --key it lists the keys with their level and what they may do without the owner.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const KEYS_OBJECT = 'config/agent-keys.json';
const STANDINGS = ['people', 'keys'];
const MAX_TIME = 9_999_999_999_999;

/** The keys record with one key's standing set; refused for a key that is not there or not Admin. */
export function applyStanding(record, keyId, standing) {
  const keys = Array.isArray(record?.keys) ? record.keys : null;
  if (!keys) throw new Error(`${KEYS_OBJECT} holds no keys`);
  const key = keys.find((k) => k?.id === keyId);
  if (!key) throw new Error(`No agent key ${keyId} on this server`);
  const next = STANDINGS.filter((s) => standing.includes(s));
  if (next.length && key.level !== 'admin') throw new Error(`${keyId} is a ${key.level} key; only an Admin key can manage people and keys without the owner`);
  const previous = STANDINGS.filter((s) => (key.standing ?? []).includes(s));
  const changed = { ...key };
  delete changed.standing;
  if (next.length) changed.standing = next;
  return { record: { ...record, keys: keys.map((k) => (k.id === keyId ? changed : k)) }, previous, standing: next, name: key.name ?? keyId };
}

/** One People record entry, keyed as the server keys them (workers/lib/audit.ts), newest first. */
export function auditEntry(entry, now = Date.now()) {
  const id = randomUUID();
  const key = `audit/${String(MAX_TIME - now).padStart(13, '0')}-999999-${id}`;
  return { key, body: { ...entry, id, at: new Date(now).toISOString(), actor: 'account-token' } };
}

function wrangler(args, input) {
  const r = spawnSync('npx', ['--no-install', 'wrangler', ...args], { encoding: 'utf8', input, env: process.env, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  return r.stdout;
}
const read = (bucket) => JSON.parse(wrangler(['r2', 'object', 'get', `${bucket}/${KEYS_OBJECT}`, '--remote', '--pipe']));
function write(bucket, key, value) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-standing-'));
  try {
    const file = join(dir, 'object.json');
    writeFileSync(file, JSON.stringify(value));
    wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--file', file, '--content-type', 'application/json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const bucket = opt('--bucket'), keyId = opt('--key');
  if (!bucket || !process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error('Usage: --bucket <bucket> [--key <id> (--set people,keys | --clear)], with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set.');
    process.exit(2);
  }
  const record = read(bucket);
  if (!keyId) {
    for (const k of record.keys ?? []) console.log(JSON.stringify({ id: k.id, name: k.name, level: k.level, standing: k.standing ?? [] }));
    return;
  }
  const set = opt('--set');
  if (set === undefined && !args.includes('--clear')) { console.error('Say --set people,keys or --clear.'); process.exit(2); }
  const wanted = set ? set.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const unknown = wanted.filter((s) => !STANDINGS.includes(s));
  if (unknown.length) { console.error(`Unknown: ${unknown.join(', ')} (people, keys)`); process.exit(2); }
  const out = applyStanding(record, keyId, wanted);
  if (out.previous.join(',') === out.standing.join(',')) { console.log(JSON.stringify({ key: keyId, standing: out.standing, changed: false })); return; }
  write(bucket, KEYS_OBJECT, out.record);
  // Read back: a key the server added meanwhile would show as missing here, and is named.
  const after = read(bucket);
  const lost = (out.record.keys ?? []).map((k) => k.id).filter((id) => !(after.keys ?? []).some((k) => k.id === id));
  const ours = (after.keys ?? []).find((k) => k.id === keyId);
  if (!ours || (ours.standing ?? []).join(',') !== out.standing.join(',')) { console.error('The record changed while it was written; run again.'); process.exit(1); }
  const audit = auditEntry({ kind: 'key_standing_set', key: keyId, name: out.name, standing: out.standing, previous: out.previous });
  write(bucket, audit.key, audit.body);
  console.log(JSON.stringify({ key: keyId, standing: out.standing, previous: out.previous, changed: true, ...(lost.length ? { warning: `keys missing after the write: ${lost.join(', ')}` } : {}) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
