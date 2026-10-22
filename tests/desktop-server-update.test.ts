import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createServerUpdater, compareVersions } = require("../desktop/server-update.cjs");

/** B-44: the app sends its bundle to an older server through the person's session, never a new token. */
const manifest = (version: string) => ({ format: "fabric-inbox-server/1", version, modules: [{ name: "index.js", file: "worker/index.js" }],
  assets: { files: { "/app.css": { hash: "h1", size: 4, contentType: "text/css" } } } });
const t = (s: string, v: Record<string, string> = {}) => s.replace(/\{(\w+)\}/g, (_m, k) => v[k] ?? "");

function harness(o: { app?: string; bundle?: string | null; server?: unknown; automatic?: boolean; post?: (form: FormData) => { status: number; body: unknown } } = {}) {
  const posts: FormData[] = []; const logs: any[] = []; const notes: string[] = []; const reads: string[] = [];
  const u = createServerUpdater({
    appVersion: o.app ?? "0.27.0", bundleDir: "/b", t,
    readBundle: async () => (o.bundle === null ? null : manifest(o.bundle ?? o.app ?? "0.27.0")),
    readFile: async (p: string) => new TextEncoder().encode(`bytes of ${p}`),
    read: async (p: string) => { reads.push(p); return o.server === undefined ? { version: "0.26.0", selfUpdate: { available: true } } : o.server; },
    post: async (_p: string, form: FormData) => { posts.push(form); return o.post ? o.post(form) : { status: 200, body: { updated: true, from: "0.26.0", to: "0.27.0" } }; },
    automatic: async () => o.automatic ?? true, log: (e: unknown) => logs.push(e), notify: (title: string) => notes.push(title),
  });
  return { u, posts, logs, notes, reads };
}

test("B-44: versions order like the deploy's", () => {
  assert.ok(compareVersions("0.27.0", "0.26.9") > 0);
  assert.ok(compareVersions("0.27.0-rc.1", "0.27.0") < 0);
});

test("B-44: an older server is updated at once when updates are automatic, once per server and version", async () => {
  const h = harness();
  const s = await h.u.onSignedIn("https://mail.example");
  assert.equal(s.phase, "current");
  assert.equal(s.server, "0.27.0");
  assert.equal(h.posts.length, 1);
  const form = h.posts[0]!;
  assert.equal(JSON.parse(String(form.get("manifest"))).version, "0.27.0");
  assert.equal(await (form.get("module:index.js") as Blob).text(), "bytes of /b/worker/index.js");
  assert.equal(await (form.get("asset:h1") as Blob).text(), "bytes of /b/static/app.css");
  assert.deepEqual(h.logs.map((l) => [l.event, l.outcome]), [["server_update", "done"]]);
  assert.deepEqual(h.notes, ["Your server is updated"]);
  await h.u.onSignedIn("https://mail.example");
  assert.equal(h.reads.length, 1, "checked once in this launch");
});

test("B-44: with automatic updates off the menu offers it; a current or newer server, or no bundle, is left alone", async () => {
  const off = harness({ automatic: false });
  await off.u.onSignedIn("https://mail.example");
  assert.equal(off.posts.length, 0);
  assert.equal(off.u.menuItem(() => {})?.label, "Update Server to 0.27.0");
  await off.u.update({ manual: true });
  assert.equal(off.posts.length, 1);
  assert.equal(off.u.menuItem(() => {}), null);
  for (const server of [{ version: "0.27.0", selfUpdate: { available: true } }, { version: "0.28.0", selfUpdate: { available: true } }]) {
    const h = harness({ server });
    assert.equal((await h.u.onSignedIn("o")).phase, "current");
    assert.equal(h.posts.length, 0);
  }
  const stale = harness({ bundle: "0.26.5" });
  assert.equal((await stale.u.onSignedIn("o")).phase, "no_bundle", "a bundle that is not this app's own is never sent");
  assert.equal(stale.posts.length, 0);
  const unknown = harness({ server: null });
  assert.equal((await unknown.u.onSignedIn("o")).phase, "unknown");
});

test("B-44: a server that cannot update itself, or refuses, keeps running and says why", async () => {
  const noToken = harness({ server: { version: "0.26.0", selfUpdate: { available: false, reason: "This server has no Cloudflare token." } } });
  const s = await noToken.u.onSignedIn("o");
  assert.deepEqual([s.phase, s.reason, noToken.posts.length], ["needs_token", "This server has no Cloudflare token.", 0]);
  const denied = harness({ post: () => ({ status: 403, body: { code: "permission", error: "The Cloudflare token is not allowed to upload the server (Workers Scripts: Edit)." } }) });
  const d = await denied.u.onSignedIn("o");
  assert.equal(d.phase, "needs_token");
  assert.deepEqual(denied.notes, ["Your server could not be updated"]);
  assert.deepEqual(denied.logs.map((l) => [l.outcome, l.code]), [["failed", "permission"]]);
  let calls = 0;
  const flaky = harness({ post: () => (++calls === 1 ? { status: 502, body: { code: "failed", error: "Cloudflare: busy" } } : { status: 200, body: { updated: true } }) });
  assert.equal((await flaky.u.onSignedIn("o")).phase, "failed");
  assert.equal(flaky.u.menuItem(() => {})?.label, "Update Server to 0.27.0", "the menu offers it again");
  assert.equal((await flaky.u.update({ manual: true })).phase, "current");
});
