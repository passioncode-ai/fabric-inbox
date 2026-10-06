'use strict';
/**
 * Creates or updates a person's own Fabric Inbox server in their Cloudflare
 * account from the Mac app (CF-5, SCN-030). Runs in the main process only;
 * the token never reaches a web page and is never written to a log.
 *
 * Every step is idempotent, reported through onStep, and stops the run on
 * failure with what to do. Running again after a fix continues.
 *
 * Contracts (Cloudflare API v4, OpenAPI spec and wrangler 4 read 2026-09-28):
 *  GET  /accounts                                         accounts the token can use
 *  GET|PUT /accounts/{a}/workers/subdomain                the account's workers.dev name
 *  GET|POST /accounts/{a}/r2/buckets[/{name}]              mail storage
 *  GET|POST /accounts/{a}/access/organizations            Zero Trust team (sign-in page)
 *  GET|POST /accounts/{a}/access/identity_providers       one-time PIN by email
 *  GET|POST /accounts/{a}/access/apps                     the app guarding the server; its aud
 *  POST /accounts/{a}/workers/scripts/{s}/assets-upload-session, POST /accounts/{a}/workers/assets/upload?base64=true
 *  GET  /accounts/{a}/workers/scripts, GET /accounts/{a}/workers/scripts/{s}/settings
 *  PUT  /accounts/{a}/workers/scripts/{s}                 multipart: metadata + ES modules
 *  POST /accounts/{a}/workers/scripts/{s}/subdomain       serve on workers.dev
 */
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

const API = 'https://api.cloudflare.com/client/v4';
const DEFAULT_SCRIPT = 'fabric-inbox';
const DEFAULT_BUCKET = 'fabric-inbox';
const TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';

/** What the token needs: running the server (as on the Domains screen) plus creating it. */
const PERMISSIONS = [
  { scope: 'Account', name: 'Workers Scripts', level: 'Edit', for: 'create and update the server' },
  { scope: 'Account', name: 'Workers R2 Storage', level: 'Edit', for: 'create the storage for your mail' },
  { scope: 'Account', name: 'Access: Apps and Policies', level: 'Edit', for: 'make the server open only for you' },
  { scope: 'Account', name: 'Access: Organizations, Identity Providers, and Groups', level: 'Edit', for: 'set up sign-in with a code by email' },
  { scope: 'Account', name: 'Access: Service Tokens', level: 'Edit', for: 'give agents their own keys to this server' },
  { scope: 'Account', name: 'Account Settings', level: 'Read', for: 'find your account' },
  { scope: 'Account', name: 'Email Routing Addresses', level: 'Edit', for: 'add the addresses a copy may be forwarded to' },
  { scope: 'Account', name: 'Email Routing Account Rules', level: 'Read', for: 'see whether an account has mail' },
  { scope: 'Account', name: 'Email Sending', level: 'Edit', for: 'send from your domains' },
  { scope: 'Zone', name: 'Zone', level: 'Read', for: 'list your domains' },
  { scope: 'Zone', name: 'Email Routing Rules', level: 'Edit', for: 'send addresses to your server' },
  { scope: 'Zone', name: 'Zone Settings', level: 'Edit', for: 'turn Email Routing on for a domain' },
  { scope: 'Zone', name: 'DNS', level: 'Edit', for: "replace another provider's MX records and add a DMARC record" },
];

/**
 * Compares versions ("0.6.1" < "0.10.0"), with a prerelease below its release
 * ("0.12.0-rc.1" < "0.12.0-rc.2" < "0.12.0"); a part that is not a number counts as 0.
 */
function compareVersions(a, b) {
  const split = (v) => { const [core, pre = ''] = String(v).split('-', 2); return { core: core.split('.').map((x) => parseInt(x, 10) || 0), pre }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) if ((x.core[i] || 0) !== (y.core[i] || 0)) return (x.core[i] || 0) - (y.core[i] || 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const px = x.pre.split('.'), py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]), ny = /^\d+$/.test(py[i]);
    if (nx && ny && Number(px[i]) !== Number(py[i])) return Number(px[i]) - Number(py[i]);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && px[i] !== py[i]) return px[i] < py[i] ? -1 : 1;
  }
  return 0;
}

class DeployError extends Error {
  constructor(message, { status = 0, code } = {}) { super(message); this.status = status; this.code = code; }
  // A 403 with its own code (10042: R2 not turned on) is not about the token.
  get isPermission() { return this.status === 401 || this.code === 10000 || this.code === 9109 || (this.status === 403 && !this.code); }
}

const TOKEN = /^[A-Za-z0-9._-]{20,300}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

function client(token, fetchImpl = (input, init) => fetch(input, init)) {
  if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw new DeployError('This does not look like a Cloudflare API token. Copy it again from the page Cloudflare showed after creating it.');
  const bearer = token.trim();
  async function call(route, { method = 'GET', body, form, what = 'do this', auth, raw = false } = {}) {
    let response;
    try {
      response = await fetchImpl(route.startsWith('http') ? route : API + route, {
        method,
        headers: { Authorization: `Bearer ${auth || bearer}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new DeployError(`Cloudflare did not answer (${error.name === 'TimeoutError' ? 'timed out' : 'network error'}). Check the connection and continue.`);
    }
    if (raw) return response;
    const data = await response.json().catch(() => null);
    if (response.ok && data?.success) return data;
    const first = data?.errors?.[0];
    const error = new DeployError(data?.errors?.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${response.status}`, { status: response.status, code: first?.code });
    // 9109 means both "Invalid access token" and "Unauthorized to access requested resource".
    if (/invalid (access|api) token|token.*(expired|revoked)/i.test(error.message))
      throw new DeployError('Cloudflare does not accept this token: it may be mistyped, expired or deleted. Copy it again, or create a new one.', { status: error.status, code: error.code });
    if (error.isPermission) throw new DeployError(`The token is not allowed to ${what}. Add the permission to the token (Edit token on the API Tokens page), then continue.`, { status: error.status, code: error.code });
    throw error;
  }
  async function list(route, what, perPage = 50) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const sep = route.includes('?') ? '&' : '?';
      const data = await call(`${route}${sep}per_page=${perPage}&page=${page}`, { what });
      out.push(...(data.result || []));
      if ((data.result || []).length < perPage || (data.result_info && page >= data.result_info.total_pages)) break;
    }
    return out;
  }
  return { call, list, token: bearer };
}

async function accounts(token, fetchImpl) {
  const c = client(token, fetchImpl);
  const found = await c.list('/accounts', 'find your account (Account Settings: Read)');
  if (!found.length) throw new DeployError('The token sees no Cloudflare account. When creating it, choose your account under Account Resources.');
  return found.map((a) => ({ id: a.id, name: a.name }));
}

/** What already exists, so the form asks only for what is missing. */
async function inspect({ token, accountId, fetchImpl }) {
  const c = client(token, fetchImpl);
  const [subdomain, team, existing] = await Promise.all([
    c.call(`/accounts/${accountId}/workers/subdomain`, { what: 'read workers.dev (Workers Scripts: Edit)' }).then((d) => d.result?.subdomain || null).catch((e) => { if (e.isPermission) throw e; return null; }),
    c.call(`/accounts/${accountId}/access/organizations`, { what: 'read Zero Trust (Access: Organizations, Identity Providers, and Groups: Edit)' }).then((d) => d.result?.auth_domain || null).catch((e) => { if (e.isPermission) throw e; return null; }),
    c.list(`/accounts/${accountId}/workers/scripts`, 'read Workers (Workers Scripts: Edit)', 100).then((all) => all.find((s) => s.id === DEFAULT_SCRIPT) || null),
  ]);
  return { subdomain, team, existing: existing ? { migrationTag: existing.migration_tag || null } : null };
}

async function readBundle(dir, readFile = fs.readFile) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'fabric-inbox-server/1') throw new DeployError('This copy of the app carries no usable server. Download the app again.');
  return manifest;
}

/**
 * Uploads the static files and the Worker (steps "files" and "server"). The
 * Worker gets the bundle's bindings, `vars`, the account id and the token as a
 * secret; an update keeps the server's DOMAINS and its other secrets.
 */
async function uploadServer({ c, accountId, script: SCRIPT, bucket: BUCKET, manifest, bundleDir, readFile = fs.readFile, attempt, report, vars, allowDowngrade = false }) {
  const a = `/accounts/${accountId}`;
  const assetsJwt = await attempt('files', 'Upload the app', async () => {
    const files = manifest.assets.files;
    const session = await c.call(`${a}/workers/scripts/${SCRIPT}/assets-upload-session`, { method: 'POST', what: 'upload the server (Workers Scripts: Edit)',
      body: { manifest: Object.fromEntries(Object.entries(files).map(([p, f]) => [p, { hash: f.hash, size: f.size }])) } });
    let completion = session.result.jwt;
    const buckets = session.result.buckets || [];
    const byHash = new Map(Object.entries(files).map(([p, f]) => [f.hash, { path: p, ...f }]));
    for (const bucket of buckets) {
      const form = new FormData();
      for (const hash of bucket) {
        const file = byHash.get(hash);
        if (!file) throw new DeployError('Cloudflare asked for a file this app does not carry. Download the app again.');
        const bytes = await readFile(path.join(bundleDir, 'static', file.path.slice(1)));
        form.append(hash, new File([Buffer.from(bytes).toString('base64')], hash, { type: file.contentType }), hash);
      }
      let result;
      for (let tries = 0; ; tries++) {
        try { result = await c.call(`${a}/workers/assets/upload?base64=true`, { method: 'POST', form, auth: session.result.jwt, what: 'upload the server (Workers Scripts: Edit)' }); break; }
        catch (e) { if (tries >= 2 || e.isPermission) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** tries)); }
      }
      if (result.result?.jwt) completion = result.result.jwt;
    }
    report('files', 'Upload the app', buckets.length ? 'done' : 'already', buckets.length ? `Uploaded ${buckets.flat().length} files.` : 'Every file was already there.');
    return completion;
  });

  // 7. The Worker itself, with its settings and the token
  await attempt('server', 'Start the server', async () => {
    const scripts = await c.list(`${a}/workers/scripts`, 'read Workers (Workers Scripts: Edit)', 100);
    const current = scripts.find((s) => s.id === SCRIPT);
    let domains = '';
    let running = '';
    let hasCredentialKey = false;
    if (current) {
      const settings = await c.call(`${a}/workers/scripts/${SCRIPT}/settings`, { what: 'read the server settings (Workers Scripts: Edit)' });
      const found = settings.result?.bindings || [];
      domains = found.find((b) => b.type === 'plain_text' && b.name === 'DOMAINS')?.text || '';
      running = found.find((b) => b.type === 'plain_text' && b.name === 'FABRIC_SERVER_VERSION')?.text || '';
      hasCredentialKey = found.some((b) => b.type === 'secret_text' && (b.name === 'MAIL_CREDENTIAL_KEY' || b.name === 'GMAIL_TOKEN_ENCRYPTION_KEY'));
    }
    // The key the server seals mail-account passwords and tokens with (workers/providers/credentials.ts).
    // Made once, here, and never sent again: a new key would leave every connected account unreadable.
    // The app keeps no copy; losing it means entering each app password again (docs/desktop-mail/setup.md).
    const credentialKey = hasCredentialKey ? null : crypto.randomBytes(32).toString('base64url');
    // An older server over a newer one would run code that does not know the newer data
    // (deploy audit M1): refused unless asked for on purpose.
    if (running && compareVersions(running, manifest.version) > 0 && !allowDowngrade)
      throw new DeployError(`The server in your account is version ${running}, newer than this app's ${manifest.version}. Update the app, then continue.`);
    // A storage step that deletes, renames or moves a class would destroy or move every user's
    // data in it; only new classes are ever sent (deploy audit M2).
    const unsafe = manifest.migrations.find((m) => Object.keys(m).some((k) => k !== 'tag' && k !== 'new_sqlite_classes' && k !== 'new_classes'));
    if (unsafe) throw new DeployError(`The server bundle has a storage step (${unsafe.tag}) that would delete or move stored data; this app does not send it.`);
    const tags = manifest.migrations.map((m) => m.tag);
    let migrations;
    if (!current?.migration_tag) migrations = { new_tag: tags[tags.length - 1], steps: manifest.migrations.map(({ tag, ...step }) => step) };
    else {
      const at = tags.indexOf(current.migration_tag);
      if (at < 0) throw new DeployError(`The server in your account is newer than this app (storage version ${current.migration_tag}). Update the app, then continue.`);
      const pending = manifest.migrations.slice(at + 1);
      if (pending.length) migrations = { old_tag: current.migration_tag, new_tag: tags[tags.length - 1], steps: pending.map(({ tag, ...step }) => step) };
    }
    const bindings = [
      ...manifest.durableObjects.map((d) => ({ type: 'durable_object_namespace', name: d.name, class_name: d.class_name })),
      ...manifest.r2Buckets.map((r) => ({ type: 'r2_bucket', name: r.binding, bucket_name: BUCKET })),
      ...manifest.sendEmail.map((e) => ({ type: 'send_email', name: e.name })),
      ...(manifest.ai ? [{ type: 'ai', name: manifest.ai.binding }] : []),
      ...Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
      { type: 'plain_text', name: 'DOMAINS', text: domains },
      { type: 'plain_text', name: 'CLOUDFLARE_ACCOUNT_ID', text: accountId },
      { type: 'plain_text', name: 'FABRIC_SERVER_VERSION', text: manifest.version },
      { type: 'secret_text', name: 'CLOUDFLARE_API_TOKEN', text: c.token },
      ...(credentialKey ? [{ type: 'secret_text', name: 'MAIL_CREDENTIAL_KEY', text: credentialKey }] : []),
    ];
    const metadata = {
      main_module: manifest.worker.main_module,
      compatibility_date: manifest.worker.compatibility_date,
      compatibility_flags: manifest.worker.compatibility_flags,
      bindings,
      ...(migrations ? { migrations } : {}),
      // Every other setting on the server survives an update: secrets (Gmail's) and plain vars
      // (UNKNOWN_ADDRESS_POLICY, GOOGLE_CLIENT_ID, AUTOMATION_MCP_HOSTS…), as wrangler's keep_vars
      // does; the values sent above still win (deploy audit H1).
      ...(current ? { keep_bindings: ['secret_text', 'secret_key', 'plain_text', 'json'] } : {}),
      assets: { jwt: assetsJwt, config: manifest.assets.config },
      observability: manifest.worker.observability,
    };
    const form = new FormData();
    form.set('metadata', JSON.stringify(metadata));
    for (const m of manifest.modules) {
      const bytes = await readFile(path.join(bundleDir, m.file));
      form.set(m.name, new File([bytes], m.name, { type: 'application/javascript+module' }));
    }
    await c.call(`${a}/workers/scripts/${SCRIPT}`, { method: 'PUT', form, what: 'upload the server (Workers Scripts: Edit)' });
    const keyNote = credentialKey ? ' It made its key for keeping app passwords; the key stays on your server.' : '';
    report('server', 'Start the server', current ? 'done' : 'done', (current ? `Updated your server to ${manifest.version}; your mail and settings are kept.` : `Your server ${manifest.version} is running.`) + keyNote);
  });

}

/**
 * Creates or updates the server. Returns { origin, accessOrigin, steps }.
 * options: token, accountId, email (who may sign in), subdomain and team (only
 * when missing), bundleDir, fetchImpl, readFile, onStep.
 */
async function deploy(options) {
  const { token, accountId, bundleDir, fetchImpl, readFile = fs.readFile, onStep = () => {} } = options;
  const SCRIPT = options.scriptName || DEFAULT_SCRIPT;
  const BUCKET = options.bucketName || DEFAULT_BUCKET;
  const c = client(token, fetchImpl);
  const a = `/accounts/${accountId}`;
  const steps = [];
  const report = (id, label, outcome, detail) => { const s = { id, label, outcome, detail }; steps.push(s); onStep(s); return s; };
  const attempt = async (id, label, fn) => {
    try { return await fn(); }
    catch (error) { report(id, label, 'failed', error instanceof DeployError ? error.message : `Unexpected problem: ${error.message}`); throw Object.assign(new DeployError(error.message), { steps }); }
  };
  const manifest = await readBundle(bundleDir, readFile);

  // 1. workers.dev name of the account
  const subdomain = await attempt('subdomain', 'Web address', async () => {
    const current = await c.call(`${a}/workers/subdomain`, { what: 'read workers.dev (Workers Scripts: Edit)' }).then((d) => d.result?.subdomain || null).catch((e) => { if (e.isPermission) throw e; return null; });
    if (current) { report('subdomain', 'Web address', 'already', `Your account's address is ${current}.workers.dev.`); return current; }
    const wanted = String(options.subdomain || '').trim().toLowerCase();
    if (!NAME.test(wanted)) throw new DeployError('Choose a name for your workers.dev address: letters, digits and dashes.');
    await c.call(`${a}/workers/subdomain`, { method: 'PUT', body: { subdomain: wanted }, what: 'create the workers.dev address (Workers Scripts: Edit)' })
      .catch((e) => { throw e.isPermission ? e : new DeployError(`${wanted}.workers.dev could not be taken (${e.message}). Try another name.`); });
    report('subdomain', 'Web address', 'done', `Your account's address is now ${wanted}.workers.dev.`);
    return wanted;
  });
  const host = `${SCRIPT}.${subdomain}.workers.dev`;

  // 2. Storage for mail
  await attempt('storage', 'Storage for your mail', async () => {
    const found = await c.call(`${a}/r2/buckets/${BUCKET}`, { what: 'read storage (Workers R2 Storage: Edit)' }).then(() => true).catch((e) => { if (e.isPermission) throw e; if (e.status === 404 || e.code === 10006) return false; throw e; });
    if (found) { report('storage', 'Storage for your mail', 'already', 'The storage exists; your mail in it is kept.'); return; }
    await c.call(`${a}/r2/buckets`, { method: 'POST', body: { name: BUCKET }, what: 'create storage (Workers R2 Storage: Edit)' })
      .catch((e) => { throw e.isPermission ? e : new DeployError(/R2|enable|subscription|billing/i.test(e.message)
        ? 'R2 storage is not turned on for this account yet. Open R2 in the Cloudflare dashboard once and turn it on (the free tier is enough), then continue.'
        : `The storage could not be created: ${e.message}`); });
    report('storage', 'Storage for your mail', 'done', 'Created the storage for your mail (R2 bucket fabric-inbox).');
  });

  // 3. Zero Trust team: the sign-in page
  const authDomain = await attempt('team', 'Sign-in page', async () => {
    const org = await c.call(`${a}/access/organizations`, { what: 'read Zero Trust (Access: Organizations, Identity Providers, and Groups: Edit)' }).then((d) => d.result).catch((e) => { if (e.isPermission) throw e; return null; });
    if (org?.auth_domain) { report('team', 'Sign-in page', 'already', `Sign-in runs at ${org.auth_domain}.`); return org.auth_domain; }
    const team = String(options.team || '').trim().toLowerCase();
    if (!NAME.test(team)) throw new DeployError('Choose a team name for your sign-in page: letters, digits and dashes.');
    const created = await c.call(`${a}/access/organizations`, { method: 'POST', body: { name: team, auth_domain: `${team}.cloudflareaccess.com` }, what: 'create the sign-in page (Access: Organizations, Identity Providers, and Groups: Edit)' })
      .catch((e) => { throw e.isPermission ? e : new DeployError(`Zero Trust is not set up for this account yet (${e.message}). Open Zero Trust in the Cloudflare dashboard once and choose the Free plan, then continue.`); });
    report('team', 'Sign-in page', 'done', `Sign-in runs at ${created.result.auth_domain}.`);
    return created.result.auth_domain;
  });

  // 4. A code by email as the way to sign in
  await attempt('otp', 'Sign in with a code by email', async () => {
    const idps = await c.list(`${a}/access/identity_providers`, 'read sign-in methods (Access: Organizations, Identity Providers, and Groups: Edit)');
    if (idps.some((i) => i.type === 'onetimepin')) { report('otp', 'Sign in with a code by email', 'already', 'Codes by email are on.'); return; }
    await c.call(`${a}/access/identity_providers`, { method: 'POST', body: { name: 'One-time PIN', type: 'onetimepin', config: {} }, what: 'turn on codes by email (Access: Organizations, Identity Providers, and Groups: Edit)' });
    report('otp', 'Sign in with a code by email', 'done', 'Codes by email are on.');
  });

  // 5. The Access application: only this email passes
  const aud = await attempt('access', 'Only you can open it', async () => {
    const email = String(options.email || '').trim().toLowerCase();
    const apps = await c.list(`${a}/access/apps`, 'read Access applications (Access: Apps and Policies: Edit)');
    const existing = apps.find((x) => String(x.domain || '').toLowerCase() === host);
    if (existing) { report('access', 'Only you can open it', 'already', `The server is already protected; its sign-in rules were kept as they are.`); return existing.aud; }
    // A server already signed in some other way (its own domain's Access app) keeps that
    // sign-in: a new app for workers.dev would replace POLICY_AUD and lock its owner out.
    const running = (await c.list(`${a}/workers/scripts`, 'read Workers (Workers Scripts: Edit)', 100)).find((x) => x.id === SCRIPT);
    if (running) {
      const settings = await c.call(`${a}/workers/scripts/${SCRIPT}/settings`, { what: 'read the server settings (Workers Scripts: Edit)' });
      const current = (settings.result?.bindings || []).find((b) => b.type === 'plain_text' && b.name === 'POLICY_AUD')?.text;
      if (current) { report('access', 'Only you can open it', 'already', 'The server keeps the sign-in it already has (on its own address); nothing was changed.'); return current; }
    }
    if (!EMAIL.test(email)) throw new DeployError('Enter the email address you will sign in with.');
    const created = await c.call(`${a}/access/apps`, { method: 'POST', what: 'protect the server (Access: Apps and Policies: Edit)', body: {
      name: 'Fabric Inbox', domain: host, type: 'self_hosted', session_duration: '720h', app_launcher_visible: false,
      policies: [{ name: 'Owner', decision: 'allow', precedence: 1, include: [{ email: { email } }] }],
    } });
    report('access', 'Only you can open it', 'done', `Only ${email} can open the server, with a code sent by email.`);
    return created.result.aud;
  });

  // 6–7. Static files, then the Worker with its settings and the token
  await uploadServer({ c, accountId, script: SCRIPT, bucket: BUCKET, manifest, bundleDir, readFile, attempt, report,
    vars: { POLICY_AUD: aud, TEAM_DOMAIN: `https://${authDomain}` }, allowDowngrade: options.allowDowngrade === true });

  // 8. Reachable at its address
  await attempt('address', 'Open it at its address', async () => {
    await c.call(`${a}/workers/scripts/${SCRIPT}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false }, what: 'publish on workers.dev (Workers Scripts: Edit)' });
    report('address', 'Open it at its address', 'done', `https://${host}`);
  });

  return { origin: `https://${host}`, accessOrigin: `https://${authDomain}`, steps };
}

module.exports = { accounts, inspect, deploy, uploadServer, client, readBundle, compareVersions, DeployError, PERMISSIONS, TOKEN_PAGE, SCRIPT: DEFAULT_SCRIPT, validName: (v) => NAME.test(v), validEmail: (v) => EMAIL.test(v) };
