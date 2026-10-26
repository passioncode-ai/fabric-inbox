import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { builtinModules } from "node:module";

/**
 * B-171 in workerd (REQ-1, REQ-2): the accounts object hands an account's new Inbox mail to the reply
 * agents' registry only when someone chose an agent for that account (R2 `accounts/<id>.json`), once
 * per message; an account without an agent, or with its agent switched off, enqueues nothing. The
 * registry is a fake that records what it was given; the run itself is tested over the fake account.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { GmailAccountsDO } from './workers/providers/accounts-do';
      export class FakeRegistry extends DurableObject {
        async enqueue(mailboxId, emailId) { await this.ctx.storage.put('q:' + mailboxId + ':' + emailId, 1); }
        async queued() { return [...(await this.ctx.storage.list({ prefix: 'q:' })).keys()].map((k) => k.slice(2)); }
      }
      export class TestAccounts extends GmailAccountsDO {
        async seed() {
          const s = this.ctx.storage;
          for (const id of ['a', 'b', 'c']) {
            await s.put('account:' + id, { id, provider: 'gmail', email: id + '@example.invalid', runtime: 'cloud', status: 'connected', createdAt: 1,
              credentials: { v: 1 }, sync: { mode: 'history', historyId: '1', generation: 'g' } });
            await s.put('pending:event:' + id + ':' + id + '0', { accountId: id, messageId: id + '0', delivered: false });
          }
          // The message as the cache answers it; its body is not what this test is about.
          this.service.getMessage = async (accountId, messageId) => ({ id: accountId + ':' + messageId, accountId, providerMessageId: messageId, threadId: messageId,
            subject: 'Hi', from: 'ann@customer.invalid', to: accountId + '@example.invalid', cc: '', date: '2026-10-26T08:00:00.000Z', rfcMessageId: '', references: '',
            timestamp: 1, snippet: '', text: 'Hello', html: '', read: false, archived: false, labels: ['INBOX'], attachments: [] });
        }
        drainNow() { return this.drain(); }
        pending() { return this.ctx.storage.list({ prefix: 'pending:event:' }).then((m) => m.size); }
      }
      export default { async fetch(request, env) {
        const accounts = env.GMAIL_ACCOUNTS.getByName('workspace');
        const path = new URL(request.url).pathname;
        if (path === '/seed') {
          await accounts.seed();
          await env.BUCKET.put('accounts/gmail:a.json', JSON.stringify({ agent: { id: 'support' } }));
          await env.BUCKET.put('accounts/gmail:c.json', JSON.stringify({ agent: 'off' }));
          return Response.json({ ok: true });
        }
        if (path === '/drain') { await accounts.drainNow(); return Response.json({ ok: true }); }
        if (path === '/again') {
          await accounts.seed();
          await accounts.drainNow();
          return Response.json({ ok: true });
        }
        return Response.json({ queued: await env.AGENT_REGISTRY.getByName('workspace').queued(), pending: await accounts.pending() });
      } };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser",
  external: ["cloudflare:*", "node:*", ...builtinModules], alias: { mimetext: "mimetext/browser" }, target: "es2022",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/');" },
});

test("REQ-1, REQ-2: an account's new mail reaches its agent only when an agent was chosen for it, once", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { GMAIL_ACCOUNTS: { className: "TestAccounts", useSQLite: true }, AGENT_REGISTRY: { className: "FakeRegistry", useSQLite: true } },
    r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  try {
    assert.equal((await mf.dispatchFetch("http://x/seed")).status, 200);
    assert.equal((await mf.dispatchFetch("http://x/drain")).status, 200);
    const first = (await (await mf.dispatchFetch("http://x/")).json()) as { queued: string[]; pending: number };
    assert.deepEqual(first.queued, ["gmail:a:a0"], "only the account with an agent; none for no settings or Off");
    assert.equal(first.pending, 0, "every event handed on");
    // The same event delivered again (a retry): the registry's queue holds it once.
    assert.equal((await mf.dispatchFetch("http://x/again")).status, 200);
    const again = (await (await mf.dispatchFetch("http://x/")).json()) as { queued: string[] };
    assert.deepEqual(again.queued, ["gmail:a:a0"]);
  } finally {
    await mf.dispose();
  }
});
