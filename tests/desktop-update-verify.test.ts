// LC-16 "Verification": the update is refused unless the release's signed SHA256SUMS covers the
// feed and the zip, the bytes match, and the app inside is the pinned team's, of the announced
// version. The release fixtures are signed by a throwaway test key (only its public half is here);
// the tests pin that key the way the app pins the organization's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, createWriteStream, existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createVerifier, requirementFor, TEAM } = require("../desktop/update-verify.cjs");

const FIX = "tests/fixtures/release-signing";
const TEST_KEY = readFileSync(`${FIX}/other-key.asc`, "utf8");
const TEST_FPR = "4A6CF6F038756A5D5C80AE742F78C0EC0DF27FF9";
const BASE = "https://github.com/passioncode-ai/fabric-inbox/releases/download/v0.12.0/";
const ZIP = "Fabric-Inbox-0.12.0-mac.zip";

function release(kind = "plain") {
  const d = `${FIX}/test-release-0.12.0-${kind}`;
  return {
    feed: readFileSync(`${d}/update-mac.json`),
    files: new Map<string, Buffer>([
      [`${BASE}SHA256SUMS`, readFileSync(`${d}/SHA256SUMS`)],
      [`${BASE}SHA256SUMS.asc`, readFileSync(`${d}/SHA256SUMS.asc`)],
      [`${BASE}${ZIP}`, readFileSync(`${d}/${ZIP}`)],
    ]),
  };
}

function harness({ kind = "plain", appVersion = "0.11.0", codesignOk = true, bundleVersion = "0.12.0", bundleId = "ai.passioncode.fabric-inbox" } = {}) {
  const r = release(kind);
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-verify-")), "updates");
  const calls: string[] = [];
  const lines: any[] = [];
  const fetch = async (url: string) => {
    calls.push(`GET ${url.replace(BASE, "")}`);
    const body = r.files.get(url);
    return body ? new Response(body) : new Response("missing", { status: 404 });
  };
  const exec = async (file: string, args: string[]) => {
    calls.push(`${path.basename(file)} ${args[0]}`);
    if (file.endsWith("ditto")) { await fsPromises.mkdir(path.join(args[3], "Fabric Inbox.app", "Contents"), { recursive: true }); return { stdout: "" }; }
    if (file.endsWith("codesign")) {
      assert.equal(args[3], `--test-requirement=${requirementFor(TEAM)}`);
      if (!codesignOk) throw new Error("code failed to satisfy specified code requirement(s)");
      return { stdout: "" };
    }
    if (file.endsWith("plutil")) {
      const own = args[5].startsWith("/Applications/");
      if (args[1] === "CFBundleShortVersionString") return { stdout: `${bundleVersion}\n` };
      return { stdout: own ? "ai.passioncode.fabric-inbox\n" : `${bundleId}\n` };
    }
    throw new Error(`unexpected ${file}`);
  };
  const verifier = createVerifier({
    repository: "passioncode-ai/fabric-inbox", appVersion, appName: "Fabric Inbox", zipName: (v: string) => `Fabric-Inbox-${v}-mac.zip`,
    runningApp: "/Applications/Fabric Inbox.app", dir, fetch, exec, fs: fsPromises, createWriteStream,
    key: TEST_KEY, fingerprint: TEST_FPR, log: (l: unknown) => lines.push(l),
  });
  return { ...r, verifier, calls, lines, dir };
}

const refusal = async (promise: Promise<unknown>, code: string, reason: string) => {
  await assert.rejects(promise, (error: any) => { assert.equal(error.code, code); assert.equal(error.reason, reason); return true; });
};

test("a newer, signed release is downloaded, checked step by step and handed over as a local feed", async () => {
  const h = harness();
  const out = await h.verifier.verify(h.feed);
  assert.equal(out.outcome, "verified");
  assert.equal(out.version, "0.12.0");
  assert.equal(out.migration, null);
  assert.deepEqual(h.calls, ["GET SHA256SUMS", "GET SHA256SUMS.asc", `GET ${ZIP}`, "ditto -x", "codesign --verify", "plutil -extract", "plutil -extract", "plutil -extract"]);
  const local = JSON.parse(readFileSync(fileURLToPath(out.localFeed), "utf8"));
  assert.equal(local.currentRelease, "0.12.0");
  const zip = fileURLToPath(local.releases[0].updateTo.url);
  assert.deepEqual(readFileSync(zip), h.files.get(`${BASE}${ZIP}`), "Squirrel.Mac gets the very bytes that were checked");
  assert.ok(!existsSync(path.join(path.dirname(zip), "unpacked")), "the unpacked copy is removed");
  assert.deepEqual(h.lines.map((l) => `${l.event}:${l.outcome}`), ["update_download:started", "update_download:done"]);
  await h.verifier.clean();
  assert.ok(!existsSync(h.dir));
});

test("an older or equal release is not offered, and nothing is downloaded", async () => {
  for (const [appVersion, outcome] of [["0.12.0", "current"], ["0.13.0", "older"]]) {
    const h = harness({ appVersion });
    assert.deepEqual(await h.verifier.verify(h.feed), { outcome, version: "0.12.0" });
    assert.deepEqual(h.calls, []);
  }
});

test("a release held for a migration is still verified, and says so", async () => {
  const h = harness({ kind: "held" });
  const out = await h.verifier.verify(h.feed);
  assert.equal(out.outcome, "verified");
  assert.match(out.migration.runbook, /docs\/release\.md$/);
});

test("a tampered package is refused before it is unpacked", async () => {
  const h = harness();
  const zip = Buffer.from(h.files.get(`${BASE}${ZIP}`)!);
  zip[zip.length - 2] ^= 1;
  h.files.set(`${BASE}${ZIP}`, zip);
  await refusal(h.verifier.verify(h.feed), "signature_failed", "zip_sha256");
  assert.ok(!h.calls.some((c) => c.startsWith("ditto")));
  const longer = harness();
  longer.files.set(`${BASE}${ZIP}`, Buffer.concat([longer.files.get(`${BASE}${ZIP}`)!, Buffer.from("x")]));
  await refusal(longer.verifier.verify(longer.feed), "signature_failed", "zip_size");
});

test("an unsigned package, or one signed by another team, is refused", async () => {
  const h = harness({ codesignOk: false });
  await refusal(h.verifier.verify(h.feed), "signature_failed", "codesign");
  assert.ok(!h.calls.some((c) => c.startsWith("plutil")));
});

test("a package whose version is not the announced one, or another app, is refused", async () => {
  await refusal(harness({ bundleVersion: "0.11.0" }).verifier.verify(harness().feed), "signature_failed", "version_mismatch");
  await refusal(harness({ bundleId: "com.example.other" }).verifier.verify(harness().feed), "signature_failed", "bundle_id");
});

test("a feed or sums that the release did not sign are refused before any download", async () => {
  const h = harness();
  const feed = JSON.parse(h.feed.toString("utf8"));
  feed.releases[0].updateTo.notes = "changed";
  await refusal(h.verifier.verify(Buffer.from(JSON.stringify(feed))), "signature_failed", "feed_not_signed");
  const sums = harness();
  const text = Buffer.from(sums.files.get(`${BASE}SHA256SUMS`)!);
  text[0] = text[0] === 0x61 ? 0x62 : 0x61;
  sums.files.set(`${BASE}SHA256SUMS`, text);
  await refusal(sums.verifier.verify(sums.feed), "signature_failed", "sums_signature");
  for (const run of [h, sums]) assert.ok(!run.calls.includes(`GET ${ZIP}`));
  // The real organization key does not accept the test release.
  const org = createVerifier({ repository: "passioncode-ai/fabric-inbox", appVersion: "0.11.0", appName: "Fabric Inbox",
    zipName: (v: string) => `Fabric-Inbox-${v}-mac.zip`, runningApp: "/x.app", dir: os.tmpdir(), fs: fsPromises, createWriteStream,
    fetch: async (url: string) => new Response(harness().files.get(url) ?? "missing"), exec: async () => ({ stdout: "" }),
    key: readFileSync("desktop/release-key.asc", "utf8") });
  await refusal(org.verify(harness().feed), "signature_failed", "sums_signature");
});

test("a feed pointing at another file, another repository or plain http is refused", async () => {
  for (const url of [`${BASE}Fabric-Inbox-0.12.0.dmg`, "https://github.com/someone/fork/releases/download/v0.12.0/Fabric-Inbox-0.12.0-mac.zip",
    `http://github.com/passioncode-ai/fabric-inbox/releases/download/v0.12.0/${ZIP}`, `${BASE.replace("v0.12.0", "v0.11.0")}${ZIP}`]) {
    const h = harness();
    const feed = JSON.parse(h.feed.toString("utf8"));
    feed.releases[0].updateTo.url = url;
    await refusal(h.verifier.verify(Buffer.from(JSON.stringify(feed))), "signature_failed", "feed_foreign_file");
    assert.deepEqual(h.calls, []);
  }
});

test("an unreachable release is a failed check or a failed download, not a verification failure", async () => {
  const h = harness();
  h.files.delete(`${BASE}SHA256SUMS.asc`);
  await refusal(h.verifier.verify(h.feed), "check_failed", "sums_unreachable");
  const d = harness();
  d.files.delete(`${BASE}${ZIP}`);
  await refusal(d.verifier.verify(d.feed), "download_failed", "zip_unreachable");
  await refusal(harness().verifier.verify(Buffer.from("not json")), "check_failed", "feed_invalid");
  await refusal(harness().verifier.verify(Buffer.from(JSON.stringify({ currentRelease: "0.12.0-rc.1" }))), "check_failed", "feed_invalid");
});

test("the release gate runs the same verification on the signed release set", async () => {
  const { checkRelease } = await import("../scripts/check-update-release.mjs");
  const dir = `${FIX}/test-release-0.12.0-plain`;
  const calls: string[] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push(path.basename(file));
    if (file.endsWith("ditto")) { await fsPromises.mkdir(path.join(args[3], "Fabric Inbox.app", "Contents"), { recursive: true }); return { stdout: "" }; }
    if (file.endsWith("plutil")) return { stdout: args[1] === "CFBundleShortVersionString" ? "0.12.0" : "ai.passioncode.fabric-inbox" };
    return { stdout: "" };
  };
  assert.deepEqual(await checkRelease({ dir, version: "0.12.0", exec, key: TEST_KEY, fingerprint: TEST_FPR }), { version: "0.12.0", held: false });
  assert.deepEqual(calls, ["ditto", "codesign", "plutil", "plutil", "plutil"]);
  assert.deepEqual(await checkRelease({ dir: `${FIX}/test-release-0.12.0-held`, version: "0.12.0", exec, key: TEST_KEY, fingerprint: TEST_FPR }), { version: "0.12.0", held: true });
  await assert.rejects(checkRelease({ dir, version: "0.12.1", exec, key: TEST_KEY, fingerprint: TEST_FPR }), /announces 0\.12\.0/);
  // With the organization's key the test release is refused, as a real copy would refuse it.
  await assert.rejects(checkRelease({ dir, version: "0.12.0", exec }), (e: any) => e.reason === "sums_signature");
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /node scripts\/check-update-release\.mjs --dir signed --version "\$VERSION"/);
});

test("before signing, the release gate checks the built feed and zip, and publish waits for it", async () => {
  const { checkRelease } = await import("../scripts/check-update-release.mjs");
  const exec = async (file: string, args: string[]) => {
    if (file.endsWith("ditto")) { await fsPromises.mkdir(path.join(args[3], "Fabric Inbox.app", "Contents"), { recursive: true }); return { stdout: "" }; }
    if (file.endsWith("plutil")) return { stdout: args[1] === "CFBundleShortVersionString" ? "0.12.0" : "ai.passioncode.fabric-inbox" };
    return { stdout: "" };
  };
  // No SHA256SUMS is needed yet, and no key: the built files only.
  const built = mkdtempSync(path.join(os.tmpdir(), "fabric-built-"));
  for (const name of ["update-mac.json", ZIP]) await fsPromises.copyFile(`${FIX}/test-release-0.12.0-plain/${name}`, path.join(built, name));
  assert.deepEqual(await checkRelease({ dir: built, version: "0.12.0", exec, beforeSigning: true }), { version: "0.12.0", held: false });
  const zip = readFileSync(path.join(built, ZIP));
  zip[3] ^= 1;
  await fsPromises.writeFile(path.join(built, ZIP), zip);
  await assert.rejects(checkRelease({ dir: built, version: "0.12.0", exec, beforeSigning: true }), (e: any) => e.reason === "zip_sha256");
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /publish:\n    needs: \[gate, macos, update-precheck\]/);
  assert.match(workflow, /check-update-release\.mjs --before-signing --dir built --version "\$VERSION" --repository "\$GITHUB_REPOSITORY"/);
});
