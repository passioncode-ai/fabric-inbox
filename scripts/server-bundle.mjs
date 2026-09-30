// Packs the built server (react-router build → build/server + build/client)
// into what the Mac app uploads to a person's own Cloudflare account (CF-5):
//
//   <out>/manifest.json   modules, bindings, migrations, asset hashes
//   <out>/worker/…        the ES modules of the Worker (no_bundle: uploaded as they are)
//   <out>/static/…        the static assets
//
// The same shape wrangler deploy uploads (checked against wrangler 4's
// create-worker-upload-form and syncAssets, 2026-09-28): module parts typed
// application/javascript+module, asset hashes blake3(base64(content) + ext)
// cut to 32 hex characters. No deployment's values are copied: vars,
// account and routes stay out; the app sets POLICY_AUD, TEAM_DOMAIN and the
// token when it creates the server.
//
//   node scripts/server-bundle.mjs [--out desktop/server-bundle] [--build build]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const blake3 = require('blake3-wasm');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SERVER_BUNDLE_FORMAT = 'fabric-inbox-server/1';
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES = {
  js: 'application/javascript', mjs: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  txt: 'text/plain', map: 'application/json', woff2: 'font/woff2', woff: 'font/woff', webmanifest: 'application/manifest+json',
};
// wrangler never uploads these from the assets directory
const IGNORED = new Set(['.assetsignore', '_headers', '_redirects', 'wrangler.json', '.dev.vars']);

export function assetHash(bytes, file) {
  const extension = path.extname(file).slice(1);
  return blake3.hash(bytes.toString('base64') + extension).toString('hex').slice(0, 32);
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

/** Builds the bundle from an existing build directory; returns the manifest. */
export function buildServerBundle({ buildDir = path.join(root, 'build'), outDir, version, revision }) {
  const serverDir = path.join(buildDir, 'server');
  const clientDir = path.join(buildDir, 'client');
  const config = JSON.parse(readFileSync(path.join(serverDir, 'wrangler.json'), 'utf8'));
  if (!config.no_bundle || config.main !== 'index.js') throw new Error('build/server is not a no_bundle Worker with index.js; run npm run build first.');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, 'worker'), { recursive: true });
  mkdirSync(path.join(outDir, 'static'), { recursive: true });

  const modules = walk(serverDir).filter((f) => /\.(m?js)$/.test(f)).sort((a, b) => (a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b)));
  for (const name of modules) {
    mkdirSync(path.dirname(path.join(outDir, 'worker', name)), { recursive: true });
    cpSync(path.join(serverDir, name), path.join(outDir, 'worker', name));
  }
  const files = {};
  for (const rel of walk(clientDir).sort()) {
    if (IGNORED.has(path.basename(rel))) continue;
    const full = path.join(clientDir, rel);
    const size = statSync(full).size;
    if (size > MAX_ASSET_BYTES) throw new Error(`${rel} is larger than a Workers asset may be (25 MiB).`);
    const bytes = readFileSync(full);
    mkdirSync(path.dirname(path.join(outDir, 'static', rel)), { recursive: true });
    cpSync(full, path.join(outDir, 'static', rel));
    files['/' + rel] = { hash: assetHash(bytes, rel), size, contentType: CONTENT_TYPES[path.extname(rel).slice(1).toLowerCase()] ?? 'application/null' };
  }
  const manifest = {
    format: SERVER_BUNDLE_FORMAT,
    version, revision, builtAt: new Date().toISOString(),
    worker: {
      main_module: 'index.js',
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags ?? [],
      observability: config.observability ?? { enabled: true },
    },
    modules: modules.map((name) => ({ name, file: `worker/${name}` })),
    durableObjects: (config.durable_objects?.bindings ?? []).map(({ name, class_name }) => ({ name, class_name })),
    migrations: (config.migrations ?? []).map(({ tag, ...steps }) => ({ tag, ...steps })),
    r2Buckets: (config.r2_buckets ?? []).map(({ binding, bucket_name }) => ({ binding, bucket_name })),
    sendEmail: (config.send_email ?? []).map(({ name }) => ({ name })),
    ai: config.ai?.binding ? { binding: config.ai.binding } : null,
    assets: {
      config: {
        ...(config.assets?.html_handling ? { html_handling: config.assets.html_handling } : {}),
        ...(config.assets?.not_found_handling ? { not_found_handling: config.assets.not_found_handling } : {}),
        ...(config.assets?.run_worker_first !== undefined ? { run_worker_first: config.assets.run_worker_first } : {}),
      },
      files,
    },
  };
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? path.resolve(args[i + 1]) : fallback; };
  const buildDir = opt('--build', path.join(root, 'build'));
  if (!existsSync(path.join(buildDir, 'server', 'wrangler.json'))) { console.error('No build found: run npm run build first.'); process.exit(1); }
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
  const manifest = buildServerBundle({ buildDir, outDir: opt('--out', path.join(root, 'desktop', 'server-bundle')), version, revision });
  console.log(`Server bundle ${manifest.version} (${manifest.revision.slice(0, 7)}): ${manifest.modules.length} modules, ${Object.keys(manifest.assets.files).length} assets, ${manifest.durableObjects.length} Durable Objects.`);
}
