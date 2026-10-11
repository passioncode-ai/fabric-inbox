#!/usr/bin/env node
// Fabric Inbox set up by a coding agent (agents first, board B-79; guide: docs/agents/onboard.md).
// This file adds the step that needs this repository — the server in the person's Cloudflare
// account — to the plugin's dependency-free onboard (plugins/fabric-inbox/scripts/onboard.mjs:
// connect, register, prove, status, forget), which it runs for every other command.
//
//   node scripts/onboard.mjs server [--token-env NAME] [--account ID] [--subdomain NAME] [--team NAME] [--email ADDRESS] [--json]
//   node scripts/onboard.mjs connect | register | prove | status | forget   (see the plugin's onboard.mjs)
//
// The Cloudflare token is typed into a hidden prompt, or read from the environment variable
// --token-env names (for a runner that injects it); it is never an argument, and it goes only to
// Cloudflare and to the server's own secret, as the Mac app's Create my server does.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as core, OnboardError, readRecord, recordPath, writeRecord } from '../plugins/fabric-inbox/scripts/onboard.mjs';

export * from '../plugins/fabric-inbox/scripts/onboard.mjs';
export { headers } from '../plugins/fabric-inbox/scripts/headers.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- the Cloudflare token

/** The token from an environment variable named by --token-env, or typed into a hidden prompt. */
export async function readToken({ envName, env = process.env, stdin = process.stdin, stderr = process.stderr } = {}) {
  if (envName) {
    const value = String(env[envName] || '').trim();
    if (!value) throw new OnboardError('no_token', `${envName} is empty in this environment.`);
    return value;
  }
  if (!stdin.isTTY) throw new OnboardError('no_token', 'No terminal for the hidden prompt: run it in a terminal, or pass the variable name with --token-env.',
    'Run the command in a terminal and paste the Cloudflare API token when it asks; nothing you paste is shown.');
  stderr.write('Paste the Cloudflare API token (it is not shown), then press Enter: ');
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (error) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stderr.write('\n'); error ? reject(error) : resolve(value.trim()); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value.trim() ? null : new OnboardError('no_token', 'No token was pasted.'));
        if (ch === '\u0003') return done(new OnboardError('cancelled', 'Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------- step: the server

/** The server bundle the app would upload, built from this checkout when missing or stale. */
async function serverBundle(say) {
  const dir = path.join(root, 'desktop', 'server-bundle');
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { /* none yet */ }
  if (manifest?.version !== version) {
    say({ step: 'bundle', outcome: 'running', detail: `Building the server ${version} (npm run desktop:server-bundle)` });
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'desktop:server-bundle'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new OnboardError('bundle', `Building the server failed (exit ${code}).`))));
    });
  }
  say({ step: 'bundle', outcome: 'done', detail: `Server ${version}` });
  return dir;
}

export async function stepServer(opts, { say, deployer = require('../desktop/cloudflare-deploy.cjs'), token: given, bundle = serverBundle } = {}) {
  const token = given ?? await readToken({ envName: opts['token-env'] });
  const accounts = await deployer.accounts(token);
  if (!accounts.length) throw new OnboardError('no_account', 'The token reaches no Cloudflare account.');
  const account = opts.account ? accounts.find((a) => a.id === opts.account) : accounts.length === 1 ? accounts[0] : null;
  if (!account) throw new OnboardError('choose_account', `The token reaches ${accounts.length} accounts; pass --account with one of: ${accounts.map((a) => `${a.id} (${a.name})`).join(', ')}.`);
  const bundleDir = await bundle(say);
  const result = await deployer.deploy({ token, accountId: account.id, bundleDir, subdomain: opts.subdomain, team: opts.team, email: opts.email,
    onStep: (s) => say({ step: `server.${s.id}`, outcome: s.outcome, detail: s.detail }) });
  const record = { ...readRecord(), server: result.origin, accessOrigin: result.accessOrigin, account: account.id };
  writeRecord(record);
  // The app offers this server first on its welcome screen (B-80): the person confirms and signs in.
  writeFileSync(path.join(path.dirname(recordPath()), 'setup.json'), JSON.stringify({ format: 'fabric-inbox-setup/1', name: 'Set up by your coding agent',
    server: { origin: result.origin, accessOrigin: result.accessOrigin }, domains: [], mailboxes: [], createdBy: 'onboard', createdAt: new Date().toISOString() }, null, 2) + '\n');
  say({ step: 'server', outcome: 'done', detail: result.origin,
    human: `Open Fabric Inbox, choose "Use the server your agent set up" (or enter ${result.origin}) and sign in with the code sent to your email. Then the agent runs connect.` });
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await core(process.argv.slice(2), { server: stepServer });
