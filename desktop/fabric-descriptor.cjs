'use strict';
// B-210 (DEC-0153 OD-9, DEC-0069): the app says where its own daily digests are, so a Fabric collector on this computer
// can read them. It writes its own descriptor, `fabric-inbox.desktop.json` in Fabric's services directory, as an app a
// person installs and starts (`lifecycle.manager: "person"`): with the ops-digest extension naming its `digests`
// folder (source `mac-app`) and nothing else, since a declared folder holds only this instance's digests. The server's
// digests are not copied here (`get_ops_digest` reads them). Written only by an installed copy on its own profile, only
// where Fabric's services directory already exists, and only when there is none, the app's version changed or the app
// moved (the contract's `appDescriptorAction`); rewritten nothing on any other start. The descriptor says the app is
// installed, never that it runs: it has no origin and claims no port.
const path = require('node:path');
const crypto = require('node:crypto');

const ID = 'fabric-inbox';
const INSTANCE = 'desktop';
const FILE = `${ID}.${INSTANCE}.json`;
const OPS_DIGEST_EXTENSION = 'https://fabric.passioncode.ai/agent-contract/extensions/ops-digest/0.1';
/** The descriptor's token file (fabric-service/0.1 requires one); the app serves nothing with it yet. */
const TOKEN_FILE = 'fabric-service.token';

/** Fabric's services directory on this system (fabric-service/0.1, "Services directory"). */
function servicesDir({ platform, env, home }) {
  if (env.FABRIC_SERVICES_DIR) return env.FABRIC_SERVICES_DIR;
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'ai.passioncode.fabric', 'services');
  if (platform === 'win32') return env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'passioncode-fabric', 'services') : null;
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'passioncode-fabric', 'services');
}

/** The installed app: the bundle on macOS, the AppImage or the executable elsewhere. */
function appPathOf({ platform, execPath, env }) {
  if (platform === 'darwin') {
    const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(execPath);
    return m ? m[1] : execPath;
  }
  if (platform === 'linux' && env.APPIMAGE) return env.APPIMAGE;
  return execPath;
}

/** The contract's appDescriptorAction (src/app-descriptor.ts): what a start does with the descriptor it finds. */
function descriptorAction(existing, tool, appPath) {
  if (appPath.includes('/AppTranslocation/')) return 'keep';
  const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  if (!isObject(existing) || !isObject(existing.installedBy)) return 'write';
  const recorded = isObject(existing.lifecycle) ? existing.lifecycle.app : undefined;
  return existing.installedBy.tool === tool && recorded === appPath ? 'keep' : 'write';
}

function buildDescriptor({ tool, appPath, userData, logs, now }) {
  return {
    protocol: 'fabric-service/0.1', id: ID, instance: INSTANCE, name: 'Fabric Inbox (desktop app)',
    summary: 'The desktop app of your mail server: where its own daily operations digests are.',
    placement: 'local',
    auth: { tokenFile: path.join(userData, TOKEN_FILE) },
    lifecycle: { manager: 'person', app: appPath },
    paths: { data: userData, logs: [logs] },
    source: { repository: 'https://github.com/passioncode-ai/fabric-inbox' },
    installedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    installedBy: { by: 'person', role: 'operator', tool },
    extensions: { [OPS_DIGEST_EXTENSION]: [{ dir: 'digests', source: 'mac-app' }] },
  };
}

/**
 * deps: { fs (node:fs/promises), platform, env, home, execPath, userData, logs, version, now, packaged, ownProfile, mas }
 * → { outcome: 'ok' | 'current' | 'skipped' | 'failed', reason? }. Never throws.
 */
async function ensureDescriptor(deps) {
  try { return await ensure(deps); } catch (error) { return { outcome: 'failed', reason: String((error && error.code) || 'unexpected') }; }
}

async function ensure(deps) {
  const { fs, platform, env = {}, home = '', execPath = '', userData, logs, version, now = Date.now() } = deps;
  // A development run, a check on a throwaway profile or the App Store's sandbox never writes Fabric's directory.
  if (!deps.packaged) return { outcome: 'skipped', reason: 'not_packaged' };
  if (!deps.ownProfile) return { outcome: 'skipped', reason: 'other_profile' };
  if (deps.mas) return { outcome: 'skipped', reason: 'app_store' };
  const dir = servicesDir({ platform, env, home });
  if (!dir) return { outcome: 'skipped', reason: 'no_services_dir' };
  try {
    if (!(await fs.stat(dir)).isDirectory()) return { outcome: 'skipped', reason: 'no_services_dir' };
  } catch { return { outcome: 'skipped', reason: 'no_services_dir' }; }
  const appPath = appPathOf({ platform, execPath, env });
  const tool = `Fabric Inbox ${version}`;
  const file = path.join(dir, FILE);
  let existing = null;
  try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch { existing = null; }
  if (descriptorAction(existing, tool, appPath) === 'keep') return { outcome: 'current' };
  try {
    await fs.mkdir(userData, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(userData, TOKEN_FILE), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
      .catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(buildDescriptor({ tool, appPath, userData, logs, now }), null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
    return { outcome: 'ok' };
  } catch (error) {
    return { outcome: 'failed', reason: String(error && error.code || 'write') };
  }
}

module.exports = { ensureDescriptor, buildDescriptor, descriptorAction, servicesDir, appPathOf, OPS_DIGEST_EXTENSION, FILE };
