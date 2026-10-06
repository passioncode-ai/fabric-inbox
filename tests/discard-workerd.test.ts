import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Discarded on Cloudflare mailboxes, in workerd (operator, 2026-10-06): real MailboxDOs, mail
 * delivered through receiveEmail, the feed through /api/inbox and the actions through /api/discard.
 * A discard moves the message to Discarded read and learns a rule at once; new mail that matches it
 * goes straight to Discarded on arrival — no copy, no agent, no rule, no category — unless the mailbox
 * wrote to the sender, took part in the conversation, or the sender is allowed; restore brings it
 * back and Undo forgets what the discard taught; 30 days later Discarded mail is deleted.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { DurableObject } from 'cloudflare:workers';
      import { MailboxDO } from './workers/durableObject/index';
      import { inboxRouter } from './workers/routes/inbox';
      import { discardRouter } from './workers/routes/discard';
      import { receiveEmail } from './workers/index';
      import { applyMigrations, mailboxMigrations } from './workers/durableObject/migrations';
      const forbidden = () => { throw new Error('External AI is forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send: forbidden}}); }
        async row(id) { return this.ctx.storage.sql.exec('SELECT folder_id, read, discard_reason, discarded_at FROM emails WHERE id = ?', id).toArray()[0] ?? null; }
        async sent(to, threadId) { await this.createEmail('sent', { id: 'sent-' + to + (threadId || ''), subject: 'Hello', sender: 'support@shop.invalid', recipient: to, date: new Date().toISOString(), body: 'hi', thread_id: threadId || null }, []); }
        async backdateDiscarded(days) { this.ctx.storage.sql.exec("UPDATE emails SET discarded_at = ? WHERE folder_id = 'discarded'", new Date(Date.now() - days * 86400000).toISOString()); }
        async folders() { return this.ctx.storage.sql.exec('SELECT id, name FROM folders ORDER BY id').toArray(); }
      }
      export class TestAgents extends DurableObject {
        async enqueue(mailboxId, emailId) { const seen = (await this.ctx.storage.get('seen')) || []; await this.ctx.storage.put('seen', [...seen, emailId]); }
        async seen() { return (await this.ctx.storage.get('seen')) || []; }
      }
      export class LegacyFolders extends DurableObject {
        async run() {
          const sql = this.ctx.storage.sql;
          // A mailbox before 0.12 whose person made a folder named Discarded of their own.
          applyMigrations(sql, mailboxMigrations.slice(0, 16), this.ctx.storage);
          sql.exec("INSERT INTO folders (id, name, is_deletable) VALUES ('mine', 'Discarded', 1)");
          applyMigrations(sql, mailboxMigrations, this.ctx.storage);
          return sql.exec('SELECT id, name FROM folders ORDER BY id').toArray();
        }
      }
      const app = new Hono();
      const box = (env) => env.MAILBOX.get(env.MAILBOX.idFromName('support@shop.invalid'));
      app.post('/mailbox', async (c) => { await c.env.BUCKET.put('mailboxes/support@shop.invalid.json', JSON.stringify({ agent: 'off', forwarding: { enabled: true, email: 'copy@gmail.invalid' } })); return c.json({ ok: true }); });
      app.post('/receive', async (c) => {
        const m = await c.req.json();
        const bytes = new TextEncoder().encode(m.raw);
        const forwards = [];
        const out = await receiveEmail({ to: 'support@shop.invalid', from: 'x@outside.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject: () => {}, forward: async (to) => { forwards.push(to); } }, c.env, c.executionCtx);
        return c.json({ ...out, forwards });
      });
      app.get('/agents', async (c) => c.json(await c.env.AGENT_REGISTRY.getByName('workspace').seen()));
      app.post('/row', async (c) => c.json(await box(c.env).row((await c.req.json()).id)));
      app.post('/sent', async (c) => { const b = await c.req.json(); await box(c.env).sent(b.to, b.threadId); return c.json({ ok: true }); });
      app.post('/backdate', async (c) => { await box(c.env).backdateDiscarded((await c.req.json()).days); return c.json({ ok: true }); });
      app.post('/purge', async (c) => c.json(await box(c.env).purgeDiscarded({})));
      app.get('/folders', async (c) => c.json(await box(c.env).folders()));
      app.get('/legacy', async (c) => c.json(await c.env.LEGACY.getByName('x').run()));
      app.get('/store', async (c) => { const o = await c.env.BUCKET.get('config/discard.json'); return c.json(o ? await o.json() : null); });
      app.get('/r2', async (c) => c.json((await c.env.BUCKET.list({ prefix: 'attachments/' })).objects.map((o) => o.key)));
      app.route('/', inboxRouter);
      app.route('/', discardRouter);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

const NEWS = "List-Id: Weekly Digest <weekly.news.example.org>\r\nList-Unsubscribe: <https://news.example.org/u>\r\n";

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true }, AGENT_REGISTRY: { className: "TestAgents", useSQLite: true }, LEGACY: { className: "LegacyFolders", useSQLite: true } },
    r2Buckets: ["BUCKET"], bindings: { DOMAINS: "shop.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await mf.dispatchFetch("http://localhost" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  await call("/mailbox", "POST");
  let n = 0;
  const receive = async (subject: string, opts: { from?: string; headers?: string; refs?: string } = {}) => {
    const id = `m${++n}-${Date.now()}`;
    const out = await call("/receive", "POST", {
      raw: `${opts.headers ?? ""}From: ${opts.from ?? "digest@news.example.org"}\r\nTo: support@shop.invalid\r\nSubject: ${subject}\r\nMessage-ID: <${id}@news.example.org>\r\n` +
        `${opts.refs ? `In-Reply-To: <${opts.refs}>\r\nReferences: <${opts.refs}>\r\n` : ""}Date: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nHello, ${subject}\r\n`,
    });
    return out.body as { emailId: string; discarded?: string; forwards: string[] };
  };
  const ref = (emailId: string) => ({ accountId: "cloudflare:support@shop.invalid", providerMessageId: emailId });
  const feed = async (folder = "inbox") => (await call(`/api/inbox?folder=${folder}&limit=50`)).body as { messages: any[]; accounts: any[] };
  return { mf, call, receive, ref, feed };
}

test("discarding moves a message to Discarded read, learns its list at once, and later mail from the list never reaches the inbox", async () => {
  const { mf, call, receive, ref, feed } = await fixture();
  try {
    const first = await receive("Digest #1", { headers: NEWS });
    assert.deepEqual(first.forwards, ["copy@gmail.invalid"], "before any rule, mail arrives as always");
    const discarded = await call("/api/discard", "POST", { messages: [ref(first.emailId)] });
    assert.equal(discarded.status, 200);
    assert.equal(discarded.body.moved, 1);
    assert.deepEqual(discarded.body.results[0], { ...ref(first.emailId), id: first.emailId, from: "inbox", unread: true });
    assert.deepEqual(discarded.body.learned.map((l: any) => [l.kind, l.label, l.created, l.discards]), [["list", "Weekly Digest", true, 1]], "learned at once, said once");
    const row = (await call("/row", "POST", { id: first.emailId })).body;
    assert.equal(row.folder_id, "discarded");
    assert.equal(row.read, 1);
    assert.equal(row.discard_reason, "You discarded it");
    assert.ok(row.discarded_at);
    const inbox = await feed("inbox");
    assert.deepEqual(inbox.messages, []);
    assert.equal(inbox.accounts.find((a: any) => a.id === "cloudflare:support@shop.invalid").unread, 0, "out of the counts");
    assert.deepEqual((await feed("discarded")).messages.map((m) => [m.subject, m.discardReason]), [["Digest #1", "You discarded it"]]);
    const stored = (await call("/store")).body;
    assert.equal(stored.rules[0].why.newsletter, true);
    assert.equal(stored.rules[0].why.domain, "news.example.org");

    // The next issue, from another address of the same list: straight to Discarded.
    const second = await receive("Digest #2", { from: "issue2@mailer.example.net", headers: NEWS });
    assert.equal(second.discarded, "Discarded automatically: you discarded 1 message from this newsletter (Weekly Digest)");
    assert.deepEqual(second.forwards, [], "no copy is forwarded: discarded counts as deleted");
    assert.deepEqual((await call("/agents")).body, [first.emailId], "no agent saw the discarded issue");
    assert.equal((await call("/row", "POST", { id: second.emailId })).body.folder_id, "discarded");
    assert.equal((await call("/store")).body.rules[0].applied, 1, "the rule counts what it took");
    assert.deepEqual((await feed("discarded")).messages.map((m) => m.discardReason).sort(),
      ["Discarded automatically: you discarded 1 message from this newsletter (Weekly Digest)", "You discarded it"]);
    // Searchable within Discarded.
    assert.deepEqual((await call("/api/inbox?folder=discarded&query=%232&limit=50")).body.messages.map((m: any) => m.subject), ["Digest #2"]);
  } finally { await mf.dispose(); }
});

test("a rule never takes mail from someone the mailbox wrote to, a reply in a conversation it took part in, or an allowed sender", async () => {
  const { mf, call, receive, ref } = await fixture();
  try {
    const bob = await receive("Hi from Bob", { from: "bob@shop-partner.example" });
    await call("/api/discard", "POST", { messages: [ref(bob.emailId)] });
    // Written to since: Bob's mail arrives.
    await call("/sent", "POST", { to: "bob@shop-partner.example" });
    assert.equal((await receive("Bob again", { from: "bob@shop-partner.example" })).discarded, undefined);
    // A list in a conversation the mailbox answered.
    const issue = await receive("Thread start", { headers: NEWS });
    await call("/api/discard", "POST", { messages: [ref(issue.emailId)] });
    const startId = "start@news.example.org";
    await call("/sent", "POST", { to: "other@x.example", threadId: startId });
    assert.equal((await receive("Re: our talk", { headers: NEWS, refs: startId })).discarded, undefined, "a reply in a thread we took part in");
    assert.match((await receive("Next issue", { headers: NEWS })).discarded ?? "", /Discarded automatically/);
    // Always allow wins over the rule.
    const allowed = await call("/api/discard/allowed", "POST", { value: "news.example.org", action: "add" });
    assert.deepEqual(allowed.body.allowed, ["news.example.org"]);
    assert.equal((await receive("Allowed issue", { headers: NEWS })).discarded, undefined);
    assert.equal((await call("/api/discard/allowed", "POST", { value: "not an entry", action: "add" })).status, 400);
  } finally { await mf.dispose(); }
});

test("Not discarded brings a message back and names the rule to stop; Undo forgets what its discard taught", async () => {
  const { mf, call, receive, ref, feed } = await fixture();
  try {
    const a = await receive("Promo", { from: "deals@shop-deals.example" });
    await call("/api/discard", "POST", { messages: [ref(a.emailId)] });
    const back = await call("/api/discard/restore", "POST", { messages: [ref(a.emailId)] });
    assert.equal(back.body.moved, 1);
    assert.deepEqual(back.body.rules.map((r: any) => r.label), ["deals@shop-deals.example"], "the rule that would discard it again");
    assert.equal((await call("/row", "POST", { id: a.emailId })).body.folder_id, "inbox");
    // Stop discarding mail like this.
    const ruleId = back.body.rules[0].ruleId;
    assert.equal((await call(`/api/discard/rules/${ruleId}`, "DELETE")).status, 200);
    assert.equal((await call(`/api/discard/rules/${ruleId}`, "DELETE")).status, 404);
    assert.equal((await call("/api/discard/rules/nope", "DELETE")).status, 400);
    // Undo: discard then restore with unlearn, unread again.
    const b = await receive("Another promo", { from: "deals@shop-deals.example" });
    const d = await call("/api/discard", "POST", { messages: [ref(b.emailId)] });
    assert.equal(d.body.learned[0].created, true);
    const undo = await call("/api/discard/restore", "POST", { messages: [ref(b.emailId)], read: false, unlearn: true });
    assert.deepEqual(undo.body.rules, [], "the rule its discard made is gone");
    assert.equal((await call("/api/discard/rules")).body.rules.length, 0);
    assert.equal((await call("/row", "POST", { id: b.emailId })).body.read, 0, "unread again");
    assert.deepEqual((await feed("inbox")).messages.map((m) => m.subject).sort(), ["Another promo", "Promo"]);
    // Nothing to restore: said, not pretended.
    const none = await call("/api/discard/restore", "POST", { messages: [ref(b.emailId)] });
    assert.equal(none.status, 502);
    assert.equal(none.body.error, "It is no longer in Discarded");
    assert.equal((await call("/api/discard", "POST", { messages: [] })).status, 400);
  } finally { await mf.dispose(); }
});

test("sent mail cannot be discarded; learning can be left out; the rules list says how long Discarded keeps mail", async () => {
  const { mf, call, receive, ref } = await fixture();
  try {
    await call("/sent", "POST", { to: "x@y.example" });
    const sent = await call("/api/discard", "POST", { messages: [ref("sent-x@y.example")] });
    assert.equal(sent.status, 502);
    assert.equal(sent.body.failed[0].error, "It is sent mail or a draft");
    const m = await receive("Quiet", { from: "noreply@quiet.example" });
    const quiet = await call("/api/discard", "POST", { messages: [ref(m.emailId)], learn: false });
    assert.equal(quiet.body.moved, 1);
    assert.deepEqual(quiet.body.learned, []);
    const rules = (await call("/api/discard/rules")).body;
    assert.deepEqual(rules, { rules: [], allowed: [], retentionDays: 30 });
  } finally { await mf.dispose(); }
});

test("Discarded mail is deleted 30 days after it was discarded; a folder the person named Discarded keeps its mail under a new name", async () => {
  const { mf, call, receive, ref } = await fixture();
  try {
    const m = await receive("Old digest", { headers: NEWS });
    await call("/api/discard", "POST", { messages: [ref(m.emailId)] });
    assert.equal((await call("/purge", "POST")).body, 0, "younger than 30 days: kept");
    await call("/backdate", "POST", { days: 31 });
    assert.equal((await call("/purge", "POST")).body, 1);
    assert.equal((await call("/row", "POST", { id: m.emailId })).body, null);
    assert.ok((await call("/folders")).body.some((f: any) => f.id === "discarded" && f.name === "Discarded"));
    assert.deepEqual((await call("/legacy")).body.filter((f: any) => f.id === "mine" || f.id === "discarded"),
      [{ id: "discarded", name: "Discarded" }, { id: "mine", name: "Discarded (your folder)" }]);
  } finally { await mf.dispose(); }
});
