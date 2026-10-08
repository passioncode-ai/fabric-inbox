import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// REQ-P2/P3 in workerd: the production AgentRegistryDO (versions, runs, send
// budget, durable queue) and MailboxDO (journal, outbox). Only the model, the
// injection scanner and the mail transport are replaced; tool calls and AI are
// forbidden, so any real effect other than the recorded transport fails.
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { AgentRegistryDO } from './workers/agents/registry';
      import { receiveEmail } from './workers/index';
      import { runIdFor } from './workers/agents/run';
      const forbidden = () => { throw new Error('External AI and tools are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) {
          super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send: async (m) => {
            await ctx.storage.put('sent', [...(await ctx.storage.get('sent') || []), {to: m.to, subject: m.subject}]);
            return { messageId: '<r@test>' };
          }}});
        }
        async sentLog() { return await this.ctx.storage.get('sent') || []; }
        async folder(name) { return this.getEmails({folder:name}); }
      }
      export class TestRegistry extends AgentRegistryDO {
        async toolSchema(grant) {
          const script = JSON.parse(await (await this.env.BUCKET.get('test/tool-schema.json'))?.text() || '{}');
          if (script.throw) throw new Error(script.throw);
          return 'schema' in script ? script.schema : {};
        }
        deps(mailboxId) {
          const real = super.deps(mailboxId);
          const env = this.env;
          return {...real,
            injection: async () => ({ flagged: false }),
            callTool: forbidden,
            model: async (request) => {
              // How many runs of one mailbox are with the model at once (audit A4).
              this.inflight ??= {}; this.maxInflight ??= {};
              this.inflight[mailboxId] = (this.inflight[mailboxId] || 0) + 1;
              this.maxInflight[mailboxId] = Math.max(this.maxInflight[mailboxId] || 0, this.inflight[mailboxId]);
              await new Promise((r) => setTimeout(r, 40));
              this.inflight[mailboxId]--;
              const script = JSON.parse(await (await env.BUCKET.get('test/model.json'))?.text() || '{}');
              await env.BUCKET.put('test/last-system.txt', request.system);
              if (script.throw) throw new Error('model down');
              return { decision: script.decision ?? null, text: script.text ?? '' };
            }};
        }
        async pump() { return this.alarm(); }
        async overlap() { return this.maxInflight ?? {}; }
        async expireHolds() { this.ctx.storage.sql.exec('UPDATE agent_queue SET next_at = 0'); }
        async endClaimWaits() { this.ctx.storage.sql.exec('UPDATE agent_message_claims SET deadline = 0'); this.ctx.storage.sql.exec('UPDATE agent_queue SET next_at = 0'); }
        async ageClaim(key, ms) { this.ctx.storage.sql.exec('UPDATE agent_message_claims SET created_at = created_at - ? WHERE key = ?', ms, key); }
        async claimCount() { return Number(this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM agent_message_claims').one().n); }
        async ageRuns() { const old = new Date(Date.now() - 11 * 60000).toISOString();
          for (const r of this.ctx.storage.sql.exec('SELECT id, body FROM agent_runs').toArray()) {
            const run = JSON.parse(r.body); run.updatedAt = old;
            this.ctx.storage.sql.exec('UPDATE agent_runs SET body = ?, updated_at = ? WHERE id = ?', JSON.stringify(run), old, r.id); }
          this.ctx.storage.sql.exec('UPDATE agent_queue SET next_at = 0'); }
      }
      export default {
        async fetch(request, env, ctx) {
          const c = await request.json();
          const reg = env.AGENT_REGISTRY.getByName('workspace');
          const box = (m) => env.MAILBOX.getByName(m);
          try {
            switch (c.op) {
              case 'create': return Response.json(await reg.createAgent(c.input, c.id));
              case 'update': return Response.json(await reg.updateAgent(c.id, c.input, c.expected));
              case 'get': return Response.json(await reg.getAgent(c.id, c.version));
              case 'list': return Response.json(await reg.listAgents());
              case 'versions': return Response.json(await reg.listVersions(c.id));
              case 'delete': return Response.json(await reg.deleteAgent(c.id));
              case 'ensure': return Response.json(await reg.ensureAgent(c.id, c.input));
              case 'reserve': return Response.json(await reg.reserveSend(c.mailbox, c.limit, c.day));
              case 'begin': return Response.json(await reg.beginRun(c.run));
              case 'setup':
                await env.BUCKET.put('mailboxes/' + c.mailbox + '.json', JSON.stringify(c.settings ?? {}));
                await env.BUCKET.put('test/model.json', JSON.stringify(c.model ?? {}));
                return Response.json(true);
              case 'schema':
                await env.BUCKET.put('test/tool-schema.json', JSON.stringify(c.script ?? {}));
                return Response.json(true);
              case 'receive': {
                const bytes = new TextEncoder().encode(c.raw);
                const event = {to:c.mailbox, from:c.from, rawSize:bytes.length, raw:new Response(bytes).body, setReject(){}};
                return Response.json(await receiveEmail(event, {...env, DOMAINS:''}, ctx));
              }
              case 'pump': await reg.pump(); return Response.json({queue: await reg.queueLength()});
              case 'overlap': return Response.json(await reg.overlap());
              case 'age': await reg.ageRuns(); return Response.json(true);
              case 'hold': await reg.enqueue(c.mailbox, c.emailId, { holdMs: c.holdMs }); return Response.json(true);
              case 'release': await reg.release(c.mailbox, c.emailId); return Response.json(true);
              case 'expire': await reg.expireHolds(); return Response.json(true);
              case 'endWaits': await reg.endClaimWaits(); return Response.json(true);
              case 'claim': return Response.json(await reg.claimMessage(c.key, c.mailbox, c.elected));
              case 'ageClaim': await reg.ageClaim(c.key, c.ms); return Response.json(true);
              case 'claimCount': return Response.json(await reg.claimCount());
              case 'runId': return Response.json(await runIdFor(c.mailbox, c.emailId));
              case 'runs': return Response.json(await reg.listRuns({mailboxId: c.mailbox, ...(c.options ?? {})}));
              case 'sent': return Response.json(await box(c.mailbox).sentLog());
              case 'folder': return Response.json(await box(c.mailbox).folder(c.folder));
              case 'settings': return Response.json(await (await env.BUCKET.get('mailboxes/' + c.mailbox + '.json')).json());
              case 'system': return Response.json(await (await env.BUCKET.get('test/last-system.txt'))?.text() ?? null);
            }
          } catch (e) { return Response.json({error: e.constructor.name, message: e.message}, {status: 409}); }
          return new Response('unknown op', {status: 400});
        }
      };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  target: "es2022",
});

async function fixture(bindings: Record<string, string> = {}) {
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { AUTOMATION_MCP_HOSTS: "tools.project.invalid", ...bindings },
    durableObjects: {
      MAILBOX: { className: "TestMailbox", useSQLite: true },
      AGENT_REGISTRY: { className: "TestRegistry", useSQLite: true },
    },
    r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const command = async (op: string, fields: Record<string, unknown> = {}): Promise<any> => {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ op, ...fields }) });
    return response.json();
  };
  return { mf, command };
}

const support = { name: "Support", instructions: "Answer from the FAQ.", knowledge: "Price: 10 EUR.", replyPolicy: { mode: "auto", allowedIntents: ["pricing"], dailySendLimit: 5 } };
const raw = (subject: string, extra = "", to = "support@project.invalid") =>
  `From: Ann <ann@customer.invalid>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, "")}@customer.invalid>\r\n${extra}Content-Type: text/plain\r\n\r\nHow much is it?\r\n`;

test("agents are versioned; a stale editor cannot overwrite; delete keeps old versions readable (REQ-P2)", async () => {
  const { mf, command } = await fixture();
  try {
    const created = await command("create", { input: support });
    assert.equal(created.id, "support");
    assert.equal(created.version, 1);
    assert.equal((await command("create", { input: support })).id, "support-2", "a second agent with the same name gets its own id");
    const v2 = await command("update", { id: "support", input: { ...support, knowledge: "Price: 12 EUR." }, expected: 1 });
    assert.equal(v2.version, 2);
    const stale = await command("update", { id: "support", input: support, expected: 1 });
    assert.match(stale.message, /^agent_conflict: /);
    assert.equal((await command("get", { id: "support", version: 1 })).knowledge, "Price: 10 EUR.");
    assert.deepEqual((await command("versions", { id: "support" })).map((v: any) => v.version), [2, 1]);
    assert.equal(await command("delete", { id: "support" }), true);
    assert.equal(await command("get", { id: "support" }), null);
    assert.equal((await command("get", { id: "support", version: 2 })).version, 2, "runs can still show the version they used");
    assert.deepEqual((await command("list")).map((a: any) => a.id), ["support-2"]);
    assert.equal(await command("ensure", { id: "support", input: support }), null, "a deleted id is never recreated by migration");
  } finally { await mf.dispose(); }
});

test("tool grants are checked against the workspace host allowlist on save (REQ-P4)", async () => {
  const { mf, command } = await fixture();
  try {
    const tool = { name: "order_status", description: "Look up an order", endpoint: "https://evil.invalid/mcp", tool: "x" };
    const refused = await command("create", { input: { ...support, tools: [tool] } });
    assert.match(refused.message, /^agent_invalid: order_status: Tool host is not enabled/);
    const ok = await command("create", { input: { ...support, tools: [{ ...tool, endpoint: "https://tools.project.invalid/mcp" }] } });
    assert.equal(ok.tools[0].name, "order_status");
  } finally { await mf.dispose(); }
});

test("a granted tool whose schema cannot be read is refused at save, with the reason (B12-01)", async () => {
  const { mf, command } = await fixture();
  try {
    const tool = { name: "order_status", description: "Look up an order", endpoint: "https://tools.project.invalid/mcp", tool: "order_status" };
    await command("schema", { script: { throw: "connect ECONNREFUSED" } });
    const unreadable = await command("create", { input: { ...support, tools: [tool] } });
    assert.match(unreadable.message, /^agent_invalid: The schema of the tool order_status could not be read: connect ECONNREFUSED$/);
    const notUpdated = await command("update", { id: "missing", input: { ...support, tools: [tool] }, expected: 1 });
    assert.match(notUpdated.message, /^agent_invalid: The schema of the tool order_status could not be read/, "update is refused before the version check");
    await command("schema", { script: { schema: null } });
    const unlisted = await command("create", { input: { ...support, tools: [tool] } });
    assert.match(unlisted.message, /^agent_invalid: The tool order_status is not listed by its endpoint$/);
    await command("schema", { script: { schema: { type: "object" } } });
    const saved = await command("create", { input: { ...support, tools: [tool] } });
    assert.equal(saved.tools[0].name, "order_status", "a readable schema saves");
  } finally { await mf.dispose(); }
});

test("the daily send budget is per address and per day", async () => {
  const { mf, command } = await fixture();
  try {
    assert.equal(await command("reserve", { mailbox: "a@p.invalid", limit: 2, day: "2026-09-28" }), true);
    assert.equal(await command("reserve", { mailbox: "A@p.invalid", limit: 2, day: "2026-09-28" }), true);
    assert.equal(await command("reserve", { mailbox: "a@p.invalid", limit: 2, day: "2026-09-28" }), false);
    assert.equal(await command("reserve", { mailbox: "b@p.invalid", limit: 2, day: "2026-09-28" }), true);
    assert.equal(await command("reserve", { mailbox: "a@p.invalid", limit: 2, day: "2026-09-29" }), true);
  } finally { await mf.dispose(); }
});

test("inbound mail reaches the assigned agent durably and one reply leaves through the outbox (SCN-024)", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { input: support });
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: { id: "support" } },
      model: { decision: { decision: "send", intent: "pricing", grounded: true, body: "Hi Ann, 10 EUR.", reason: "" } } });
    const received = await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw: raw("Price") });
    assert.equal(received.inserted, true);
    assert.deepEqual(await command("pump"), { queue: 0 });
    const [run] = await command("runs", { mailbox: "support@project.invalid" });
    assert.equal(run.status, "sent", run.reason);
    assert.equal(run.agentId, "support");
    assert.equal(run.agentVersion, 1);
    assert.deepEqual(await command("sent", { mailbox: "support@project.invalid" }), [{ to: "ann@customer.invalid", subject: "Re: Price" }]);
    // The same message delivered again is deduplicated before the agent.
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw: raw("Price") });
    await command("pump");
    assert.equal((await command("sent", { mailbox: "support@project.invalid" })).length, 1);
    assert.equal((await command("runs", { mailbox: "support@project.invalid" })).length, 1);
    assert.match(await command("system"), /Price: 10 EUR/);
  } finally { await mf.dispose(); }
});

test("a newsletter is skipped without the model; Off stores mail and does nothing", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { input: support });
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: { id: "support" } }, model: { throw: true } });
    await command("receive", { mailbox: "support@project.invalid", from: "news@list.invalid", raw: raw("News", "List-Unsubscribe: <mailto:u@list.invalid>\r\n") });
    await command("pump");
    const [skipped] = await command("runs", { mailbox: "support@project.invalid" });
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.reason, /Mailing list/);

    await command("setup", { mailbox: "hello@project.invalid", settings: { agent: "off" }, model: { throw: true } });
    await command("receive", { mailbox: "hello@project.invalid", from: "ann@customer.invalid", raw: raw("Hello") });
    await command("pump");
    const offRuns = await command("runs", { mailbox: "hello@project.invalid" });
    assert.deepEqual(offRuns, [], "an Off address leaves no run");
    assert.equal((await command("folder", { mailbox: "hello@project.invalid", folder: "inbox" })).length, 1, "mail is kept for the operator");
    assert.deepEqual(await command("sent", { mailbox: "hello@project.invalid" }), []);
  } finally { await mf.dispose(); }
});

test("a pre-registry mailbox is migrated once to a drafting agent and the draft lands in Drafts", async () => {
  const { mf, command } = await fixture();
  try {
    await command("setup", { mailbox: "old@project.invalid", settings: { fromName: "Old", agentSystemPrompt: "Legacy prompt Z" },
      model: { decision: { decision: "send", intent: "pricing", grounded: true, body: "Hi Ann.", reason: "" } } });
    await command("receive", { mailbox: "old@project.invalid", from: "ann@customer.invalid", raw: raw("Question") });
    await command("pump");
    const [run] = await command("runs", { mailbox: "old@project.invalid" });
    assert.equal(run.status, "drafted");
    assert.equal(run.agentId, "mailbox-old-project-invalid");
    assert.deepEqual((await command("settings", { mailbox: "old@project.invalid" })).agent, { id: "mailbox-old-project-invalid" });
    assert.equal((await command("settings", { mailbox: "old@project.invalid" })).fromName, "Old", "other settings are kept");
    assert.match(await command("system"), /Legacy prompt Z/);
    const drafts = await command("folder", { mailbox: "old@project.invalid", folder: "draft" });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].recipient, "ann@customer.invalid");
    assert.deepEqual(await command("sent", { mailbox: "old@project.invalid" }), []);
  } finally { await mf.dispose(); }
});


test("a run cut off before sending is claimed again; one cut off while sending is only reported", async () => {
  const { mf, command } = await fixture();
  try {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const base = { mailboxId: "a@project.invalid", emailId: "e1", sender: "x@y.invalid", subject: "s", status: "running", reason: "", toolCalls: [] };
    await command("begin", { run: { ...base, id: "r-fresh", createdAt: now, updatedAt: now } });
    assert.equal((await command("begin", { run: { ...base, id: "r-fresh", createdAt: now, updatedAt: now } })).claimed, false, "a live claim is not taken twice");
    await command("begin", { run: { ...base, id: "r-stale", createdAt: old, updatedAt: old } });
    assert.equal((await command("begin", { run: { ...base, id: "r-stale", createdAt: now, updatedAt: now } })).claimed, true, "no send had started, so it runs again");
    await command("begin", { run: { ...base, id: "r-sending", phase: "sending", createdAt: old, updatedAt: old } });
    const reported = await command("begin", { run: { ...base, id: "r-sending", createdAt: now, updatedAt: now } });
    assert.equal(reported.claimed, false);
    assert.equal(reported.run.status, "interrupted");
    assert.match(reported.run.reason, /while sending/);
  } finally { await mf.dispose(); }
});

test("history pages by a cursor that keeps runs sharing a timestamp, and filters by outcome and agent (audit A14)", async () => {
  const { mf, command } = await fixture();
  try {
    const at = "2026-09-29T10:00:00.000Z";
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [] };
    const runs = [
      { id: "r1", status: "sent", agentId: "support", createdAt: at },
      { id: "r2", status: "drafted", agentId: "sales", createdAt: at },
      { id: "r3", status: "skipped", agentId: "support", createdAt: at },
      { id: "r4", status: "send_unknown", agentId: "support", createdAt: "2026-09-29T09:00:00.000Z" },
      { id: "r5", status: "running", agentId: "support", createdAt: "2026-09-29T08:00:00.000Z", updatedAt: old },
    ];
    for (const r of runs) await command("begin", { run: { ...base, emailId: r.id, updatedAt: r.createdAt, ...r } });
    const first = await command("runs", { options: { limit: 2 } });
    assert.deepEqual(first.map((r: any) => r.id), ["r3", "r2"]);
    const last = first[first.length - 1];
    const second = await command("runs", { options: { limit: 2, before: `${last.createdAt}|${last.id}` } });
    assert.deepEqual(second.map((r: any) => r.id), ["r1", "r4"], "r1 shares r2's timestamp and is not skipped");
    assert.deepEqual((await command("runs", { options: { outcome: "answered" } })).map((r: any) => r.id), ["r2", "r1"]);
    const attention = await command("runs", { options: { outcome: "attention" } });
    assert.deepEqual(attention.map((r: any) => r.id), ["r4", "r5"], "a stale running run needs attention");
    assert.equal(attention[1].status, "interrupted");
    assert.deepEqual((await command("runs", { options: { agentId: "sales" } })).map((r: any) => r.id), ["r2"]);
  } finally { await mf.dispose(); }
});

test("two messages to one address are answered one after the other, never side by side (audit A4)", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { input: support });
    const draft = { decision: { decision: "draft", intent: "pricing", grounded: true, body: "Hi Ann.", reason: "check" } };
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: { id: "support" } }, model: draft });
    await command("setup", { mailbox: "sales@project.invalid", settings: { agent: { id: "support" } }, model: draft });
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw: raw("First") });
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw: raw("Second") });
    await command("receive", { mailbox: "sales@project.invalid", from: "ann@customer.invalid", raw: raw("Other", "", "sales@project.invalid") });
    for (let i = 0; i < 5 && (await command("pump")).queue; i++);
    assert.equal((await command("runs", { mailbox: "support@project.invalid" })).length, 2);
    assert.equal((await command("runs", { mailbox: "sales@project.invalid" })).length, 1);
    assert.equal((await command("overlap"))["support@project.invalid"], 1, "the second message of one address waits for the first");
  } finally { await mf.dispose(); }
});

test("a run cut off mid-way is not dropped: its message waits and is answered once the run is stale (reliability audit M2)", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { input: support });
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: { id: "support" } },
      model: { decision: { decision: "draft", intent: "pricing", grounded: true, body: "Hi Ann.", reason: "check" } } });
    const received = await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw: raw("Cut off") });
    // A worker took the message and vanished mid-way: its run is "running" and fresh.
    const now = new Date().toISOString();
    const id = await command("runId", { mailbox: "support@project.invalid", emailId: received.emailId });
    await command("begin", { run: { id, mailboxId: "support@project.invalid", emailId: received.emailId, sender: "ann@customer.invalid", subject: "Cut off",
      status: "running", reason: "", toolCalls: [], createdAt: now, updatedAt: now } });
    const first = await command("pump");
    assert.equal(first.queue, 1, "the message stays queued while its run may still be alive");
    await command("age");
    await command("pump");
    const [run] = await command("runs", { mailbox: "support@project.invalid" });
    assert.equal(run.status, "drafted", "claimed again once stale, and answered");
    assert.equal((await command("pump")).queue, 0);
  } finally { await mf.dispose(); }
});

test("a stranger's message waits for its spam check: released, it is answered; never released, it is answered when the hold ends (B-30)", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { input: support });
    const draft = { decision: { decision: "draft", intent: "pricing", grounded: true, body: "Hi.", reason: "check" } };
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: { id: "support" } }, model: draft });
    // Delivered with no agent consumer racing it: seed the mailbox, then queue by hand with a hold.
    await command("setup", { mailbox: "hold@project.invalid", settings: { agent: "off" }, model: draft });
    const a = await command("receive", { mailbox: "hold@project.invalid", from: "ann@customer.invalid", raw: raw("First", "", "hold@project.invalid") });
    const b = await command("receive", { mailbox: "hold@project.invalid", from: "bob@customer.invalid", raw: raw("Second", "", "hold@project.invalid") });
    await command("pump"); // Off: nothing is answered and the plain queue rows are gone.
    await command("setup", { mailbox: "hold@project.invalid", settings: { agent: { id: "support" } }, model: draft });
    await command("hold", { mailbox: "hold@project.invalid", emailId: a.emailId, holdMs: 15 * 60_000 });
    await command("hold", { mailbox: "hold@project.invalid", emailId: b.emailId, holdMs: 15 * 60_000 });
    await command("pump");
    assert.equal((await command("runs", { mailbox: "hold@project.invalid" })).length, 0, "held: not answered before its spam check");
    await command("release", { mailbox: "hold@project.invalid", emailId: a.emailId });
    await command("pump");
    assert.deepEqual((await command("runs", { mailbox: "hold@project.invalid" })).map((r: any) => r.emailId), [a.emailId], "released: answered");
    await command("expire");
    await command("pump");
    assert.equal((await command("runs", { mailbox: "hold@project.invalid" })).length, 2, "the hold ends by itself: a spam check that never answers delays, never drops");
  } finally { await mf.dispose(); }
});

// ── B-22: one answer per workspace for a message sent to several agent addresses ──

const autoSend = { decision: { decision: "send", intent: "pricing", grounded: true, body: "Hi Ann, 10 EUR.", reason: "" } };
const addressed = (subject: string, to: string, cc = "", extra = `Message-ID: <${subject.replace(/\W/g, "")}@customer.invalid>\r\n`) =>
  `From: Ann <ann@customer.invalid>\r\nTo: ${to}\r\n${cc ? `Cc: ${cc}\r\n` : ""}Subject: ${subject}\r\nDate: Mon, 5 Oct 2026 10:00:00 +0000\r\n${extra}Content-Type: text/plain\r\n\r\nHow much is it?\r\n`;

async function agentAddresses(command: (op: string, fields?: Record<string, unknown>) => Promise<any>, ...boxes: string[]) {
  await command("create", { input: support });
  for (const mailbox of boxes) await command("setup", { mailbox, settings: { agent: { id: "support" } }, model: autoSend });
}

test("a message sent To one agent address and Cc another is answered once, from the To address (B-22)", async () => {
  const { mf, command } = await fixture();
  try {
    await agentAddresses(command, "support@project.invalid", "sales@project.invalid");
    const raw = addressed("Price", "support@project.invalid", "sales@project.invalid");
    // The Cc copy arrives and is picked up before the To copy exists.
    await command("receive", { mailbox: "sales@project.invalid", from: "ann@customer.invalid", raw });
    assert.equal((await command("pump")).queue, 1, "the Cc copy waits for the To address");
    assert.deepEqual(await command("runs", { mailbox: "sales@project.invalid" }), [], "nothing is recorded while it waits");
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw });
    await command("pump");
    assert.deepEqual(await command("sent", { mailbox: "support@project.invalid" }), [{ to: "ann@customer.invalid", subject: "Re: Price" }]);
    await command("expire");
    assert.equal((await command("pump")).queue, 0);
    assert.deepEqual(await command("sent", { mailbox: "sales@project.invalid" }), [], "the customer gets one reply");
    const [duplicate] = await command("runs", { mailbox: "sales@project.invalid" });
    assert.equal(duplicate.status, "skipped");
    assert.equal(duplicate.reason, "Duplicate: answered from support@project.invalid");
    assert.equal(duplicate.agentId, "support", "the history names the agent that would have answered");
    assert.equal((await command("runs", { mailbox: "support@project.invalid" }))[0].status, "sent");
  } finally { await mf.dispose(); }
});

test("two agent addresses both in To: the first one listed answers (B-22)", async () => {
  const { mf, command } = await fixture();
  try {
    await agentAddresses(command, "support@project.invalid", "sales@project.invalid");
    const raw = addressed("Both", "Sales <sales@project.invalid>, support@project.invalid");
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw });
    await command("receive", { mailbox: "sales@project.invalid", from: "ann@customer.invalid", raw });
    await command("pump");
    await command("expire");
    await command("pump");
    assert.equal((await command("sent", { mailbox: "sales@project.invalid" })).length, 1);
    assert.deepEqual(await command("sent", { mailbox: "support@project.invalid" }), []);
    assert.equal((await command("runs", { mailbox: "support@project.invalid" }))[0].reason, "Duplicate: answered from sales@project.invalid");
  } finally { await mf.dispose(); }
});

test("deliveries that claim the same message at the same moment: exactly one claim wins (B-22)", async () => {
  const { mf, command } = await fixture();
  try {
    // Neither address is listed (both Bcc): each would answer itself, so only the claim decides.
    await agentAddresses(command, "support@project.invalid", "sales@project.invalid");
    const raw = addressed("Hidden", "team@customer.invalid");
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw });
    await command("receive", { mailbox: "sales@project.invalid", from: "ann@customer.invalid", raw });
    assert.equal((await command("pump")).queue, 0, "both runs started in one pass, side by side");
    const sent = [...await command("sent", { mailbox: "support@project.invalid" }), ...await command("sent", { mailbox: "sales@project.invalid" })];
    assert.equal(sent.length, 1, "one reply, whichever claimed first");
    const runs = [...await command("runs", { mailbox: "support@project.invalid" }), ...await command("runs", { mailbox: "sales@project.invalid" })];
    assert.deepEqual(runs.map((r: any) => r.status).sort(), ["sent", "skipped"]);

    // The claim itself, raced directly by eight deliveries that each choose themselves.
    const boxes = Array.from({ length: 8 }, (_, i) => `m${i}@project.invalid`);
    const claims = await Promise.all(boxes.map((mailbox) => command("claim", { key: "mid:race", mailbox, elected: mailbox })));
    const winners = claims.filter((c: any) => c.outcome === "answer");
    assert.equal(winners.length, 1, JSON.stringify(claims));
    const owner = boxes[claims.findIndex((c: any) => c.outcome === "answer")];
    assert.ok(claims.every((c: any) => c.outcome === "answer" || (c.outcome === "duplicate" && c.owner === owner)));
  } finally { await mf.dispose(); }
});

test("a message with no Message-ID is still answered once, matched by sender, subject, Date, To and Cc (B-22)", async () => {
  const { mf, command } = await fixture();
  try {
    await agentAddresses(command, "support@project.invalid", "sales@project.invalid");
    const raw = addressed("No id", "support@project.invalid", "sales@project.invalid", "");
    await command("receive", { mailbox: "sales@project.invalid", from: "ann@customer.invalid", raw });
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw });
    await command("pump");
    await command("expire");
    await command("pump");
    assert.equal((await command("sent", { mailbox: "support@project.invalid" })).length, 1);
    assert.deepEqual(await command("sent", { mailbox: "sales@project.invalid" }), []);
    assert.equal((await command("runs", { mailbox: "sales@project.invalid" }))[0].reason, "Duplicate: answered from support@project.invalid");
  } finally { await mf.dispose(); }
});

test("an address with no agent changes nothing: the agent address in Cc answers at once (B-22)", async () => {
  const { mf, command } = await fixture();
  try {
    await agentAddresses(command, "support@project.invalid");
    await command("setup", { mailbox: "hello@project.invalid", settings: { agent: "off" }, model: autoSend });
    const raw = addressed("Hello", "hello@project.invalid", "support@project.invalid");
    await command("receive", { mailbox: "hello@project.invalid", from: "ann@customer.invalid", raw });
    await command("receive", { mailbox: "support@project.invalid", from: "ann@customer.invalid", raw });
    assert.equal((await command("pump")).queue, 0, "nobody waits for an address that has no agent");
    assert.equal((await command("sent", { mailbox: "support@project.invalid" })).length, 1);
    assert.deepEqual(await command("runs", { mailbox: "hello@project.invalid" }), [], "the Off address leaves no run");
    assert.equal((await command("folder", { mailbox: "hello@project.invalid", folder: "inbox" })).length, 1, "and keeps the mail");
  } finally { await mf.dispose(); }
});

test("the address chosen to answer never receives the message: the waiting copy answers once the wait ends (B-22)", async () => {
  const { mf, command } = await fixture();
  try {
    await agentAddresses(command, "support@project.invalid", "sales@project.invalid");
    // Listed in To and served here, but its copy never arrives (dropped as spam there, say).
    await command("receive", { mailbox: "sales@project.invalid", from: "ann@customer.invalid", raw: addressed("Lost", "support@project.invalid", "sales@project.invalid") });
    assert.equal((await command("pump")).queue, 1);
    await command("expire");
    assert.equal((await command("pump")).queue, 1, "still inside the wait: polled, not answered");
    await command("endWaits");
    assert.equal((await command("pump")).queue, 0);
    assert.equal((await command("sent", { mailbox: "sales@project.invalid" })).length, 1, "answered rather than lost");
  } finally { await mf.dispose(); }
});

test("message claims expire like other receipts, so storage does not grow without bound (B-22)", async () => {
  const { mf, command } = await fixture();
  try {
    assert.deepEqual(await command("claim", { key: "mid:old", mailbox: "a@project.invalid", elected: "a@project.invalid" }), { outcome: "answer" });
    await command("ageClaim", { key: "mid:old", ms: 8 * 86_400_000 });
    await command("claim", { key: "mid:new", mailbox: "a@project.invalid", elected: "a@project.invalid" });
    assert.equal(await command("claimCount"), 1, "the week-old claim is pruned");
  } finally { await mf.dispose(); }
});
