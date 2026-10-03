import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneReleases } from './release-retention.mjs';

export const BUNDLE_ID = 'ai.passioncode.fabric-inbox';
export const MIN_FREE_BYTES = 6 * 1024 ** 3; // Conservative working-space budget, not a measured build size.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function run(command, args, options = {}) {
  try { return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch { throw new Error(`${path.basename(command)} failed; inspect the prerequisite locally (command output withheld).`); }
}

export function parseArgs(args) {
  const config = { build: false };
  const keys = new Set(['mode', 'arch', 'team', 'identity', 'installer-identity', 'profile', 'build-number', 'revision']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--build') { requireThat(!config.build, 'Duplicate --build.'); config.build = true; continue; }
    const key = args[i].replace(/^--/, '');
    requireThat(args[i].startsWith('--') && keys.has(key), 'Unknown argument. See docs/app-store/mas.md.');
    requireThat(config[key] === undefined && args[i + 1] && !args[i + 1].startsWith('--'), `Provide one value for --${key}.`);
    config[key] = args[++i];
  }
  validateConfig(config);
  return config;
}

export function validateConfig(c) {
  requireThat(['development', 'distribution'].includes(c.mode), 'Choose --mode development or distribution.');
  requireThat(['arm64', 'x64'].includes(c.arch), 'Choose --arch arm64 or x64.');
  requireThat(/^[A-Z0-9]{10}$/.test(c.team || ''), 'Provide the confirmed ten-character Apple --team.');
  requireThat(/^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/.test(c['build-number'] || ''), 'Provide a positive --build-number (up to 9999.99.99), incremented for distribution.');
  requireThat(/^[a-f0-9]{40}$/.test(c.revision || ''), 'Provide the exact 40-character --revision SHA.');
  requireThat(typeof c.profile === 'string' && path.isAbsolute(c.profile), 'Provide an absolute --profile path outside the repository.');
  const appPattern = c.mode === 'development' ? /^(Apple Development|Mac Developer): / : /^(Apple Distribution|3rd Party Mac Developer Application|Mac App Distribution): /;
  requireThat(appPattern.test(c.identity || '') && c.identity.endsWith(`(${c.team})`), 'Provide an exact matching MAS application identity name; Developer ID is not a store identity.');
  if (c.mode === 'distribution') requireThat(/^(3rd Party Mac Developer Installer|Mac Installer Distribution): /.test(c['installer-identity'] || '') && c['installer-identity'].endsWith(`(${c.team})`), 'Distribution requires a matching Mac Installer Distribution identity.');
  else requireThat(!c['installer-identity'], 'Development produces a test app, not an installer for submission.');
}

export function parseIdentities(output) {
  return [...output.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\n]+)"\s*$/gm)].map((m) => ({ hash: m[1].toUpperCase(), name: m[2] }));
}
export function selectIdentity(identities, name) {
  const matching = identities.filter((entry) => entry.name === name);
  requireThat(matching.length === 1, 'The exact signing identity must resolve to one valid certificate/private-key pair.');
  return matching[0];
}

export function validateProfile(c, p, certificateHash, now = Date.now()) {
  requireThat(Array.isArray(p.Platform) && p.Platform.includes('OSX'), 'Profile must target macOS.');
  requireThat(Array.isArray(p.TeamIdentifier) && p.TeamIdentifier.length === 1 && p.TeamIdentifier[0] === c.team, 'Profile team does not match --team.');
  requireThat(Number.isFinite(Date.parse(p.ExpirationDate)) && Date.parse(p.ExpirationDate) > now, 'Profile has expired or has no valid expiry.');
  const e = p.Entitlements || {};
  requireThat(e['com.apple.developer.team-identifier'] === c.team, 'Profile entitlement team does not match.');
  requireThat(p.AppIdentifierPrefix?.length === 1 && p.AppIdentifierPrefix[0] === c.team, 'This signing configuration requires the App ID prefix to equal the team; legacy prefixes need explicit review.');
  requireThat(e['com.apple.application-identifier'] === `${c.team}.${BUNDLE_ID}`, 'Profile must authorize the exact bundle ID; wildcard App IDs are refused.');
  requireThat(p.CertificateHashes?.includes(certificateHash), 'Signing certificate is not authorized by this profile.');
  requireThat(p.ProvisionsAllDevices !== true, 'All-device profiles are not Mac App Store profiles.');
  const debug = e['com.apple.security.get-task-allow'] === true || e['get-task-allow'] === true;
  if (c.mode === 'development') requireThat(p.ProvisionedDevices?.length > 0, 'Development requires a device provisioned development profile.');
  else requireThat(!debug && !Object.hasOwn(p, 'ProvisionedDevices'), 'Distribution requires a store profile without debug/device provisioning.');
  const group = `${c.team}.${BUNDLE_ID}`;
  // TN3125: sandbox groups and get-task-allow are unrestricted macOS entitlements.
  // A missing group allowlist is valid; an explicit conflicting one needs review.
  const groups = e['com.apple.security.application-groups'];
  requireThat(groups === undefined || (Array.isArray(groups) && groups.some((v) => v === group || v === `${c.team}.*`)), 'Profile declares a conflicting sandbox application group.');
  return { expires: p.ExpirationDate, applicationGroup: group };
}

function decodeProfile(profile) {
  const xml = run('/usr/bin/security', ['cms', '-D', '-i', profile]);
  // Dates and certificate data cannot be converted by plutil's JSON formatter.
  // Decode in memory; return certificate fingerprints only, never certificate blobs.
  return JSON.parse(run('python3', ['-c', `import sys,plistlib,json,hashlib,datetime
p=plistlib.loads(sys.stdin.buffer.read())
p['CertificateHashes']=[hashlib.sha1(c).hexdigest().upper() for c in p.pop('DeveloperCertificates',[])]
print(json.dumps(p,default=lambda x:x.isoformat()+'Z' if isinstance(x,datetime.datetime) else None))`], { input: xml }));
}
export function validateSource(c, head, status) {
  requireThat(head.trim() === c.revision, 'Requested revision must equal HEAD.');
  requireThat(status.trim() === '', 'Commit or resolve source changes before preflight/build.');
}
function ensureSource(c) {
  validateSource(c, run('git', ['rev-parse', 'HEAD']), run('git', ['status', '--porcelain', '--untracked-files=normal']));
}
export function checkCapacity(freeBytes) {
  requireThat(freeBytes >= MIN_FREE_BYTES, 'At least 6 GiB free working space is required on repository and temporary volumes; no runtime downloaded.');
}
function capacity(directory) { const s = statfsSync(directory); checkCapacity(s.bavail * s.bsize); }

export function preflight(c) {
  validateConfig(c);
  requireThat(process.platform === 'darwin', 'MAS signing requires macOS.');
  ensureSource(c);
  requireThat(existsSync(c.profile), 'Provisioning profile does not exist.');
  const profileRelative = path.relative(realpathSync(root), realpathSync(c.profile));
  requireThat(profileRelative.startsWith(`..${path.sep}`), 'Keep the provisioning profile outside the repository.');
  run('/usr/bin/xcodebuild', ['-version']);
  const appIdentity = selectIdentity(parseIdentities(run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])), c.identity);
  let installerIdentity;
  if (c.mode === 'distribution') installerIdentity = selectIdentity(parseIdentities(run('/usr/bin/security', ['find-identity', '-v'])), c['installer-identity']);
  const profile = decodeProfile(c.profile);
  const profileSummary = validateProfile(c, profile, appIdentity.hash);
  if (c.mode === 'development') {
    const hardware = JSON.parse(run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json']));
    const uuid = hardware.SPHardwareDataType?.[0]?.platform_UUID;
    requireThat(uuid && profile.ProvisionedDevices.includes(uuid), 'This Mac is not registered in the development profile.');
  }
  capacity(root); capacity(os.tmpdir());
  return { appIdentity, installerIdentity, profileSummary, profileSha256: sha256(c.profile) };
}

export function mainEntitlements(c) {
  return {
    'com.apple.security.app-sandbox': true,
    'com.apple.security.network.client': true,
    'com.apple.security.files.user-selected.read-write': true,
    'com.apple.application-identifier': `${c.team}.${BUNDLE_ID}`,
    'com.apple.developer.team-identifier': c.team,
    'com.apple.security.application-groups': [`${c.team}.${BUNDLE_ID}`],
    ...(c.mode === 'development' ? { 'com.apple.security.get-task-allow': true } : {}),
  };
}
export function childEntitlements() {
  return { 'com.apple.security.app-sandbox': true, 'com.apple.security.inherit': true };
}
export function validateEntitlements(actual, expected) {
  requireThat(JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort()), 'Signed entitlements differ from the declared policy.');
}
function xmlPlist(value) {
  return run('python3', ['-c', 'import sys,json,plistlib;sys.stdout.buffer.write(plistlib.dumps(json.load(sys.stdin)))'], { input: JSON.stringify(value) });
}
function plistRead(filename) {
  return JSON.parse(run('python3', ['-c', 'import sys,plistlib,json;print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', filename]));
}
function sha256(filename) { return createHash('sha256').update(readFileSync(filename)).digest('hex'); }

export async function build(c, checked) {
  // Only --build reaches imports that can download Electron or access signing keys.
  const { packager } = await import('@electron/packager');
  const { sign, flat } = await import('@electron/osx-sign');
  const { hardenTemplateHook, verifyHardening } = await import('./hardening.mjs');
  ensureSource(c);
  capacity(root); capacity(os.tmpdir());
  const destination = path.join(root, 'release', `mas-${c.mode}-${c.arch}-${c['build-number']}-${c.revision.slice(0, 12)}`);
  requireThat(!existsSync(destination), 'Output already exists; preserve or remove it explicitly before rebuilding.');
  const temp = mkdtempSync(path.join(os.tmpdir(), 'fabric-mas-'));
  try {
    // Only committed inputs enter the package, including when ignored local files exist.
    run('/usr/bin/tar', ['-xf', '-', '-C', temp], { input: run('git', ['archive', c.revision, 'desktop', 'package-lock.json'], { encoding: 'buffer' }) });
    const lock = JSON.parse(readFileSync(path.join(temp, 'package-lock.json'), 'utf8'));
    const electronVersion = lock.packages?.['node_modules/electron']?.version;
    requireThat(/^\d+\.\d+\.\d+$/.test(electronVersion || ''), 'The committed lockfile must pin a stable Electron version.');
    const profilePath = path.join(temp, 'embedded.provisionprofile');
    writeFileSync(profilePath, readFileSync(c.profile), { mode: 0o600 });
    requireThat(sha256(profilePath) === checked.profileSha256, 'Profile changed after preflight.');
    const main = path.join(temp, 'main.plist');
    const child = path.join(temp, 'child.plist');
    writeFileSync(main, xmlPlist(mainEntitlements(c)));
    writeFileSync(child, xmlPlist(childEntitlements()));
    mkdirSync(destination, { recursive: true });
    const apps = await packager({
      dir: path.join(temp, 'desktop'), name: 'Fabric Inbox', executableName: 'Fabric Inbox',
      appBundleId: BUNDLE_ID, appCategoryType: 'public.app-category.productivity',
      platform: 'mas', arch: c.arch, electronVersion, buildVersion: c['build-number'],
      out: destination, overwrite: false, asar: true, prune: true, osxSign: false,
      ignore: [/\/(?:mas-package|package|dist-mac|hardening|release-retention)\.mjs$/, /\/entitlements\.mac\.plist$/, /\/icon\.icns$/, /\/dmg-background/],
      extendInfo: { ElectronTeamID: c.team, FabricInboxSourceRevision: c.revision, NSHumanReadableCopyright: 'Fabric Inbox', NSRequiresAquaSystemAppearance: false },
      // LC-13/LC-07: hardened fuses, no unused purpose strings (desktop/hardening.mjs); verified after signing.
      afterExtract: hardenTemplateHook(),
    });
    requireThat(apps.length === 1, 'Expected exactly one architecture-specific MAS application.');
    const app = path.join(apps[0], 'Fabric Inbox.app');
    requireThat(!existsSync(path.join(app, 'Contents/Frameworks/Squirrel.framework')), 'Darwin Electron runtime detected; it cannot validate MAS behavior.');
    const signedChildren = new Set();
    await sign({ app, platform: 'mas', type: c.mode, identity: checked.appIdentity.hash,
      provisioningProfile: profilePath, version: electronVersion, preAutoEntitlements: false,
      optionsForFile: (file) => {
        const topLevel = path.resolve(file) === path.resolve(app);
        if (!topLevel) signedChildren.add(file);
        return { entitlements: topLevel ? main : child, hardenedRuntime: false };
      },
    });
    const actualArch = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS/Fabric Inbox')]).trim();
    requireThat(actualArch === (c.arch === 'x64' ? 'x86_64' : 'arm64'), 'Packaged architecture differs from request.');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    requireThat(signedChildren.size > 0, 'No nested Electron code was signed.');
    for (const file of [app, ...signedChildren]) {
      const signedEntitlements = run('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', file]);
      const decoded = JSON.parse(run('python3', ['-c', 'import sys,plistlib,json;print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { input: signedEntitlements }));
      validateEntitlements(decoded, file === app ? mainEntitlements(c) : childEntitlements());
    }
    const hardening = verifyHardening(app);
    const info = plistRead(path.join(app, 'Contents/Info.plist'));
    requireThat(info.CFBundleIdentifier === BUNDLE_ID && info.CFBundleVersion === c['build-number'] && info.FabricInboxSourceRevision === c.revision, 'Packaged bundle metadata does not match requested inputs.');
    requireThat(checked.profileSha256 === sha256(path.join(app, 'Contents/embedded.provisionprofile')), 'Embedded provisioning profile mismatch.');
    let pkg;
    if (c.mode === 'distribution') {
      pkg = path.join(destination, 'Fabric Inbox.pkg');
      await flat({ app, platform: 'mas', identity: checked.installerIdentity.hash, pkg, implementation: 'native' });
      run('/usr/sbin/pkgutil', ['--check-signature', pkg]);
    }
    const receipt = { status: c.mode === 'distribution' ? 'signed-package-local-checks-passed' : 'development-app-local-checks-passed', submissionReady: false,
      sourceRevision: c.revision, platform: 'mas', arch: c.arch, bundleId: BUNDLE_ID, buildNumber: c['build-number'], electronVersion,
      app: path.relative(destination, app), ...(pkg ? { pkg: path.basename(pkg), pkgSha256: sha256(pkg) } : {}),
      fuses: hardening.fuses, usageDescriptions: hardening.usageDescriptions,
      remaining: ['Real MAS sandbox launch and mail acceptance', 'App Store Connect processing and review', 'Operator privacy/export/legal declarations'],
    };
    // LC-15: release/ keeps this store build and the newest other one.
    receipt.prunedFromRelease = pruneReleases(path.join(root, 'release'), { currentMas: path.basename(destination) });
    writeFileSync(path.join(destination, 'build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = parseArgs(process.argv.slice(2));
    const checked = preflight(config);
    console.log(config.build ? JSON.stringify(await build(config, checked), null, 2) : JSON.stringify({ status: 'preflight-passed-not-built', submissionReady: false, platform: 'mas', mode: config.mode, arch: config.arch, sourceRevision: config.revision, profileExpires: checked.profileSummary.expires }, null, 2));
  } catch (error) { console.error(`MAS blocked: ${error.message}`); process.exitCode = 1; }
}
