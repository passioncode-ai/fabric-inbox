import { packager } from '@electron/packager';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenTemplateHook, verifyHardening } from './hardening.mjs';
const require = createRequire(import.meta.url);
const desktop = path.dirname(fileURLToPath(import.meta.url));
const arch = process.argv[2] || process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Choose arm64 or x64 for macOS.');
const apps = await packager({
  dir: desktop, name: 'Fabric Inbox', executableName: 'Fabric Inbox',
  appBundleId: 'ai.passioncode.fabric-inbox', appCategoryType: 'public.app-category.productivity',
  platform: 'darwin', arch, electronVersion: require('electron/package.json').version,
  out: path.join(desktop, '..', 'release'), overwrite: true, asar: true, prune: true,
  icon: path.join(desktop, 'icon.icns'),
  ignore: [/\/(?:mas-package|package|dist-mac|hardening|release-retention)\.mjs$/, /\/entitlements\.mac\.plist$/, /\/icon\.icns$/, /\/dmg-background/],
  extendInfo: { NSHumanReadableCopyright: 'Fabric Inbox', NSRequiresAquaSystemAppearance: false },
  // Hardened like a release (desktop/hardening.mjs); an unsigned Apple-silicon build is re-signed ad hoc to launch.
  afterExtract: hardenTemplateHook({ resetAdHocSignature: true }),
});
for (const output of apps) console.log(output, JSON.stringify(verifyHardening(path.join(output, 'Fabric Inbox.app'))));
console.log('Unsigned local build. Signing and notarization are separate release steps.');
