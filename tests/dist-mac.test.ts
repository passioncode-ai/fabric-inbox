import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, pickIdentity, readDeploymentSetup, stagePaths, checkStageState, BUNDLE_ID } from "../desktop/dist-mac.mjs";

const found = `  1) 1111111111111111111111111111111111111111 "Developer ID Application: Example Developer (ABCDE12345)"
  2) 2222222222222222222222222222222222222222 "3rd Party Mac Developer Application: Example Developer (ABCDE12345)"
  3) 3333333333333333333333333333333333333333 "Apple Distribution: Example Developer (ABCDE12345)"
     3 valid identities found`;

test("the disk image is signed with the one Developer ID identity, never a store identity", () => {
  assert.equal(pickIdentity(found).hash, "1111111111111111111111111111111111111111");
  assert.equal(pickIdentity(found, "Developer ID Application: Example Developer (ABCDE12345)").hash, "1111111111111111111111111111111111111111");
  assert.throws(() => pickIdentity(found, "Apple Distribution: Example Developer (ABCDE12345)"), /not a valid Developer ID/);
  assert.throws(() => pickIdentity("0 valid identities found"), /found 0/);
  const two = found + `\n  4) ${"A".repeat(40)} "Developer ID Application: Other (ABCDEFGHIJ)"`;
  assert.throws(() => pickIdentity(two), /found 2; name one/);
});

// The CI release (docs/release.md): the workflow signs with the identity the apple-signing action
// names and notarizes through the shared notarize action, so the builder works in three stages and
// never notarizes itself there. The local path (a notary profile) stays, for debugging only.
const CI_IDENTITY = "Developer ID Application: Example Developer (ABCDE12345)";
const SUBMISSION = "2a4c2f0e-0000-4000-8000-000000000001";
test("arguments: a CI stage takes the identity by name and leaves notarization to the workflow", () => {
  assert.deepEqual(parseArgs(["--stage", "app", "--identity", CI_IDENTITY]),
    { unsigned: false, notaryProfile: "", identity: CI_IDENTITY, setups: [], stage: "app", submission: "" });
  assert.equal(parseArgs(["--stage", "image", "--identity", CI_IDENTITY, "--submission", SUBMISSION]).submission, SUBMISSION);
  assert.equal(parseArgs(["--stage", "finish", "--submission", SUBMISSION]).stage, "finish");
  assert.throws(() => parseArgs(["--stage", "app"]), /--stage app needs --identity/);
  assert.throws(() => parseArgs(["--stage", "image"]), /--stage image needs --identity/);
  assert.throws(() => parseArgs(["--stage", "dmg", "--identity", CI_IDENTITY]), /--stage is app, image or finish/);
  assert.throws(() => parseArgs(["--stage", "app", "--identity", CI_IDENTITY, "--notary-profile", "fabric-notary"]), /notarized by the workflow/);
  assert.throws(() => parseArgs(["--stage", "app", "--identity", CI_IDENTITY, "--setup", "owner"]), /never carries a setup/);
  assert.throws(() => parseArgs(["--stage", "app", "--unsigned"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--stage", "app", "--identity", CI_IDENTITY, "--submission", SUBMISSION]), /--submission belongs to --stage image or finish/);
  assert.throws(() => parseArgs(["--submission", SUBMISSION]), /--submission belongs to --stage image or finish/);
  assert.throws(() => parseArgs(["--stage", "finish", "--submission", "not an id"]), /submission id/);
});

test("the stage directory and the files a CI release publishes", () => {
  assert.deepEqual(stagePaths("/repo", "0.9.0"), {
    dir: "/repo/release/ci", app: "/repo/release/ci/Fabric Inbox.app", state: "/repo/release/ci/state.json",
    dmg: "/repo/release/Fabric-Inbox-0.9.0.dmg", receipt: "/repo/release/Fabric-Inbox-0.9.0.receipt.json",
    zip: "/repo/release/Fabric-Inbox-0.9.0-mac.zip", feed: "/repo/release/update-mac.json",
  });
});

test("a stage refuses a state written for another commit or version", () => {
  const state = { revision: "a".repeat(40), version: "0.9.0", receipt: { product: "Fabric Inbox" } };
  assert.deepEqual(checkStageState(state, "a".repeat(40), "0.9.0"), state);
  assert.throws(() => checkStageState(state, "b".repeat(40), "0.9.0"), /written for commit a{12}.*HEAD is b{12}/);
  assert.throws(() => checkStageState(state, "a".repeat(40), "0.9.1"), /version 0\.9\.0.*0\.9\.1/);
  assert.throws(() => checkStageState(null, "a".repeat(40), "0.9.0"), /Run --stage app first/);
});

test("arguments: a notary profile by name only, unsigned stays unsigned", () => {
  assert.deepEqual(parseArgs([]), { unsigned: false, notaryProfile: "", identity: "", setups: [], stage: "", submission: "" });
  assert.deepEqual(parseArgs(["--setup", "owner"]).setups, ["owner"]);
  assert.throws(() => parseArgs(["--setup", "../x"]), /deployment name/);
  assert.equal(parseArgs(["--notary-profile", "fabric-notary"]).notaryProfile, "fabric-notary");
  assert.throws(() => parseArgs(["--notary-profile", "a b"]), /letters, digits/);
  assert.throws(() => parseArgs(["--unsigned", "--notary-profile", "x"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--password", "x"]), /Unknown argument/);
  assert.equal(BUNDLE_ID, "ai.passioncode.fabric-inbox");
});

// Release receipts (docs/release.md): what the builder reads from notarytool and spctl, the
// release notes it takes from CHANGELOG.md, and the checksum file published beside the image.
import { changelogSection, notarization, gatekeeper, checksumLine } from "../desktop/dist-mac.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const CHANGELOG = `# Changelog

Intro text.

## 0.7.1 — 2026-09-30

- First published release.
- Second line.

## 0.7.0 — 2026-09-29

- The agent protocol.
`;

test("release notes are the version's own CHANGELOG section, nothing of the next one", () => {
  assert.equal(changelogSection(CHANGELOG, "0.7.1"), "- First published release.\n- Second line.");
  assert.equal(changelogSection(CHANGELOG, "0.7.0"), "- The agent protocol.");
  assert.equal(changelogSection(CHANGELOG, "0.7.2"), "");
  // 0.7.1 must not match a heading for 0.7.10 or 0x7y1 (the dots are literal).
  assert.equal(changelogSection("## 0.7.10\n\n- later\n", "0.7.1"), "");
  assert.equal(changelogSection("## 0x7y1\n\n- no\n", "0.7.1"), "");
});

test("notarization is accepted only when notarytool says Accepted", () => {
  const accepted = JSON.stringify({ id: "2a4c2f0e-0000-4000-8000-000000000001", status: "Accepted", message: "Processing complete" });
  assert.deepEqual(notarization(accepted), { id: "2a4c2f0e-0000-4000-8000-000000000001", status: "Accepted" });
  // notarytool can finish --wait with a verdict that is not a pass; that is a failed build.
  assert.throws(() => notarization(JSON.stringify({ id: "x", status: "Invalid", message: "Processing complete" })), /Invalid.*notarytool log x/s);
  assert.throws(() => notarization("Error: HTTP status code: 401"), /no verdict/);
});

test("Gatekeeper passes an item only as accepted from a notarized Developer ID", () => {
  const ok = "/tmp/x/Fabric Inbox.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Someone (ABCDEFGHIJ)\n";
  assert.deepEqual(gatekeeper(ok, true), { accepted: true, source: "Notarized Developer ID" });
  // Signed but not notarized: spctl may accept a local item yet name another source.
  assert.equal(gatekeeper("/x.app: accepted\nsource=Developer ID\n", true).accepted, false);
  assert.deepEqual(gatekeeper("/x.app: rejected\nsource=Unnotarized Developer ID\n", false), { accepted: false, source: "Unnotarized Developer ID" });
  assert.equal(gatekeeper("/x.app: rejected\nsource=Notarized Developer ID\n", false).accepted, false, "a failed spctl is never a pass");
});

test("the checksum file is what shasum -a 256 -c reads", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fi-sum-"));
  writeFileSync(path.join(dir, "Fabric-Inbox-9.9.9.dmg"), "image bytes");
  const sha = execFileSync("shasum", ["-a", "256", path.join(dir, "Fabric-Inbox-9.9.9.dmg")], { encoding: "utf8" }).split(" ")[0]!;
  writeFileSync(path.join(dir, "Fabric-Inbox-9.9.9.dmg.sha256"), checksumLine(sha, "Fabric-Inbox-9.9.9.dmg"));
  assert.match(execFileSync("shasum", ["-a", "256", "-c", "Fabric-Inbox-9.9.9.dmg.sha256"], { cwd: dir, encoding: "utf8" }), /Fabric-Inbox-9\.9\.9\.dmg: OK/);
  assert.throws(() => checksumLine("abc", "x.dmg"), /64 hex/);
  assert.throws(() => checksumLine(sha, "../x.dmg"), /file name/);
});

// spctl writes its verdict to stderr and nothing to stdout, so a reader of stdout alone saw
// "source=null" on a notarized app (trial 0.7.1 build, 2026-09-30). Checked with the real spctl.
import { spctl } from "../desktop/dist-mac.mjs";
test("spctl's verdict is read from what it prints, stderr included", { skip: process.platform !== "darwin" }, () => {
  const system = spctl(["--assess", "--type", "execute", "-vv", "/System/Applications/Calculator.app"]);
  assert.equal(system.ok, true);
  assert.deepEqual(gatekeeper(system.out, system.ok), { accepted: false, source: "Apple System" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "fi-spctl-"));
  const unsigned = spctl(["--assess", "--type", "execute", "-vv", dir]);
  assert.equal(unsigned.ok, false);
  assert.equal(gatekeeper(unsigned.out, unsigned.ok).accepted, false);
});

test("a personal build bundles the local deployment's setup, checked and hashed; a missing or broken one stops it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-dist-"));
  assert.throws(() => readDeploymentSetup(root, "owner"), /No deployments\/owner\/setup\.json on this machine.*never committed/);
  mkdirSync(path.join(root, "deployments", "owner"), { recursive: true });
  const file = path.join(root, "deployments", "owner", "setup.json");
  copyFileSync("deployments/setup.example.json", file);
  const read = readDeploymentSetup(root, "owner");
  assert.equal(read.name, "owner");
  assert.equal(read.text, readFileSync("deployments/setup.example.json", "utf8"), "bundled byte for byte");
  assert.equal(read.sha256, createHash("sha256").update(read.text).digest("hex"));
  writeFileSync(file, "{ not json");
  assert.throws(() => readDeploymentSetup(root, "owner"), /is not JSON/);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(read.text), server: { origin: "http://inbox.example.com" } }));
  assert.throws(() => readDeploymentSetup(root, "owner"), /cannot be bundled: .*server address cannot be used/);
});
