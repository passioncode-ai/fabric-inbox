import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { inScope, matchesConditions, kindOf, CategoryInputSchema } from "../workers/categories/definition";

/**
 * Categories (CAT-1..CAT-5) in workerd: real MailboxDOs and CategoriesDO, mail
 * delivered through receiveEmail, the feed read through /api/inbox. The model is
 * scripted: it places a message in a category when the category's description
 * names a word the message contains, and counts its calls.
 */

test("scope: all, accounts, domains (with subdomains) and projects; conditions need every group", () => {
  const acct = (id: string, email: string) => ({ id, email });
  const acme = { id: "acme", name: "Acme", domains: ["acme.invalid"], addresses: ["founder@gmail.invalid"], createdAt: "", updatedAt: "" };
  const s = (x: object) => CategoryInputSchema.parse({ name: "x", scope: x }).scope;
  assert.equal(inScope(s({ all: true }), acct("cloudflare:a@b.invalid", "a@b.invalid"), []), true);
  assert.equal(inScope(s({ domains: ["acme.invalid"] }), acct("cloudflare:x@mail.acme.invalid", "x@mail.acme.invalid"), []), true);
  assert.equal(inScope(s({ projects: ["acme"] }), acct("gmail:1", "founder@gmail.invalid"), [acme]), true, "a project's address");
  assert.equal(inScope(s({ projects: ["acme"] }), acct("gmail:2", "other@gmail.invalid"), [acme]), false);
  assert.throws(() => CategoryInputSchema.parse({ name: "x", scope: {} }), /Choose where to look/);
  const c = { senders: ["@payments.invalid"], subjectWords: ["refund"], textWords: [] };
  assert.equal(matchesConditions(c, { sender: "Stripe <billing@mail.payments.invalid>", subject: "Refund issued", text: "" }).ok, true);
  assert.equal(matchesConditions(c, { sender: "billing@payments.invalid", subject: "Invoice", text: "refund" }).ok, false, "subject words look in the subject");
  assert.equal(kindOf({ description: "", conditions: { senders: [], subjectWords: [], textWords: [] } }), "scope");
});

const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { MailboxDO } from './workers/durableObject/index';
      import { CategoriesDO } from './workers/categories/store';
      import { categoriesRouter } from './workers/routes/categories';
      import { inboxRouter } from './workers/routes/inbox';
      import { receiveEmail } from './workers/index';
      import { MockLanguageModelV3 } from 'ai/test';
      const forbidden = () => { throw new Error('External AI is forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send: forbidden}}); }
        async trash(id) { return this.moveEmail ? this.moveEmail(id, 'trash') : null; }
      }
      export class TestCategories extends CategoriesDO {
        calls = 0;
        async callCount() { return this.calls; }
        model() {
          const env = this.env;
          return new MockLanguageModelV3({ doGenerate: async (options) => {
            this.calls++;
            if (env.MODEL_DOWN === '1') throw new Error('model down');
            const text = JSON.stringify(options.prompt);
            const input = JSON.parse(text.match(/\\{\\\\"categories[\\s\\S]*?\\\\"}}/)?.[0].replace(/\\\\"/g, '"') || '{}');
            const email = (input.email?.subject + ' ' + input.email?.text).toLowerCase();
            const results = (input.categories || []).map((c) => {
              const word = c.description.match(/about (\\w+)/)?.[1]?.toLowerCase() || '';
              return { id: c.id, match: !!word && email.includes(word), reason: word && email.includes(word) ? 'mentions ' + word : 'unrelated' };
            });
            return { content: [{ type: 'text', text: JSON.stringify({ results }) }], finishReason: { unified: 'stop', raw: 'stop' },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
          }});
        }
        async pump() { for (let i = 0; i < 20; i++) { await this.alarm(); const n = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM queue WHERE next_at <= ?', Date.now()).one().n; if (!n) break; } }
        async queueRows() { return this.ctx.storage.sql.exec('SELECT account_id, message_id, target, attempts, last_error FROM queue').toArray(); }
      }
      const app = new Hono();
      app.post('/mailbox', async (c) => { const b = await c.req.json(); await c.env.BUCKET.put('mailboxes/' + b.email + '.json', JSON.stringify({ agent: 'off' })); return c.json({ ok: true }); });
      app.post('/receive', async (c) => {
        const m = await c.req.json();
        const bytes = new TextEncoder().encode(m.raw);
        await receiveEmail({ to: m.to, from: 'x@outside.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject: () => {}, forward: async () => {} }, c.env, c.executionCtx);
        return c.json({ ok: true });
      });
      app.post('/allow', async (c) => { const b = await c.req.json(); await c.env.BUCKET.put('config/spam.json', JSON.stringify({ allowedDomains: b.domains })); return c.json({ ok: true }); });
      app.post('/pump', async (c) => { await c.env.CATEGORIES.getByName('workspace').pump(); return c.json({ ok: true }); });
      app.get('/queue', async (c) => c.json(await c.env.CATEGORIES.getByName('workspace').queueRows()));
      app.get('/calls', async (c) => c.json(await c.env.CATEGORIES.getByName('workspace').callCount()));
      app.post('/trash', async (c) => { const b = await c.req.json(); const box = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(b.mailbox)); await box.deleteEmail(b.id); return c.json({ ok: true }); });
      app.route('/', categoriesRouter);
      app.route('/', inboxRouter);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture(bindings: Record<string, string> = {}) {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true }, CATEGORIES: { className: "TestCategories", useSQLite: true } },
    r2Buckets: ["BUCKET"], bindings: { DOMAINS: "acme.invalid other.invalid", ...bindings },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await mf.dispatchFetch("http://localhost" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  for (const email of ["support@acme.invalid", "sales@acme.invalid", "hi@other.invalid"]) await call("/mailbox", "POST", { email });
  // These tests are about categories: the senders are allowed, so the spam model (SP-2,
  // tests/spam-workerd.test.ts) does not read their mail and the call counts stay the categories' own.
  await call("/allow", "POST", { domains: ["customer.invalid", "people.test", "payments.invalid"] });
  let n = 0;
  const receive = (to: string, subject: string, body: string, from = "Ann <ann@customer.invalid>") =>
    call("/receive", "POST", { to, raw: `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <m${++n}-${Date.now()}@customer.invalid>\r\nDate: ${new Date(Date.now() - (100 - n) * 60_000).toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n` });
  return { mf, call, receive };
}

test("a described category classifies the last messages in scope, lists them with why, and raises them in Focus", async () => {
  const { mf, call, receive } = await fixture();
  try {
    await receive("support@acme.invalid", "Please refund my order", "I want a refund for order 42.");
    await receive("sales@acme.invalid", "Partnership", "Let us talk about a partnership.");
    await receive("hi@other.invalid", "Refund?", "Can I get my money back? refund please");
    const made = await call("/api/categories", "POST", { name: "Refunds", description: "Messages about refund requests", scope: { all: true }, promote: true });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.kind, "screened");
    await call("/pump", "POST");
    const view = await call("/api/inbox?category=refunds");
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.deepEqual(view.body.messages.map((m: any) => m.subject).sort(), ["Please refund my order", "Refund?"]);
    assert.ok(view.body.messages.every((m: any) => m.categoryReason === "mentions refund"));
    assert.equal(Number((await call("/calls")).body), 3, "one model call per message, no more");
    const listed = (await call("/api/categories")).body.categories[0];
    assert.deepEqual([listed.stats.matched, listed.stats.classified, listed.stats.backfill.state, listed.stats.backfill.done], [2, 3, "done", 3]);

    const feed = (await call("/api/inbox")).body.messages;
    const refund = feed.find((m: any) => m.subject === "Please refund my order");
    assert.equal(refund.triage.importance, "important");
    assert.equal(refund.triage.reasons[0], "Category: Refunds");
    assert.deepEqual(refund.categories.map((x: any) => x.name), ["Refunds"]);
    assert.equal(feed.find((m: any) => m.subject === "Partnership").categories, undefined);

    await receive("sales@acme.invalid", "Another refund", "refund for invoice 7");
    await call("/pump", "POST");
    const after = (await call("/api/inbox?category=refunds")).body.messages;
    assert.equal(after.length, 3, "new mail after creation is classified too");
    assert.equal((await call("/api/categories")).body.categories[0].stats.fresh, 3, "unseen matches count as new");
    await call("/api/categories/refunds/seen", "POST");
    assert.equal((await call("/api/categories")).body.categories[0].stats.fresh, 0);
  } finally { await mf.dispose(); }
});

test("a project scope category is the live feed of its inboxes; a project in use cannot be deleted", async () => {
  const { mf, call, receive } = await fixture();
  try {
    await receive("support@acme.invalid", "Question", "hi");
    await receive("hi@other.invalid", "Other", "hi");
    const project = await call("/api/projects", "POST", { name: "Acme", domains: ["acme.invalid"] });
    assert.equal(project.status, 201);
    const cat = await call("/api/categories", "POST", { name: "Acme", scope: { projects: [project.body.id] } });
    assert.equal(cat.body.kind, "scope");
    const view = (await call(`/api/inbox?category=${cat.body.id}`)).body;
    assert.deepEqual(view.messages.map((m: any) => m.accountId), ["cloudflare:support@acme.invalid"]);
    const listed = (await call("/api/categories")).body.categories[0];
    assert.deepEqual(listed.accountIds.sort(), ["cloudflare:sales@acme.invalid", "cloudflare:support@acme.invalid"]);
    assert.equal((await call("/calls")).body, 0, "a scope category never calls the model");
    const del = await call(`/api/projects/${project.body.id}`, "DELETE");
    assert.equal(del.status, 409);
    assert.match(del.body.error, /Used by Acme/);
    assert.equal((await call("/api/categories", "POST", { name: "Ghost", scope: { projects: ["nope"] } })).status, 400);
  } finally { await mf.dispose(); }
});

test("plain conditions decide without the model; a change starts over; a trashed message leaves the view", async () => {
  const { mf, call, receive } = await fixture();
  try {
    await receive("support@acme.invalid", "Invoice paid", "thanks", "Stripe <billing@payments.invalid>");
    await receive("support@acme.invalid", "Invoice from a person", "hi", "Bob <bob@people.test>");
    const cat = await call("/api/categories", "POST", { name: "Stripe", scope: { domains: ["acme.invalid"] }, conditions: { senders: ["@payments.invalid"] } });
    await call("/pump", "POST");
    let view = (await call("/api/inbox?category=stripe")).body.messages;
    assert.deepEqual(view.map((m: any) => m.subject), ["Invoice paid"]);
    assert.match(view[0].categoryReason, /from @payments\.invalid/);
    assert.equal((await call("/calls")).body, 0);

    const changed = await call("/api/categories/stripe", "PUT", { name: "Stripe", scope: { domains: ["acme.invalid"] }, conditions: { senders: ["@people.test"] } });
    assert.equal(changed.body.version, 2);
    await call("/pump", "POST");
    view = (await call("/api/inbox?category=stripe")).body.messages;
    assert.deepEqual(view.map((m: any) => m.subject), ["Invoice from a person"], "old verdicts are dropped with the old version");
    const renamed = await call("/api/categories/stripe", "PUT", { name: "People mail", scope: { domains: ["acme.invalid"] }, conditions: { senders: ["@people.test"] } });
    assert.equal(renamed.body.version, 2, "a rename alone does not start over");

    await call("/trash", "POST", { mailbox: "support@acme.invalid", id: view[0].providerMessageId });
    assert.deepEqual((await call("/api/inbox?category=stripe")).body.messages, []);
    assert.equal((await call("/api/categories")).body.categories[0].stats.matched, 0, "the verdict of a removed message is forgotten");
    void cat;
  } finally { await mf.dispose(); }
});

test("the daily model budget holds messages for the next day; a model that is down is retried, not dropped", async () => {
  const limited = await fixture({ CATEGORY_DAILY_LIMIT: "1" });
  try {
    await limited.receive("support@acme.invalid", "refund one", "refund");
    await limited.receive("support@acme.invalid", "refund two", "refund");
    await limited.call("/api/categories", "POST", { name: "Refunds", description: "about refund", scope: { all: true } });
    await limited.call("/pump", "POST");
    const stats = (await limited.call("/api/categories")).body.categories[0].stats;
    assert.deepEqual([stats.classified, stats.waitingBudget], [1, 1]);
    assert.match(stats.backfill.detail, /1 wait for tomorrow's model budget/);
  } finally { await limited.mf.dispose(); }

  const down = await fixture({ MODEL_DOWN: "1" });
  try {
    await down.receive("support@acme.invalid", "refund", "refund");
    await down.call("/api/categories", "POST", { name: "Refunds", description: "about refund", scope: { all: true } });
    await down.call("/pump", "POST");
    const rows = (await down.call("/queue")).body;
    assert.equal(rows.length, 1, "the message stays queued");
    assert.equal(rows[0].attempts, 1);
    assert.match(rows[0].last_error, /model down/);
    assert.equal((await down.call("/api/categories")).body.categories[0].stats.pending, 1);
  } finally { await down.mf.dispose(); }
});
