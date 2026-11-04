import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenTemplateHook, verifyHardening } from './hardening.mjs';
import { CONSOLE_ASAR, stageConsolePty, stageConsoleView, verifyConsoleUnpacked } from './console-assets.mjs';
const require = createRequire(import.meta.url);
const desktop = path.dirname(fileURLToPath(import.meta.url));
const arch = process.argv[2] || process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Choose arm64 or x64 for macOS.');
const out = path.join(desktop, '..', 'release');
mkdirSync(out, { recursive: true });
// Assembled from a copy with the agent console staged in it, as the release builds it (desktop/dist-mac.mjs):
// a build without node-pty opens a console that cannot start (B-202, found by the first macOS smoke).
const temp = mkdtempSync(path.join(out, '.package-'));
try {
  const source = path.join(temp, 'desktop');
  cpSync(desktop, source, { recursive: true, filter: (f) => !/^(?:node_modules|console-vendor|setups)(?:[/\\]|$)/.test(path.relative(desktop, f)) });
  stageConsoleView(source); stageConsolePty(source, { platform: 'darwin' });
  const apps = await packager({
    dir: source, name: 'Fabric Inbox', executableName: 'Fabric Inbox',
    protocols: [{ name: 'Fabric Inbox connect link', schemes: ['fabric-inbox'] }], appBundleId: 'ai.passioncode.fabric-inbox', appCategoryType: 'public.app-category.productivity',
    platform: 'darwin', arch, electronVersion: require('electron/package.json').version,
    out, overwrite: true, asar: CONSOLE_ASAR, prune: false,
    icon: path.join(source, 'icon.icns'),
    ignore: [/\/(?:mas-package|package|dist-mac|dist-platform|hardening|release-retention|console-assets)\.mjs$/, /\/entitlements\.mac\.plist$/, /\/icon\.(?:icns|ico|png)$/, /\/dmg-background/, /^\/(?:linux|windows)\//],
    extendInfo: { NSHumanReadableCopyright: 'Fabric Inbox', NSRequiresAquaSystemAppearance: false },
    // Hardened like a release (desktop/hardening.mjs); an unsigned Apple-silicon build is re-signed ad hoc to launch.
    afterExtract: hardenTemplateHook({ resetAdHocSignature: true }),
  });
  for (const output of apps) {
    const app = path.join(output, 'Fabric Inbox.app');
    verifyConsoleUnpacked(path.join(app, 'Contents', 'Resources'), { platform: 'darwin', arch }, { throwOnMissing: true });
    // Apple silicon runs signed code only: the staged node-pty and the assembled bundle are signed ad hoc together.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    console.log(output, JSON.stringify(verifyHardening(app)));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('Unsigned local build. Signing and notarization are separate release steps.');
