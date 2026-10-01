import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Spam (SP-1…SP-6) in workerd: real MailboxDOs and CategoriesDO, mail delivered
 * through receiveEmail with Cloudflare's Authentication-Results, the feed read
 * through /api/inbox, the actions through /api/spam. The model is scripted: spam
 * when the message offers "SEO services". Agents are a recorder of what reached them.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { DurableObject } from 'cloudflare:workers';
      import { MailboxDO } from './workers/durableObject/index';
      import { CategoriesDO } from './workers/categories/store';
      import { inboxRouter } from './workers/routes/inbox';
      import { spamRouter } from './workers/routes/spam';
      import { receiveEmail } from './workers/index';
      import { updateSpamLists } from './workers/spam/lists';
      import { MockLanguageModelV3 } from 'ai/test';
      const forbidden = () => { throw new Error('External AI is forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send: forbidden}}); }
        async folderOf(id) { return this.ctx.storage.sql.exec('SELECT folder_id, spam_reason FROM emails WHERE id = ?', id).toArray()[0] ?? null; }
        async sent(to) { await this.createEmail('sent', { id: 'sent-' + to, subject: 'Hello', sender: this.ctx.id.name ?? 'me', recipient: to, date: new Date().toISOString(), body: 'hi' }, []); }
        async ids() { return this.ctx.storage.sql.exec('SELECT id, folder_id FROM emails ORDER BY date').toArray(); }
        async backdate(days) { this.ctx.storage.sql.exec("UPDATE emails SET date = ? WHERE folder_id = 'spam'", new Date(Date.now() - days * 86400000).toISOString()); }
        async backdateSpamAt(days) { this.ctx.storage.sql.exec("UPDATE emails SET spam_at = ? WHERE folder_id = 'spam'", new Date(Date.now() - days * 86400000).toISOString()); }
        async backdateAll(days) { this.ctx.storage.sql.exec("UPDATE emails SET date = ?", new Date(Date.now() - days * 86400000).toISOString()); }
      }
      export class TestAgents extends DurableObject {
        async enqueue(mailboxId, emailId, options = {}) {
          const seen = (await this.ctx.storage.get('seen')) || []; await this.ctx.storage.put('seen', [...seen, emailId]);
          if (options.holdMs) await this.ctx.storage.put('held:' + emailId, options.holdMs);
        }
        async release(mailboxId, emailId) { await this.ctx.storage.put('released:' + emailId, true); }
        async seen() { return (await this.ctx.storage.get('seen')) || []; }
        async holds() { const out = {}; for (const [k, v] of await this.ctx.storage.list()) if (k.startsWith('held:') || k.startsWith('released:')) out[k] = v; return out; }
      }
      export class TestCategories extends CategoriesDO {
        calls = 0;
        async callCount() { return this.calls; }
        model() {
          return new MockLanguageModelV3({ doGenerate: async (options) => {
            this.calls++;
            const text = JSON.stringify(options.prompt);
            const input = JSON.parse(text.match(/\\{\\\\"categories[\\s\\S]*?\\\\"}}/)?.[0].replace(/\\\\"/g, '"') || '{}');
            const email = (input.email?.subject + ' ' + input.email?.text).toLowerCase();
            const results = (input.categories || []).map((c) => ({ id: c.id, match: c.id === '__spam' && email.includes('seo services'),
              reason: email.includes('seo services') ? 'Unsolicited SEO outreach from a stranger' : 'A person with a real question' }));
            return { content: [{ type: 'text', text: JSON.stringify({ results }) }], finishReason: { unified: 'stop', raw: 'stop' },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
          }});
        }
        async pump() { for (let i = 0; i < 20; i++) { await this.alarm(); const n = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM queue WHERE next_at <= ?', Date.now()).one().n; if (!n) break; } }
        async checks() { return this.ctx.storage.sql.exec('SELECT message_id, verdict, reason FROM spam_checks').toArray(); }
      }
      const app = new Hono();
      const box = (env, m) => env.MAILBOX.get(env.MAILBOX.idFromName(m));
      app.post('/mailbox', async (c) => { const b = await c.req.json(); await c.env.BUCKET.put('mailboxes/' + b.email + '.json', JSON.stringify({ agent: 'off', forwarding: { enabled: true, email: 'copy@gmail.invalid' } })); return c.json({ ok: true }); });
      app.post('/receive', async (c) => {
        const m = await c.req.json();
        const bytes = new TextEncoder().encode(m.raw);
        const forwards = [];
        const out = await receiveEmail({ to: m.to, from: 'x@outside.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject: () => {}, forward: async (to) => { forwards.push(to); } }, c.env, c.executionCtx);
        return c.json({ ...out, forwards });
      });
      app.post('/pump', async (c) => { await c.env.CATEGORIES.getByName('workspace').pump(); return c.json({ ok: true }); });
      app.get('/calls', async (c) => c.json(await c.env.CATEGORIES.getByName('workspace').callCount()));
      app.get('/checks', async (c) => c.json(await c.env.CATEGORIES.getByName('workspace').checks()));
      app.get('/agents', async (c) => c.json(await c.env.AGENT_REGISTRY.getByName('workspace').seen()));
      app.get('/holds', async (c) => c.json(await c.env.AGENT_REGISTRY.getByName('workspace').holds()));
      app.post('/folder', async (c) => { const b = await c.req.json(); return c.json(await box(c.env, b.mailbox).folderOf(b.id)); });
      app.post('/sent', async (c) => { const b = await c.req.json(); await box(c.env, b.mailbox).sent(b.to); return c.json({ ok: true }); });
      app.post('/ids', async (c) => { const b = await c.req.json(); return c.json(await box(c.env, b.mailbox).ids()); });
      app.post('/backdate', async (c) => { const b = await c.req.json(); await box(c.env, b.mailbox).backdate(b.days); return c.json({ ok: true }); });
      app.post('/backdate-spam-at', async (c) => { const b = await c.req.json(); await box(c.env, b.mailbox).backdateSpamAt(b.days); return c.json({ ok: true }); });
      app.post('/backdate-all', async (c) => { const b = await c.req.json(); await box(c.env, b.mailbox).backdateAll(b.days); return c.json({ ok: true }); });
      app.post('/purge', async (c) => { const b = await c.req.json(); return c.json(await box(c.env, b.mailbox).purgeSpam({})); });
      app.post('/lists-race', async (c) => {
        await Promise.all(['a@x.invalid', 'b@x.invalid', 'c@x.invalid'].map((v) => updateSpamLists(c.env.BUCKET, (l) => ({ ...l, blockedSenders: [...l.blockedSenders, v] }))));
        return c.json(JSON.parse(await (await c.env.BUCKET.get('config/spam.json')).text()));
      });
      app.get('/r2', async (c) => c.json((await c.env.BUCKET.list({ prefix: 'attachments/' })).objects.map((o) => o.key)));
      app.route('/', inboxRouter);
      app.route('/', spamRouter);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

const PASS = (d: string) => `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${d}; dmarc=pass header.from=${d} policy.dmarc=reject; spf=pass\r\n`;
const FORGED = (d: string) => `Authentication-Results: mx.cloudflare.net; dkim=none; dmarc=fail header.from=${d} policy.dmarc=reject; spf=fail\r\n`;

async function fixture(bindings: Record<string, string> = {}) {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      MAILBOX: { className: "TestMailbox", useSQLite: true },
      CATEGORIES: { className: "TestCategories", useSQLite: true },
      AGENT_REGISTRY: { className: "TestAgents", useSQLite: true },
    },
    r2Buckets: ["BUCKET"], bindings: { DOMAINS: "shop.invalid", ...bindings },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await mf.dispatchFetch("http://localhost" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  await call("/mailbox", "POST", { email: "support@shop.invalid" });
  let n = 0;
  const receive = async (subject: string, opts: { from?: string; headers?: string; body?: string; attachment?: boolean } = {}) => {
    const from = opts.from ?? "ann@customer.invalid";
    const id = `m${++n}-${Date.now()}`;
    const bodyPart = opts.attachment
      ? `Content-Type: multipart/mixed; boundary=b1\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\n${opts.body ?? "Hello"}\r\n--b1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0x\r\n--b1--\r\n`
      : `Content-Type: text/plain\r\n\r\n${opts.body ?? "Hello, a question about my order."}\r\n`;
    const out = await call("/receive", "POST", { to: "support@shop.invalid",
      raw: `${opts.headers ?? ""}From: ${from}\r\nTo: support@shop.invalid\r\nSubject: ${subject}\r\nMessage-ID: <${id}@customer.invalid>\r\nDate: ${new Date().toUTCString()}\r\n${bodyPart}` });
    return out.body as { emailId: string; spam?: string; forwards: string[] };
  };
  const feed = async (folder = "inbox") => (await call(`/api/inbox?folder=${folder}&limit=50`)).body.messages as any[];
  return { mf, call, receive, feed };
}

test("a forged message goes to Spam on arrival with its reason: no copy, no agent, no category, not in the inbox (SP-1, SP-4)", async () => {
  const { mf, call, receive, feed } = await fixture();
  try {
    const forged = await receive("Your account is locked", { from: "security@payments.invalid", headers: FORGED("payments.invalid") });
    assert.match(forged.spam ?? "", /DMARC for payments\.invalid/);
    assert.deepEqual(forged.forwards, [], "spam is not sent on as a copy");
    const own = await receive("Wire the money today", { from: "ceo@shop.invalid", headers: FORGED("shop.invalid") });
    assert.match(own.spam ?? "", /your domain shop\.invalid/);
    const fine = await receive("Order question", { headers: PASS("customer.invalid") });
    assert.equal(fine.spam, undefined);
    assert.deepEqual(fine.forwards, ["copy@gmail.invalid"]);
    await call("/pump", "POST");
    assert.deepEqual((await call("/agents")).body, [fine.emailId], "only the clean message reached the agents");
    assert.deepEqual((await feed("inbox")).map((m) => m.subject), ["Order question"]);
    const spam = await feed("spam");
    assert.deepEqual(spam.map((m) => m.subject).sort(), ["Wire the money today", "Your account is locked"]);
    assert.ok(spam.every((m) => m.spamReason), "each row says why it is in Spam");
  } finally { await mf.dispose(); }
});

test("a stranger's message is read by the model once; spam moves with the model's reason; a correspondent is never screened (SP-2)", async () => {
  const { mf, call, receive, feed } = await fixture();
  try {
    await call("/sent", "POST", { mailbox: "support@shop.invalid", to: "friend@partner.invalid" });
    const pitch = await receive("Grow your traffic", { from: "bob@agency.test", headers: PASS("agency.test"), body: "We offer SEO services at a great price." });
    const question = await receive("Where is my order?", { from: "ann@customer.invalid", headers: PASS("customer.invalid") });
    const friend = await receive("Lunch?", { from: "friend@partner.invalid", headers: PASS("partner.invalid"), body: "SEO services joke" });
    await call("/pump", "POST");
    assert.equal((await call("/calls")).body, 2, "one call each for the two strangers, none for someone we wrote to");
    const moved = (await call("/folder", "POST", { mailbox: "support@shop.invalid", id: pitch.emailId })).body;
    assert.deepEqual(moved, { folder_id: "spam", spam_reason: "Unsolicited SEO outreach from a stranger" });
    assert.equal((await call("/folder", "POST", { mailbox: "support@shop.invalid", id: question.emailId })).body.folder_id, "inbox");
    assert.equal((await call("/folder", "POST", { mailbox: "support@shop.invalid", id: friend.emailId })).body.folder_id, "inbox");
    await call("/pump", "POST");
    assert.equal((await call("/calls")).body, 2, "nothing is judged twice");
    assert.deepEqual((await feed("spam")).map((m) => m.spamReason), ["Unsolicited SEO outreach from a stranger"]);
  } finally { await mf.dispose(); }
});

test("over the day's spam budget a message is left in the inbox and says so in the log of checks (SP-2)", async () => {
  const { mf, call, receive } = await fixture({ SPAM_DAILY_LIMIT: "1" });
  try {
    await receive("First", { from: "a@one.invalid", headers: PASS("one.invalid") });
    const second = await receive("Cheap SEO services", { from: "b@two.invalid", headers: PASS("two.invalid"), body: "We offer SEO services for your store this month." });
    await call("/pump", "POST");
    assert.equal((await call("/calls")).body, 1);
    assert.equal((await call("/folder", "POST", { mailbox: "support@shop.invalid", id: second.emailId })).body.folder_id, "inbox");
    const checks = (await call("/checks")).body as any[];
    assert.ok(checks.some((c) => c.message_id === second.emailId && c.verdict === "skipped" && /budget/.test(c.reason)));
    const stats = (await call("/api/spam")).body;
    assert.deepEqual([stats.model.used, stats.model.limit], [1, 1]);
  } finally { await mf.dispose(); }
});

test("Report spam moves the message and blocks the sender; Not spam brings it back and allows them; the lists decide the next arrival (SP-3)", async () => {
  const { mf, call, receive, feed } = await fixture();
  try {
    const first = await receive("Deals", { from: "Deals <deals@promo.invalid>", headers: PASS("promo.invalid") });
    const report = await call("/api/spam/report", "POST", { messages: [{ accountId: "cloudflare:support@shop.invalid", providerMessageId: first.emailId, sender: "Deals <deals@promo.invalid>" }], list: "sender" });
    assert.equal(report.status, 200);
    assert.deepEqual([report.body.moved, report.body.listed], [1, ["deals@promo.invalid"]]);
    const again = await receive("More deals", { from: "deals@promo.invalid", headers: PASS("promo.invalid") });
    assert.equal(again.spam, "You marked this sender as spam", "blocked on arrival, without the model");

    const release = await call("/api/spam/release", "POST", { messages: [{ accountId: "cloudflare:support@shop.invalid", providerMessageId: again.emailId, sender: "deals@promo.invalid" }], list: "domain" });
    assert.equal(release.body.moved, 1);
    assert.deepEqual(release.body.lists.allowedDomains, ["promo.invalid"]);
    assert.deepEqual(release.body.lists.blockedSenders, ["deals@promo.invalid"], "the sender entry stays until removed; the allowed domain wins");
    // Allowing promo.invalid does not let through mail that promo.invalid's own DMARC rejects.
    const third = await receive("A forgery of an allowed domain", { from: "news@promo.invalid", headers: FORGED("promo.invalid") });
    assert.match(third.spam ?? "", /Failed DMARC for promo\.invalid/, "a forgery is spam even from an allowed domain");
    const fourth = await receive("Allowed, unsigned", { from: "news@promo.invalid", headers: "" });
    assert.equal(fourth.spam, undefined, "an allowed domain still beats the model and the weaker checks");
    assert.ok((await feed("inbox")).some((m) => m.subject === "More deals" && !m.spamReason));

    const removed = await call("/api/spam/lists", "POST", { list: "blockedSenders", value: "deals@promo.invalid", action: "remove" });
    assert.deepEqual(removed.body.lists.blockedSenders, []);
    assert.equal((await call("/api/spam/lists", "POST", { list: "blockedDomains", value: "not a domain", action: "add" })).status, 400);
    const wrong = await call("/api/spam/release", "POST", { messages: [{ accountId: "cloudflare:support@shop.invalid", providerMessageId: "nope", sender: "" }] });
    assert.equal(wrong.status, 502);
    assert.equal(wrong.body.failed[0].error, "It is no longer in Spam");
  } finally { await mf.dispose(); }
});

test("two list changes at once both land (conditional writes)", async () => {
  const { mf, call } = await fixture();
  try {
    const lists = (await call("/lists-race", "POST")).body;
    assert.deepEqual([...lists.blockedSenders].sort(), ["a@x.invalid", "b@x.invalid", "c@x.invalid"]);
  } finally { await mf.dispose(); }
});

test("Spam older than 30 days is deleted with its attachments; Empty spam now deletes the rest (SP-5, SP-4)", async () => {
  const { mf, call, receive, feed } = await fixture();
  try {
    const old = await receive("Invoice attached", { from: "billing@payments.invalid", headers: FORGED("payments.invalid"), attachment: true });
    assert.ok(old.spam);
    assert.equal((await call("/r2")).body.length, 1);
    assert.equal((await call("/purge", "POST", { mailbox: "support@shop.invalid" })).body, 0, "a fresh one stays");
    await call("/backdate-spam-at", "POST", { mailbox: "support@shop.invalid", days: 31 });
    assert.equal((await call("/purge", "POST", { mailbox: "support@shop.invalid" })).body, 1);
    assert.deepEqual((await call("/r2")).body, [], "its attachment went with it");
    await receive("Another", { from: "x@payments.invalid", headers: FORGED("payments.invalid") });
    await receive("And another", { from: "y@payments.invalid", headers: FORGED("payments.invalid") });
    const emptied = await call("/api/spam/empty", "POST", {});
    assert.deepEqual(emptied.body, { deleted: 2, failed: 0 });
    assert.deepEqual(await feed("spam"), []);
  } finally { await mf.dispose(); }
});

test("an almost empty message is not judged by the model: there is nothing to judge (live false positive, 2026-09-29)", async () => {
  const { mf, call, receive } = await fixture();
  try {
    const empty = await receive("$$$$$$$$$$", { from: "someone@icloud.invalid", headers: PASS("icloud.invalid"), body: "Wysłane z iPhone'a" });
    const linked = await receive("hi", { from: "other@icloud.invalid", headers: PASS("icloud.invalid"), body: "http://x.invalid/SEO services" });
    await call("/pump", "POST");
    assert.equal((await call("/calls")).body, 1, "only the one with a link is read");
    assert.equal((await call("/folder", "POST", { mailbox: "support@shop.invalid", id: empty.emailId })).body.folder_id, "inbox");
    const checks = (await call("/checks")).body as any[];
    assert.ok(checks.some((c) => c.message_id === empty.emailId && c.verdict === "clean" && /too little/i.test(c.reason)));
    assert.equal((await call("/folder", "POST", { mailbox: "support@shop.invalid", id: linked.emailId })).body.folder_id, "spam");
  } finally { await mf.dispose(); }
});

test("30 days count from the move into Spam: an old message reported now is kept, and Not spam can still bring it back (deploy audit H2)", async () => {
  const { mf, call, receive } = await fixture();
  try {
    const old = await receive("An old newsletter", { from: "news@shop-news.invalid", headers: PASS("shop-news.invalid") });
    await call("/pump", "POST");
    await call("/backdate-all", "POST", { mailbox: "support@shop.invalid", days: 60 });
    const report = await call("/api/spam/report", "POST", { messages: [{ accountId: "cloudflare:support@shop.invalid", providerMessageId: old.emailId, sender: "news@shop-news.invalid" }], list: "none" });
    assert.equal(report.body.moved, 1);
    assert.equal((await call("/purge", "POST", { mailbox: "support@shop.invalid" })).body, 0, "it arrived 60 days ago but entered Spam now");
    assert.equal((await call("/folder", "POST", { mailbox: "support@shop.invalid", id: old.emailId })).body.folder_id, "spam");
    const back = await call("/api/spam/release", "POST", { messages: [{ accountId: "cloudflare:support@shop.invalid", providerMessageId: old.emailId, sender: "" }], list: "none" });
    assert.equal(back.body.moved, 1);
  } finally { await mf.dispose(); }
});

test("hiding an address through the route takes its mail out of All inboxes; showing it brings it back (sidebar filter)", async () => {
  const { mf, call, receive, feed } = await fixture();
  try {
    await receive("Order question", { headers: PASS("customer.invalid"), body: "Where is my order? It has been a week already." });
    assert.equal((await feed("inbox")).length, 1);
    const hide = await call("/api/inbox/hidden", "PUT", { hide: ["cloudflare:support@shop.invalid"] });
    assert.deepEqual(hide.body.hidden, ["cloudflare:support@shop.invalid"]);
    const hiddenFeed = await call("/api/inbox?limit=50");
    assert.equal(hiddenFeed.body.messages.length, 0);
    assert.equal(hiddenFeed.body.accounts[0].hidden, true);
    assert.equal(hiddenFeed.body.accounts[0].total, 1, "its count is still known, for the Hidden list");
    assert.equal((await call("/api/inbox?limit=50&account=cloudflare%3Asupport%40shop.invalid")).body.messages.length, 1, "it opens on its own");
    assert.deepEqual((await call("/api/inbox/hidden", "PUT", { show: ["cloudflare:support@shop.invalid"] })).body.hidden, []);
    assert.equal((await feed("inbox")).length, 1);
    assert.equal((await call("/api/inbox/hidden", "PUT", {})).status, 400);
  } finally { await mf.dispose(); }
});

test("a stranger's message is held for its agent until the spam check answers; a correspondent's is not held (B-30)", async () => {
  const { mf, call, receive } = await fixture();
  try {
    await call("/sent", "POST", { mailbox: "support@shop.invalid", to: "friend@partner.invalid" });
    const stranger = await receive("A question", { from: "ann@customer.invalid", headers: PASS("customer.invalid"), body: "Hello, when does my order arrive? I paid last week." });
    const friend = await receive("Lunch", { from: "friend@partner.invalid", headers: PASS("partner.invalid"), body: "Lunch on Friday at the usual place?" });
    let holds = (await call("/holds")).body;
    assert.equal(holds["held:" + stranger.emailId], 15 * 60_000, "held while its spam check runs");
    assert.equal(holds["held:" + friend.emailId], undefined, "someone we wrote to is not held");
    assert.equal(holds["released:" + stranger.emailId], undefined);
    await call("/pump", "POST");
    holds = (await call("/holds")).body;
    assert.equal(holds["released:" + stranger.emailId], true, "released once the check answered");
  } finally { await mf.dispose(); }
});
