import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error a plain .mjs script
import { buildDigest, makeReceipt } from "../scripts/deploy-receipt.mjs";

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "receipt-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "one\n"); git("add", "."); git("commit", "-qm", "one");
  mkdirSync(join(root, "build/server"), { recursive: true }); mkdirSync(join(root, "build/client/assets"), { recursive: true });
  writeFileSync(join(root, "build/server/index.js"), "export default {}\n"); writeFileSync(join(root, "build/client/assets/app.js"), "x\n");
  return { root, git, commit: git("rev-parse", "HEAD") };
}
const cloudflare = (tag: string | null, versions = [{ version_id: "v-1", percentage: 100 }]) => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    asked.push(url.replace(/^.*\/scripts\//, ""));
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer token");
    const result = url.endsWith("/deployments") ? { deployments: [{ id: "d-1", created_on: "2026-10-19T20:00:00Z", versions }] }
      // The shape Cloudflare answers (read live 2026-10-19): annotations at the top, the script's etag under resources.
      : { id: "v-1", metadata: { created_on: "2026-10-19T20:00:00Z" }, annotations: tag ? { "workers/tag": tag } : {}, resources: { script: { etag: "etag-1" } } };
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
};

test("B-62: a served version tagged with this clean checkout's commit is linked, with the build's digest and no secret", async () => {
  const c = checkout();
  const cf = cloudflare(c.commit.slice(0, 12));
  const r = await makeReceipt({ root: c.root, token: "token", account: "acc-123", script: "fabric-inbox", fetchImpl: cf.fetchImpl });
  assert.equal(r.verdict, "linked", JSON.stringify(r.problems));
  assert.equal(r.commit, c.commit);
  assert.equal(r.worker.versionId, "v-1");
  assert.equal(r.worker.scriptEtag, "etag-1");
  assert.equal(r.build.files, 2);
  assert.equal(r.build.sha256, buildDigest(c.root).sha256, "the digest is stable");
  assert.deepEqual(cf.asked, ["fabric-inbox/deployments", "fabric-inbox/versions/v-1"]);
  assert.ok(!JSON.stringify(r).includes("token") && !JSON.stringify(r).includes("acc-123"), "no token or account in the receipt");
});

test("B-62: another commit's tag, no tag, a dirty tree, a split deployment or an unexpected version is unlinked, each said", async () => {
  const c = checkout();
  const other = await makeReceipt({ root: c.root, token: "token", account: "a", script: "s", fetchImpl: cloudflare("0123456789ab").fetchImpl });
  assert.equal(other.verdict, "unlinked");
  assert.match(other.problems.join(" "), /tagged 0123456789ab/);
  assert.match((await makeReceipt({ root: c.root, token: "token", account: "a", script: "s", fetchImpl: cloudflare(null).fetchImpl })).problems.join(" "), /no commit tag/);
  const split = await makeReceipt({ root: c.root, token: "token", account: "a", script: "s",
    fetchImpl: cloudflare(c.commit.slice(0, 12), [{ version_id: "v-1", percentage: 90 }, { version_id: "v-0", percentage: 10 }]).fetchImpl });
  assert.match(split.problems.join(" "), /splits traffic/);
  assert.match((await makeReceipt({ root: c.root, token: "token", account: "a", script: "s", fetchImpl: cloudflare(c.commit.slice(0, 12)).fetchImpl, expectVersion: "v-9" })).problems.join(" "), /not v-9/);
  writeFileSync(join(c.root, "a.txt"), "changed\n");
  assert.match((await makeReceipt({ root: c.root, token: "token", account: "a", script: "s", fetchImpl: cloudflare(c.commit.slice(0, 12)).fetchImpl })).problems.join(" "), /uncommitted/);
  // The build's bytes change the digest.
  const before = buildDigest(c.root).sha256;
  writeFileSync(join(c.root, "build/server/index.js"), "export default { changed: true }\n");
  assert.notEqual(buildDigest(c.root).sha256, before);
});
