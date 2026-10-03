// Builds the installable macOS app: a universal (Apple silicon + Intel) Fabric
// Inbox.app signed with Developer ID and the hardened runtime, inside a disk
// image with an Applications shortcut — drag to install, like any Mac app.
//
// A published release is built only by .github/workflows/release.yml, in three stages, with the
// identity the organization's apple-signing action names and notarization by its notarize action
// (docs/release.md). The DMG is made from the stapled app, so notarization sits between stages:
//
//   --stage app   --identity NAME                    build and sign the app into release/ci/
//   (workflow: notarize and staple release/ci/Fabric Inbox.app)
//   --stage image --identity NAME [--submission ID]  the image from the stapled app, signed
//   (workflow: notarize and staple release/Fabric-Inbox-<version>.dmg)
//   --stage finish [--submission ID]                 assess the image, write the receipt and checksum
//
// Everything below is a local build: for debugging, never published or attached to a release.
//
//   npm run desktop:dmg                          signed with the one Developer ID identity found
//   npm run desktop:dmg -- --notary-profile NAME notarized and stapled too (xcrun notarytool store-credentials NAME)
//   npm run desktop:dmg -- --unsigned            local test image, not for sharing
//   npm run desktop:dmg -- --setup owner         a personal build with deployments/owner/setup.json inside
//
// The public build carries no setup: deployments/<name>/setup.json names real domains and
// addresses, so it lives only on its owner's machine (git-ignored; deployments/README.md) and
// is bundled only on request, into an image named after it, with its SHA-256 in the receipt.
//
// The app carries the server it creates in a person's Cloudflare account
// (server-bundle/, built by scripts/server-bundle.mjs from the same commit).
//
// Only committed files are packaged (git archive of HEAD), so the image matches
// an exact commit; a bundled setup is the one exception, named by its hash. A receipt with hashes and the signing/notarization state is
// written beside the image, and a `<image>.sha256` that `shasum -a 256 -c` reads.
// Signed is not notarized: without a notary profile Gatekeeper still asks on
// first open, and the receipt says so. With one, the build fails unless Apple
// accepted both the app and the image, both are stapled, and Gatekeeper names
// the source "Notarized Developer ID" for each. The release version needs its
// section in CHANGELOG.md. Publishing the result: docs/release.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const BUNDLE_ID = 'ai.passioncode.fabric-inbox';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_FREE_BYTES = 3 * 1024 ** 3;
/** What the server bundle is built from; must be committed before an image is made. */
export const SERVER_SOURCES = ['app', 'workers', 'shared', 'scripts/server-bundle.mjs', 'package.json', 'package-lock.json', 'vite.config.ts', 'react-router.config.ts', 'wrangler.jsonc', 'public'];

function requireThat(condition, message) { if (!condition) throw new Error(message); }

/**
 * A deployment's setup for a personal build, read from this machine: deployments/<name>/ is
 * git-ignored, so no commit holds it. Checked the way the app checks a setup file (desktop/policy.cjs).
 * Returns the exact text to bundle and its SHA-256 for the receipt.
 */
export function readDeploymentSetup(repoRoot, name) {
  const relative = `deployments/${name}/setup.json`;
  const file = path.join(repoRoot, relative);
  requireThat(existsSync(file), `No ${relative} on this machine. A deployment's files are local and never committed; deployments/README.md says how to create one.`);
  const text = readFileSync(file, 'utf8');
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${relative} is not JSON: ${error.message}`); }
  const { readSetup } = createRequire(import.meta.url)('./policy.cjs');
  const read = readSetup(value);
  requireThat(read.ok, `${relative} cannot be bundled: ${read.error}`);
  return { name, text, sha256: createHash('sha256').update(text).digest('hex') };
}
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}
function tryRun(command, args) {
  // stdout and stderr together: codesign and spctl report on stderr.
  try {
    const out = execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (error) { return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() }; }
}
function codesignDetails(target) {
  const result = spawnOutput('codesign', ['-dv', '--verbose=2', target]);
  return result;
}
function spawnOutput(command, args) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const STAGES = ['app', 'image', 'finish'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv) {
  const args = { unsigned: false, notaryProfile: '', identity: '', setups: [], stage: '', submission: '' };
  const valued = { '--notary-profile': 'notaryProfile', '--identity': 'identity', '--stage': 'stage', '--submission': 'submission' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--unsigned') args.unsigned = true;
    else if (a === '--setup') {
      requireThat(/^[a-z0-9-]{1,40}$/.test(argv[i + 1] || ''), 'Give a deployment name from deployments/, e.g. --setup owner.');
      args.setups.push(argv[++i]);
    } else if (valued[a]) {
      requireThat(argv[i + 1] && !argv[i + 1].startsWith('--'), `Give a value for ${a}.`);
      args[valued[a]] = argv[++i];
    } else throw new Error(`Unknown argument ${a}. Use --notary-profile NAME, --identity NAME, --unsigned, or --stage app|image|finish (the release workflow).`);
  }
  requireThat(!(args.unsigned && (args.notaryProfile || args.identity || args.stage)), '--unsigned cannot be combined with signing options.');
  requireThat(!args.notaryProfile || /^[A-Za-z0-9._-]{1,64}$/.test(args.notaryProfile), 'A notary profile name has letters, digits, dot, dash or underscore.');
  if (args.stage) {
    requireThat(STAGES.includes(args.stage), '--stage is app, image or finish.');
    requireThat(!args.notaryProfile, 'A CI stage is notarized by the workflow (the shared notarize action); --notary-profile is the local path.');
    requireThat(!args.setups.length, 'A CI release is the public build and never carries a setup.');
    requireThat(args.stage === 'finish' || args.identity, `--stage ${args.stage} needs --identity (the apple-signing action's identity output).`);
  }
  requireThat(!args.submission || ['image', 'finish'].includes(args.stage), '--submission belongs to --stage image or finish.');
  requireThat(!args.submission || UUID.test(args.submission), 'A notarization submission id is a UUID.');
  return args;
}

/** Where the CI stages keep the app and their state between workflow steps, and what they produce. */
export function stagePaths(repoRoot, version) {
  const dir = path.join(repoRoot, 'release', 'ci');
  return {
    dir, app: path.join(dir, 'Fabric Inbox.app'), state: path.join(dir, 'state.json'),
    dmg: path.join(repoRoot, 'release', `Fabric-Inbox-${version}.dmg`),
    receipt: path.join(repoRoot, 'release', `Fabric-Inbox-${version}.receipt.json`),
  };
}

/** The state an earlier stage left, refused unless it was written for this commit and version. */
export function checkStageState(state, revision, version) {
  requireThat(state && typeof state === 'object' && state.receipt, 'No stage state in release/ci/. Run --stage app first.');
  requireThat(state.revision === revision, `The stage state was written for commit ${String(state.revision).slice(0, 12)}, but HEAD is ${revision.slice(0, 12)}; run --stage app again.`);
  requireThat(state.version === version, `The stage state is for version ${state.version}, but desktop/package.json says ${version}; run --stage app again.`);
  return state;
}

/** The single valid Developer ID Application identity, or the named one. */
export function pickIdentity(findIdentityOutput, wanted = '') {
  const all = [...findIdentityOutput.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "([^"\n]+)"\s*$/gm)].map((m) => ({ hash: m[1], name: m[2] }));
  const developerId = all.filter((i) => i.name.startsWith('Developer ID Application: '));
  const matching = wanted ? developerId.filter((i) => i.name === wanted) : developerId;
  requireThat(matching.length === 1, wanted
    ? `The identity "${wanted}" is not a valid Developer ID Application identity here.`
    : `Expected exactly one Developer ID Application identity, found ${developerId.length}; name one with --identity.`);
  return matching[0];
}

/** The body of `## <version>` in CHANGELOG.md text, up to the next `## `; '' when absent. */
export function changelogSection(text, version) {
  const escaped = version.replace(/\./g, '\\.');
  const m = new RegExp(`^## ${escaped}(?![\\d.])[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

/**
 * The verdict of `notarytool submit --wait --output-format json`. Anything but Accepted is a
 * failed build: notarytool can end --wait with Invalid, and its log says why.
 */
export function notarization(output) {
  let verdict = null;
  try { verdict = JSON.parse(String(output).trim().split('\n').filter(Boolean).pop() ?? ''); } catch { verdict = null; }
  requireThat(verdict && typeof verdict.status === 'string', `notarytool returned no verdict: ${String(output).slice(0, 200)}`);
  requireThat(verdict.status === 'Accepted', `Apple did not accept the submission (${verdict.status}: ${verdict.message ?? ''}); read it with xcrun notarytool log ${verdict.id} --keychain-profile <profile>.`);
  return { id: verdict.id, status: verdict.status };
}

/** spctl -a -vv output: accepted only when spctl succeeded, said accepted, from a notarized Developer ID. */
export function gatekeeper(output, succeeded) {
  const source = /^source=(.+)$/m.exec(String(output))?.[1]?.trim() ?? null;
  const said = /: accepted$/m.test(String(output));
  return { accepted: Boolean(succeeded && said && source === 'Notarized Developer ID'), source };
}

/**
 * Runs spctl and returns its exit and everything it printed. spctl writes the verdict
 * ("accepted", "source=…") to stderr and nothing to stdout, so stdout alone reads as no source.
 */
export function spctl(args) {
  const r = spawnSync('spctl', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** One line in the format `shasum -a 256 -c` checks: `<sha256>  <file name>`. */
export function checksumLine(sha, fileName) {
  requireThat(/^[0-9a-f]{64}$/.test(sha), 'A SHA-256 is 64 hex characters.');
  requireThat(/^[A-Za-z0-9._-]+$/.test(fileName), 'Give the image file name, not a path.');
  return `${sha}  ${fileName}\n`;
}

/** What the build is made from: the committed version, Electron pin and release notes at HEAD. */
function readSource() {
  const revision = run('git', ['rev-parse', 'HEAD']).trim();
  const dirty = run('git', ['status', '--porcelain', '--', 'desktop', 'package-lock.json']).trim().length > 0;
  const desktopPackage = JSON.parse(run('git', ['show', `${revision}:desktop/package.json`]));
  const version = desktopPackage.version;
  requireThat(/^\d+\.\d+\.\d+$/.test(version), 'desktop/package.json needs a version like 1.2.3.');
  const lock = JSON.parse(run('git', ['show', `${revision}:package-lock.json`]));
  const electronVersion = lock.packages?.['node_modules/electron']?.version;
  requireThat(/^\d+\.\d+\.\d+$/.test(electronVersion || ''), 'The committed lockfile must pin Electron.');
  let changelog = '';
  try { changelog = run('git', ['show', `${revision}:CHANGELOG.md`]); } catch { changelog = ''; }
  const notes = changelogSection(changelog, version);
  requireThat(notes, `The committed CHANGELOG.md has no section for ${version}; add "## ${version}" and commit it.`);
  return { revision, dirty, version, electronVersion };
}

/** The workflow run that built it, or this machine: a local build is a debug build. */
function builtBy() {
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_ACTIONS === 'true' && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : 'this machine (a debug build: never published)';
}

/** Temporary files stay inside release/ (git-ignored); returns the directory and resets TMPDIR to it. */
function buildTempDir(out) {
  // On 2026-09-28 files vanished from the system temp directory mid-build (spawn codesign ENOENT)
  // while the disk was 99% full and other sessions were cleaning. electron-packager and
  // os.tmpdir() both read TMPDIR.
  const buildTemp = path.join(out, '.build-tmp');
  rmSync(buildTemp, { recursive: true, force: true });
  mkdirSync(buildTemp, { recursive: true });
  process.env.TMPDIR = buildTemp + path.sep;
  return buildTemp;
}

/** Signature checks on the packaged app, recorded in the receipt; the hardened runtime is required. */
function checkSignedApp(app, identity, receipt) {
  requireThat(tryRun('codesign', ['--verify', '--deep', '--strict', app]).ok, 'The signed app failed strict signature verification.');
  receipt.signing = identity.name;
  receipt.checks.appSignature = 'codesign --verify --deep --strict: valid';
  receipt.checks.hardenedRuntime = /flags=0x10000\(runtime\)/.test(codesignDetails(app)) ? 'present' : 'missing';
  requireThat(receipt.checks.hardenedRuntime === 'present', 'The app was signed without the hardened runtime; notarization would refuse it.');
}

/** The app must be notarized and stapled before it goes in an image; proven, then recorded. */
function checkNotarizedApp(app, receipt) {
  requireThat(tryRun('xcrun', ['stapler', 'validate', app]).ok, 'The app is not stapled; notarization of the app did not complete.');
  receipt.checks.appStaple = 'stapler validate: valid';
  const assessed = spctl(['--assess', '--type', 'execute', '-vv', app]);
  const verdict = gatekeeper(assessed.out, assessed.ok);
  requireThat(verdict.accepted, `Gatekeeper did not accept the app as notarized (source=${verdict.source}).`);
  receipt.checks.appGatekeeper = `spctl -a -vv -t execute: accepted, source=${verdict.source}`;
}

/**
 * Disk image: the app and an Applications shortcut over a background that says to drag it there.
 * dmgbuild writes the Finder layout (.DS_Store) directly, so no Finder automation is involved;
 * without uv the image is built by hdiutil with the default view, still installable by drag.
 */
function makeImage({ app, background, dmg, temp, identity, receipt }) {
  const settings = path.join(temp, 'dmg-settings.py');
  writeFileSync(settings, [
    'import os',
    `files = [${JSON.stringify(app)}]`,
    "symlinks = {'Applications': '/Applications'}",
    "icon_locations = {'Fabric Inbox.app': (140, 160), 'Applications': (400, 160)}",
    `background = ${JSON.stringify(background)}`,
    'window_rect = ((200, 120), (540, 340))',
    "default_view = 'icon-view'",
    'icon_size = 112',
    'text_size = 13',
    'show_status_bar = False',
    'show_tab_view = False',
    'show_toolbar = False',
    'show_pathbar = False',
    'show_sidebar = False',
    "format = 'UDZO'",
    "filesystem = 'HFS+'",
    '',
  ].join('\n'));
  const built = tryRun('uvx', ['--from', 'dmgbuild==1.6.7', 'dmgbuild', '-s', settings, 'Fabric Inbox', dmg]);
  if (built.ok) receipt.checks.windowLayout = 'icon view, app beside Applications, drag-to-install background (dmgbuild 1.6.7)';
  else {
    receipt.checks.windowLayout = `default view: dmgbuild unavailable (${built.out.split('\n').pop()?.slice(0, 160)}); the image still installs by drag`;
    const stage = path.join(temp, 'stage');
    mkdirSync(stage);
    run('/usr/bin/ditto', [app, path.join(stage, 'Fabric Inbox.app')]);
    symlinkSync('/Applications', path.join(stage, 'Applications'));
    run('hdiutil', ['create', '-volname', 'Fabric Inbox', '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', dmg]);
  }
  if (identity) {
    run('codesign', ['--sign', identity.hash, '--timestamp', dmg]);
    receipt.checks.imageSignature = tryRun('codesign', ['--verify', '--strict', dmg]).ok ? 'valid' : 'invalid';
  }
}

/** Gatekeeper's verdict on a signed image, recorded; required when the image is notarized. */
function assessImage(dmg, receipt, mustBeNotarized) {
  const assess = spctl(['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
  const verdict = gatekeeper(assess.out, assess.ok);
  receipt.gatekeeper = verdict.accepted ? `accepted, source=${verdict.source}`
    : `not accepted: ${assess.out.split('\n').find((l) => l.includes('source=')) ?? assess.out.split('\n')[0]}`;
  requireThat(verdict.accepted || !mustBeNotarized, `Gatekeeper did not accept the notarized image: ${receipt.gatekeeper}`);
}

/** The image's hash, its `.sha256` and the receipt beside it. */
function writeReceipt(dmg, receipt, receiptFile) {
  receipt.sha256 = sha256(dmg);
  receipt.bytes = readFileSync(dmg).length;
  receipt.checksumFile = `${path.basename(dmg)}.sha256`;
  writeFileSync(`${dmg}.sha256`, checksumLine(receipt.sha256, path.basename(dmg)));
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}

function readStageState(paths, src) {
  let state = null;
  try { state = JSON.parse(readFileSync(paths.state, 'utf8')); } catch { state = null; }
  return checkStageState(state, src.revision, src.version);
}

/** CI stage 2: the image from the app the workflow notarized and stapled, signed by the same identity. */
async function stageImage(args, src) {
  const paths = stagePaths(root, src.version);
  const state = readStageState(paths, src);
  const { receipt } = state;
  requireThat(existsSync(paths.app), `No app at ${path.relative(root, paths.app)}. Run --stage app first.`);
  const identity = pickIdentity(run('security', ['find-identity', '-v', '-p', 'codesigning']), args.identity);
  requireThat(identity.name === receipt.signing, 'The image is signed by the identity that signed the app.');
  try { checkNotarizedApp(paths.app, receipt); } catch (error) {
    throw new Error(`${error.message} Notarize and staple ${path.relative(root, paths.app)} (the shared notarize action) before --stage image.`);
  }
  if (args.submission) receipt.checks.appNotarySubmission = `${args.submission}: Accepted`;
  const buildTemp = buildTempDir(path.join(root, 'release'));
  const temp = mkdtempSync(path.join(buildTemp, 'fabric-dmg-'));
  try {
    run('/usr/bin/tar', ['-xf', '-', '-C', temp], { input: run('git', ['archive', src.revision, 'desktop/dmg-background.png'], { encoding: 'buffer' }) });
    rmSync(paths.dmg, { force: true });
    rmSync(`${paths.dmg}.sha256`, { force: true });
    makeImage({ app: paths.app, background: path.join(temp, 'desktop', 'dmg-background.png'), dmg: paths.dmg, temp, identity, receipt });
    requireThat(receipt.checks.imageSignature === 'valid', 'The signed image failed signature verification.');
    writeFileSync(paths.state, JSON.stringify({ ...state, receipt }, null, 2) + '\n');
    console.log(JSON.stringify({ stage: 'image', image: path.relative(root, paths.dmg), next: 'notarize and staple it, then --stage finish' }, null, 2));
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(buildTemp, { recursive: true, force: true });
  }
}

/** CI stage 3: the image the workflow notarized and stapled, assessed; then the receipt and checksum. */
function stageFinish(args, src) {
  const paths = stagePaths(root, src.version);
  const { receipt } = readStageState(paths, src);
  requireThat(existsSync(paths.dmg) && receipt.checks.imageSignature === 'valid', `No signed image at ${path.relative(root, paths.dmg)}. Run --stage image first.`);
  requireThat(tryRun('xcrun', ['stapler', 'validate', paths.dmg]).ok, `The image is not stapled. Notarize and staple ${path.relative(root, paths.dmg)} (the shared notarize action) before --stage finish.`);
  if (args.submission) receipt.checks.notarySubmission = `${args.submission}: Accepted`;
  receipt.notarization = 'accepted and stapled (release workflow, passioncode-ai/.github notarize action)';
  assessImage(paths.dmg, receipt, true);
  writeReceipt(paths.dmg, receipt, paths.receipt);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireThat(process.platform === 'darwin', 'A macOS disk image is built on macOS.');
  requireThat(statfsSync(root).bavail * statfsSync(root).bsize > MIN_FREE_BYTES, 'At least 3 GB of free disk space is needed.');
  const src = readSource();
  if (args.stage === 'image') return stageImage(args, src);
  if (args.stage === 'finish') return stageFinish(args, src);
  const { revision, dirty, version, electronVersion } = src;
  // Read and checked before anything is signed, so a missing or broken setup fails in seconds.
  const bundled = args.setups.map((name) => readDeploymentSetup(root, name));

  const identity = args.unsigned ? null : pickIdentity(run('security', ['find-identity', '-v', '-p', 'codesigning']), args.identity);
  if (args.notaryProfile) {
    const probe = tryRun('xcrun', ['notarytool', 'history', '--keychain-profile', args.notaryProfile]);
    requireThat(probe.ok, `The notary profile "${args.notaryProfile}" is not in this Mac's keychain. Create it once: xcrun notarytool store-credentials ${args.notaryProfile} --team-id <TEAM>.`);
  }

  const out = path.join(root, 'release');
  mkdirSync(out, { recursive: true });
  const buildTemp = buildTempDir(out);
  const name = `Fabric-Inbox-${version}${args.setups.length ? '-' + args.setups.join('-') : ''}${args.unsigned ? '-unsigned' : ''}`;
  const dmg = path.join(out, `${name}.dmg`);
  const staged = args.stage === 'app' ? stagePaths(root, version) : null;
  if (staged) rmSync(staged.dir, { recursive: true, force: true });
  else {
    rmSync(dmg, { force: true });
    rmSync(`${dmg}.sha256`, { force: true });
  }
  const temp = mkdtempSync(path.join(buildTemp, 'fabric-dmg-'));
  try {
    run('/usr/bin/tar', ['-xf', '-', '-C', temp], { input: run('git', ['archive', revision, 'desktop'], { encoding: 'buffer' }) });
    const source = path.join(temp, 'desktop');
    requireThat(!existsSync(path.join(source, 'setups')), 'desktop/setups exists in the commit: setups belong in deployments/<name>/setup.json and are bundled only with --setup.');
    for (const setup of bundled) {
      mkdirSync(path.join(source, 'setups'), { recursive: true });
      writeFileSync(path.join(source, 'setups', `${setup.name}.json`), setup.text);
    }
    // The server the app can create in a person's own account (CF-5), built
    // from the same commit: a dirty server source would ship code no commit holds.
    const serverDirty = run('git', ['status', '--porcelain', '--', ...SERVER_SOURCES]).trim();
    requireThat(!serverDirty, `Commit the server sources first; changed: ${serverDirty.split('\n').slice(0, 5).join(', ')}`);
    run('npm', ['run', 'build'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const { buildServerBundle } = await import('../scripts/server-bundle.mjs');
    const serverManifest = buildServerBundle({ buildDir: path.join(root, 'build'), outDir: path.join(source, 'server-bundle'),
      version: JSON.parse(run('git', ['show', `${revision}:package.json`])).version, revision });
    const { packager } = await import('@electron/packager');
    const [appDir] = await packager({
      dir: source, name: 'Fabric Inbox', executableName: 'Fabric Inbox', appVersion: version, buildVersion: version,
      protocols: [{ name: 'Fabric Inbox connect link', schemes: ['fabric-inbox'] }], appBundleId: BUNDLE_ID, appCategoryType: 'public.app-category.productivity', icon: path.join(source, 'icon.icns'),
      platform: 'darwin', arch: 'universal', electronVersion, out: path.join(temp, 'out'), overwrite: true, asar: true, prune: true,
      ignore: [/\/(?:mas-package|package|dist-mac)\.mjs$/, /\/entitlements\.mac\.plist$/, /\/icon\.icns$/, /\/dmg-background/],
      extendInfo: { NSHumanReadableCopyright: 'Fabric Inbox — PassionCode.ai', NSRequiresAquaSystemAppearance: false, LSMinimumSystemVersion: '12.0' },
      osxSign: identity ? {
        identity: identity.hash,
        optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.join(source, 'entitlements.mac.plist') }),
      } : undefined,
      // In a CI stage the workflow notarizes; only the local path asks the packager to.
      osxNotarize: args.notaryProfile ? { keychainProfile: args.notaryProfile } : undefined,
    });
    const app = path.join(appDir, 'Fabric Inbox.app');
    const receipt = {
      product: 'Fabric Inbox', version, revision, dirtyDesktopSources: dirty, electronVersion, architectures: ['arm64', 'x86_64'],
      builtAt: new Date().toISOString(), builtBy: builtBy(), image: path.basename(staged ? staged.dmg : dmg),
      bundledSetups: bundled.length ? bundled.map(({ name, sha256 }) => ({ name, file: `deployments/${name}/setup.json`, sha256 })) : 'none (public build)',
      serverBundle: { version: serverManifest.version, revision: serverManifest.revision, modules: serverManifest.modules.length,
        assets: Object.keys(serverManifest.assets.files).length, manifestSha256: sha256(path.join(source, 'server-bundle', 'manifest.json')) },
      signing: 'unsigned', notarization: 'not requested',
      gatekeeper: 'not assessed', checks: {},
    };
    if (identity) checkSignedApp(app, identity, receipt);
    receipt.checks.architectures = run('lipo', ['-archs', path.join(app, 'Contents/MacOS/Fabric Inbox')]).trim();
    if (staged) {
      // CI stage 1: the signed app waits in release/ci/ for the workflow to notarize and staple it.
      mkdirSync(staged.dir, { recursive: true });
      run('/usr/bin/ditto', [app, staged.app]);
      receipt.notarization = 'pending: the release workflow notarizes the app, then the image';
      writeFileSync(staged.state, JSON.stringify({ revision, version, receipt }, null, 2) + '\n');
      console.log(JSON.stringify({ stage: 'app', app: path.relative(root, staged.app), next: 'notarize and staple it, then --stage image' }, null, 2));
      return;
    }
    // The packager notarized and stapled the app (osxNotarize); prove both before it goes in the image.
    if (args.notaryProfile) checkNotarizedApp(app, receipt);
    makeImage({ app, background: path.join(source, 'dmg-background.png'), dmg, temp, identity, receipt });
    if (args.notaryProfile) {
      let submitted;
      try {
        submitted = run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', args.notaryProfile, '--wait', '--output-format', 'json'], { timeout: 45 * 60 * 1000 });
      } catch (error) { submitted = `${error.stdout ?? ''}`; if (!submitted.trim()) throw error; }
      const verdict = notarization(submitted);
      receipt.checks.notarySubmission = `${verdict.id}: ${verdict.status}`;
      run('xcrun', ['stapler', 'staple', dmg]);
      requireThat(tryRun('xcrun', ['stapler', 'validate', dmg]).ok, 'The image was accepted but its staple does not validate.');
      receipt.notarization = 'accepted and stapled';
    }
    if (identity) assessImage(dmg, receipt, Boolean(args.notaryProfile));
    writeReceipt(dmg, receipt, path.join(out, `${name}.receipt.json`));
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(buildTemp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let finished = false;
  // A promise that never settles lets Node drain its loop and exit 0 with nothing built — a
  // failure reported as success (seen in fabric-dashboards' builder). Refuse that exit.
  process.on('beforeExit', () => { if (!finished) { console.error('The build stopped before writing a receipt; nothing was produced.'); process.exit(1); } });
  main().then(() => { finished = true; }).catch((error) => { finished = true; console.error(error.message); process.exit(1); });
}
