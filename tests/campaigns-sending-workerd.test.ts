import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { builtinModules } from "node:module";

/**
 * B-181 step 2 (SCN-090) in workerd: a launched campaign is sent by CampaignsDO's loop through the account's own send,
 * one message per wake inside the window and the gaps, each with the stop line and List-Unsubscribe; a reply stops that
 * person and their company, "unsubscribe" puts them on the do-not-write list, an automatic reply moves their next step
 * on, a follow-up answers in the same conversation, and the report counts it all. The account is a fake that records sends.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { Hono } from 'hono';
      import { campaignsRouter } from './workers/routes/campaigns';
      export { CampaignsDO } from './workers/campaigns/store';
      export class FakeAccounts extends DurableObject {
        async listAccounts() { return { accounts: [{ id: 'g1', provider: 'gmail', email: 'me@owner.example' }] }; }
        async send(accountId, request, options) {
          const sent = (await this.ctx.storage.get('sent')) ?? [];
          sent.push({ accountId, request, options });
          await this.ctx.storage.put('sent', sent);
          return { status: 'accepted', idempotencyKey: request.idempotencyKey, providerMessageId: 'm' + sent.length, threadId: 't-' + request.to[0].split('@')[0] };
        }
        async sent() { return (await this.ctx.storage.get('sent')) ?? []; }
      }
      const app = new Hono();
      app.route('/', campaignsRouter);
      app.post('/t/tick', async (c) => c.json(await c.env.CAMPAIGNS.getByName('workspace').tick(Number(c.req.query('now')), 0)));
      app.post('/t/inbound', async (c) => { const b = await c.req.json(); return c.json(await c.env.CAMPAIGNS.getByName('workspace').inbound(b.account, b.message, Number(c.req.query('now')))); });
      app.get('/t/sent', async (c) => c.json(await c.env.GMAIL_ACCOUNTS.getByName('workspace').sent()));
      export default { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser",
  external: ["cloudflare:*", "node:*", ...builtinModules], alias: { mimetext: "mimetext/browser" }, target: "es2022",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/');" },
});

const MON = Date.UTC(2026, 10, 2, 9); // Monday 09:00 UTC
const MIN = 60_000, DAY = 86_400_000;

test("SCN-090: the loop sends one at a time, follow-ups answer in the thread, replies, stops and auto-replies are heard", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CAMPAIGNS: { className: "CampaignsDO", useSQLite: true }, GMAIL_ACCOUNTS: { className: "FakeAccounts", useSQLite: true } },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await mf.dispatchFetch(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const tick = async (at: number) => (await call("POST", `/t/tick?now=${at}`)).json.sent as number;
  const inbound = (at: number, sender: string, subject: string, body: string, threadId?: string) =>
    call("POST", `/t/inbound?now=${at}`, { account: "gmail:g1", message: { sender, subject, body, threadId } });
  try {
    const created = await call("POST", "/api/campaigns", { campaign: { name: "Pilot", sender: "gmail:g1", timezone: "UTC", gapMinutes: [5, 5],
      steps: [{ subject: "About {{company|your team}}", body: "Hi {{first_name|there}}" }, { body: "Any thoughts?", delayDays: 3 }] } });
    const id = created.json.id;
    await call("POST", `/api/campaigns/${id}/recipients`, { recipients: [
      { email: "ann@acme.example", fields: { first_name: "Ann", company: "Acme" } }, { email: "bob@acme.example" },
      { email: "cy@beta.example" }, { email: "dee@delta.example" }] });
    assert.equal((await call("POST", `/api/campaigns/${id}/pause`)).status, 409, "a draft is not paused");
    const launched = await call("POST", `/api/campaigns/${id}/launch`);
    assert.equal(launched.json.state, "running");

    // One message per wake, then the gap; nothing outside the window.
    assert.equal(await tick(MON - 60 * MIN), 0, "08:00 is before the window");
    assert.equal(await tick(MON), 1);
    assert.equal(await tick(MON + MIN), 0, "the gap holds");
    assert.equal(await tick(MON + 5 * MIN), 1);
    let sent = (await call("GET", "/t/sent")).json;
    assert.deepEqual(sent.map((s: any) => s.request.to[0]), ["ann@acme.example", "bob@acme.example"]);
    assert.equal(sent[0].accountId, "g1");
    assert.equal(sent[0].request.subject, "About Acme");
    assert.match(sent[0].request.text, /^Hi Ann\n\nIf you would rather not hear from me again, reply "unsubscribe"/);
    assert.deepEqual(sent[0].options.listUnsubscribe, ["mailto:me@owner.example?subject=unsubscribe"], "no one-click page yet: a reply only");
    assert.match(sent[0].request.idempotencyKey, /^campaign:[0-9a-f]{32}$/);

    // Bob replies: he is stopped, and so is Ann at the same company.
    assert.equal((await inbound(MON + 6 * MIN, "Bob <bob@acme.example>", "Re: About your team", "Interested", "t-bob")).json.kind, "reply");
    assert.equal(await tick(MON + 10 * MIN), 1);
    assert.equal(await tick(MON + 15 * MIN), 1);
    // Cy asks to stop: on the do-not-write list. Dee is away: her follow-up moves three days from now.
    assert.equal((await inbound(MON + 20 * MIN, "cy@beta.example", "Re: About your team", "Please unsubscribe me")).json.kind, "unsubscribe");
    assert.equal((await inbound(MON + DAY, "dee@delta.example", "Automatic reply: About your team", "I am away")).json.kind, "auto");
    assert.deepEqual((await call("GET", "/api/suppression")).json.suppression.map((s: any) => s.value), ["cy@beta.example"]);

    assert.equal(await tick(MON + 3 * DAY + 30 * MIN), 0, "Dee's follow-up waits for the auto-reply's three days");
    assert.equal(await tick(MON + 4 * DAY + 60 * MIN), 1);
    sent = (await call("GET", "/t/sent")).json;
    const follow = sent[sent.length - 1];
    assert.deepEqual([follow.request.to[0], follow.request.subject, follow.request.threadId], ["dee@delta.example", "Re: About your team", "t-dee"]);
    assert.match(follow.request.text, /^Any thoughts\?/);

    const report = (await call("GET", `/api/campaigns/${id}/report`)).json;
    assert.equal(report.campaign.state, "finished", "nobody is left");
    assert.deepEqual(report.perStep, [4, 1]);
    assert.equal(report.contacted, 4);
    assert.deepEqual(report.campaign.counts, { done: 1, replied: 1, stopped: 1, unsubscribed: 1 });
    assert.equal(report.replyRate, 0.5);
    assert.equal((await call("POST", `/api/campaigns/${id}/launch`)).status, 409, "a finished campaign is not started again");
    assert.equal(await tick(MON + 5 * DAY), 0, "the same people are never written to twice");
  } finally {
    await mf.dispose();
  }
});

test("SCN-090: bounces past 5% pause the campaign; stop ends it for whoever was still waiting", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CAMPAIGNS: { className: "CampaignsDO", useSQLite: true }, GMAIL_ACCOUNTS: { className: "FakeAccounts", useSQLite: true } },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await mf.dispatchFetch(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  try {
    const id = (await call("POST", "/api/campaigns", { campaign: { name: "Bounces", sender: "gmail:g1", timezone: "UTC", gapMinutes: [5, 5], steps: [{ body: "Hi" }] } })).json.id;
    await call("POST", `/api/campaigns/${id}/recipients`, { recipients: Array.from({ length: 12 }, (_, i) => ({ email: `p${i}@corp${i}.example` })) });
    await call("POST", `/api/campaigns/${id}/launch`);
    for (let i = 0; i < 10; i++) await call("POST", `/t/tick?now=${MON + i * 5 * MIN}`);
    const bounce = await call("POST", `/t/inbound?now=${MON + 60 * MIN}`, { account: "gmail:g1",
      message: { sender: "Mail Delivery Subsystem <mailer-daemon@mail.example>", subject: "Delivery Status Notification (Failure)", body: "Your message to p3@corp3.example could not be delivered." } });
    assert.deepEqual(bounce.json, { kind: "bounce", matched: 1 });
    const paused = (await call("GET", `/api/campaigns/${id}`)).json;
    assert.deepEqual([paused.state, paused.reason, paused.counts.bounced], ["paused", "bounces", 1], "1 of 10 is over 5%");
    assert.equal((await call("POST", `/t/tick?now=${MON + 70 * MIN}`)).json.sent, 0, "a paused campaign sends nothing");
    const stopped = (await call("POST", `/api/campaigns/${id}/stop`)).json;
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.counts.stopped, 2, "the two still waiting");
    assert.equal((await call("POST", `/api/campaigns/${id}/launch`)).status, 409);
  } finally {
    await mf.dispose();
  }
});

test("SCN-090: once the server has its unsubscribe page, every message carries the one-click link first", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CAMPAIGNS: { className: "CampaignsDO", useSQLite: true }, GMAIL_ACCOUNTS: { className: "FakeAccounts", useSQLite: true } },
    r2Buckets: ["BUCKET"], bindings: { MAIL_CREDENTIAL_KEY: "k".repeat(43) },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await mf.dispatchFetch(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  try {
    const bucket = await mf.getR2Bucket("BUCKET");
    await bucket.put("config/unsubscribe-access.json", JSON.stringify({ host: "inbox.owner.example", appId: "app2", createdAt: "2026-10-27T00:00:00Z" }));
    const id = (await call("POST", "/api/campaigns", { campaign: { name: "One click", sender: "gmail:g1", timezone: "UTC", steps: [{ body: "Hi" }] } })).json.id;
    await call("POST", `/api/campaigns/${id}/recipients`, { recipients: [{ email: "ann@acme.example" }] });
    await call("POST", `/api/campaigns/${id}/launch`);
    assert.equal((await call("POST", `/t/tick?now=${MON}`)).json.sent, 1);
    const [first] = (await call("GET", "/t/sent")).json;
    assert.match(first.options.listUnsubscribe[0], /^https:\/\/inbox\.owner\.example\/u\/1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    assert.equal(first.options.listUnsubscribe[1], "mailto:me@owner.example?subject=unsubscribe");
  } finally {
    await mf.dispose();
  }
});
