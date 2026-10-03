import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { BUNDLE_ID, MIN_FREE_BYTES, checkCapacity, childEntitlements, expectedEntitlementsFor, mainEntitlements, validateEntitlements, validateSource, parseArgs, parseIdentities, selectIdentity, validateConfig, validateProfile } from '../desktop/mas-package.mjs';

const hash = 'A'.repeat(40);
const team = 'ABC123DEF4';
const configuration = () => ({ mode: 'distribution', arch: 'arm64', team, identity: `Apple Distribution: Example (${team})`, 'installer-identity': `3rd Party Mac Developer Installer: Example (${team})`, profile: '/private/tmp/example.provisionprofile', 'build-number': '1.2.3', revision: 'a'.repeat(40), build: false });
const profile = () => ({ Platform: ['OSX'], TeamIdentifier: [team], ApplicationIdentifierPrefix: [team], ExpirationDate: '2030-01-01T00:00:00Z', CertificateHashes: [hash], Entitlements: { 'com.apple.application-identifier': `${team}.${BUNDLE_ID}`, 'com.apple.developer.team-identifier': team, 'com.apple.security.application-groups': [`${team}.${BUNDLE_ID}`] } });
const now = Date.parse('2026-01-01T00:00:00Z');

test('distribution configuration requires explicit MAS identity, team, installer, version and exact revision', () => {
  assert.doesNotThrow(() => validateConfig(configuration()));
  for (const patch of [
    { team: '' }, { identity: `Developer ID Application: Example (${team})` },
    { identity: `Apple Development: Example (${team})` }, { 'installer-identity': '' },
    { 'installer-identity': `Developer ID Installer: Example (${team})` },
    { identity: 'Apple Distribution: Example (ZZZ123DEF4)' }, { mode: 'darwin' }, { arch: 'universal' },
    { revision: 'HEAD' }, { revision: 'abcd123' }, { profile: './example.provisionprofile' },
    ...['', '0', '1.0.0-beta', '01', '1.100', '1.2.3.4'].map((value) => ({ 'build-number': value })),
  ]) assert.throws(() => validateConfig({ ...configuration(), ...patch }), JSON.stringify(patch));
});

test('development is separate from distribution and never requires an installer', () => {
  const config = { ...configuration(), mode: 'development', identity: `Apple Development: Example (${team})`, 'installer-identity': undefined };
  assert.doesNotThrow(() => validateConfig(config));
  const p = { ...profile(), ProvisionedDevices: ['fake-device'], Entitlements: { ...profile().Entitlements, 'com.apple.security.get-task-allow': true } };
  assert.doesNotThrow(() => validateProfile(config, p, hash, now));
  assert.throws(() => validateProfile(config, profile(), hash, now), /Development/);
  assert.throws(() => validateProfile(configuration(), p, hash, now), /Distribution/);
});

test('profile validates actual entitlement, expiry, platform and authorized certificate facts', () => {
  assert.doesNotThrow(() => validateProfile(configuration(), profile(), hash, now));
  const unrestricted = profile();
  delete unrestricted.Entitlements['com.apple.security.application-groups'];
  assert.doesNotThrow(() => validateProfile(configuration(), unrestricted, hash, now));
  for (const patch of [
    { Platform: ['iOS'] }, { Platform: undefined }, { TeamIdentifier: ['WRONG12345'] },
    { ExpirationDate: '2025-01-01' }, { ExpirationDate: 'not-a-date' }, { CertificateHashes: ['B'.repeat(40)] },
    { ApplicationIdentifierPrefix: ['LEGACY1234'] }, { ProvisionsAllDevices: true }, { ProvisionedDevices: [] },
  ]) assert.throws(() => validateProfile(configuration(), { ...profile(), ...patch }, hash, now), JSON.stringify(patch));
  for (const patch of [
    { 'com.apple.application-identifier': `${team}.*` }, { 'com.apple.application-identifier': `${team}.wrong.app` },
    { 'com.apple.developer.team-identifier': 'WRONG12345' }, { 'com.apple.security.application-groups': [] },
    { 'com.apple.security.application-groups': ['*'] }, { 'com.apple.security.get-task-allow': true }, { 'get-task-allow': true },
  ]) assert.throws(() => validateProfile(configuration(), { ...profile(), Entitlements: { ...profile().Entitlements, ...patch } }, hash, now), JSON.stringify(patch));
});

test('identity parsing excludes invalid/expired entries and rejects missing or ambiguous matches', () => {
  const name = configuration().identity;
  const identities = parseIdentities(`  1) ${hash} "${name}"\n  2) ${'B'.repeat(40)} "${name}" (CSSMERR_TP_CERT_EXPIRED)\n  1 valid identities found\n`);
  assert.deepEqual(selectIdentity(identities, name), { hash, name });
  assert.throws(() => selectIdentity([], name));
  assert.throws(() => selectIdentity([...identities, ...identities], name));
  assert.throws(() => selectIdentity(identities, 'Apple Distribution'));
});

test('default action is read-only; unknown/missing/duplicate switches fail closed', () => {
  const args = Object.entries(configuration()).filter(([key]) => key !== 'build').flatMap(([key, value]) => [`--${key}`, String(value)]);
  assert.equal(parseArgs(args).build, false);
  assert.equal(parseArgs([...args, '--build']).build, true);
  for (const suffix of [['--upload'], ['--mode'], ['--mode', 'development'], ['--build', '--build']]) assert.throws(() => parseArgs([...args, ...suffix]));
});

test('insufficient disk rejects the build rather than downloading a runtime', () => {
  assert.throws(() => checkCapacity(1.3 * 1024 ** 3), /6 GiB/);
  assert.throws(() => checkCapacity(Number.NaN));
  assert.doesNotThrow(() => checkCapacity(MIN_FREE_BYTES));
});

test('main entitlements grant only sandbox, outgoing network, selected file access and identifiers', () => {
  assert.deepEqual(mainEntitlements(configuration()), {
    'com.apple.security.app-sandbox': true,
    'com.apple.security.network.client': true,
    'com.apple.security.files.user-selected.read-write': true,
    'com.apple.application-identifier': `${team}.${BUNDLE_ID}`,
    'com.apple.developer.team-identifier': team,
    'com.apple.security.application-groups': [`${team}.${BUNDLE_ID}`],
  });
  assert.equal(mainEntitlements({ ...configuration(), mode: 'development' })['com.apple.security.get-task-allow'], true);
});

test('real CLI refuses missing config before imports, downloads or output creation', () => {
  const hadOutput = existsSync(new URL('../release', import.meta.url));
  const result = spawnSync(process.execPath, ['desktop/mas-package.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MAS blocked: Choose --mode/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(new URL('../release', import.meta.url)), hadOutput);
});


test('dirty, staged, untracked and wrong-revision sources cannot become attributed builds', () => {
  const c = configuration();
  assert.doesNotThrow(() => validateSource(c, c.revision + '\n', ''));
  assert.throws(() => validateSource(c, 'b'.repeat(40), ''), /HEAD/);
  for (const status of [' M desktop/main.cjs', 'M  desktop/main.cjs', '?? desktop/secret.txt']) {
    assert.throws(() => validateSource(c, c.revision, status), /source changes/);
  }
});

test('signed child entitlement drift and extra privileges are rejected', () => {
  const expected = childEntitlements();
  assert.deepEqual(expected, { 'com.apple.security.app-sandbox': true, 'com.apple.security.inherit': true });
  assert.doesNotThrow(() => validateEntitlements(expected, expected));
  assert.throws(() => validateEntitlements({ ...expected, 'com.apple.security.network.server': true }, expected));
  assert.throws(() => validateEntitlements({ 'com.apple.security.app-sandbox': true }, expected));
  assert.throws(() => validateEntitlements({ ...expected, 'com.apple.security.inherit': false }, expected));
});


test('installed signing and packaging exports match the build API without invoking them', async () => {
  const signer = await import('@electron/osx-sign');
  const packager = await import('@electron/packager');
  assert.equal(typeof signer.sign, 'function');
  assert.equal(typeof signer.flat, 'function');
  assert.equal(typeof packager.packager, 'function');
});

test('signed code without entitlements: a library is skipped, a bundle is refused by name', () => {
  const c = configuration();
  const app = '/build/Fabric Inbox.app';
  const lib = `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`;
  const helper = `${app}/Contents/Frameworks/Fabric Inbox Helper (GPU).app`;
  assert.equal(expectedEntitlementsFor(lib, app, c, ''), null);
  assert.equal(expectedEntitlementsFor(lib, app, c, '  \n'), null);
  assert.throws(() => expectedEntitlementsFor(app, app, c, ''), /Fabric Inbox\.app; an application bundle must carry them/);
  assert.throws(() => expectedEntitlementsFor(helper, app, c, ''), /Helper \(GPU\)\.app/);
  const xml = '<?xml version="1.0"?><plist version="1.0"><dict/></plist>';
  assert.deepEqual(expectedEntitlementsFor(app, app, c, xml), mainEntitlements(c));
  assert.deepEqual(expectedEntitlementsFor(helper, app, c, xml), childEntitlements());
  assert.deepEqual(expectedEntitlementsFor(lib, app, c, xml), childEntitlements());
});
