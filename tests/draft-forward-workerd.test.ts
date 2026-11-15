import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * B-277: a forward draft's origin kept by the server beside the draft, on the production code in
 * workerd (the MailboxDO and the mailbox HTTP API): written with a save that carries it, left as it
 * was by a save that does not (an older app, an agent's update), answered with the draft, gone with
 * a delete or a send, and never in the message that leaves.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { app } from './workers/index';
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) {
          super(ctx, { ...env, AI: { run: () => { throw new Error('no AI'); } }, EMAIL: { send: async (m) => {
            const sent = (await ctx.storage.get('test:sent')) || [];
            await ctx.storage.put('test:sent', [...sent, { to: m.to, cc: m.cc, bcc: m.bcc, from: m.from, subject: m.subject, html: m.html, text: m.text, headers: m.headers,
              attachments: (m.attachments || []).map((a) => ({ filename: a.filename, content: a.content })) }]);
            return { messageId: '<sent-' + sent.length + '@cloudflare.invalid>' };
          } } });
        }
        async seed(folder, row) { return this.createEmail(folder, row, []); }
        async sent() { return (await this.ctx.storage.get('test:sent')) || []; }
      }
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/test') {
            const c = await request.json();
            const box = env.MAILBOX.getByName(c.mailbox);
            if (c.op === 'seed') { await box.seed(c.folder, c.row); return Response.json(true); }
            if (c.op === 'sent') return Response.json(await box.sent());
            if (c.op === 'folder') return Response.json(await box.getEmails({ folder: c.folder }));
            if (c.op === 'r2') return Response.json((await env.BUCKET.list({ prefix: c.prefix })).objects.map((o) => o.key));
            if (c.op === 'put') { await env.BUCKET.put(c.key, JSON.stringify(c.value)); return Response.json(true); }
            if (c.op === 'meta') { const o = await env.BUCKET.head(c.key); return Response.json(o ? { revision: o.customMetadata?.revision ?? null } : null); }
          }
          return app.fetch(request, env, ctx);
        },
      };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:*", "node:*"], target: "es2022",
  alias: { mimetext: "mimetext/browser" }, define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"' },
});

const BOX = "me@p.invalid";
async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"],
    bindings: { DOMAINS: "p.invalid", EMAIL_ADDRESSES: BOX },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const t = async (fields: Record<string, unknown>): Promise<any> =>
    (await mf.dispatchFetch("http://localhost/test", { method: "POST", body: JSON.stringify({ mailbox: BOX, ...fields }) })).json();
  await t({ op: "put", key: `mailboxes/${BOX}.json`, value: { fromName: "Me at P", signature: { enabled: true, text: "- Me" } } });
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await mf.dispatchFetch(`http://localhost/api/v1/mailboxes/${BOX}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() as any };
  };
  return { mf, t, api };
}
const file = (name: string, base64 = "aGk=") => ({ content: base64, filename: name, type: "text/plain", disposition: "attachment" });

const KEY = `draft-forward/${encodeURIComponent(BOX)}/d-1.json`;
const meta = (n: number) => JSON.stringify({ v: 1, source: { accountId: "cloudflare:" + BOX, originalId: "orig-" + n, provider: "cloudflare", files: [] }, leftOut: [], attached: [] });

test("B-277: a Cloudflare draft keeps its forward's origin beside it, answers it, and loses it with the draft", async () => {
  const { mf, t, api } = await fixture();
  try {
    const made = await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Fwd: Plan", body: "<p>See</p>", expected_revision: 0, forward: meta(1) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await api("GET", "/drafts/d-1")).body.forward, meta(1));
    assert.deepEqual(await t({ op: "meta", key: KEY }), { revision: "1" });
    // An older app or an agent's update carries no meta: it stays as it was.
    assert.equal((await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Fwd: Plan", body: "<p>Edited</p>", expected_revision: 1 })).status, 200);
    assert.equal((await api("GET", "/drafts/d-1")).body.forward, meta(1));
    assert.equal((await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Fwd: Plan", body: "<p>Again</p>", expected_revision: 2, forward: meta(3) })).status, 200);
    assert.equal((await api("GET", "/drafts/d-1")).body.forward, meta(3));
    // A refused save writes nothing.
    assert.equal((await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "x", body: "<p>Stale</p>", expected_revision: 1, forward: meta(9) })).status, 409);
    assert.equal((await api("GET", "/drafts/d-1")).body.forward, meta(3));
    for (const bad of ["not json", "[1]", "x".repeat(200_001)]) {
      const r = await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "x", body: "<p>x</p>", expected_revision: 3, forward: bad });
      assert.equal(r.status, 400, bad.slice(0, 20));
    }
    assert.equal((await api("DELETE", "/drafts/d-1")).status, 204);
    assert.deepEqual(await t({ op: "r2", prefix: "draft-forward/" }), []);
    const plain = await api("PUT", "/drafts/d-2", { to: "ann@x.invalid", subject: "Hi", body: "<p>Hi</p>", expected_revision: 0 });
    assert.equal(plain.status, 201);
    assert.equal((await api("GET", "/drafts/d-2")).body.forward, null, "a draft that was never a forward answers null");
  } finally { await mf.dispose(); }
});

test("B-277: a forward draft sent goes out with nothing of its origin, and its origin goes with it", async () => {
  const { mf, t, api } = await fixture();
  try {
    assert.equal((await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Fwd: Plan", body: "<p>See</p>", expected_revision: 0, forward: meta(1) })).status, 201);
    const sent = await api("POST", "/drafts/d-1/send", { idempotencyKey: "send-1" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const out = await t({ op: "sent" });
    assert.equal(out.length, 1);
    assert.ok(!JSON.stringify(out[0]).includes("orig-1") && !JSON.stringify(out[0]).includes("draft-forward"), "the message carries no trace of the meta");
    assert.deepEqual(await t({ op: "r2", prefix: "draft-forward/" }), []);
  } finally { await mf.dispose(); }
});

test("B-277: the old replace-by-POST path takes the replaced draft's origin away", async () => {
  const { mf, t, api } = await fixture();
  try {
    assert.equal((await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Fwd", body: "<p>See</p>", expected_revision: 0, forward: meta(1) })).status, 201);
    const replaced = await api("POST", "/drafts", { to: "ann@x.invalid", subject: "Fwd", body: "<p>New</p>", draft_id: "d-1" });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    assert.deepEqual(await t({ op: "r2", prefix: "draft-forward/" }), []);
  } finally { await mf.dispose(); }
});
