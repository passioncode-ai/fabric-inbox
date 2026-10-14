import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * B-114 on a Cloudflare mailbox, in workerd: each row of the feed says how many messages its
 * conversation holds — sent replies and drafts counted, Trash, Spam and Discarded not — read in one
 * query whatever the page's length (bound parameters are limited in a Durable Object's SQLite).
 */
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      const forbidden = () => { throw new Error('External calls are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, { ...env, AI: { run: forbidden }, EMAIL: { send: forbidden } }); }
        async seed(rows) {
          for (const r of rows) await this.createEmail(r.folder, { id: r.id, subject: 'Plan', sender: 'ann@x.invalid', recipient: 'support@shop.invalid',
            date: new Date(Date.UTC(2026, 9, 1, 0, r.minute)).toISOString(), body: 'hi', thread_id: r.thread }, []);
        }
      }
      const box = (env) => env.MAILBOX.get(env.MAILBOX.idFromName('support@shop.invalid'));
      export default { async fetch(request, env) {
        if (request.method === 'POST') { await box(env).seed(await request.json()); return Response.json({ ok: true }); }
        return Response.json(await box(env).listInboxMessages('support@shop.invalid', { folder: 'inbox', query: '', limit: 100 }));
      } };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

test("a Cloudflare row carries its conversation's length; a row alone carries none", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"], bindings: { DOMAINS: "shop.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  try {
    const rows = [
      { id: "a1", folder: "inbox", thread: "ta", minute: 201 }, { id: "a2", folder: "sent", thread: "ta", minute: 202 },
      { id: "a3", folder: "draft", thread: "ta", minute: 203 }, { id: "a4", folder: "trash", thread: "ta", minute: 204 },
      { id: "a5", folder: "spam", thread: "ta", minute: 205 }, { id: "b1", folder: "inbox", thread: "tb", minute: 206 },
      { id: "c1", folder: "inbox", thread: null, minute: 207 },
      // More conversations on one page than a statement may bind parameters.
      ...Array.from({ length: 120 }, (_, i) => ({ id: "m" + i, folder: "inbox", thread: "t" + (i % 60), minute: 10 + i })),
    ];
    assert.equal((await mf.dispatchFetch("http://x/", { method: "POST", body: JSON.stringify(rows) })).status, 200);
    const page = (await (await mf.dispatchFetch("http://x/")).json()) as { providerMessageId: string; threadCount?: number }[];
    const count = (id: string) => page.find((m) => m.providerMessageId === id)?.threadCount;
    assert.equal(count("a1"), 3, "received, sent and draft; not Trash or Spam");
    assert.equal(count("b1"), undefined, "a conversation of one");
    assert.equal(count("c1"), undefined, "no conversation");
    assert.equal(count("m60"), 2);
    assert.equal(count("m59"), 2);
  } finally {
    await mf.dispose();
  }
});
