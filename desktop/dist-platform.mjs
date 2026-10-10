// Windows and Linux builds of Fabric Inbox (fabric-workspace knowledge/platforms.md PL-01…PL-08).
//
//   node desktop/dist-platform.mjs --platform win32|linux [--arch x64|arm64] [--out release] [--stage all|app|package]
//
// Stages (the release workflow's Windows job): `app` assembles and hardens the app in
// <out>/.stage-<platform>-<arch>/ and prints where; the workflow signs its executables and DLLs
// (passioncode-ai/.github windows-signing, Azure Artifact Signing); `package` wraps that signed
// folder with electron-builder (which signs the uninstaller and the installer itself) and writes
// the receipt. electron-builder never signs a prepackaged app's own files: its packing step,
// where it would, is skipped for a prepackaged folder. `all` (the default) does both at once.
//
// The same discipline as the macOS builder (desktop/dist-mac.mjs): only committed files are
// packaged (git archive of HEAD), the server the app can create is built from the same commit, the
// Electron template is hardened before the app is assembled (desktop/hardening.mjs) and the built
// executable is gated on its fuse wire. @electron/packager assembles the app; electron-builder
// only wraps the prepackaged folder:
//   Windows: an NSIS installer, per-user (no elevation), registering fabric-inbox:// under
//            HKCU\Software\Classes (PL-01, PL-04). Authenticode signing is Azure Artifact Signing in
//            the release environment once the operator's identity is validated (PL-02); until then
//            the receipt says windows_authenticode: NOT_SIGNED.
//   Linux:   an AppImage (updates itself, PL-03) and a .deb (puts `fabric-inbox` on PATH, never
//            checks for updates), both with a .desktop entry MimeType=x-scheme-handler/fabric-inbox
//            (PL-04) and depending on the Secret Service library (PL-05).
// A receipt (<name>.receipt.json) lists every artifact with its SHA-256, the fuses and the signing
// state; SHA256SUMS lines are written beside it. A release build (the release workflow) also writes
// the feed its copies read, update-<platform>-<arch>.json, naming the installer (Windows) or the
// AppImage (Linux) with its digest and size.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenTemplateHook, verifyHardening } from './hardening.mjs';
import { analyticsBundle, BUNDLE_ID, SERVER_SOURCES } from './dist-mac.mjs';
import { pruneReleases } from './release-retention.mjs';

const require = createRequire(import.meta.url);
const { feedFor } = require('./updater.cjs');
const { WINDOWS_SIGNER } = require('./update-verify.cjs');
const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(desktop, '..');

export const PLATFORMS = Object.freeze({
  win32: { executableName: 'Fabric Inbox', icon: 'icon.ico', builder: 'WINDOWS', targets: ['nsis'] },
  linux: { executableName: 'fabric-inbox', icon: 'icon.png', builder: 'LINUX', targets: ['AppImage', 'deb'] },
});
const ARCHES = ['x64', 'arm64'];
// Files of the macOS builders and of this one never ship inside an app.
export const PACKAGE_IGNORE = [/\/(?:mas-package|package|dist-mac|dist-platform|hardening|release-retention)\.mjs$/, /\/entitlements\.mac\.plist$/, /\/icon\.(?:icns|ico)$/, /\/dmg-background/, /^\/(?:linux|windows)\//];

function requireThat(condition, message) { if (!condition) throw new Error(message); }
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', cwd: root, maxBuffer: 256 * 1024 * 1024, ...options });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function parsePlatformArgs(argv) {
  const out = { platform: '', arch: process.arch, out: path.join(root, 'release'), stage: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--platform') out.platform = value();
    else if (flag === '--arch') out.arch = value();
    else if (flag === '--out') out.out = path.resolve(value());
    else if (flag === '--stage') out.stage = value();
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  requireThat(Object.hasOwn(PLATFORMS, out.platform), `--platform must be ${Object.keys(PLATFORMS).join(' or ')}`);
  requireThat(ARCHES.includes(out.arch), `--arch must be ${ARCHES.join(' or ')}`);
  requireThat(['all', 'app', 'package'].includes(out.stage), '--stage must be all, app or package');
  return out;
}

/** The update feed a release build checks, per platform and architecture (PL-03); null outside the release workflow. */
export function platformFeed(env, platform, arch) {
  if (env.GITHUB_ACTIONS !== 'true' || !env.FABRIC_INBOX_RELEASE_BUILD) return null;
  const repository = String(env.GITHUB_REPOSITORY || '');
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'GITHUB_REPOSITORY must name owner/repository for the update feed.');
  return { feed: `https://github.com/${repository}/releases/latest/download/update-${platform}-${arch}.json` };
}

/**
 * electron-builder's configuration for the prepackaged app. File names carry our own architecture
 * names (x64, arm64): electron-builder's `${arch}` says `amd64` in a .deb and `x86_64` in an AppImage,
 * and the update feed and the release workflow name the files exactly.
 */
export function builderConfig({ platform, version, arch, signing }) {
  requireThat(ARCHES.includes(arch), `--arch must be ${ARCHES.join(' or ')}`);
  const common = {
    appId: BUNDLE_ID, productName: 'Fabric Inbox', copyright: 'PassionCode.ai',
    directories: { output: '.' }, electronVersion: require('electron/package.json').version,
    protocols: [{ name: 'Fabric Inbox connect link', schemes: ['fabric-inbox'] }],
    publish: null, npmRebuild: false, buildDependenciesFromSource: false,
  };
  if (platform === 'win32') return {
    ...common,
    artifactName: `Fabric-Inbox-${version}-win-${arch}-setup.\${ext}`,
    win: { icon: path.join(desktop, 'icon.ico'), executableName: 'Fabric Inbox', ...(signing ? { azureSignOptions: signing } : {}) },
    nsis: {
      oneClick: true, perMachine: false, allowElevation: false, runAfterFinish: true,
      createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'Fabric Inbox',
      deleteAppDataOnUninstall: false, differentialPackage: false,
      include: path.join(desktop, 'windows', 'installer.nsh'),
    },
  };
  return {
    ...common,
    // The .deb installs to /opt/<productName>. Chromium's zygote cannot start from a path with a
    // space (CI: "LaunchProcess: failed to execvp: /opt/Fabric"), so the folder is /opt/fabric-inbox;
    // menus still say Fabric Inbox (desktop entry Name).
    productName: 'fabric-inbox',
    artifactName: `Fabric-Inbox-${version}-linux-${arch}.\${ext}`,
    linux: {
      icon: path.join(desktop, 'icon.png'), executableName: 'fabric-inbox', category: 'Network;Email;',
      desktop: { entry: { Name: 'Fabric Inbox', StartupWMClass: 'fabric-inbox' } },
      maintainer: 'PassionCode.ai <contact@passioncode.ai>', vendor: 'PassionCode.ai', syncDesktopName: true,
      synopsis: 'Mail client with cloud automation', description: 'Fabric Inbox: one triaged list across Gmail and Cloudflare mailboxes, answered by versioned agents.',
    },
    // PL-05: the sign-in is kept in the Secret Service; libsecret reaches it, a keyring provides it.
    deb: { packageName: 'fabric-inbox', depends: ['libsecret-1-0', 'libgtk-3-0', 'libnss3', 'libxss1', 'libasound2 | libasound2t64', 'xdg-utils'], recommends: ['gnome-keyring | kwalletmanager'],
      afterInstall: path.join(desktop, 'linux', 'after-install.sh'), afterRemove: path.join(desktop, 'linux', 'after-remove.sh') },
    appImage: { artifactName: `Fabric-Inbox-${version}-linux-${arch}.AppImage` },
  };
}

/** The 7z filter for the Windows installer's payload: BCJ for arm64 (nsis7z has no ARM64 filter), else 7-Zip's own choice. */
export function installerFilter(arch) { return arch === 'arm64' ? 'BCJ' : undefined; }

/** Azure Artifact Signing from the release environment (PL-02), or null: then NOT_SIGNED. */
export function windowsSigning(env) {
  const endpoint = String(env.AZURE_SIGNING_ENDPOINT || '').trim();
  const account = String(env.AZURE_SIGNING_ACCOUNT || '').trim();
  const profile = String(env.AZURE_SIGNING_PROFILE || '').trim();
  if (!endpoint || !account || !profile) return null;
  // publisherName is the certificate's CN (electron-builder records it for the installer).
  return { endpoint, codeSigningAccountName: account, certificateProfileName: profile, publisherName: WINDOWS_SIGNER };
}

/** Where a staged build keeps its work between `--stage app` and `--stage package`. */
export const stageDir = (out, platform, arch) => path.join(out, `.stage-${platform}-${arch}`);

/** Stage `app`: the hardened app folder, from the committed desktop folder and the server of the same commit. */
async function assembleApp(args, temp) {
  const { platform, arch } = args;
  const spec = PLATFORMS[platform];
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const revision = run('git', ['rev-parse', 'HEAD']).trim();
  // Only committed files ship (as on macOS): the desktop folder of HEAD.
  // Extracted with cwd, not -C: Git for Windows' GNU tar reads "C:\..." as a remote host.
  execFileSync('tar', ['-xf', '-'], { cwd: temp, input: run('git', ['archive', revision, 'desktop'], { encoding: 'buffer' }) });
  const source = path.join(temp, 'desktop');
  requireThat(!existsSync(path.join(source, 'setups')), 'desktop/setups exists in the commit: setups are bundled only into personal macOS builds.');
  for (const file of ['analytics.json', 'updates.json']) requireThat(!existsSync(path.join(source, file)), `desktop/${file} exists in the commit: only the release build writes it.`);
  const analytics = analyticsBundle(process.env);
  if (analytics) writeFileSync(path.join(source, 'analytics.json'), JSON.stringify(analytics) + '\n', { mode: 0o600 });
  const feed = platformFeed(process.env, platform, arch);
  if (feed) writeFileSync(path.join(source, 'updates.json'), JSON.stringify(feed) + '\n');
  // The server the app can create (CF-5), from the same commit.
  const serverDirty = run('git', ['status', '--porcelain', '--', ...SERVER_SOURCES]).trim();
  requireThat(!serverDirty, `Commit the server sources first; changed: ${serverDirty.split('\n').slice(0, 5).join(', ')}`);
  run('npm', ['run', 'build'], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const { buildServerBundle } = await import('../scripts/server-bundle.mjs');
  const serverManifest = buildServerBundle({ buildDir: path.join(root, 'build'), outDir: path.join(source, 'server-bundle'), version, revision });

  const { packager } = await import('@electron/packager');
  const [appDir] = await packager({
    dir: source, name: 'Fabric Inbox', executableName: spec.executableName, appVersion: version, buildVersion: version,
    platform, arch, electronVersion: require('electron/package.json').version, out: path.join(temp, 'out'), overwrite: true,
    asar: true, prune: true, icon: path.join(source, spec.icon), ignore: PACKAGE_IGNORE,
    ...(platform === 'win32' ? { win32metadata: { CompanyName: 'PassionCode.ai', ProductName: 'Fabric Inbox', FileDescription: 'Fabric Inbox', OriginalFilename: 'Fabric Inbox.exe' } } : {}),
    afterExtract: hardenTemplateHook(),
  });
  // @electron/packager assembles the app in a private (0700) temporary folder and moves it here;
  // installed under /opt by the .deb, a 0700 folder owned by root is one nobody else can enter
  // (spawn … EACCES). The app's folder is world-readable, as every installed program's is.
  if (platform === 'linux') chmodSync(appDir, 0o755);
  verifyHardening(appDir, { platform, executableName: spec.executableName });
  return { platform, arch, version, revision, source, appDir, analytics: !!analytics, feed,
    serverBundle: { version: serverManifest.version, revision: serverManifest.revision, modules: serverManifest.modules.length } };
}

/** Stage `package`: electron-builder wraps the (signed) app folder; the receipt, feed and sums. */
async function packageApp(args, state) {
  const { platform, arch, version, revision, source, appDir, feed } = state;
  const spec = PLATFORMS[platform];
  // Read again here: signing the app's executables must leave the fuse wire as it was.
  const hardening = verifyHardening(appDir, { platform, executableName: spec.executableName });
  const builder = await import('electron-builder');
  const signing = platform === 'win32' ? windowsSigning(process.env) : null;
  // 7-Zip picks its ARM64 filter for arm64 executables on its own; the installer's NSIS unpacker
  // (nsis7z) cannot decode it and silently skipped every .exe and .dll (CI run 38007825102: the
  // install left only data files). BCJ is a filter nsis7z reads.
  if (platform === 'win32' && arch === 'arm64') process.env.ELECTRON_BUILDER_7Z_FILTER = installerFilter(arch);
  const outDir = path.join(path.dirname(path.dirname(appDir)), 'artifacts');
  const produced = await builder.build({
    prepackaged: appDir, projectDir: source,
    targets: builder.Platform[spec.builder].createTarget(spec.targets, builder.Arch[arch]),
    config: { ...builderConfig({ platform, version, arch, signing }), directories: { output: outDir } },
  });
  const artifacts = produced.filter((file) => /\.(exe|AppImage|deb)$/.test(file)).map((file) => {
    const name = path.basename(file);
    const target = path.join(args.out, name);
    writeFileSync(target, readFileSync(file));
    return { name, bytes: statSync(target).size, sha256: sha256(target) };
  });
  requireThat(artifacts.length === spec.targets.length, `Expected ${spec.targets.length} artifacts, got ${artifacts.map((a) => a.name).join(', ') || 'none'}.`);
  const receipt = {
    product: 'Fabric Inbox', version, revision, platform, arch, artifacts, hardening,
    serverBundle: state.serverBundle,
    analytics: state.analytics ? 'App Key bundled' : 'none', updates: feed ? feed.feed : 'none (not a release build)',
    // SIGNED here means signing was configured; the release workflow's verify step replaces it with
    // the per-file report (Valid and timestamped) before anything is published.
    ...(platform === 'win32' ? { windows_authenticode: signing ? 'SIGNED (Azure Artifact Signing)' : 'NOT_SIGNED' } : {}),
    builtAt: new Date().toISOString(),
  };
  if (feed) {
    // The feed every released copy of this platform reads at releases/latest/download/ (PL-03).
    const updatable = artifacts.find((a) => (platform === 'win32' ? /-setup\.exe$/ : /\.AppImage$/).test(a.name));
    requireThat(updatable, 'No installer or AppImage to name in the update feed.');
    const repository = String(process.env.GITHUB_REPOSITORY);
    const feedName = path.basename(new URL(feed.feed).pathname);
    writeFileSync(path.join(args.out, feedName), JSON.stringify(feedFor({ repository, version, zipName: updatable.name, sha256: updatable.sha256, size: updatable.bytes,
      notes: `Fabric Inbox ${version}: https://github.com/${repository}/releases/tag/v${version}`, pubDate: new Date().toISOString() }), null, 2) + '\n');
    receipt.update = { file: updatable.name, feed: feedName };
  }
  const base = `Fabric-Inbox-${version}-${platform === 'win32' ? 'win' : 'linux'}-${arch}`;
  // LC-15: release/ keeps this release and the newest other one (receipts stay).
  receipt.prunedFromRelease = pruneReleases(args.out, { current: version });
  writeFileSync(path.join(args.out, `${base}.receipt.json`), JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(path.join(args.out, `${base}.sha256`), artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n');
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

async function build(args) {
  const { platform, arch } = args;
  mkdirSync(args.out, { recursive: true });
  if (args.stage === 'all') {
    const temp = mkdtempSync(path.join(os.tmpdir(), `fabric-${platform}-`));
    try { return await packageApp(args, await assembleApp(args, temp)); }
    finally { rmSync(temp, { recursive: true, force: true }); }
  }
  const dir = stageDir(args.out, platform, arch);
  const stateFile = path.join(dir, 'stage.json');
  if (args.stage === 'app') {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const state = await assembleApp(args, dir);
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    console.log(JSON.stringify({ stage: 'app', appDir: state.appDir, executable: path.join(state.appDir, `${PLATFORMS[platform].executableName}${platform === 'win32' ? '.exe' : ''}`) }));
    return state;
  }
  requireThat(existsSync(stateFile), `No ${path.relative(root, stateFile)}: run --stage app first.`);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  requireThat(state.platform === platform && state.arch === arch, 'The staged app is for another platform or architecture.');
  requireThat(state.revision === run('git', ['rev-parse', 'HEAD']).trim(), 'The staged app was built from another commit.');
  try { return await packageApp(args, state); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build(parsePlatformArgs(process.argv.slice(2))).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}

export { build };
