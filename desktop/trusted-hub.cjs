'use strict';
// B-307: a hub this Mac trusts without a dialog. The owner, 2026-11-20 (relayed by CEO Fabric): «это все должно быть
// автоматически, не надо никакой подключать, я типа установил». A `fabric-inbox://connect` link is allowed with no
// prompt only when the process that listens on its callback is Fabric's own app, signed by the same developer team as
// this app, with a signature that verifies. Anything else (an unsigned build, another team, another app, a Mac other than
// macOS, the switch off) falls back to the person's Allow/Deny, as before. The check reads the signature the system
// keeps, so a process cannot claim it by its name. `exec(file, args)` is injected for tests.
const path = require('node:path');

/** Bundle identifiers of the hubs this app connects to without asking. */
const TRUSTED_HUBS = new Set(['ai.passioncode.desktop']);
const CODESIGN = '/usr/bin/codesign';

/** The `.app` bundle an executable path lies in, or null. */
function bundleOf(executable) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(executable || ''));
  return m ? m[1] : null;
}

/** `codesign -dv` prints to stderr; both streams are read. Answers { identifier, team } or null. */
async function signatureOf(exec, bundle) {
  let out = '';
  try {
    const r = await exec(CODESIGN, ['-dv', '--verbose=2', bundle]);
    out = `${r.stdout || ''}\n${r.stderr || ''}`;
  } catch (error) {
    out = `${(error && error.stdout) || ''}\n${(error && error.stderr) || ''}`;
  }
  const identifier = (/^Identifier=(.+)$/m.exec(out) || [])[1];
  const team = (/^TeamIdentifier=(.+)$/m.exec(out) || [])[1];
  if (!identifier || !team || team === 'not set') return null;
  return { identifier: identifier.trim(), team: team.trim() };
}

async function verifies(exec, bundle) {
  try { await exec(CODESIGN, ['--verify', '--strict', bundle]); return true; } catch { return false; }
}

/**
 * trustedHubWith(exec, { self, platform, enabled }) → async (listener) => { trusted, reason, app? }.
 * `self` is this app's executable (process.execPath); `enabled()` reads the person's switch (default on).
 */
function trustedHubWith(exec, { self = process.execPath, platform = process.platform, enabled = async () => true } = {}) {
  let own;
  const ownTeam = async () => {
    if (own === undefined) {
      const bundle = bundleOf(self);
      const sig = bundle ? await signatureOf(exec, bundle) : null;
      own = sig ? sig.team : null;
    }
    return own;
  };
  return async (listener) => {
    if (platform !== 'darwin') return { trusted: false, reason: 'platform' };
    if (!(await enabled())) return { trusted: false, reason: 'switch_off' };
    if (!listener || !listener.path) return { trusted: false, reason: 'no_listener' };
    const bundle = bundleOf(listener.path);
    if (!bundle) return { trusted: false, reason: 'not_an_app' };
    const team = await ownTeam();
    if (!team) return { trusted: false, reason: 'self_unsigned' };
    const sig = await signatureOf(exec, bundle);
    if (!sig) return { trusted: false, reason: 'hub_unsigned' };
    if (!TRUSTED_HUBS.has(sig.identifier)) return { trusted: false, reason: 'not_a_trusted_hub' };
    if (sig.team !== team) return { trusted: false, reason: 'other_team' };
    if (!(await verifies(exec, bundle))) return { trusted: false, reason: 'signature_invalid' };
    return { trusted: true, reason: 'trusted_hub', app: path.basename(bundle, '.app') };
  };
}

module.exports = { trustedHubWith, bundleOf, signatureOf, TRUSTED_HUBS };
