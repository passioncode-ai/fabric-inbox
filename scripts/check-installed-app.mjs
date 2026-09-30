// Checks the agent protocol of an INSTALLED Fabric Inbox.app (docs/release.md, step 6).
//
// The Mac app serves nothing itself; agents talk to the server it opens, at <server>/mcp. The
// server a new person gets is the one this app carries and uploads (Contents/Resources/app.asar →
// server-bundle/). This script takes that bundle out of the installed app, runs it on 127.0.0.1 in
// workerd (Miniflare) the way Cloudflare runs it, behind a local stand-in for Cloudflare Access,
// with empty storage and no network, and calls <origin>/mcp as an MCP client would:
// initialize, tools/list, one read-only tool (list_accounts), and initialize without Access, which
// must be refused. Nothing of anyone's mail, accounts or keys is read.
//
//   node scripts/check-installed-app.mjs "<folder>/Fabric Inbox.app" [--keep-serving]
//
// Prints a JSON receipt and exits 0 only when every call answered as expected. --keep-serving
// leaves the server up (Ctrl-C stops it) so the app itself can be pointed at the printed origin.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const EXPECTED_READ_TOOL = 'list_accounts';

/** Miniflare options for a server bundle (scripts/server-bundle.mjs's manifest) in `bundleDir`. */
export function workerOptions(manifest, bundleDir, { aud, team }, read = (f) => readFileSync(f, 'utf8')) {
  return {
    host: '127.0.0.1', port: 0,
    modulesRoot: path.join(bundleDir, 'worker'),
    modules: manifest.modules.map((m) => ({ type: 'ESModule', path: path.join(bundleDir, m.file), contents: read(path.join(bundleDir, m.file)) })),
    compatibilityDate: manifest.worker.compatibility_date,
    compatibilityFlags: manifest.worker.compatibility_flags ?? [],
    durableObjects: Object.fromEntries(manifest.durableObjects.map((d) => [d.name, { className: d.class_name, useSQLite: true }])),
    r2Buckets: manifest.r2Buckets.map((b) => b.binding),
    // Cloudflare puts the Worker behind the assets when a script has both; without
    // has_user_worker the local router answers 404 for every non-file path, /mcp included.
    assets: { directory: path.join(bundleDir, 'static'), binding: 'ASSETS', routerConfig: { has_user_worker: true } },
    bindings: { POLICY_AUD: aud, TEAM_DOMAIN: team, DOMAINS: '' },
  };
}

/**
 * A stand-in for Cloudflare Access: its own key set at <team>/cdn-cgi/access/certs and a signed-in
 * owner's assertion, as Access would put in `cf-access-jwt-assertion`. Every other outbound
 * request is refused and recorded.
 */
export async function accessStandIn({ team, aud }) {
  const jose = await import('jose');
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'release-check', alg: 'RS256', use: 'sig' };
  const assertion = await new jose.SignJWT({ email: 'owner@example.com', type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'release-check' }).setIssuer(team).setAudience(aud)
    .setSubject('release-check').setIssuedAt().setExpirationTime('30m').sign(privateKey);
  const requested = [];
  const outbound = async (request) => {
    requested.push(request.url);
    if (request.url === `${team}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return new Response('External network disabled for this check', { status: 503 });
  };
  return { assertion, outbound, requested };
}

/** A Streamable HTTP answer: JSON, or the last `data:` line of a server-sent event. */
export function mcpBody(text) {
  let t = String(text).trim();
  if (/^(event|data):/m.test(t)) t = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() ?? '';
  try { return JSON.parse(t); } catch { throw new Error(`not an MCP answer: ${String(text).slice(0, 120)}`); }
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep-serving');
  const appPath = args.find((a) => !a.startsWith('--'));
  if (!appPath) throw new Error('Give the installed app: node scripts/check-installed-app.mjs "<folder>/Fabric Inbox.app"');
  const asar = require('@electron/asar');
  const { Miniflare } = require('miniflare');
  const work = mkdtempSync(path.join(os.tmpdir(), 'fabric-inbox-check-'));
  let mf;
  try {
    asar.extractAll(path.join(appPath, 'Contents/Resources/app.asar'), work);
    const bundleDir = path.join(work, 'server-bundle');
    const manifest = JSON.parse(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
    const appVersion = JSON.parse(readFileSync(path.join(work, 'package.json'), 'utf8')).version;
    const team = 'http://access.release-check.invalid';
    const aud = 'release-check';
    const access = await accessStandIn({ team, aud });
    mf = new Miniflare({ ...workerOptions(manifest, bundleDir, { aud, team }), outboundService: access.outbound });
    const origin = (await mf.ready).origin;
    const mcpUrl = `${origin}/mcp`;
    const post = async (id, method, params, signedIn = true) => {
      const response = await fetch(mcpUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18',
        ...(signedIn ? { 'cf-access-jwt-assertion': access.assertion } : {}) } });
      return { status: response.status, text: await response.text() };
    };
    const hello = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fabric-inbox-release-check', version: appVersion } };
    const init = await post(1, 'initialize', hello);
    const list = await post(2, 'tools/list', {});
    const read = await post(3, 'tools/call', { name: EXPECTED_READ_TOOL, arguments: {} });
    const refused = await post(4, 'initialize', hello, false);
    const server = mcpBody(init.text).result?.serverInfo;
    const tools = mcpBody(list.text).result?.tools ?? [];
    const readResult = mcpBody(read.text).result;
    const receipt = {
      app: { version: appVersion }, serverBundle: { version: manifest.version, revision: manifest.revision },
      mcpUrl, initialize: { http: init.status, serverInfo: server },
      toolsList: { http: list.status, tools: tools.length },
      [EXPECTED_READ_TOOL]: { http: read.status, isError: Boolean(readResult?.isError), text: readResult?.content?.[0]?.text?.slice(0, 200) },
      withoutAccess: { http: refused.status, text: refused.text.slice(0, 80) },
      outboundRequests: access.requested,
    };
    console.log(JSON.stringify(receipt, null, 2));
    const ok = init.status === 200 && server?.version === appVersion && manifest.version === appVersion
      && list.status === 200 && tools.length > 0 && tools.some((t) => t.name === EXPECTED_READ_TOOL)
      && read.status === 200 && !readResult?.isError && refused.status === 403
      && access.requested.every((u) => u === `${team}/cdn-cgi/access/certs`);
    if (!ok) throw new Error('The installed app\'s server did not answer the agent protocol as expected (receipt above).');
    if (keep) {
      console.error(`Serving ${origin} (MCP at ${mcpUrl}); Ctrl-C stops it.`);
      await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    }
  } finally {
    await mf?.dispose();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error.message); process.exit(1); });
}
