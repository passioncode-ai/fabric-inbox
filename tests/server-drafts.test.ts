import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Drafts on the server (B-52, parity gap 1), on the production code in workerd: the MailboxDO and
 * the mailbox HTTP API. A draft keeps one id, is saved in place under a revision, keeps its files in
 * R2, and is sent as it is — as a reply when it answers a message — then removed.
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
  await t({ op: "put", key: `mailboxes/${BOX}.json`, value: { fromName: "Me at P", signature: { enabled: true, text: "— Me" } } });
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await mf.dispatchFetch(`http://localhost/api/v1/mailboxes/${BOX}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() as any };
  };
  return { mf, t, api };
}
const file = (name: string, base64 = "aGk=") => ({ content: base64, filename: name, type: "text/plain", disposition: "attachment" });

test("a draft keeps its id, is saved in place, and a save from an older revision is refused (B-52)", async () => {
  const { mf, t, api } = await fixture();
  try {
    const made = await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Hi", body: "<p>One</p>", expected_revision: 0 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.revision, 1);
    const changed = await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Hi", body: "<p>Two</p>", expected_revision: 1 });
    assert.equal(changed.status, 200);
    assert.deepEqual([changed.body.id, changed.body.revision], ["d-1", 2]);
    const stale = await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", subject: "Hi", body: "<p>Lost?</p>", expected_revision: 1 });
    assert.equal(stale.status, 409);
    assert.deepEqual([stale.body.code, stale.body.revision], ["draft_conflict", 2]);
    assert.equal((await api("GET", "/drafts/d-1")).body.body, "<p>Two</p>", "the refused save changed nothing");
    const again = await api("PUT", "/drafts/d-1", { to: "ann@x.invalid", body: "<p>New window</p>", expected_revision: 0 });
    assert.equal(again.status, 409, "a second window's new draft does not overwrite a saved one");

    const list = await api("GET", "/drafts");
    assert.deepEqual(list.body.drafts.map((d: { id: string; revision: number; snippet: string }) => [d.id, d.revision, d.snippet]), [["d-1", 2, "Two"]]);

    await t({ op: "seed", folder: "inbox", row: { id: "in-1", subject: "Q", sender: "ann@x.invalid", recipient: BOX, date: "2026-10-01T00:00:00Z", body: "q" } });
    const notDraft = await api("PUT", "/drafts/in-1", { body: "x" });
    assert.deepEqual([notDraft.status, notDraft.body.code], [409, "not_a_draft"]);
    assert.equal((await api("DELETE", "/drafts/in-1")).status, 404, "an inbox message is never deleted as a draft");
    const gone = await api("PUT", "/drafts/never", { body: "x", expected_revision: 3 });
    assert.deepEqual([gone.status, gone.body.code], [409, "draft_gone"]);
    assert.equal((await api("PUT", "/drafts/bad id", { body: "x" })).status, 400);

    // A draft saved before revisions existed (the legacy route) reads as revision 1.
    const legacy = await api("POST", "/drafts", { body: "<p>old</p>", to: "bob@x.invalid" });
    const read = await api("GET", `/drafts/${legacy.body.id}`);
    assert.equal(read.body.revision, 1);
  } finally { await mf.dispose(); }
});

test("a draft's files live on the server: kept, removed, and refused over the limits with nothing left behind (B-52)", async () => {
  const { mf, t, api } = await fixture();
  try {
    const made = await api("PUT", "/drafts/d-2", { to: "ann@x.invalid", body: "files", attachments: [file("a.txt"), file("b.txt")] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.attachments.map((a: { filename: string }) => a.filename).sort(), ["a.txt", "b.txt"]);
    assert.equal((await t({ op: "r2", prefix: "attachments/d-2/" })).length, 2);
    const keep = made.body.attachments.find((a: { filename: string }) => a.filename === "a.txt").id;
    const trimmed = await api("PUT", "/drafts/d-2", { to: "ann@x.invalid", body: "files", keep_attachments: [keep], expected_revision: 1 });
    assert.deepEqual(trimmed.body.attachments.map((a: { id: string }) => a.id), [keep]);
    assert.equal((await t({ op: "r2", prefix: "attachments/d-2/" })).length, 1, "a removed file's bytes are deleted");
    const big = "A".repeat(4 * 1024 * 1024);
    const refused = await api("PUT", "/drafts/d-2", { to: "ann@x.invalid", body: "files", attachments: [file("big1.bin", big), file("big2.bin", big)], expected_revision: 2 });
    assert.equal(refused.status, 413);
    assert.equal((await t({ op: "r2", prefix: "attachments/d-2/" })).length, 1, "a refused save leaves no bytes behind");
    assert.equal((await api("DELETE", "/drafts/d-2")).status, 204);
    assert.equal((await t({ op: "r2", prefix: "attachments/d-2/" })).length, 0);
    assert.equal((await api("GET", "/drafts/d-2")).status, 404);
  } finally { await mf.dispose(); }
});

test("send a draft: as it is, as a reply in its conversation, from the display name, with its files, then removed (B-50)", async () => {
  const { mf, t, api } = await fixture();
  try {
    await t({ op: "seed", folder: "inbox", row: { id: "in-1", subject: "Order", sender: "ann@x.invalid", recipient: BOX, date: "2026-10-01T00:00:00Z", body: "where?", message_id: "orig@x.invalid", thread_id: "th-1" } });
    await api("PUT", "/drafts/d-3", { to: "ann@x.invalid", cc: "carol@x.invalid", bcc: "boss@x.invalid", subject: "Re: Order", body: "<p>Soon</p><div>— Me</div>", in_reply_to: "in-1", thread_id: "th-1", attachments: [file("a.txt")] });
    const stale = await api("POST", "/drafts/d-3/send", { idempotencyKey: "k1", expected_revision: 5 });
    assert.deepEqual([stale.status, stale.body.code], [409, "DRAFT_CONFLICT"]);
    const sent = await api("POST", "/drafts/d-3/send", { idempotencyKey: "k1", expected_revision: 1 });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.status, "accepted");
    const [mail] = await t({ op: "sent" });
    assert.deepEqual(mail.from, { email: BOX, name: "Me at P" });
    assert.equal(mail.subject, "Re: Order");
    assert.deepEqual([mail.to, mail.cc, mail.bcc].map((x: unknown) => [x].flat()), [["ann@x.invalid"], ["carol@x.invalid"], ["boss@x.invalid"]]);
    assert.equal(mail.html, "<p>Soon</p><div>— Me</div>", "sent as it is: no second signature, no added quote");
    assert.equal(mail.headers["In-Reply-To"], "<orig@x.invalid>");
    assert.deepEqual(mail.attachments.map((a: { filename: string }) => a.filename), ["a.txt"]);
    assert.equal((await api("GET", "/drafts/d-3")).status, 404, "the draft is gone once the send was accepted");
    assert.deepEqual((await t({ op: "folder", folder: "sent" })).map((e: { thread_id: string }) => e.thread_id), ["th-1"]);
    const retry = await api("POST", "/drafts/d-3/send", { idempotencyKey: "k1" });
    assert.equal(retry.status, 200, "a retry with the same key answers the first send");
    assert.equal(retry.body.id, sent.body.id);
    assert.equal((await t({ op: "sent" })).length, 1, "and sends nothing again");
    assert.equal((await api("POST", "/drafts/nope/send", { idempotencyKey: "k2" })).status, 404);
    await api("PUT", "/drafts/d-4", { body: "no recipient" });
    assert.equal((await api("POST", "/drafts/d-4/send", { idempotencyKey: "k3" })).status, 400);
  } finally { await mf.dispose(); }
});
