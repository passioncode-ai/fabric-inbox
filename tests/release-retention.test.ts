// LC-15 (knowledge/lifecycle.md): a build leaves at most the current release and the one before it.
// The audit found 3.9 GB of fourteen old disk images in release/ (raw/fabric-inbox.md §4); the
// builders now prune it themselves (desktop/release-retention.mjs), keeping small receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planReleasePrune, pruneReleases, compareVersions } from "../desktop/release-retention.mjs";

const family = (v: string, suffix = "") => [`Fabric-Inbox-${v}${suffix}.dmg`, `Fabric-Inbox-${v}${suffix}.dmg.sha256`, `Fabric-Inbox-${v}${suffix}.receipt.json`];

test("versions compare numerically, not as text", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.2.3", "1.2.3") === 0);
  assert.ok(compareVersions("0.8.1", "0.8.2") < 0);
});

test("the current release and the newest other one stay; older images go; receipts are kept", () => {
  const names = [
    ...family("0.2.0"), ...family("0.2.0", "-owner"), ...family("0.7.1"), ...family("0.8.1"), ...family("0.8.1", "-owner"),
    ...family("0.8.2"), ...family("0.8.2", "-unsigned"), ".build-tmp", "Fabric Inbox-darwin-arm64", "notes.txt",
  ];
  const plan = planReleasePrune(names, { current: "0.8.2" });
  assert.deepEqual(plan.remove.sort(), [
    "Fabric-Inbox-0.2.0-owner.dmg", "Fabric-Inbox-0.2.0-owner.dmg.sha256", "Fabric-Inbox-0.2.0.dmg", "Fabric-Inbox-0.2.0.dmg.sha256",
    "Fabric-Inbox-0.7.1.dmg", "Fabric-Inbox-0.7.1.dmg.sha256",
  ]);
  assert.deepEqual(plan.keepVersions, ["0.8.2", "0.8.1"]);
  // Receipts are small JSON and may stay (LC-15); nothing that is not a release artefact is touched.
  for (const kept of ["Fabric-Inbox-0.2.0.receipt.json", ".build-tmp", "Fabric Inbox-darwin-arm64", "notes.txt", "Fabric-Inbox-0.8.1-owner.dmg", "Fabric-Inbox-0.8.2-unsigned.dmg"]) {
    assert.ok(!plan.remove.includes(kept), kept);
  }
});

test("rebuilding an older version keeps the newest release beside it, not an even older one", () => {
  const plan = planReleasePrune([...family("0.7.0"), ...family("0.8.0"), ...family("0.9.0")], { current: "0.8.0" });
  assert.deepEqual(plan.keepVersions, ["0.8.0", "0.9.0"]);
  assert.deepEqual(plan.remove.sort(), ["Fabric-Inbox-0.7.0.dmg", "Fabric-Inbox-0.7.0.dmg.sha256"]);
});

test("store builds keep the current and the previous build folder", () => {
  const rev = "a".repeat(12);
  const names = [`mas-distribution-arm64-3-${rev}`, `mas-distribution-arm64-10-${rev}`, `mas-development-x64-2-${rev}`, `mas-distribution-arm64-9-${rev}`];
  const plan = planReleasePrune(names, { currentMas: `mas-distribution-arm64-9-${rev}` });
  assert.deepEqual(plan.remove.sort(), [`mas-development-x64-2-${rev}`, `mas-distribution-arm64-3-${rev}`]);
});

test("after two builds, at most two releases remain on disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-release-"));
  for (const v of ["0.2.0", "0.3.0", "0.4.0", "0.5.0"]) for (const f of family(v)) writeFileSync(path.join(dir, f), v);
  mkdirSync(path.join(dir, ".build-tmp"));
  for (const v of ["0.6.0", "0.7.0"]) {
    for (const f of family(v)) writeFileSync(path.join(dir, f), v);
    const removed = pruneReleases(dir, { current: v });
    assert.ok(removed.every((name) => !name.includes(v)), `the build of ${v} never removes itself`);
  }
  const images = readdirSync(dir).filter((n) => n.endsWith(".dmg"));
  assert.deepEqual(images.sort(), ["Fabric-Inbox-0.6.0.dmg", "Fabric-Inbox-0.7.0.dmg"]);
  assert.ok(existsSync(path.join(dir, "Fabric-Inbox-0.2.0.receipt.json")));
  assert.ok(existsSync(path.join(dir, ".build-tmp")));
  // A missing release folder is nothing to prune, not an error.
  assert.deepEqual(pruneReleases(path.join(dir, "absent"), { current: "0.7.0" }), []);
});

test("the disk-image and store builders prune release/ themselves after a successful build", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync("desktop/dist-mac.mjs", "utf8"), /pruneReleases\(out, \{ current: version \}\)/);
  assert.match(readFileSync("desktop/mas-package.mjs", "utf8"), /pruneReleases\(path\.join\(root, 'release'\), \{ currentMas: path\.basename\(destination\) \}\)/);
});

test("npm run clean removes the build caches, not local data or releases", async () => {
  const { clean, CACHES } = await import("../scripts/clean.mjs");
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-clean-"));
  for (const dir of [...CACHES, ".wrangler/state", "release"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "file"), "12345");
  }
  const result = clean(root);
  assert.deepEqual(result, { removed: CACHES, bytes: 5 * CACHES.length });
  for (const dir of CACHES) assert.equal(existsSync(path.join(root, dir)), false, dir);
  assert.ok(existsSync(path.join(root, ".wrangler/state/file")));
  assert.ok(existsSync(path.join(root, "release/file")));
  assert.deepEqual(clean(root), { removed: [], bytes: 0 });
  const { readFileSync } = await import("node:fs");
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts.clean, "node scripts/clean.mjs");
});
