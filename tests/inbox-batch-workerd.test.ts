import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { builtinModules } from "node:module";

/**
 * B-24 in workerd: the feed reads every Gmail, IMAP and Outlook account of the accounts object in
 * one call for their pages and one for their counts, through the real Durable Object's RPC; an
 * account that is not there answers its own error code and the others their mail.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { GmailAccountsDO } from './workers/providers/accounts-do';
      import { inboxSources } from './workers/lib/inbox-sources';
      export class TestAccounts extends GmailAccountsDO {
        calls = 0;
        async seed() {
          const s = this.ctx.storage;
          for (const [id, n] of [['a', 2], ['b', 1]]) {
            await s.put('account:' + id, { id, provider: 'gmail', email: id + '@example.invalid', runtime: 'cloud', status: 'connected', createdAt: 1,
              credentials: { v: 1 }, sync: { mode: 'history', historyId: '1', generation: 'g' } });
            for (let i = 0; i < n; i++) {
              const mid = id + i;
              await s.put('message:' + id + ':' + mid, { message: { id: id + ':' + mid, accountId: id, providerMessageId: mid, threadId: mid, subject: 'S ' + mid,
                from: 'x@example.invalid', to: id + '@example.invalid', cc: '', replyTo: '', date: '', rfcMessageId: '', references: '', timestamp: 1000 + i,
                snippet: '', read: i > 0, archived: false, labels: ['INBOX', ...(i > 0 ? [] : ['UNREAD'])], attachments: [] }, parts: 1, blobId: 'b' + mid, generation: 'g' });
            }
          }
        }
        inboxPages(ids, options) { this.calls++; return super.inboxPages(ids, options); }
        inboxCountsMany(ids) { this.calls++; return super.inboxCountsMany(ids); }
        listInboxMessages(id, options) { this.calls++; return super.listInboxMessages(id, options); }
        countInbox(id) { this.calls++; return super.countInbox(id); }
        rpcCalls() { return this.calls; }
      }
      const feed = (id) => ({ id: 'gmail:' + id, provider: 'gmail', email: id + '@example.invalid', name: id, status: 'connected' });
      export default { async fetch(request, env) {
        const stub = env.GMAIL_ACCOUNTS.getByName('workspace');
        if (request.method === 'POST') { await stub.seed(); return Response.json({ ok: true }); }
        const sources = inboxSources(env), accounts = ['a', 'b', 'gone'].map(feed);
        const pages = await sources.messagesMany(accounts, { folder: 'inbox', query: '', limit: 50 });
        const counts = await sources.countsMany(accounts);
        return Response.json({ pages, counts, calls: await stub.rpcCalls() });
      } };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", // The IMAP client imports Node built-ins by bare name; workerd serves them under nodejs_compat, as wrangler bundles them.
  external: ["cloudflare:*", "node:*", ...builtinModules], alias: { mimetext: "mimetext/browser" }, target: "es2022",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/');" },
});

test("one call reads every remote account's page and one their counts; a missing account is its own error (B-24)", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { GMAIL_ACCOUNTS: { className: "TestAccounts", useSQLite: true } }, r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  try {
    assert.equal((await mf.dispatchFetch("http://x/", { method: "POST" })).status, 200);
    const body = (await (await mf.dispatchFetch("http://x/")).json()) as {
      pages: Record<string, { messages?: { providerMessageId: string }[]; error?: string }>; counts: Record<string, unknown>; calls: number };
    assert.deepEqual(body.pages["gmail:a"].messages?.map((m) => m.providerMessageId), ["a1", "a0"]);
    assert.deepEqual(body.pages["gmail:b"].messages?.map((m) => m.providerMessageId), ["b0"]);
    assert.deepEqual(body.pages["gmail:gone"], { error: "account_not_found" });
    assert.deepEqual(body.counts, { "gmail:a": { unread: 1, total: 2 }, "gmail:b": { unread: 1, total: 1 }, "gmail:gone": { error: "account_not_found" } });
    // Two RPCs from the Worker for three accounts: the object's per-account methods are never called over RPC.
    assert.equal(body.calls, 2);
  } finally {
    await mf.dispose();
  }
});
