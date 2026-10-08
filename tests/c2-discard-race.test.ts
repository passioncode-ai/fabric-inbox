// C2 test-hardening (UX audit 2026-10-07, AUD-B9-02, SCN-075): "two changes at once both land".
// The discard rules and the Always allow list are one R2 object written conditionally on the version
// read (workers/discard/store.ts). Here two writes race, once against the in-memory bucket with R2's
// conditional-put semantics (tests/fake-r2.ts) and once in workerd against Miniflare's real R2, and
// the store that keeps losing ends in DiscardStoreConflict, which the route answers with 409.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { DISCARD_KEY, DiscardStoreConflict, readDiscardStore, updateDiscardStore } from "../workers/discard/store";
import { discardRouter } from "../workers/routes/discard";
import type { DiscardStore } from "../shared/mail/discard";
import { fakeBucket } from "./fake-r2";

const asBucket = (b: unknown) => b as R2Bucket;
const addSender = (value: string) => (s: DiscardStore): DiscardStore =>
  ({ ...s, rules: [...s.rules, { kind: "sender", value, why: {}, at: 1, applied: 0 } as unknown as DiscardStore["rules"][number]] });

test("AUD-B9-02: two discard-store writes racing on an empty store both land; the loser retries on the new version", async () => {
  const bucket = fakeBucket();
  let puts = 0, refused = 0;
  const put = bucket.put.bind(bucket);
  bucket.put = async (...args: Parameters<typeof put>) => { puts++; const r = await put(...args); if (!r) refused++; return r; };
  const [a, b] = await Promise.all([
    updateDiscardStore(asBucket(bucket), addSender("first@news.example.org")),
    updateDiscardStore(asBucket(bucket), addSender("second@news.example.org")),
  ]);
  assert.equal(refused, 1, "both read an empty store; the second create is refused (If-None-Match: *)");
  assert.equal(puts, 3, "the loser read again and wrote once more");
  const stored = await readDiscardStore(asBucket(bucket));
  assert.deepEqual(stored.rules.map((r) => r.value).sort(), ["first@news.example.org", "second@news.example.org"], "neither change is lost");
  assert.equal([a, b].find((s) => s.rules.length === 2)?.rules.length, 2, "the retried write returns the store with both");
});

test("AUD-B9-02: two writes racing on an existing store both land (etag match)", async () => {
  const bucket = fakeBucket();
  await updateDiscardStore(asBucket(bucket), (s) => ({ ...s, allowed: ["kept@example.org"] }));
  await Promise.all([
    updateDiscardStore(asBucket(bucket), (s) => ({ ...s, allowed: [...s.allowed, "friend@example.org"] })),
    updateDiscardStore(asBucket(bucket), addSender("promo@shop.example.org")),
  ]);
  const stored = await readDiscardStore(asBucket(bucket));
  assert.deepEqual(stored.allowed.sort(), ["friend@example.org", "kept@example.org"]);
  assert.deepEqual(stored.rules.map((r) => r.value), ["promo@shop.example.org"]);
});

/** A bucket another writer always beats: every conditional put is refused. */
function alwaysBeaten() {
  const bucket = fakeBucket();
  let attempts = 0;
  bucket.put = async () => { attempts++; return null; };
  return { bucket, attempts: () => attempts };
}

test("AUD-B9-02: a store that changes under every attempt gives up after five with DiscardStoreConflict, writing nothing", async () => {
  const { bucket, attempts } = alwaysBeaten();
  await assert.rejects(updateDiscardStore(asBucket(bucket), addSender("x@news.example.org")), (e: unknown) => {
    assert.ok(e instanceof DiscardStoreConflict);
    assert.match((e as Error).message, /changed several times at once; try again/);
    return true;
  });
  assert.equal(attempts(), 5);
  assert.equal(bucket.objects.has(DISCARD_KEY), false);
});

test("AUD-B9-02: the routes answer DiscardStoreConflict with 409 and its sentence, not a 502", async () => {
  const { bucket } = alwaysBeaten();
  const env = { BUCKET: bucket } as never;
  const allowed = await discardRouter.request("/api/discard/allowed", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "friend@example.org", action: "add" }) }, env);
  assert.equal(allowed.status, 409);
  assert.match(((await allowed.json()) as { error: string }).error, /try again/);
  const removed = await discardRouter.request("/api/discard/rules/s-0123abcd", { method: "DELETE" }, env);
  assert.equal(removed.status, 409);
});

// ── workerd: the same race through the real route and Miniflare's R2 ──

const bundle = await build({
  stdin: {
    contents: `
      import { discardRouter } from './workers/routes/discard';
      export default { fetch: (r, env, ctx) => discardRouter.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

test("AUD-B9-02: in workerd, Always-allow changes sent at once through the real route and R2 all land or are refused with 409, never lost", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["BUCKET"], outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  try {
    const values = Array.from({ length: 8 }, (_, i) => `sender${i}@example.org`);
    const answers = await Promise.all(values.map((value) => mf.dispatchFetch("http://localhost/api/discard/allowed", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value, action: "add" }) })));
    // Each write retries up to five times; eight at once may exhaust a retry budget, and then the
    // person is told to try again (409) — never a silent loss. Every 200 must be in the store.
    const statuses = await Promise.all(answers.map(async (r) => { await r.text(); return r.status; }));
    assert.ok(statuses.every((s) => s === 200 || s === 409), `statuses ${statuses}`);
    const landed = values.filter((_, i) => statuses[i] === 200);
    assert.ok(landed.length >= 2, "at least two concurrent writes land");
    const store = await (await mf.dispatchFetch("http://localhost/api/discard/rules")).json() as { allowed: string[] };
    assert.deepEqual(store.allowed.filter((v) => landed.includes(v)).sort(), [...landed].sort(), "every acknowledged change is stored");
    assert.deepEqual(store.allowed.filter((v) => !landed.includes(v)), [], "a refused change wrote nothing");

    // Two at once, the case the scenario names: both land.
    const pair = await Promise.all(["a@pair.example.org", "b@pair.example.org"].map((value) => mf.dispatchFetch("http://localhost/api/discard/allowed", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value, action: "add" }) })));
    assert.deepEqual(await Promise.all(pair.map(async (r) => { await r.text(); return r.status; })), [200, 200]);
    const after = await (await mf.dispatchFetch("http://localhost/api/discard/rules")).json() as { allowed: string[] };
    assert.ok(after.allowed.includes("a@pair.example.org") && after.allowed.includes("b@pair.example.org"));
  } finally {
    await mf.dispose();
  }
});
