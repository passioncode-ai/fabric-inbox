// Hardening every build of Fabric Inbox — macOS, Windows and Linux (knowledge/lifecycle.md LC-13 and
// LC-07; knowledge/platforms.md). Fuses are flipped on every platform; purpose strings are macOS only.
//
// Fuses (LC-13). Electron ships with fuses that let any process on the Mac turn the app into a
// Node interpreter (RunAsNode, NODE_OPTIONS, --inspect), load code from outside its signed asar,
// and keep cookies in plaintext SQLite. The audit read the 0.8.2 wire as Electron's stock
// `101100011` and found the Cloudflare Access session cookie in the plaintext `value` column
// (raw/fabric-inbox.md §5, F1). The builders flip the six fuses below on the extracted Electron
// template, before the app is assembled and signed, then read the wire of the binary they built and
// fail unless every slice carries it.
//
// Cookie encryption creates one Keychain item, "Fabric Inbox Safe Storage", on the first launch of a
// build that has it. Under the stable Developer ID it is created silently and its access list (the
// designated requirement: team + bundle id) still matches after an update, so it does not prompt
// again. A signed build is the only proof; docs/release.md carries that upgrade check.
//
// Purpose strings (LC-07). Electron's template Info.plist declares camera, microphone, Bluetooth and
// audio-capture purposes. Fabric Inbox denies every web permission (desktop/main.cjs
// rejectPermissions) and uses none of them, so they are stripped from the template and the built
// Info.plist is checked against the declared set, which is empty.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import plist from 'plist';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';

/** Electron's fuse sentinel; the wire follows it as <version byte><length byte><one byte per fuse>. */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
/** Fuses this product sets, by @electron/fuses name. Others keep Electron's default. */
export const REQUIRED_FUSES = Object.freeze({
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  EnableCookieEncryption: true,
});
/** NS*UsageDescription keys the app may declare. It requests no camera, microphone, Bluetooth or audio capture. */
export const DECLARED_USAGE_DESCRIPTIONS = Object.freeze([]);
const USAGE_KEY = /^NS[A-Za-z]+UsageDescription$/;
const STATE = { 0x30: 'off', 0x31: 'on', 0x72: 'removed' };

function requireThat(condition, message) { if (!condition) throw new Error(message); }

/**
 * The binary that holds the fuse wire of a built app: the framework inside the .app bundle on macOS,
 * the executable itself on Windows and Linux (`appPath` is then the packaged folder).
 */
export function fuseFile(appPath, platform = 'darwin', executableName = 'Fabric Inbox') {
  if (platform === 'win32') return path.join(appPath, `${executableName}.exe`);
  if (platform === 'linux') return path.join(appPath, executableName);
  return path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
}

/** Every fuse wire in a binary, in file order: one per Mach-O slice. */
export function readFuseWires(buffer) {
  const sentinel = Buffer.from(FUSE_SENTINEL);
  const wires = [];
  for (let at = buffer.indexOf(sentinel); at !== -1; at = buffer.indexOf(sentinel, at + 1)) {
    const header = at + sentinel.length;
    if (header + 2 > buffer.length) { wires.push({ version: buffer[header] ?? -1, wire: '' }); continue; }
    const version = buffer[header];
    const length = buffer[header + 1];
    wires.push({ version, wire: buffer.subarray(header + 2, Math.min(header + 2 + length, buffer.length)).toString('latin1') });
  }
  return wires;
}

/**
 * The release gate: every slice has the V1 wire with each required fuse in its required state.
 * Returns a one-line summary for the build receipt; throws with every deviation otherwise.
 */
export function checkFuses(wires) {
  requireThat(wires.length > 0, 'The built binary has no fuse wire; it is not an Electron 12+ framework.');
  requireThat(wires.length <= 2, `The built binary has ${wires.length} fuse wires; at most one per slice of a universal app (2) is expected.`);
  const problems = [];
  wires.forEach(({ version, wire }, i) => {
    const where = wires.length > 1 ? `slice ${i + 1}: ` : '';
    if (version !== Number(FuseVersion.V1)) { problems.push(`${where}fuse wire version ${version}, expected ${FuseVersion.V1}`); return; }
    for (const [name, wanted] of Object.entries(REQUIRED_FUSES)) {
      const index = FuseV1Options[name];
      const byte = wire.charCodeAt(index);
      const state = index < wire.length ? STATE[byte] ?? `unknown (0x${byte.toString(16)})` : 'missing';
      if (state !== (wanted ? 'on' : 'off')) problems.push(`${where}${name} is ${state}`);
    }
  });
  requireThat(problems.length === 0, `Electron fuses are not hardened: ${problems.join('; ')}.`);
  const states = Object.entries(REQUIRED_FUSES).map(([name, on]) => `${name}=${on ? 'on' : 'off'}`).join(', ');
  return `${wires.length} ${wires.length === 1 ? 'slice' : 'slices'}: ${states}`;
}

/** The NS*UsageDescription keys an Info.plist object declares. */
export function usageDescriptionKeys(info) {
  return Object.keys(info).filter((key) => USAGE_KEY.test(key));
}
/** A copy of an Info.plist object without purpose strings outside `declared`. */
export function stripUsageDescriptions(info, declared = DECLARED_USAGE_DESCRIPTIONS) {
  return Object.fromEntries(Object.entries(info).filter(([key]) => !USAGE_KEY.test(key) || declared.includes(key)));
}
/** The release gate for purpose strings: only declared ones; returns a summary for the receipt. */
export function checkUsageDescriptions(info, declared = DECLARED_USAGE_DESCRIPTIONS) {
  const extra = usageDescriptionKeys(info).filter((key) => !declared.includes(key)).sort();
  requireThat(extra.length === 0, `Info.plist carries undeclared purpose strings: ${extra.join(', ')}.`);
  const present = usageDescriptionKeys(info).sort();
  return `${present.length ? present.join(', ') : 'none'} (declared: ${declared.length ? declared.join(', ') : 'none'})`;
}

function fuseConfig() {
  const config = { version: FuseVersion.V1, strictlyRequireAllFuses: false };
  for (const [name, on] of Object.entries(REQUIRED_FUSES)) config[FuseV1Options[name]] = on;
  return config;
}

/**
 * Hardens the Electron template the packager extracted into `buildPath`, before it becomes the app:
 * flips the fuses in every slice and strips undeclared purpose strings from its Info.plist. The
 * packager reads that Info.plist as the base of the app's own and signs afterwards, so the
 * signature covers the hardened bytes. `resetAdHocSignature` re-signs the template ad hoc, which an
 * unsigned Apple-silicon build needs to launch; signed and universal builds are re-signed later by
 * the packager (a re-signed slice would differ from its sibling and fail the universal merge).
 */
export async function hardenElectronTemplate({ buildPath, platform, arch }, { resetAdHocSignature = false } = {}) {
  if (platform === 'win32' || platform === 'linux') {
    // The extracted template is Electron's own executable, renamed later by the packager.
    const binary = path.join(buildPath, platform === 'win32' ? 'electron.exe' : 'electron');
    requireThat(existsSync(binary), `The extracted template at ${buildPath} has no ${path.basename(binary)} to harden.`);
    await flipFuses(binary, fuseConfig());
    checkFuses(readFuseWires(readFileSync(binary)));
    return { slices: 1 };
  }
  requireThat(platform === 'darwin' || platform === 'mas', `Unknown platform to harden: ${platform}.`);
  const appPath = path.join(buildPath, 'Electron.app');
  requireThat(existsSync(fuseFile(appPath)), `The extracted template at ${buildPath} has no Electron.app to harden.`);
  const slices = await flipFuses(appPath, { ...fuseConfig(), resetAdHocDarwinSignature: resetAdHocSignature && arch === 'arm64' && process.platform === 'darwin' });
  checkFuses(readFuseWires(readFileSync(fuseFile(appPath))));
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  const info = plist.parse(readFileSync(infoPath, 'utf8'));
  writeFileSync(infoPath, plist.build(stripUsageDescriptions(info)));
  return { slices };
}

/** The packager's `afterExtract` option: one hook that hardens every extracted template. */
export function hardenTemplateHook(options = {}) {
  return [(args) => hardenElectronTemplate(args, options)];
}

/**
 * The gate run on a built app: its fuse wire, and on macOS its Info.plist. Returns receipt lines.
 * On Windows and Linux `appPath` is the packaged folder and `executableName` its executable.
 */
export function verifyHardening(appPath, { platform = 'darwin', executableName = 'Fabric Inbox' } = {}) {
  const fuses = checkFuses(readFuseWires(readFileSync(fuseFile(appPath, platform, executableName))));
  if (platform === 'win32' || platform === 'linux') return { fuses, usageDescriptions: 'not applicable (no Info.plist)' };
  const usageDescriptions = checkUsageDescriptions(plist.parse(readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8')));
  return { fuses, usageDescriptions };
}
