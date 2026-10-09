// Windows and Linux builds of Fabric Inbox (fabric-workspace knowledge/platforms.md PL-01…PL-08).
//
//   node desktop/dist-platform.mjs --platform win32|linux [--arch x64|arm64] [--out release]
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
// state; SHA256SUMS lines are written beside it.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenTemplateHook, verifyHardening } from './hardening.mjs';
import { analyticsBundle, BUNDLE_ID, SERVER_SOURCES } from './dist-mac.mjs';

const require = createRequire(import.meta.url);
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
  const out = { platform: '', arch: process.arch, out: path.join(root, 'release') };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--platform') out.platform = value();
    else if (flag === '--arch') out.arch = value();
    else if (flag === '--out') out.out = path.resolve(value());
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  requireThat(Object.hasOwn(PLATFORMS, out.platform), `--platform must be ${Object.keys(PLATFORMS).join(' or ')}`);
  requireThat(ARCHES.includes(out.arch), `--arch must be ${ARCHES.join(' or ')}`);
  return out;
}

/** The update feed a release build checks, per platform and architecture (PL-03); null outside the release workflow. */
export function platformFeed(env, platform, arch) {
  if (env.GITHUB_ACTIONS !== 'true' || !env.FABRIC_INBOX_RELEASE_BUILD) return null;
  const repository = String(env.GITHUB_REPOSITORY || '');
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'GITHUB_REPOSITORY must name owner/repository for the update feed.');
  return { feed: `https://github.com/${repository}/releases/latest/download/update-${platform}-${arch}.json` };
}

/** electron-builder's configuration for the prepackaged app. */
export function builderConfig({ platform, version, signing }) {
  const common = {
    appId: BUNDLE_ID, productName: 'Fabric Inbox', copyright: 'PassionCode.ai',
    directories: { output: '.' }, electronVersion: require('electron/package.json').version,
    protocols: [{ name: 'Fabric Inbox connect link', schemes: ['fabric-inbox'] }],
    publish: null, npmRebuild: false, buildDependenciesFromSource: false,
  };
  if (platform === 'win32') return {
    ...common,
    artifactName: `Fabric-Inbox-${version}-win-\${arch}-setup.\${ext}`,
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
    artifactName: `Fabric-Inbox-${version}-linux-\${arch}.\${ext}`,
    linux: {
      icon: path.join(desktop, 'icon.png'), executableName: 'fabric-inbox', category: 'Network;Email;Office',
      synopsis: 'Mail client with cloud automation', description: 'Fabric Inbox: one triaged list across Gmail and Cloudflare mailboxes, answered by versioned agents.',
      mimeTypes: ['x-scheme-handler/fabric-inbox'],
      desktop: { entry: { StartupWMClass: 'Fabric Inbox', MimeType: 'x-scheme-handler/fabric-inbox;' } },
    },
    // PL-05: the sign-in is kept in the Secret Service; libsecret reaches it, a keyring provides it.
    deb: { depends: ['libsecret-1-0', 'libgtk-3-0', 'libnss3', 'libxss1', 'libasound2 | libasound2t64', 'xdg-utils'], recommends: ['gnome-keyring | kwalletmanager'],
      afterInstall: path.join(desktop, 'linux', 'after-install.sh'), afterRemove: path.join(desktop, 'linux', 'after-remove.sh') },
    appImage: { artifactName: `Fabric-Inbox-${version}-linux-\${arch}.AppImage` },
  };
}

/** Azure Artifact Signing from the release environment (PL-02), or null: then NOT_SIGNED. */
export function windowsSigning(env) {
  const endpoint = String(env.AZURE_SIGNING_ENDPOINT || '').trim();
  const account = String(env.AZURE_SIGNING_ACCOUNT || '').trim();
  const profile = String(env.AZURE_SIGNING_PROFILE || '').trim();
  if (!endpoint || !account || !profile) return null;
  return { endpoint, codeSigningAccountName: account, certificateProfileName: profile, publisherName: 'PassionCode' };
}

async function build(args) {
  const { platform, arch } = args;
  const spec = PLATFORMS[platform];
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const revision = run('git', ['rev-parse', 'HEAD']).trim();
  mkdirSync(args.out, { recursive: true });
  const temp = mkdtempSync(path.join(os.tmpdir(), `fabric-${platform}-`));
  try {
    // Only committed files ship (as on macOS): the desktop folder of HEAD.
    execFileSync('tar', ['-xf', '-', '-C', temp], { input: run('git', ['archive', revision, 'desktop'], { encoding: 'buffer' }) });
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
    const hardening = verifyHardening(appDir, { platform, executableName: spec.executableName });

    const builder = await import('electron-builder');
    const signing = platform === 'win32' ? windowsSigning(process.env) : null;
    const outDir = path.join(temp, 'artifacts');
    const produced = await builder.build({
      prepackaged: appDir, projectDir: source,
      targets: builder.Platform[spec.builder].createTarget(spec.targets, builder.Arch[arch]),
      config: { ...builderConfig({ platform, version, signing }), directories: { output: outDir } },
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
      serverBundle: { version: serverManifest.version, revision: serverManifest.revision, modules: serverManifest.modules.length },
      analytics: analytics ? 'App Key bundled' : 'none', updates: feed ? feed.feed : 'none (not a release build)',
      ...(platform === 'win32' ? { windows_authenticode: signing ? 'SIGNED (Azure Artifact Signing)' : 'NOT_SIGNED' } : {}),
      builtAt: new Date().toISOString(),
    };
    const base = `Fabric-Inbox-${version}-${platform === 'win32' ? 'win' : 'linux'}-${arch}`;
    writeFileSync(path.join(args.out, `${base}.receipt.json`), JSON.stringify(receipt, null, 2) + '\n');
    writeFileSync(path.join(args.out, `${base}.sha256`), artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n');
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build(parsePlatformArgs(process.argv.slice(2))).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}

export { build };
