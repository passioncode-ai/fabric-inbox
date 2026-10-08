import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * C2 test-hardening packet, spam in workerd (UX audit 2026-10-07, batch B8: SCN-039…SCN-042).
 * The spam and inbox routes run as built; a scenario header swaps in an R2 bucket whose reads or
 * conditional writes fail, mailboxes whose Spam cannot be emptied, a categories object whose count
 * cannot be read, or a Gmail accounts object that records setSpam. Arrival runs the real
 * receiveEmail, MailboxDO and CategoriesDO (the model scripted as in spam-workerd.test.ts); revival
 * runs the real incoming journal against a consumer that refuses until told otherwise.
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
      import { MockLanguageModelV3 } from 'ai/test';
      const forbidden = () => { throw new Error('External AI is forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send: forbidden}}); }
        async folderOf(id) { return this.ctx.storage.sql.exec('SELECT folder_id, spam_reason FROM emails WHERE id = ?', id).toArray()[0] ?? null; }
        async dueNow() { this.ctx.storage.sql.exec("UPDATE incoming_receipts SET next_at = 0 WHERE automation_status = 'pending'"); await this.flushIncomingEvents(); }
        async receipts() { return this.ctx.storage.sql.exec('SELECT automation_status AS s FROM incoming_receipts').toArray().map((r) => r.s); }
      }
      export class TestAgents extends DurableObject {
        async enqueue(mailboxId, emailId, options = {}) {
          const seen = (await this.ctx.storage.get('seen')) || []; await this.ctx.storage.put('seen', [...seen, emailId]);
          if (options.holdMs) await this.ctx.storage.put('held:' + emailId, options.holdMs);
        }
        async release(mailboxId, emailId) { await this.ctx.storage.put('released:' + emailId, true); }
        async held() { const out = []; for (const k of (await this.ctx.storage.list()).keys()) if (k.startsWith('held:')) out.push(k.slice(5)); return out; }
      }
      export class TestCategories extends CategoriesDO {
        async refuse(on) { await this.ctx.storage.put('test:refuse', on); }
        async accepted() { return (await this.ctx.storage.get('test:accepted')) || []; }
        async ingest(account, event) {
          // Revival: refuses while told to, and records what it took once it accepts.
          if (await this.ctx.storage.get('test:refuse')) throw new Error('categories refused it');
          await this.ctx.storage.put('test:accepted', [...((await this.ctx.storage.get('test:accepted')) || []), event.id]);
          return super.ingest(account, event);
        }
        model() {
          return new MockLanguageModelV3({ doGenerate: async (options) => {
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
        async checks() { return this.ctx.storage.sql.exec('SELECT message_id, verdict FROM spam_checks').toArray(); }
      }

      /** R2 whose reads of one key throw, or whose conditional writes of one key always lose. */
      const faulty = (bucket, s) => ({
        get: (k, o) => s.failGet === k ? Promise.reject(new Error('R2 is unreachable')) : bucket.get(k, o),
        put: (k, v, o) => s.refusePut === k ? Promise.resolve(null) : bucket.put(k, v, o),
        head: (k) => bucket.head(k), list: (o) => bucket.list(o), delete: (k) => bucket.delete(k),
      });
      const recorded = [];
      function scenarioEnv(env, s) {
        const out = { ...env, BUCKET: faulty(env.BUCKET, s) };
        if (s.purge) out.MAILBOX = { idFromName: (n) => n, get: (n) => ({ async purgeSpam(o) {
          recorded.push(['purge', n, o]);
          const r = s.purge[n]; if (typeof r !== 'number') throw new Error('storage reset'); return r; } }) };
        if (s.gone) out.MAILBOX = { idFromName: (n) => n, get: () => ({ async markSpam() { return []; }, async markNotSpam() { return []; } }) };
        if (s.gmail) out.GMAIL_ACCOUNTS = { getByName: () => ({ async setSpam(...a) { recorded.push(['setSpam', ...a]); } }) };
        if (s.noGmail) delete out.GMAIL_ACCOUNTS;
        if (s.categories === 'throw') out.CATEGORIES = { getByName: () => ({ spamStats: () => Promise.reject(new Error('categories object reset')) }) };
        if (s.categories === 'none') delete out.CATEGORIES;
        return out;
      }
      const routes = new Hono();
      routes.route('/', spamRouter);
      routes.route('/', inboxRouter);
      const app = new Hono();
      const box = (env, m) => env.MAILBOX.get(env.MAILBOX.idFromName(m));
      app.all('/s/*', async (c) => {
        const s = JSON.parse(c.req.header('x-scenario') || '{}');
        const url = new URL(c.req.url); url.pathname = url.pathname.slice(2);
        return routes.fetch(new Request(url, c.req.raw), scenarioEnv(c.env, s), c.executionCtx);
      });
      app.get('/recorded', (c) => c.json(recorded.splice(0)));
      app.post('/r2', async (c) => { const b = await c.req.json(); await c.env.BUCKET.put(b.key, b.value); return c.json({ ok: true }); });
      app.post('/r2-get', async (c) => { const b = await c.req.json(); const o = await c.env.BUCKET.get(b.key); return c.json(o ? await o.text() : null); });
      app.post('/receive', async (c) => {
        const m = await c.req.json();
        const bytes = new TextEncoder().encode(m.raw);
        const env = m.unreadable ? { ...c.env, BUCKET: faulty(c.env.BUCKET, { failGet: 'config/spam.json' }) } : c.env;
        return c.json(await receiveEmail({ to: m.to, from: 'x@outside.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject: () => {}, forward: async () => {} }, env, c.executionCtx));
      });
      app.post('/pump', async (c) => { await c.env.CATEGORIES.getByName('workspace').pump(); return c.json({ ok: true }); });
      app.get('/checks', async (c) => c.json(await c.env.CATEGORIES.getByName('workspace').checks()));
      app.get('/held', async (c) => c.json(await c.env.AGENT_REGISTRY.getByName('workspace').held()));
      app.post('/refuse', async (c) => { await c.env.CATEGORIES.getByName('workspace').refuse((await c.req.json()).on); return c.json({ ok: true }); });
      app.get('/accepted', async (c) => c.json(await c.env.CATEGORIES.getByName('workspace').accepted()));
      app.post('/folder', async (c) => { const b = await c.req.json(); return c.json(await box(c.env, b.mailbox).folderOf(b.id)); });
      app.post('/due', async (c) => { const b = await c.req.json(); await box(c.env, b.mailbox).dueNow(); return c.json({ ok: true }); });
      app.post('/counts', async (c) => { const b = await c.req.json(); return c.json(await box(c.env, b.mailbox).inboxCounts()); });
      app.post('/retry', async (c) => { const b = await c.req.json(); return c.json(await box(c.env, b.mailbox).retryIncoming()); });
      app.post('/receipts', async (c) => { const b = await c.req.json(); return c.json(await box(c.env, b.mailbox).receipts()); });
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

const MAILBOX = "support@shop.invalid";
const SPAM = "config/spam.json";
const HIDDEN = "config/hidden-accounts.json";
const PASS = (d: string) => `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${d}; dmarc=pass header.from=${d} policy.dmarc=reject; spf=pass\r\n`;

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      MAILBOX: { className: "TestMailbox", useSQLite: true },
      CATEGORIES: { className: "TestCategories", useSQLite: true },
      AGENT_REGISTRY: { className: "TestAgents", useSQLite: true },
    },
    r2Buckets: ["BUCKET"], bindings: { DOMAINS: "shop.invalid", SPAM_DAILY_LIMIT: "40" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (path: string, method = "GET", body?: unknown, scenario?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (scenario !== undefined) headers["x-scenario"] = JSON.stringify(scenario);
    const r = await mf.dispatchFetch("http://localhost" + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  await call("/r2", "POST", { key: `mailboxes/${MAILBOX}.json`, value: JSON.stringify({ agent: "off" }) });
  let n = 0;
  const receive = async (subject: string, opts: { from?: string; body?: string; unreadable?: boolean } = {}) => {
    const from = opts.from ?? "ann@customer.invalid";
    const domain = from.split("@")[1]!;
    const out = await call("/receive", "POST", { to: MAILBOX, unreadable: !!opts.unreadable,
      raw: `${PASS(domain)}From: ${from}\r\nTo: ${MAILBOX}\r\nSubject: ${subject}\r\nMessage-ID: <c2-${++n}-${Date.now()}@${domain}>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${opts.body ?? "Hello, a question about my order."}\r\n` });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    return out.body as { emailId: string; spam?: string };
  };
  const folder = async (id: string) => (await call("/folder", "POST", { mailbox: MAILBOX, id })).body?.folder_id;
  return { mf, call, receive, folder };
}

// ── SCN-039: Spam stays out of the inbox — when the lists cannot be read, and when Spam cannot be emptied ──

test("SCN-039 / B8: when the spam lists cannot be read, a blocked sender's message goes to the inbox and is still screened by the model", async () => {
  const { mf, call, receive, folder } = await fixture();
  try {
    await call("/r2", "POST", { key: SPAM, value: JSON.stringify({ blockedSenders: ["deals@agency.test"], blockedDomains: [], allowedSenders: [], allowedDomains: [] }) });
    const listed = await receive("Deals", { from: "deals@agency.test" });
    assert.match(listed.spam ?? "", /./, "control: with the lists readable the blocked sender goes to Spam");
    assert.equal(await folder(listed.emailId), "spam");

    const unread = await receive("Deals again", { from: "deals@agency.test", unreadable: true });
    assert.equal(unread.spam, undefined, "no verdict is invented from lists nobody read");
    assert.equal(await folder(unread.emailId), "inbox", "no mail is lost to the filter");
    assert.ok((await call("/held")).body.includes(unread.emailId), "its agent still waits for the spam check (screen, not clean)");
    await call("/pump", "POST");
    const checks = (await call("/checks")).body as { message_id: string; verdict: string }[];
    assert.ok(checks.some((c) => c.message_id === unread.emailId), "the model's check is not switched off by the failed look-up");

    const pitch = await receive("Grow your traffic", { from: "bob@seo.test", body: "We offer SEO services.", unreadable: true });
    assert.equal(await folder(pitch.emailId), "inbox", "on arrival it is in the inbox…");
    await call("/pump", "POST");
    assert.equal(await folder(pitch.emailId), "spam", "…and the model still moves spam to Spam");
  } finally { await mf.dispose(); }
});

test("SCN-039 / B8: Delete all now with one address failing deletes the rest and counts the failure; all failing is a 502", async () => {
  const { mf, call } = await fixture();
  try {
    for (const a of ["a@shop.invalid", "b@shop.invalid"]) await call("/r2", "POST", { key: `mailboxes/${a}.json`, value: "{}" });
    // Three addresses (support@ from the fixture, a@, b@); b@'s Spam cannot be emptied.
    const partial = await call("/s/api/spam/empty", "POST", {}, { purge: { [MAILBOX]: 3, "a@shop.invalid": 2 } });
    assert.equal(partial.status, 200, "what could be deleted was deleted");
    assert.deepEqual(partial.body, { deleted: 5, failed: 1 });
    const purges = ((await call("/recorded")).body as [string, string, unknown][]).filter((r) => r[0] === "purge");
    assert.deepEqual(purges.map((p) => p[1]).sort(), ["a@shop.invalid", "b@shop.invalid", MAILBOX], "one failing address does not stop the others");
    assert.ok(purges.every((p) => (p[2] as { all?: boolean }).all === true), "Delete all now deletes everything, not only what is past 30 days");

    const none = await call("/s/api/spam/empty", "POST", {}, { purge: {} });
    assert.equal(none.status, 502, "nothing deleted and something failed is a failure");
    assert.deepEqual(none.body, { deleted: 0, failed: 3 });

    const clean = await call("/s/api/spam/empty", "POST", {}, { purge: { [MAILBOX]: 0, "a@shop.invalid": 0, "b@shop.invalid": 0 } });
    assert.deepEqual([clean.status, clean.body], [200, { deleted: 0, failed: 0 }], "an empty Spam is not an error");
  } finally { await mf.dispose(); }
});

// ── SCN-040: Report spam / Not spam when something does not go through ─────────────────────────

test("SCN-040 / B8: when the spam lists cannot be changed the Gmail message still moves (setSpam) and the answer says the rule was not saved", async () => {
  const { mf, call } = await fixture();
  try {
    const r = await call("/s/api/spam/report", "POST",
      { messages: [{ accountId: "gmail:acc1", providerMessageId: "m1", sender: "Deals <deals@spam.invalid>" }], list: "sender" },
      { gmail: true, refusePut: SPAM });
    assert.equal(r.status, 200, "the message moved");
    assert.equal(r.body.moved, 1);
    assert.deepEqual(r.body.failed, []);
    assert.match(r.body.listError, /^The messages moved, but the spam rules were not changed: The spam lists changed several times at once; try again$/);
    assert.equal(r.body.lists, undefined, "no lists are claimed as saved");
    assert.deepEqual((await call("/recorded")).body, [["setSpam", "acc1", "m1", true]], "Gmail's own label, through the accounts object");
    assert.equal((await call("/r2-get", "POST", { key: SPAM })).body, null, "nothing was written");

    const back = await call("/s/api/spam/release", "POST", { messages: [{ accountId: "gmail:acc1", providerMessageId: "m1", sender: "deals@spam.invalid" }] }, { gmail: true });
    assert.equal(back.status, 200);
    assert.deepEqual((await call("/recorded")).body, [["setSpam", "acc1", "m1", false]], "Not spam is setSpam false");
    assert.deepEqual(back.body.lists.allowedSenders, ["deals@spam.invalid"], "and the sender is never treated as spam again");
  } finally { await mf.dispose(); }
});

test("SCN-040 / B8: a message that is no longer there says so and nothing goes on a list; a Gmail message with no accounts object is refused", async () => {
  const { mf, call } = await fixture();
  try {
    const msg = [{ accountId: `cloudflare:${MAILBOX}`, providerMessageId: "gone", sender: "x@spam.invalid" }];
    const r = await call("/s/api/spam/report", "POST", { messages: msg }, { gone: true });
    assert.equal(r.status, 502);
    assert.deepEqual([r.body.moved, r.body.error, r.body.listed], [0, "It is sent mail, a draft, or no longer here", []]);
    const back = await call("/s/api/spam/release", "POST", { messages: msg }, { gone: true });
    assert.deepEqual([back.status, back.body.error], [502, "It is no longer in Spam"]);
    assert.equal((await call("/r2-get", "POST", { key: SPAM })).body, null, "no rule is saved for a message that did not move");

    const gmail = await call("/s/api/spam/report", "POST", { messages: [{ accountId: "gmail:acc1", providerMessageId: "m1", sender: "a@spam.invalid" }] }, { noGmail: true });
    assert.deepEqual([gmail.status, gmail.body.error], [502, "Mail accounts are not configured on this server"]);
  } finally { await mf.dispose(); }
});

// ── SCN-041: Keep the spam rules — the model's count, or the lists, cannot be read ─────────────────

test("SCN-041 / B8: when the model's count cannot be read, /api/spam answers the lists and marks the count unavailable, never zero", async () => {
  const { mf, call } = await fixture();
  try {
    await call("/r2", "POST", { key: SPAM, value: JSON.stringify({ blockedSenders: ["deals@spam.invalid"], blockedDomains: [], allowedSenders: [], allowedDomains: [] }) });
    const readable = await call("/s/api/spam", "GET", undefined, {});
    assert.equal(readable.status, 200);
    assert.equal(readable.body.model.unavailable, undefined, "control: the real categories object answers its count");

    for (const categories of ["throw", "none"]) {
      const r = await call("/s/api/spam", "GET", undefined, { categories });
      assert.equal(r.status, 200, categories);
      assert.deepEqual(r.body.lists.blockedSenders, ["deals@spam.invalid"], "the lists are not lost with the count");
      assert.deepEqual(r.body.model, { used: 0, limit: 40, spamToday: 0, screenedToday: 0, unavailable: true }, categories);
    }
  } finally { await mf.dispose(); }
});

test("SCN-041 / B8: spam lists that cannot be read are an error the screen can retry, never empty lists; a lost write is a 409", async () => {
  const { mf, call } = await fixture();
  try {
    const r = await call("/s/api/spam", "GET", undefined, { failGet: SPAM });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "Reading the spam rules could not be completed: R2 is unreachable");
    const edit = await call("/s/api/spam/lists", "POST", { list: "blockedDomains", value: "spam.invalid", action: "add" }, { refusePut: SPAM });
    assert.equal(edit.status, 409, "another change kept landing first: say so, change nothing");
    assert.equal(edit.body.error, "The spam lists changed several times at once; try again");
    assert.equal((await call("/r2-get", "POST", { key: SPAM })).body, null);
  } finally { await mf.dispose(); }
});

// ── SCN-042: List only the addresses that matter — a hide that cannot be saved; stuck mail revived ──

test("SCN-042 / B8: hiding addresses that cannot be saved answers an error and changes nothing", async () => {
  const { mf, call } = await fixture();
  try {
    await call("/r2", "POST", { key: HIDDEN, value: JSON.stringify({ hidden: ["cloudflare:old@shop.invalid"] }) });
    const conflict = await call("/s/api/inbox/hidden", "PUT", { hide: ["cloudflare:new@shop.invalid"] }, { refusePut: HIDDEN });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "The hidden addresses changed several times at once; try again");
    const down = await call("/s/api/inbox/hidden", "PUT", { hide: ["cloudflare:new@shop.invalid"] }, { failGet: HIDDEN });
    assert.deepEqual([down.status, down.body.error], [503, "R2 is unreachable"]);
    const unreadable = await call("/s/api/inbox/hidden", "GET", undefined, { failGet: HIDDEN });
    assert.equal(unreadable.status, 503, "an unreadable list is an error, never an empty one");
    assert.equal((await call("/s/api/inbox/hidden", "PUT", {}, {})).status, 400);
    assert.deepEqual((await call("/s/api/inbox/hidden", "GET", undefined, {})).body, { hidden: ["cloudflare:old@shop.invalid"] }, "nothing changed");
  } finally { await mf.dispose(); }
});

test("SCN-042 / B8: stuck incoming mail revived by Retry reaches its consumers once they accept, and the stuck count clears", async () => {
  const { mf, call, receive } = await fixture();
  try {
    await call("/refuse", "POST", { on: true });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await receive(`Order ${i}`)).emailId);
    for (let i = 0; i < 12; i++) await call("/due", "POST", { mailbox: MAILBOX });
    let counts = (await call("/counts", "POST", { mailbox: MAILBOX })).body;
    assert.deepEqual([counts.stuck.dead, counts.stuck.retrying], [3, 0], "set aside after the bound");
    assert.match(counts.stuck.lastError, /categories refused it/);
    assert.equal(counts.total, 3, "the mail itself is in the inbox");

    // Retry while the consumer still refuses: revived, tried, and back on its backoff — not lost.
    assert.equal((await call("/retry", "POST", { mailbox: MAILBOX })).body, 3);
    counts = (await call("/counts", "POST", { mailbox: MAILBOX })).body;
    assert.deepEqual([counts.stuck.dead, counts.stuck.retrying], [0, 3], "being retried again, with its error kept");
    assert.deepEqual((await call("/accepted")).body, []);

    // The consumer is fixed; the next turn delivers every revived event, once.
    await call("/refuse", "POST", { on: false });
    await call("/due", "POST", { mailbox: MAILBOX });
    assert.deepEqual(((await call("/accepted")).body as string[]).sort(), [...ids].sort());
    assert.deepEqual((await call("/receipts", "POST", { mailbox: MAILBOX })).body, ["accepted", "accepted", "accepted"]);
    counts = (await call("/counts", "POST", { mailbox: MAILBOX })).body;
    assert.deepEqual(counts.stuck, { dead: 0, retrying: 0, lastError: null }, "the stuck-mail banner has nothing left to say");
    assert.equal((await call("/retry", "POST", { mailbox: MAILBOX })).body, 0, "a Retry with nothing set aside revives nothing");
    assert.equal(((await call("/accepted")).body as string[]).length, 3, "nothing is delivered twice");
  } finally { await mf.dispose(); }
});
