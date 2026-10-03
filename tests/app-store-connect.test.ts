// The Mac App Store leg of the CI release (docs/release.md → "Mac App Store"): the build number a
// tag gets, the App Store Connect token, the app-record check that stops an upload Apple would
// refuse, and the altool upload with its key file placed for the call and removed after it.
// No test reaches Apple: the network is a stand-in and the key is generated here, in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLE_ID, altoolUploadArgs, ascToken, buildNumberForTag, findAppRecord, keyFilePath,
  lookupAppRecord, readCredentials, uploadPackage,
} from "../scripts/app-store-connect.mjs";
import { validateConfig } from "../desktop/mas-package.mjs";

const KEY_ID = "ABCDE12345";
const ISSUER = "00000000-0000-4000-8000-000000000000";
function fakeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const p8 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
  return { p8, publicKey };
}
const env = (p8: string) => ({ ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_API_KEY_P8_B64: p8 });

test("a release tag gets a build number that only grows: rc builds below their release, releases below the next", () => {
  assert.equal(buildNumberForTag("v0.8.2", "0.8.2"), "8.2.99");
  assert.equal(buildNumberForTag("v0.8.2-rc.1", "0.8.2"), "8.2.1");
  assert.equal(buildNumberForTag("v0.8.2-rc.98", "0.8.2"), "8.2.98");
  assert.equal(buildNumberForTag("v1.0.0", "1.0.0"), "100.0.99");
  assert.equal(buildNumberForTag("refs/tags/v0.9.0", "0.9.0"), "9.0.99");
  const order = ["v0.8.2-rc.1", "v0.8.2-rc.2", "v0.8.2", "v0.8.3-rc.1", "v0.8.3", "v0.9.0", "v0.10.0", "v1.0.0-rc.1", "v1.0.0", "v1.2.10"]
    .map((tag) => buildNumberForTag(tag, tag.replace(/^v/, "").replace(/-rc\.\d+$/, "")).split(".").map(Number));
  for (let i = 1; i < order.length; i++) {
    const [a, b] = [order[i - 1]!, order[i]!];
    const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    assert.ok(cmp < 0, `${a.join(".")} < ${b.join(".")}`);
  }
  // Every number it gives is one the MAS packager accepts.
  const config = { mode: "distribution", arch: "arm64", team: "ABCDE12345", identity: "3rd Party Mac Developer Application: Example (ABCDE12345)",
    "installer-identity": "3rd Party Mac Developer Installer: Example (ABCDE12345)", profile: "/private/tmp/x.provisionprofile", revision: "a".repeat(40) };
  for (const tag of ["v0.8.2", "v0.8.2-rc.1", "v99.99.99", "v0.1.0-rc.98"]) {
    const version = tag.slice(1).replace(/-rc\.\d+$/, "");
    assert.doesNotThrow(() => validateConfig({ ...config, "build-number": buildNumberForTag(tag, version) }), tag);
  }
});

test("a tag that does not name the version the app carries, or cannot be numbered, is refused", () => {
  assert.throws(() => buildNumberForTag("v0.8.3", "0.8.2"), /tag v0\.8\.3 does not match the version 0\.8\.2/);
  assert.throws(() => buildNumberForTag("main", "0.8.2"), /not a release tag/);
  assert.throws(() => buildNumberForTag("v0.8.2-beta.1", "0.8.2"), /not a release tag/);
  assert.throws(() => buildNumberForTag("v0.8.2-rc.0", "0.8.2"), /rc number from 1 to 98/);
  assert.throws(() => buildNumberForTag("v0.8.2-rc.99", "0.8.2"), /rc number from 1 to 98/);
  assert.throws(() => buildNumberForTag("v0.100.0", "0.100.0"), /minor and patch up to 99/);
  assert.throws(() => buildNumberForTag("v0.0.1", "0.0.1"), /0\.0\.x has no store build number/);
  assert.throws(() => buildNumberForTag("v100.0.0", "100.0.0"), /major up to 99/);
});

test("credentials come from the environment, are checked by shape, and no value is echoed back", () => {
  const { p8 } = fakeKey();
  assert.deepEqual(readCredentials(env(p8)), { keyId: KEY_ID, issuer: ISSUER, p8 });
  assert.throws(() => readCredentials({ ...env(p8), ASC_KEY_ID: "" }), /ASC_KEY_ID is empty/);
  assert.throws(() => readCredentials({ ...env(p8), ASC_ISSUER_ID: undefined }), /ASC_ISSUER_ID is empty/);
  assert.throws(() => readCredentials({ ...env(p8), ASC_API_KEY_P8_B64: "" }), /ASC_API_KEY_P8_B64 is empty/);
  for (const bad of ["../../x", "abcde12345", "ABCDE1234"]) {
    assert.throws(() => readCredentials({ ...env(p8), ASC_KEY_ID: bad }), (error: Error) => /ASC_KEY_ID is not a key id/.test(error.message) && !error.message.includes(bad));
  }
  assert.throws(() => readCredentials({ ...env(p8), ASC_ISSUER_ID: "issuer" }), (error: Error) => /ASC_ISSUER_ID is not an issuer id/.test(error.message) && !error.message.includes("issuer\""));
});

test("the App Store Connect token is an ES256 JWT for that key, valid for minutes, not hours", () => {
  const { p8, publicKey } = fakeKey();
  const now = 1_790_000_000;
  const token = ascToken(readCredentials(env(p8)), now);
  const [head, body, signature] = token.split(".");
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  assert.deepEqual(decode(head!), { alg: "ES256", kid: KEY_ID, typ: "JWT" });
  assert.deepEqual(decode(body!), { iss: ISSUER, iat: now, exp: now + 600, aud: "appstoreconnect-v1" });
  assert.equal(Buffer.from(signature!, "base64url").length, 64, "raw r||s, as JWS requires, not DER");
  assert.ok(verify("sha256", Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url")));
  assert.throws(() => ascToken({ keyId: KEY_ID, issuer: ISSUER, p8: Buffer.from("not a key").toString("base64") }, now), /ASC_API_KEY_P8_B64 is not a .p8 private key/);
});

const record = (bundleId: string, id = "6700000000") => ({ type: "apps", id, attributes: { bundleId, name: "Fabric Inbox", sku: "fabric-inbox" } });

test("the app record is the one whose bundle id is exactly ours", () => {
  assert.deepEqual(findAppRecord({ data: [record(BUNDLE_ID)] }, BUNDLE_ID), { id: "6700000000", name: "Fabric Inbox", bundleId: BUNDLE_ID });
  assert.equal(findAppRecord({ data: [] }, BUNDLE_ID), null);
  assert.equal(findAppRecord({ data: [record(`${BUNDLE_ID}.helper`)] }, BUNDLE_ID), null, "a filter that matches more is not our record");
  assert.throws(() => findAppRecord({ errors: [] }, BUNDLE_ID), /no data/);
});

function fakeFetch(answers: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; authorization: string }> = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, authorization: init.headers.Authorization! });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  return { calls, fetchImpl };
}
const noSleep = async () => {};

test("the app-record lookup asks App Store Connect for our bundle id with the key's token", async () => {
  const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { data: [record(BUNDLE_ID)] } }]);
  const found = await lookupAppRecord({ token: "header.body.sig", bundleId: BUNDLE_ID, fetchImpl, sleep: noSleep });
  assert.deepEqual(found, { id: "6700000000", name: "Fabric Inbox", bundleId: BUNDLE_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.appstoreconnect.apple.com/v1/apps?filter%5BbundleId%5D=ai.passioncode.fabric-inbox&fields%5Bapps%5D=bundleId%2Cname");
  assert.equal(calls[0]!.authorization, "Bearer header.body.sig");
  const none = fakeFetch([{ status: 200, body: { data: [] } }]);
  assert.equal(await lookupAppRecord({ token: "t", bundleId: BUNDLE_ID, fetchImpl: none.fetchImpl, sleep: noSleep }), null);
});

test("a refused key fails at once; a network or server failure is retried, then reported", async () => {
  const refused = fakeFetch([{ status: 401, body: { errors: [{ title: "Authentication credentials are missing or invalid." }] } }]);
  await assert.rejects(lookupAppRecord({ token: "t", bundleId: BUNDLE_ID, fetchImpl: refused.fetchImpl, sleep: noSleep }),
    /refused the API key \(401: Authentication credentials are missing or invalid\.\)/);
  assert.equal(refused.calls.length, 1, "a 401 is not retried");
  const flaky = fakeFetch([new Error("ECONNRESET"), { status: 503 }, { status: 200, body: { data: [record(BUNDLE_ID)] } }]);
  assert.equal((await lookupAppRecord({ token: "t", bundleId: BUNDLE_ID, fetchImpl: flaky.fetchImpl, sleep: noSleep }))?.id, "6700000000");
  assert.equal(flaky.calls.length, 3);
  const down = fakeFetch([{ status: 500 }, { status: 502 }, { status: 503 }]);
  await assert.rejects(lookupAppRecord({ token: "t", bundleId: BUNDLE_ID, fetchImpl: down.fetchImpl, sleep: noSleep }), /after 3 attempts.*503/);
});

test("altool uploads the package for macOS with the API key; the key itself is a file, never an argument", () => {
  assert.deepEqual(altoolUploadArgs("/w/Fabric Inbox.pkg", KEY_ID, ISSUER),
    ["altool", "--upload-app", "-f", "/w/Fabric Inbox.pkg", "-t", "macos", "--apiKey", KEY_ID, "--apiIssuer", ISSUER, "--output-format", "json"]);
  assert.equal(keyFilePath("/Users/runner", KEY_ID), "/Users/runner/.appstoreconnect/private_keys/AuthKey_ABCDE12345.p8");
  assert.throws(() => altoolUploadArgs("/w/Fabric Inbox.dmg", KEY_ID, ISSUER), /\.pkg/);
});

function workspace() {
  const home = mkdtempSync(path.join(os.tmpdir(), "fi-asc-home-"));
  const pkg = path.join(mkdtempSync(path.join(os.tmpdir(), "fi-asc-pkg-")), "Fabric Inbox.pkg");
  writeFileSync(pkg, "package bytes");
  return { home, pkg };
}
const found = async () => ({ id: "6700000000", name: "Fabric Inbox", bundleId: BUNDLE_ID });

test("the upload places the key where altool looks, only for the call, and removes it after success or failure", async () => {
  const { p8 } = fakeKey();
  const { home, pkg } = workspace();
  const keyFile = keyFilePath(home, KEY_ID);
  let seen: { args: string[]; mode: number } | null = null;
  const result = await uploadPackage({ pkg, credentials: readCredentials(env(p8)), home, findRecord: found,
    runAltool: (args: string[]) => { seen = { args, mode: statSync(keyFile).mode & 0o777 }; return { status: 0, output: '{"success-message":"No errors uploading"}' }; } });
  assert.equal(seen!.mode, 0o600);
  assert.deepEqual(seen!.args, altoolUploadArgs(pkg, KEY_ID, ISSUER));
  assert.equal(existsSync(keyFile), false, "removed after the upload");
  assert.deepEqual(readdirSync(home), [], "the directories it made are gone too");
  assert.equal(result.app.id, "6700000000");

  await assert.rejects(uploadPackage({ pkg, credentials: readCredentials(env(p8)), home, findRecord: found,
    runAltool: () => ({ status: 1, output: '{"product-errors":[{"message":"Redundant Binary Upload"}]}' }) }), /altool exited 1.*Redundant Binary Upload/s);
  assert.equal(existsSync(keyFile), false, "removed after a failed upload");
  await assert.rejects(uploadPackage({ pkg, credentials: readCredentials(env(p8)), home, findRecord: found,
    runAltool: () => { throw new Error("spawn xcrun ENOENT"); } }), /ENOENT/);
  assert.equal(existsSync(keyFile), false, "removed when altool could not start");
});

test("no upload without the app record: a clear refusal that names the human step, and no key written", async () => {
  const { p8 } = fakeKey();
  const { home, pkg } = workspace();
  let ran = false;
  await assert.rejects(uploadPackage({ pkg, credentials: readCredentials(env(p8)), home, findRecord: async () => null,
    runAltool: () => { ran = true; return { status: 0, output: "" }; } }),
  /No App Store Connect app record for ai\.passioncode\.fabric-inbox.*the API cannot create one.*docs\/release\.md/s);
  assert.equal(ran, false);
  assert.deepEqual(readdirSync(home), []);
});

test("an existing key file is never overwritten or deleted, and a missing package stops before anything", async () => {
  const { p8 } = fakeKey();
  const { home, pkg } = workspace();
  const keyFile = keyFilePath(home, KEY_ID);
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, "someone else's key file");
  await assert.rejects(uploadPackage({ pkg, credentials: readCredentials(env(p8)), home, findRecord: found, runAltool: () => ({ status: 0, output: "" }) }),
    /already holds AuthKey_ABCDE12345\.p8/);
  assert.equal(existsSync(keyFile), true, "left as it was");
  await assert.rejects(uploadPackage({ pkg: pkg + ".missing", credentials: readCredentials(env(p8)), home: mkdtempSync(path.join(os.tmpdir(), "fi-asc-home-")), findRecord: found, runAltool: () => ({ status: 0, output: "" }) }),
    /No package at/);
});
