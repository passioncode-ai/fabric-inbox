'use strict';
/**
 * B-44: the app updates its server without a new Cloudflare token. When the server answers an older
 * version than the server this app carries, the app sends that bundle to `POST /api/server/self-update`
 * through the mail window's session (the person's sign-in), and the server uploads it with its own
 * token (workers/routes/server-update.ts). Automatic when updates are automatic (the same switch as the
 * app's own updates, LC-16); otherwise the app menu offers Update Server. Never an older bundle.
 *
 * Pure apart from what is passed in: tests drive it with fake reads and posts.
 */
const path = require('node:path');

/** Same order as desktop/cloudflare-deploy.cjs compareVersions. */
function compareVersions(a, b) {
  const split = (v) => { const [core, pre = ''] = String(v).split('-', 2); return { core: core.split('.').map((x) => parseInt(x, 10) || 0), pre }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) if ((x.core[i] || 0) !== (y.core[i] || 0)) return (x.core[i] || 0) - (y.core[i] || 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * opts: { appVersion (a string, or a function returning one), bundleDir, readBundle(dir) → manifest, readFile(path) → bytes,
 *         read(pathname) → JSON | null (GET through the mail session),
 *         post(pathname, FormData) → { status, body } (through the mail session),
 *         automatic() → boolean or a promise of one, log(event), notify(title, body), t, onChange() }
 */
function createServerUpdater(opts) {
  const { t, log = () => {}, notify = () => {}, onChange = () => {} } = opts;
  let state = { phase: 'unknown', server: null, bundle: null, reason: null };
  let running = null;
  let triedFor = null;
  const set = (next) => { state = { ...state, ...next }; onChange(state); };
  // A function, read when needed: the main process passes app.getVersion.
  const appVersion = () => (typeof opts.appVersion === 'function' ? opts.appVersion() : opts.appVersion);

  async function bundle() {
    try {
      const manifest = await opts.readBundle(opts.bundleDir);
      return manifest && manifest.version === appVersion() ? manifest : null;
    } catch { return null; }
  }

  /** What the server runs against what this app carries: current, older (an update is offered), or why not. */
  async function check() {
    const [manifest, server] = await Promise.all([bundle(), opts.read('/api/server')]);
    if (!manifest) { set({ phase: 'no_bundle', server: server?.version ?? null, bundle: null, reason: null }); return state; }
    if (!server || typeof server.version !== 'string') { set({ phase: 'unknown', server: null, bundle: manifest.version }); return state; }
    const order = compareVersions(server.version, manifest.version);
    if (order >= 0) { set({ phase: 'current', server: server.version, bundle: manifest.version, reason: null }); return state; }
    if (!server.selfUpdate || server.selfUpdate.available !== true) {
      set({ phase: 'needs_token', server: server.version, bundle: manifest.version, reason: server.selfUpdate?.reason ?? null });
      return state;
    }
    set({ phase: 'older', server: server.version, bundle: manifest.version, reason: null });
    return state;
  }

  /** Sends the bundle; one at a time. */
  function update({ manual = false } = {}) {
    if (running) return running;
    running = (async () => {
      const manifest = await bundle();
      if (!manifest || !['older', 'failed'].includes(state.phase)) return state;
      set({ phase: 'updating' });
      const started = Date.now();
      try {
        const form = new FormData();
        form.set('manifest', JSON.stringify(manifest));
        for (const m of manifest.modules) form.set(`module:${m.name}`, new Blob([await opts.readFile(path.join(opts.bundleDir, m.file))], { type: 'application/javascript+module' }), m.name);
        for (const [file, f] of Object.entries(manifest.assets.files))
          form.set(`asset:${f.hash}`, new Blob([await opts.readFile(path.join(opts.bundleDir, 'static', file.slice(1)))], { type: f.contentType }), f.hash);
        const answer = await opts.post('/api/server/self-update', form);
        if (answer && answer.status === 200 && answer.body && answer.body.updated) {
          log({ event: 'server_update', outcome: 'done', from: state.server, to: manifest.version, manual, ms: Date.now() - started });
          set({ phase: 'current', server: manifest.version, reason: null });
          notify(t('Your server is updated'), t('It now runs {version}; your mail and settings are kept.', { version: manifest.version }));
        } else {
          const code = answer?.body?.code || (answer ? `http_${answer.status}` : 'unreachable');
          log({ event: 'server_update', outcome: 'failed', code, manual, ms: Date.now() - started });
          const reason = answer?.body?.error || t('The server did not answer.');
          set({ phase: code === 'permission' || code === 'not_configured' ? 'needs_token' : 'failed', reason });
          notify(t('Your server could not be updated'), t('{reason} It keeps running {version}.', { reason, version: state.server }));
        }
      } catch (error) {
        log({ event: 'server_update', outcome: 'failed', code: 'local', manual });
        set({ phase: 'failed', reason: t('This computer could not send the update ({error}).', { error: String(error && error.message || error).slice(0, 120) }) });
      } finally { running = null; }
      return state;
    })();
    return running;
  }

  /**
   * After the person is signed in to `origin`: check once per server and app version, and update
   * at once when updates are automatic. A failure is not retried in this launch; the menu still offers it.
   */
  async function onSignedIn(origin) {
    const key = `${origin}@${appVersion()}`;
    if (triedFor === key) return state;
    triedFor = key;
    await check();
    if (state.phase === 'older' && await opts.automatic()) await update({ manual: false });
    return state;
  }

  /** The app menu item: shown only while an update is possible or running. */
  function menuItem(click) {
    if (state.phase === 'older' || state.phase === 'failed') return { label: t('Update Server to {version}', { version: state.bundle }), enabled: true, click };
    if (state.phase === 'updating') return { label: t('Updating Server…'), enabled: false, click };
    return null;
  }

  return { check, update, onSignedIn, menuItem, status: () => state };
}

module.exports = { createServerUpdater, compareVersions };
