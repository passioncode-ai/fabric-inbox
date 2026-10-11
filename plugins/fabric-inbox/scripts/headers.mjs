#!/usr/bin/env node
// Fabric Inbox agent key → MCP headers (B-79). Claude Code runs this as the server's headersHelper
// on every connection; it prints the two Cloudflare Access headers as JSON and nothing else. The key
// lives in the system's key store (macOS Keychain, Secret Service, Windows Credential Locker), put
// there by `onboard.mjs connect`; it is never in Claude Code's config, an argument or a file.
// Standalone on purpose: `onboard.mjs register` copies it beside the setup record, so an update of
// the plugin never moves the command Claude Code runs.
//
//   node headers.mjs [--server https://<server>]   (default: the record, or CLAUDE_CODE_MCP_SERVER_URL)
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE = 'fabric-inbox-agent-key';

export class OnboardError extends Error {
  constructor(code, message, human = null) { super(message); this.code = code; this.human = human; }
}

// Beside the shared PassionCode folder the app already keeps its server's backup in
// (desktop/backup.cjs), not in the app's own profile, which the app sweeps.
export function recordPath(platform = process.platform, env = process.env, home = os.homedir()) {
  const appData = platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(appData, 'PassionCode', 'fabric-inbox', 'onboard.json');
}
export function readRecord(file = recordPath()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

const run = (file, args, { input, env } = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, env: env ?? process.env },
    (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout))));
  if (input !== undefined) { child.stdin.end(input); }
});

/**
 * The agent key in the system's own key store, keyed by the server's host. The secret goes in on
 * stdin and comes back on stdout; it is never an argument (argv is visible to every process).
 */
export function keyStore(platform = process.platform, exec = run) {
  const q = (v) => `"${String(v).replace(/[\\"]/g, '\\$&')}"`;
  const ps = (script) => [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script]];
  const vault = '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;';
  return {
    async put(account, value) {
      // base64url: no quote or newline for `security -i` to parse.
      const secret = Buffer.from(JSON.stringify(value)).toString('base64url');
      if (platform === 'darwin') {
        // `security -i` reads its commands from stdin, so the secret is no process's argument.
        await exec('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} -l ${q(`Fabric Inbox agent key (${account})`)} -w ${q(secret)}\n` });
      } else if (platform === 'linux') {
        await exec('secret-tool', ['store', '--label', `Fabric Inbox agent key (${account})`, 'service', SERVICE, 'account', account], { input: secret });
      } else if (platform === 'win32') {
        const [file, args] = ps(`${vault} $s = [Console]::In.ReadToEnd(); try { $v.Remove($v.Retrieve('${SERVICE}', '${account}')) } catch {}; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', '${account}', $s)))`);
        await exec(file, args, { input: secret });
      } else throw new OnboardError('key_store', `No key store for ${platform}.`);
    },
    async get(account) {
      let out;
      try {
        if (platform === 'darwin') out = await exec('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
        else if (platform === 'linux') out = await exec('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
        else if (platform === 'win32') { const [file, args] = ps(`${vault} $c = $v.Retrieve('${SERVICE}', '${account}'); $c.RetrievePassword(); [Console]::Out.Write($c.Password)`); out = await exec(file, args); }
        else return null;
      } catch { return null; }
      try { const value = JSON.parse(Buffer.from(String(out).trim(), 'base64url').toString('utf8')); return value && value.clientId && value.clientSecret ? value : null; } catch { return null; }
    },
    async remove(account) {
      try {
        if (platform === 'darwin') await exec('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
        else if (platform === 'linux') await exec('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
        else if (platform === 'win32') { const [file, args] = ps(`${vault} $v.Remove($v.Retrieve('${SERVICE}', '${account}'))`); await exec(file, args); }
        return true;
      } catch { return false; }
    },
  };
}


/** The key's two headers for a server: from --server, the record, or Claude Code's own variable. */
export async function headers(opts = {}, { store = keyStore(), env = process.env } = {}) {
  const server = opts.server || readRecord().server || (env.CLAUDE_CODE_MCP_SERVER_URL && new URL(env.CLAUDE_CODE_MCP_SERVER_URL).origin);
  if (!server) throw new OnboardError('no_server', 'No server: pass --server.');
  const key = await store.get(new URL(server).host);
  if (!key) throw new OnboardError('no_key', 'No key for this server in the key store: run onboard connect.');
  return { 'CF-Access-Client-Id': key.clientId, 'CF-Access-Client-Secret': key.clientSecret };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--server');
  try { process.stdout.write(JSON.stringify(await headers(i > 0 ? { server: process.argv[i + 1] } : {}))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
