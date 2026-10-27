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
      import { DurableObject } from 'cloudflare:workers';
      import { MailboxDO } from './workers/durableObject/index';
      import { AgentRegistryDO } from './workers/agents/registry';
      import { receiveEmail } from './workers/index';
      import { runIdFor } from './workers/agents/run';
      import { mailVolume } from './workers/agents/volume';
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
        async seedThread(rows) { for (const r of rows) this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id) VALUES (?, ?, 's', 'x@y.invalid', 'a', ?, '', ?)", r.id, r.folder, r.date, r.thread); }
        async seed(rows) { for (const r of rows) this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body) VALUES (?, ?, 's', 'x@y.invalid', 'a', ?, '')", r.id, r.folder, r.date); }
      }
      // B-171 phase 3: an account's conversations, as the accounts object reads them from its cache.
      export class FakeAccounts extends DurableObject {
        async listAccounts() { return { accounts: [{ id: 'g1', provider: 'gmail', email: 'Help@Project.invalid' }] }; }
        async agentThreads(accountId, mailboxId) {
          return JSON.parse(await (await this.env.BUCKET.get('test/account-threads.json'))?.text() || '[]');
        }
      }
      export class TestRegistry extends AgentRegistryDO {
        async toolInfo(grant) {
          const script = JSON.parse(await (await this.env.BUCKET.get('test/tool-schema.json'))?.text() || '{}');
          if (script.throw) throw new Error(script.throw);
          const schema = 'schema' in script ? script.schema : {};
          return schema === null ? null : { schema, readOnly: (script.readOnly || []).includes(grant.tool) };
        }
        deps(mailboxId) {
          const real = super.deps(mailboxId);
          const env = this.env;
          return {...real,
            injection: async () => ({ flagged: false }),
            // B-153: a gap list scripted in test/gap-list.json ({ tool, revision, gaps, throw }); every call is logged.
            callTool: async (grant, args) => {
              const script = JSON.parse(await (await env.BUCKET.get('test/gap-list.json'))?.text() || 'null');
              if (!script || grant.tool !== script.tool) return forbidden();
              const calls = JSON.parse(await (await env.BUCKET.get('test/gap-calls.json'))?.text() || '[]');
              await env.BUCKET.put('test/gap-calls.json', JSON.stringify([...calls, args]));
              if (script.throw) throw new Error(script.throw);
              const gaps = args.after === undefined ? script.gaps.slice(0, args.limit) : script.gaps.filter((g) => g.id > args.after).slice(0, args.limit);
              return JSON.stringify({ class: 'internal', ledgerRevision: script.revision, gaps });
            },
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
        async retryHeldNow(now) { return this.retryHeld(now); }
        async answerClosedGapsNow(now) { return this.answerClosedGaps(now); }
        async superviseNow(now) { return this.superviseWaiting(now); }
        async abandonNow(now) { return this.superviseAbandoned(now); }
        async closeNow(now) { return this.closeExpired(now); }
        async seedFacts(rows) { for (const r of rows) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO agent_facts (endpoint, revision, seen_at) VALUES (?, ?, ?)", r.endpoint, r.revision, r.at); }
        async qualityNow(now) { return this.emitQualityDays(now); }
        async forgetQualityDay() { await this.ctx.storage.delete('quality_day'); }
        hookFetch = async (url, init) => {
          const script = JSON.parse(await (await this.env.BUCKET.get('test/hook.json'))?.text() || '{"status":200}');
          const calls = JSON.parse(await (await this.env.BUCKET.get('test/hook-calls.json'))?.text() || '[]');
          calls.push({ url, headers: init.headers, body: init.body });
          await this.env.BUCKET.put('test/hook-calls.json', JSON.stringify(calls));
          return new Response('ok', { status: script.status });
        };
        async hooksNow(now) { return this.deliverHooks(now); }
        async judgeAnswer(models, input) {
          const script = JSON.parse(await (await this.env.BUCKET.get('test/judge.json'))?.text() || 'null');
          if (!script) return null;
          await this.env.BUCKET.put('test/judge-last.json', JSON.stringify({ models, input }));
          if (script.throw) throw new Error(script.throw);
          return { ...script.verdict, model: models[0] };
        }
        async benchAnswer(model, input, reasoning) {
          const calls = JSON.parse(await (await this.env.BUCKET.get('test/bench-calls.json'))?.text() || '[]');
          calls.push({ model, reasoning, answer: input.answer });
          await this.env.BUCKET.put('test/bench-calls.json', JSON.stringify(calls));
          if (model === 'bad/model') return { ok: false, checks: null, helped: null, costUsd: null, ms: 5, reasoning, error: 'not the rubric' };
          return { ok: true, checks: { language: 'PASS', addressed: 'PASS', policySafe: 'PASS', routing: 'PASS', actionable: 'PASS', continuity: 'PASS' }, helped: 'yes', costUsd: 0.001, ms: 10, reasoning };
        }
        async redactNow(now) { return this.redactOldRuns(now); }
        async batchMailboxes() { return this.nextBatch().map((r) => r.mailbox_id); }
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
              case 'batch': return Response.json(await reg.batchMailboxes());
              case 'endWaits': await reg.endClaimWaits(); return Response.json(true);
              case 'claim': return Response.json(await reg.claimMessage(c.key, c.mailbox, c.elected));
              case 'ageClaim': await reg.ageClaim(c.key, c.ms); return Response.json(true);
              case 'claimCount': return Response.json(await reg.claimCount());
              case 'runId': return Response.json(await runIdFor(c.mailbox, c.emailId));
              case 'runs': return Response.json(await reg.listRuns({mailboxId: c.mailbox, ...(c.options ?? {})}));
              case 'preview': return Response.json(await reg.previewAnswer(c.id, c.input));
              case 'retry-held': return Response.json({ next: await reg.retryHeldNow(c.now), queue: await reg.queueLength() });
              case 'judgeScript': await env.BUCKET.put('test/judge.json', JSON.stringify(c.script)); return Response.json(true);
              case 'bench': return Response.json(await reg.judgeBench(c.address, c.options ?? {}, c.now));
              case 'judgeLast': return Response.json(JSON.parse(await (await env.BUCKET.get('test/judge-last.json'))?.text() || 'null'));
              case 'quality': return Response.json({ next: await reg.qualityNow(c.now) });
              case 'forgetQualityDay': await reg.forgetQualityDay(); return Response.json(true);
              case 'redact': await reg.redactNow(c.now); return Response.json(true);
              case 'supervise': return Response.json({ next: await reg.superviseNow(c.now) });
              case 'abandon': return Response.json({ next: await reg.abandonNow(c.now) });
              case 'close': return Response.json({ next: await reg.closeNow(c.now) });
              case 'seedFacts': await reg.seedFacts(c.rows); return Response.json(true);
              case 'seedThread': await box(c.mailbox).seedThread(c.rows); return Response.json(true);
              case 'byIds': return Response.json(await reg.runsByIds(c.ids));
              case 'gaps': return Response.json({ next: await reg.answerClosedGapsNow(c.now) });
              case 'grade': return Response.json(await reg.gradeRun(c.id, c.grade));
              case 'toGrade': return Response.json(await reg.answersToGrade(c.options ?? {}, c.now));
              case 'calibration': return Response.json(await reg.judgeCalibration(c.options ?? {}, c.now));
              case 'again': return Response.json(await reg.answerAgain(c.id));
              case 'sentAfter': return Response.json(await reg.sentInThreadAfter(c.mailbox, c.thread, c.since));
              case 'save': await reg.saveRun(c.run); return Response.json(true);
              case 'events': return Response.json(await reg.listEvents(c.after, c.limit));
              case 'modelCalls': return Response.json(await reg.modelUsagePerDay(c.since));
              case 'hooks': return Response.json({ next: await reg.hooksNow(c.now) });
              case 'hookStates': return Response.json(await reg.hookStates(c.ids));
              case 'r2put': await env.BUCKET.put(c.key, c.text); return Response.json(true);
              case 'r2get': return Response.json(JSON.parse(await (await env.BUCKET.get(c.key))?.text() || 'null'));
              case 'seed': await box(c.mailbox).seed(c.rows); return Response.json(true);
              case 'volume': return Response.json(await mailVolume(env, c.days, c.now));
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
      GMAIL_ACCOUNTS: { className: "FakeAccounts", useSQLite: true },
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

test("B-85 REQ-2: the endpoint's schema is stored on save over whatever the editor sent; fixed and prefetch must fit it", async () => {
  const { mf, command } = await fixture();
  try {
    const schema = { type: "object", properties: { query: { type: "string" }, domain: { type: "string" }, limit: { type: "number" } }, required: ["query"] };
    await command("schema", { script: { schema } });
    const kb = { name: "acme_kb", description: "Search the knowledge base", endpoint: "https://tools.project.invalid/mcp", tool: "research.search" };
    const saved = await command("create", { input: { ...support, tools: [{ ...kb, inputSchema: JSON.stringify({ type: "object", properties: { evil: {} } }), fixed: { domain: "acme" }, prefetch: { argument: "query" }, publicOnly: true }] } });
    assert.deepEqual(JSON.parse(saved.tools[0].inputSchema), schema, "the endpoint's schema, not the client's");
    assert.deepEqual(saved.tools[0].fixed, { domain: "acme" });
    assert.deepEqual(saved.tools[0].prefetch, { argument: "query" });
    assert.equal(saved.tools[0].publicOnly, true);
    const unknownFixed = await command("create", { input: { ...support, tools: [{ ...kb, fixed: { tenant: "x" } }] } });
    assert.match(unknownFixed.message, /^agent_invalid: acme_kb: fixed argument "tenant" is not in the tool's schema$/);
    const numberPrefetch = await command("create", { input: { ...support, tools: [{ ...kb, prefetch: { argument: "limit" } }] } });
    assert.match(numberPrefetch.message, /^agent_invalid: acme_kb: "limit" is not a text argument of the tool$/);
  } finally { await mf.dispose(); }
});

test("B-118: a run that ends appends one event; the feed pages forward by cursor and starts with the newest", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    for (const id of ["e1", "e2", "e3"]) {
      const run = { ...base, id: "run-" + id, emailId: id, status: "running", createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z" };
      await command("begin", { run });
      await command("save", { run: { ...run, status: "drafted" } });
      await command("save", { run: { ...run, status: "drafted" } }); // saved again: still one event
    }
    const newest = await command("events", { limit: 2 });
    assert.deepEqual(newest.events.map((e: any) => e.data.value.runId), ["run-e2", "run-e3"], "without after: the newest, oldest first");
    assert.equal(newest.cursor, newest.events[1].id);
    const all = await command("events", { after: "0", limit: 50 });
    assert.deepEqual(all.events.map((e: any) => e.data.value.runId), ["run-e1", "run-e2", "run-e3"]);
    assert.ok(Number(all.events[1].id) > Number(all.events[0].id), "ids increase");
    const none = await command("events", { after: all.cursor, limit: 50 });
    assert.deepEqual(none, { events: [], cursor: null });
  } finally { await mf.dispose(); }
});

test("B-162: a held message is diagnosed once per cause across retries; its answer, once sent, is cited once", async () => {
  const { mf, command } = await fixture();
  try {
    const run = { id: "run-h", mailboxId: "a@project.invalid", emailId: "h1", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1,
      status: "running", createdAt: "2026-10-27T08:00:00.000Z", updatedAt: "2026-10-27T08:00:00.000Z" };
    const of = async (kind: string) => ((await command("events", { after: "0", limit: 50 })).events as { kind: string; data: { value: Record<string, any> } }[]).filter((e) => e.kind === kind);
    await command("begin", { run });
    await command("save", { run: { ...run, status: "held", unanswered: true, question: "How do refunds work?" } });
    await command("save", { run: { ...run, status: "running" } });
    await command("save", { run: { ...run, status: "held", unanswered: true, question: "How do refunds work?" } }); // retried, the same cause
    assert.deepEqual((await of("support.diagnosed")).map((e) => e.data.value.cause), ["data"]);
    await command("save", { run: { ...run, status: "running" } });
    await command("save", { run: { ...run, status: "held" } }); // the knowledge now has it, the checker did not approve
    assert.deepEqual((await of("support.diagnosed")).map((e) => e.data.value.cause), ["data", "draft-or-check"]);
    await command("save", { run: { ...run, status: "running" } });
    const sent = { ...run, status: "sent", evidence: [{ tool: "facts", items: ["fact:refunds"], coverage: [0.9], revision: "r2" }] };
    await command("save", { run: sent });
    await command("save", { run: sent });
    const cited = await of("answer.cited");
    assert.equal(cited.length, 1);
    assert.deepEqual([cited[0]!.data.value.cited, cited[0]!.data.value.coverage, cited[0]!.data.value.status], [["fact:refunds"], [0.9], "answered"]);
  } finally { await mf.dispose(); }
});

test("B-170: a conversation on an agent address still open two days later is reported once as agent.abandoned", async () => {
  const { mf, command } = await fixture();
  try {
    const box = "support@project.invalid";
    await command("setup", { mailbox: box, settings: { agent: { id: "support" } } });
    await command("setup", { mailbox: "plain@project.invalid", settings: {} });
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    await command("seedThread", { mailbox: box, rows: [
      { id: "old", folder: "inbox", date: ago(72), thread: "t1" },
      { id: "skipped", folder: "inbox", date: ago(72), thread: "t2" },
      { id: "fresh", folder: "inbox", date: ago(1), thread: "t3" },
      { id: "backlog", folder: "inbox", date: ago(240), thread: "t4" },
    ] });
    await command("seedThread", { mailbox: "plain@project.invalid", rows: [{ id: "x", folder: "inbox", date: ago(72), thread: "t9" }] });
    const id = await command("runId", { mailbox: box, emailId: "skipped" });
    const run = { id, mailboxId: box, emailId: "skipped", sender: "x@y.invalid", subject: "s", reason: "Mailing list", toolCalls: [], agentId: "support", agentVersion: 1,
      status: "running", createdAt: ago(72), updatedAt: ago(72) };
    await command("begin", { run });
    await command("save", { run: { ...run, status: "skipped" } });

    const first = await command("abandon", { now });
    assert.equal(first.next, now + 3_600_000);
    const kinds = async () => (await command("events", { after: "0", limit: 50 })).events.filter((e: any) => e.kind === "agent.abandoned");
    const found = await kinds();
    assert.equal(found.length, 1, "only the open one in the reporting window; not the skipped, the fresh, the backlog or an address without an agent");
    assert.deepEqual(found[0].data.value, { runId: await command("runId", { mailbox: box, emailId: "old" }), address: box, agentId: "support",
      status: "none", unanswered: false, sources: [], state: "unanswered", abandonedHours: 72 });
    assert.equal(found[0].level, "warning");

    assert.equal((await command("abandon", { now: now + 60_000 })).next, now + 3_600_000, "not looked at again before the hour");
    await command("abandon", { now: now + 3 * 3_600_000 });
    assert.equal((await kinds()).length, 1, "reported once");

    // B-171 phase 3: an account with a reply agent is looked at the same way and reported under its email.
    await command("r2put", { key: "accounts/gmail:g1.json", text: JSON.stringify({ agent: { id: "support" } }) });
    const late = now + 5 * 3_600_000;
    await command("r2put", { key: "test/account-threads.json", text: JSON.stringify([
      { threadId: "a1", lastInbound: { id: "acct-old", at: late - 50 * 3_600_000 }, lastSent: null, agentAnsweredBefore: false },
      { threadId: "a2", lastInbound: { id: "acct-fresh", at: late - 3_600_000 }, lastSent: null, agentAnsweredBefore: false },
    ]) });
    await command("abandon", { now: late });
    const account = (await kinds()).filter((e: any) => e.data.value.address === "help@project.invalid");
    assert.deepEqual(account.map((e: any) => [e.data.value.runId, e.data.value.agentId, e.data.value.abandonedHours]),
      [[await command("runId", { mailbox: "gmail:g1", emailId: "acct-old" }), "support", 50]], "the open account conversation past two days, once");
  } finally { await mf.dispose(); }
});

test("B-126: mail volume per agent address and UTC day — received, agent runs, no run, spam; counts only", async () => {
  const { mf, command } = await fixture();
  try {
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: { id: "support" } } });
    await command("setup", { mailbox: "off@project.invalid", settings: { agent: "off" } });
    await command("seed", { mailbox: "support@project.invalid", rows: [
      { id: "m1", folder: "inbox", date: "2026-10-16T09:00:00.000Z" }, { id: "m2", folder: "archive", date: "2026-10-16T23:59:00.000Z" },
      { id: "m3", folder: "spam", date: "2026-10-16T10:00:00.000Z" }, { id: "m4", folder: "sent", date: "2026-10-16T11:00:00.000Z" },
      { id: "m5", folder: "inbox", date: "2026-10-17T08:00:00.000Z" }, { id: "m6", folder: "inbox", date: "2026-10-10T08:00:00.000Z" }] });
    const run = { mailboxId: "support@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1,
      id: "run-m1", emailId: "m1", status: "sent", createdAt: "2026-10-16T09:00:01.000Z", updatedAt: "2026-10-16T09:00:05.000Z" };
    await command("begin", { run });
    const volume = await command("volume", { days: 3, now: Date.parse("2026-10-17T12:00:00.000Z") });
    assert.equal(volume.from, "2026-10-15");
    assert.equal(volume.to, "2026-10-17");
    assert.equal(volume.runsKeptFrom, null);
    assert.deepEqual(volume.addresses.map((a: any) => a.address), ["support@project.invalid"], "an address with no agent is left out");
    assert.deepEqual(volume.addresses[0].days, [
      { day: "2026-10-15", received: 0, agentRuns: 0, noRun: 0, spam: 0, spent: null },
      { day: "2026-10-16", received: 2, agentRuns: 1, noRun: 1, spam: 1, spent: null },
      { day: "2026-10-17", received: 1, agentRuns: 0, noRun: 1, spam: 0, spent: null },
    ]);
    assert.doesNotMatch(JSON.stringify(volume), /x@y\.invalid|"s"/, "no sender, no subject");
  } finally { await mf.dispose(); }
});

test("B-163: each day's model spend from its runs' receipts; a run that called a model and kept none makes the cost unknown", async () => {
  const { mf, command } = await fixture();
  try {
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: { id: "support" } } });
    const receipt = (model: string, cost: number | null, role?: string) => ({ model, inputTokens: 100, outputTokens: 10, costUsd: cost, measured: true, ...(role ? { role } : {}) });
    const base = { mailboxId: "support@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1, status: "sent" };
    const at = (day: string) => ({ createdAt: `${day}T09:00:01.000Z`, updatedAt: `${day}T09:00:05.000Z` });
    await command("begin", { run: { ...base, ...at("2026-10-16"), id: "run-a", emailId: "a", modelCalls: { calls: 2, failed: 0, recovered: 0 },
      usage: [receipt("x/writer", 0.001, "writer"), receipt("y/checker", 0.0002, "checker")] } });
    await command("begin", { run: { ...base, ...at("2026-10-16"), id: "run-b", emailId: "b", usage: [receipt("x/writer", 0.003)] } });
    await command("begin", { run: { ...base, ...at("2026-10-17"), id: "run-c", emailId: "c", usage: [receipt("x/writer", 0.001)] } });
    await command("begin", { run: { ...base, ...at("2026-10-17"), id: "run-d", emailId: "d", modelCalls: { calls: 1, failed: 0, recovered: 0 } } });
    const volume = await command("volume", { days: 2, now: Date.parse("2026-10-17T12:00:00.000Z") });
    assert.deepEqual(volume.addresses[0].days.map((d: any) => d.spent), [
      { calls: 3, inputTokens: 300, outputTokens: 30, costUsd: 0.0042, measured: true },
      { calls: 2, inputTokens: 100, outputTokens: 10, costUsd: null, measured: false },
    ]);
  } finally { await mf.dispose(); }
});

test("answer again: a drafted, skipped or failed run is queued once more as a new attempt; a sent one never is", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "r", toolCalls: [], agentId: "support", agentVersion: 1,
      createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z" };
    for (const [id, status] of [["d", "drafted"], ["s", "sent"], ["u", "send_unknown"], ["k", "skipped"]]) await command("begin", { run: { ...base, id, emailId: id, status } });
    const again = await command("again", { id: "d" });
    assert.equal(again.ok, true);
    assert.equal(again.run.attempt, 2);
    assert.equal((await command("byIds", { ids: ["d"] }))[0].status, "interrupted", "shown as waiting to be answered again");
    assert.deepEqual(await command("again", { id: "s" }), { ok: false, reason: "This message was already answered; it is not sent twice." });
    assert.equal((await command("again", { id: "u" })).ok, false, "a send that may have happened is never repeated");
    assert.equal((await command("again", { id: "nope" })).ok, false);
    assert.equal((await command("again", { id: "k" })).run.attempt, 2);
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
    // No limit (null, operator 2026-10-13): sends are still counted, never refused.
    for (let i = 0; i < 5; i++) assert.equal(await command("reserve", { mailbox: "c@p.invalid", limit: null, day: "2026-09-28" }), true);
    assert.equal(await command("reserve", { mailbox: "c@p.invalid", limit: 5, day: "2026-09-28" }), false, "the five were counted");
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
    // B-115: the inbox asks for the runs of the messages on its page, by id; unknown ids are left out.
    const some = await command("byIds", { ids: ["r2", "nope", "r5"] });
    assert.deepEqual(some.map((r: any) => r.id).sort(), ["r2", "r5"]);
    assert.equal(some.find((r: any) => r.id === "r5").status, "interrupted", "presented as the history shows it");
    assert.deepEqual(await command("byIds", { ids: [] }), []);
    // B-117: questions without an answer, newest first.
    await command("begin", { run: { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "q", reason: "", toolCalls: [], emailId: "q1", id: "q1", status: "drafted", agentId: "support", createdAt: "2026-09-29T11:00:00.000Z", updatedAt: "2026-09-29T11:00:00.000Z", question: "How to X", unanswered: true } });
    assert.deepEqual((await command("runs", { options: { outcome: "unanswered" } })).map((r: any) => r.id), ["q1"]);
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

test("a burst to one address does not hold up another address's answer (bug hunt 2026-10-12)", async () => {
  const { mf, command } = await fixture();
  try {
    for (let i = 0; i < 35; i++) await command("hold", { mailbox: "busy@p.invalid", emailId: `b${i}`, holdMs: 60_000 });
    await command("hold", { mailbox: "quiet@p.invalid", emailId: "q1", holdMs: 60_000 });
    await command("expire");
    const batch = await command("batch");
    assert.ok(batch.includes("quiet@p.invalid"), JSON.stringify(batch));
    assert.equal(batch.filter((m: string) => m === "busy@p.invalid").length, 1, "one message per mailbox at a time");
  } finally { await mf.dispose(); }
});

test("B-94: a grant's read-only mark is the endpoint's, and a stale run's second claim is marked a re-run", async () => {
  const { mf, command } = await fixture();
  try {
    await command("schema", { script: { schema: { type: "object", properties: { order: { type: "string" } } }, readOnly: ["order_status"] } });
    const tools = [
      { name: "order_status", description: "Look up an order", endpoint: "https://tools.project.invalid/mcp", tool: "order_status" },
      { name: "refund", description: "Refund an order", endpoint: "https://tools.project.invalid/mcp", tool: "refund", readOnly: true },
    ];
    const saved = await command("create", { input: { ...support, tools } });
    assert.deepEqual(saved.tools.map((t: { readOnly?: boolean }) => t.readOnly), [true, false], "the editor's readOnly: true on refund is replaced");
    const stale = new Date(Date.now() - 24 * 3600_000).toISOString();
    const run = { id: "run-b94", mailboxId: "a@project.invalid", emailId: "e-b94", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [],
      agentId: "support", agentVersion: 1, status: "running", createdAt: stale, updatedAt: stale };
    assert.equal((await command("begin", { run })).claimed, true);
    const again = await command("begin", { run: { ...run, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    assert.equal(again.claimed, true, "a stale run is claimed again");
    assert.equal(again.run.rerun, true);
  } finally { await mf.dispose(); }
});

test("a preview runs the agent on a written message and sends, drafts and stores nothing", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { id: "support", input: support });
    await command("setup", { mailbox: "support@project.invalid", settings: { agent: "off" },
      model: { decision: { decision: "send", intent: "pricing", grounded: true, body: "It costs 10 EUR.", reason: "" } } });
    const preview = await command("preview", { id: "support", input: { address: "support@project.invalid", from: "lead@customer.invalid", subject: "Price?", text: "How much is it?" } });
    assert.equal(preview.status, "sent", JSON.stringify(preview));
    assert.equal(preview.reply.to, "lead@customer.invalid");
    assert.match(preview.reply.text, /10 EUR/);
    assert.equal(preview.run.subject, "", "the preview answer carries no message text but the reply");
    assert.deepEqual(await command("runs", { mailbox: "support@project.invalid" }).then((r: { runs?: unknown[] }) => r.runs ?? r), [], "nothing stored");
  } finally { await mf.dispose(); }
});

test("a held message is given back every 12 hours for 7 days, then daily until day 30, then left alone", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    const now = Date.parse("2026-10-17T12:00:00.000Z");
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    for (const [id, created, updated] of [["due", 20, 13], ["not-yet", 20, 2], ["late-not-yet", 24 * 10, 13], ["late-due", 24 * 10, 25], ["too-old", 24 * 31, 25]] as const)
      await command("begin", { run: { ...base, id: "agent-" + id.padEnd(32, "0").replace(/[^0-9a-f]/g, "0"), emailId: id, status: "held", createdAt: at(created), updatedAt: at(updated) } });
    const r = await command("retry-held", { now });
    assert.equal(r.queue, 2, "due: the 12-hour one in its first week and the daily one after it; not one older than 30 days");
    assert.equal(r.next, Date.parse(at(2)) + 12 * 3_600_000, "the next try is the soonest still to come");
  } finally { await mf.dispose(); }
});

test("B-131: a message waiting for a person past 4 hours is escalated once; one a person answered, or one from before the rule, is not", async () => {
  const { mf, command } = await fixture();
  try {
    const box = "a@project.invalid";
    const base = { mailboxId: box, sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    const now = Date.now();
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const id = (name: string) => "agent-" + name.replace(/[^0-9a-f]/g, "0").padEnd(32, "0").slice(0, 32);
    // A draft a person answered (a reply in Sent after it), and one nobody answered.
    await command("seedThread", { mailbox: box, rows: [
      { id: "answered", folder: "inbox", date: at(6), thread: "t-answered" }, { id: "reply", folder: "sent", date: at(1), thread: "t-answered" },
      { id: "draft-open", folder: "inbox", date: at(6), thread: "t-open" }] });
    for (const [name, status, created] of [["held-due", "held", 5], ["held-soon", "held", 2], ["answered", "drafted", 5], ["draft-open", "drafted", 5], ["held-old", "held", 24 * 4]] as const)
      await command("begin", { run: { ...base, id: id(name), emailId: name, status, createdAt: at(created), updatedAt: at(created) } });
    const first = await command("supervise", { now });
    const events = (await command("events", {})).events as { kind: string; data: { value: { runId: string; waitingHours: number } } }[];
    const waiting = events.filter((e) => e.kind === "agent.waiting");
    assert.deepEqual(waiting.map((e) => e.data.value.runId).sort(), [id("draft-open"), id("held-due")].sort());
    assert.equal(waiting[0].data.value.waitingHours, 5);
    assert.ok(Math.abs(first.next - (now + 3_600_000)) < 1000, "the next check is the open draft looked at again in an hour, before the 2-hour one reaches 4 hours");
    await command("supervise", { now });
    const again = ((await command("events", {})).events as { kind: string }[]).filter((e) => e.kind === "agent.waiting");
    assert.equal(again.length, 2, "escalated once");
    const runs = await command("byIds", { ids: [id("answered"), id("held-old")] }) as { id: string; escalatedAt?: string }[];
    assert.ok(runs.find((r) => r.id === id("answered"))?.escalatedAt, "an answered draft is marked, so it is not looked at again");
    assert.equal(runs.find((r) => r.id === id("held-old"))?.escalatedAt, undefined, "a run from before the rule is left alone");
    // A retry of a held run keeps its escalation (and a waiting reply) across the re-run.
    const kept = await command("byIds", { ids: [id("held-due")] }) as { escalatedAt?: string }[];
    assert.ok(kept[0].escalatedAt);
  } finally { await mf.dispose(); }
});

test("review 2026-10-21: a draft escalated as waiting that a person answers later counts as answered by a person", async () => {
  const { mf, command } = await fixture();
  try {
    const box = "a@project.invalid";
    const base = { mailboxId: box, sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    const now = Date.now();
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const runId = "agent-" + "9a".repeat(16);
    await command("seedThread", { mailbox: box, rows: [{ id: "open", folder: "inbox", date: at(6), thread: "t-open" }] });
    await command("begin", { run: { ...base, id: runId, emailId: "open", status: "drafted", createdAt: at(5), updatedAt: at(5) } });
    await command("supervise", { now });
    let [run] = await command("byIds", { ids: [runId] }) as { answeredByPerson?: boolean; personCheckAt?: string }[];
    assert.equal(run.answeredByPerson, false);
    assert.ok(run.personCheckAt);
    await command("seedThread", { mailbox: box, rows: [{ id: "reply", folder: "sent", date: new Date(now + 60_000).toISOString(), thread: "t-open" }] });
    const next = await command("supervise", { now: now + 30 * 60_000 });
    [run] = await command("byIds", { ids: [runId] }) as { answeredByPerson?: boolean }[];
    assert.equal(run.answeredByPerson, false, "not looked at before its hour");
    assert.ok(next.next >= now + 3_600_000 - 1000);
    await command("supervise", { now: now + 3_600_000 + 1000 });
    [run] = await command("byIds", { ids: [runId] }) as { answeredByPerson?: boolean; personCheckAt?: string }[];
    assert.equal(run.answeredByPerson, true);
    assert.equal(run.personCheckAt, undefined, "and not looked at again");
    assert.equal(((await command("events", {})).events as { kind: string }[]).filter((e) => e.kind === "agent.waiting").length, 1, "escalated once");
  } finally { await mf.dispose(); }
});

test("B-131: answering a held message again keeps its escalation and its waiting reply", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    const runId = "agent-" + "ab".repeat(16);
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
    await command("begin", { run: { ...base, id: runId, emailId: "m1", status: "held", createdAt: old, updatedAt: old,
      escalatedAt: old, acknowledged: { at: old, status: "accepted", text: "We are checking." } } });
    assert.equal((await command("again", { id: runId })).ok, true);
    const now = new Date().toISOString();
    const claim = await command("begin", { run: { ...base, id: runId, emailId: "m1", status: "running", createdAt: now, updatedAt: now } });
    assert.equal(claim.claimed, true);
    assert.equal(claim.run.createdAt, old);
    assert.equal(claim.run.escalatedAt, old);
    assert.equal(claim.run.acknowledged?.text, "We are checking.");
  } finally { await mf.dispose(); }
});

test("B-130: each closed UTC day gives one support.quality_daily per agent address, once; a day is not reported twice", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { id: "support", input: support });
    const box = "support@project.invalid";
    await command("setup", { mailbox: box, settings: { agent: { id: "support" } }, model: {} });
    const now = Date.parse("2026-10-20T00:10:00.000Z");
    await command("seedThread", { mailbox: box, rows: [{ id: "a", folder: "inbox", date: "2026-10-18T09:00:00.000Z", thread: "t1" },
      { id: "b", folder: "inbox", date: "2026-10-18T10:00:00.000Z", thread: "t2" }, { id: "c", folder: "spam", date: "2026-10-18T10:00:00.000Z", thread: "t3" }] });
    const base = { mailboxId: box, sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    await command("begin", { run: { ...base, id: "agent-" + "a1".repeat(16), emailId: "a", status: "sent", createdAt: "2026-10-18T09:00:10.000Z",
      updatedAt: "2026-10-18T09:01:00.000Z", receivedAt: "2026-10-18T09:00:00.000Z", repliedAt: "2026-10-18T09:01:00.000Z", modelCalls: { calls: 2, failed: 0, recovered: 0 } } });
    const early = await command("quality", { now: Date.parse("2026-10-19T00:10:00.000Z") });
    assert.equal(early.next, Date.parse("2026-10-20T00:05:00.000Z"), "a day is reported a day after it closes, so late replies count");
    const of18 = async () => ((await command("events", {})).events as { kind: string; data: { value: Record<string, any> } }[])
      .filter((e) => e.kind === "support.quality_daily" && e.data.value.date === "2026-10-18");
    assert.equal((await of18()).length, 0, "not yet");
    const first = await command("quality", { now });
    assert.equal(first.next, Date.parse("2026-10-21T00:05:00.000Z"), "the next day settles a day after midnight; looked at five minutes after");
    const events = await of18();
    assert.equal(events.length, 1);
    const v = events[0].data.value;
    assert.equal(v.date, "2026-10-18");
    assert.equal(v.channel, "mail:project.invalid:support");
    assert.equal(v.coverage.turns, 2, "spam apart");
    assert.equal(v.coverage.delivered, 1);
    assert.equal(v.coverage.firstReplyP50Ms, 60_000);
    assert.equal(v.autonomy.answered, 1);
    await command("quality", { now: now + 3_600_000 });
    assert.equal((await of18()).length, 1, "once per day");
  } finally { await mf.dispose(); }
});

test("B-130: a run's sender, subject and texts are removed 30 days after it began; its counts stay", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", reason: "", agentId: "support", agentVersion: 1 };
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString(), fresh = new Date().toISOString();
    const oldId = "agent-" + "c1".repeat(16), freshId = "agent-" + "c2".repeat(16);
    const texts = { sender: "ann@customer.invalid", subject: "My account", question: "Why?", summary: "About an account",
      toolCalls: [{ name: "kb", host: "h", ok: true, ms: 1, result: "private text" }], sent: { to: "ann@customer.invalid", subject: "Re: My account", body: "Hello Ann", outboxId: "o" } };
    await command("begin", { run: { ...base, ...texts, id: oldId, emailId: "m1", status: "sent", createdAt: old, updatedAt: old } });
    await command("begin", { run: { ...base, ...texts, id: freshId, emailId: "m2", status: "sent", createdAt: fresh, updatedAt: fresh } });
    await command("redact", { now: Date.now() });
    const runs = await command("byIds", { ids: [oldId, freshId] }) as Record<string, any>[];
    const gone = runs.find((r) => r.id === oldId)!, kept = runs.find((r) => r.id === freshId)!;
    assert.equal(gone.redacted, true);
    assert.ok(!JSON.stringify(gone).includes("ann@customer.invalid") && !JSON.stringify(gone).includes("private text") && !JSON.stringify(gone).includes("Hello Ann"));
    assert.equal(gone.status, "sent", "counts stay");
    assert.equal(kept.sender, "ann@customer.invalid");
  } finally { await mf.dispose(); }
});

test("B-132: the day's answers are judged once by another vendor, the verdict stays on the run, and the day's event carries the counts", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { id: "support", input: support });
    const box = "support@project.invalid";
    await command("setup", { mailbox: box, settings: { agent: { id: "support" } }, model: {} });
    await command("seedThread", { mailbox: box, rows: [{ id: "a", folder: "inbox", date: "2026-10-18T09:00:00.000Z", thread: "t1" }] });
    const base = { mailboxId: box, sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    const id = "agent-" + "d1".repeat(16);
    await command("begin", { run: { ...base, id, emailId: "a", status: "sent", createdAt: "2026-10-18T09:00:10.000Z", updatedAt: "2026-10-18T09:01:00.000Z",
      model: "xiaomi/mimo-v2.6-pro", checkedBy: "qwen/qwen3.8-flash", repliedAt: "2026-10-18T09:01:00.000Z",
      sent: { to: "x@y.invalid", subject: "Re: s", body: "Open Settings, then Account.", outboxId: "o" } } });
    // A hand-off template and a safe reply are fixed texts, never judged as answers (VoC audit 2026-10-27).
    for (const [n, mark] of [["d2", { handoff: true }], ["d3", { fallback: true }]] as const)
      await command("begin", { run: { ...base, id: "agent-" + n.repeat(16), emailId: n, status: "sent", createdAt: "2026-10-18T09:00:20.000Z", updatedAt: "2026-10-18T09:01:00.000Z",
        ...mark, sent: { to: "x@y.invalid", subject: "Re: s", body: "A person from our team will answer you.", outboxId: "o" + n } } });
    const checks = { language: "PASS", addressed: "PASS", policySafe: "PASS", routing: "PASS", actionable: "FAIL", continuity: "PASS" };
    await command("judgeScript", { script: { verdict: { rubric: "v1", checks, question: true, helped: "partly", note: "no clear step" } } });
    await command("quality", { now: Date.parse("2026-10-20T00:10:00.000Z") });
    const last = await command("judgeLast", {});
    assert.deepEqual(last.models, ["deepseek/deepseek-v4.1-flash"], "neither the writer's vendor nor the checker's");
    assert.equal(last.input.answer, "Open Settings, then Account.");
    const event = ((await command("events", {})).events as { kind: string; data: { value: Record<string, any> } }[]).find((e) => e.kind === "support.quality_daily")!;
    assert.equal(event.data.value.judgeModel, "deepseek/deepseek-v4.1-flash");
    assert.equal(event.data.value.quality.judged, 1);
    assert.equal(event.data.value.quality.helpedPartly, 1);
    assert.equal(event.data.value.quality.actionableFail, 1);
    assert.ok(!event.data.value.notMeasured.includes("quality"));
    assert.ok(!JSON.stringify(event.data).includes("no clear step"), "the judge's note stays on the run");
    const [kept] = await command("byIds", { ids: [id] }) as { judgement?: { note: string } }[];
    assert.equal(kept.judgement?.note, "no clear step");
  } finally { await mf.dispose(); }
});

test("B-132: with no judge, or every call failing, quality is not measured rather than 0", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { id: "support", input: support });
    const box = "support@project.invalid";
    await command("setup", { mailbox: box, settings: { agent: { id: "support" } }, model: {} });
    await command("seedThread", { mailbox: box, rows: [{ id: "a", folder: "inbox", date: "2026-10-18T09:00:00.000Z", thread: "t1" }] });
    await command("begin", { run: { mailboxId: box, sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1,
      id: "agent-" + "d2".repeat(16), emailId: "a", status: "sent", createdAt: "2026-10-18T09:00:10.000Z", updatedAt: "2026-10-18T09:01:00.000Z",
      model: "xiaomi/mimo-v2.6-pro", sent: { to: "x@y.invalid", subject: "Re: s", body: "Hello", outboxId: "o" } } });
    await command("judgeScript", { script: { throw: "judge down" } });
    await command("quality", { now: Date.parse("2026-10-20T00:10:00.000Z") });
    const event = ((await command("events", {})).events as { kind: string; data: { value: Record<string, any> } }[]).find((e) => e.kind === "support.quality_daily")!;
    assert.equal(event.data.value.quality.judged, null);
    assert.ok(event.data.value.notMeasured.includes("quality"));
  } finally { await mf.dispose(); }
});

test("B-152: a judge comparison grades each sent answer with every model and the reference, a slice per call, with no words of the mail in its lines", async () => {
  const { mf, command } = await fixture();
  try {
    const box = "support@project.invalid";
    await command("seedThread", { mailbox: box, rows: [{ id: "a", folder: "inbox", date: "2026-10-18T09:00:00.000Z", thread: "t1" },
      { id: "b", folder: "inbox", date: "2026-10-19T09:00:00.000Z", thread: "t2" }] });
    const base = { mailboxId: box, sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1, model: "xiaomi/mimo-v2.6-pro" };
    const sent = (body: string) => ({ to: "x@y.invalid", subject: "Re: s", body, outboxId: "o" });
    const prod = { rubric: "v1", model: "qwen/qwen3.8-flash", checks: { language: "PASS", addressed: "FAIL", policySafe: "PASS", routing: "PASS", actionable: "PASS", continuity: "PASS" }, question: true, helped: "no", note: "secret note" };
    await command("begin", { run: { ...base, id: "agent-" + "b1".repeat(16), emailId: "a", status: "sent", createdAt: "2026-10-18T09:00:10.000Z", updatedAt: "2026-10-18T09:01:00.000Z", sent: sent("Private answer one"), judgement: prod } });
    await command("begin", { run: { ...base, id: "agent-" + "b2".repeat(16), emailId: "b", status: "sent", createdAt: "2026-10-19T09:00:10.000Z", updatedAt: "2026-10-19T09:01:00.000Z", sent: sent("Private answer two") } });
    await command("begin", { run: { ...base, id: "agent-" + "b3".repeat(16), emailId: "gone", status: "sent", createdAt: "2026-10-19T10:00:10.000Z", updatedAt: "2026-10-19T10:01:00.000Z", sent: sent("Answer to a deleted message") } });
    await command("begin", { run: { ...base, id: "agent-" + "b4".repeat(16), emailId: "a", status: "skipped", createdAt: "2026-10-19T11:00:10.000Z", updatedAt: "2026-10-19T11:01:00.000Z" } });
    await command("begin", { run: { ...base, id: "agent-" + "b5".repeat(16), emailId: "a", status: "sent", createdAt: "2026-08-01T09:00:10.000Z", updatedAt: "2026-08-01T09:01:00.000Z", sent: sent("Too old") } });
    const now = Date.parse("2026-10-24T00:00:00.000Z");
    const options = { models: ["good/model", "bad/model"], reference: "ref/model" };
    const first = await command("bench", { address: "Support@project.invalid", options, now });
    assert.equal(first.total, 9, "three sent answers in 30 days, three models each");
    assert.equal(first.done, false);
    assert.equal(first.graded + first.gone, 6, "one slice of six per call");
    let last = first;
    for (let i = 0; i < 3 && !last.done; i++) last = await command("bench", { address: box, options: {}, now });
    assert.equal(last.done, true);
    assert.equal(last.gone, 3, "the deleted message's three rows are counted, not graded");
    assert.equal(last.lines.length, 6);
    const calls = JSON.parse(JSON.stringify(await command("r2get", { key: "test/bench-calls.json" }))) as { model: string; reasoning: boolean }[];
    assert.ok(calls.every((c) => c.reasoning === (c.model === "ref/model")), "reasoning only for the reference");
    const lines = last.lines as Record<string, any>[];
    const judged = lines.filter((l) => l.prod);
    assert.equal(judged.length, 3);
    assert.deepEqual(judged[0].prod.checks, prod.checks);
    assert.equal(new Set(lines.map((l) => l.turn)).size, 2, "one hash per answer, the same for every model");
    assert.ok(lines.every((l) => /^[0-9a-f]{16}$/.test(l.turn) && l.channel === `mail:${box}` && l.drafter === "xiaomi/mimo-v2.6-pro"));
    assert.equal(lines.filter((l) => l.reference).length, 2);
    assert.ok(lines.every((l) => l.reasoning === l.reference), "each line says whether its model reasoned");
    assert.equal(lines.filter((l) => !l.ok).length, 2, "a model off the rubric is a line with ok false");
    assert.equal(last.costUsd, 0.004);
    const text = JSON.stringify(last);
    for (const word of ["Private answer", "secret note", "x@y.invalid", "agent-"]) assert.ok(!text.includes(word), word);
    const again = await command("bench", { address: box, options: { restart: true, runs: 1, models: ["good/model"], reference: "ref/model" }, now });
    assert.equal(again.total, 2, "restart picks again: the newest answer, one model and the reference");
  } finally { await mf.dispose(); }
});

test("review 2026-10-21: answering a message again keeps when it was received", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    const runId = "agent-" + "ef".repeat(16);
    const first = "2026-10-18T18:20:00.000Z";
    await command("begin", { run: { ...base, id: runId, emailId: "m1", status: "held", createdAt: first, updatedAt: first, receivedAt: first } });
    assert.equal((await command("again", { id: runId })).ok, true);
    const now = new Date().toISOString();
    const claim = await command("begin", { run: { ...base, id: runId, emailId: "m1", status: "running", createdAt: now, updatedAt: now, receivedAt: now } });
    assert.equal(claim.run.receivedAt, first);
  } finally { await mf.dispose(); }
});

test("review 2026-10-21: a reply after midnight counts for the evening's message, and a day is never reported twice for an address", async () => {
  const { mf, command } = await fixture();
  try {
    await command("create", { id: "support", input: support });
    const box = "support@project.invalid";
    await command("setup", { mailbox: box, settings: { agent: { id: "support" } }, model: {} });
    await command("seedThread", { mailbox: box, rows: [{ id: "a", folder: "inbox", date: "2026-10-18T23:30:00.000Z", thread: "t1" }] });
    const base = { mailboxId: box, sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    await command("begin", { run: { ...base, id: "agent-" + "7b".repeat(16), emailId: "a", status: "sent", createdAt: "2026-10-18T23:30:10.000Z",
      updatedAt: "2026-10-19T01:30:00.000Z", receivedAt: "2026-10-18T23:30:00.000Z", repliedAt: "2026-10-19T01:30:00.000Z", modelCalls: { calls: 1, failed: 0, recovered: 0 } } });
    const now = Date.parse("2026-10-20T00:10:00.000Z");
    await command("quality", { now });
    // A pass cut off after the event was written and before the day was recorded runs again.
    await command("forgetQualityDay", {});
    await command("quality", { now });
    const events = ((await command("events", {})).events as { kind: string; data: { value: Record<string, any> } }[]).filter((e) => e.kind === "support.quality_daily");
    assert.equal(events.length, 1, "once per day and address");
    assert.equal(events[0].data.value.coverage.delivered, 1);
    assert.equal(events[0].data.value.coverage.firstReplyP50Ms, 2 * 3_600_000);
  } finally { await mf.dispose(); }
});

// ── B-141: review 2026-10-21 of the reply lanes ──

const b141 = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
const rid = (name: string) => "agent-" + name.replace(/[^0-9a-f]/g, "0").padEnd(32, "0").slice(0, 32);

test("B-141: a run that failed before anything was sent, and one the safety check skipped, are escalated once at 4 hours; an old failure is not", async () => {
  const { mf, command } = await fixture();
  try {
    const box = b141.mailboxId;
    const now = Date.now();
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    await command("seedThread", { mailbox: box, rows: [{ id: "answered", folder: "inbox", date: at(6), thread: "t-a" }, { id: "reply", folder: "sent", date: at(1), thread: "t-a" },
      { id: "model", folder: "inbox", date: at(6), thread: "t-m" }, { id: "steer", folder: "inbox", date: at(6), thread: "t-s" }, { id: "legacy", folder: "inbox", date: at(6), thread: "t-l" }] });
    await command("begin", { run: { ...b141, id: rid("model"), emailId: "model", status: "failed", failure: "model", createdAt: at(5), updatedAt: at(5) } });
    await command("begin", { run: { ...b141, id: rid("steer"), emailId: "steer", status: "skipped", injection: true, createdAt: at(5), updatedAt: at(5) } });
    await command("begin", { run: { ...b141, id: rid("answered"), emailId: "answered", status: "failed", failure: "safety", createdAt: at(5), updatedAt: at(5) } });
    await command("begin", { run: { ...b141, id: rid("legacy"), emailId: "legacy", status: "failed", createdAt: at(5), updatedAt: at(5) } });
    await command("supervise", { now });
    await command("supervise", { now });
    const waiting = ((await command("events", {})).events as { kind: string; text: string; data: { value: { runId: string } } }[]).filter((e) => e.kind === "agent.waiting");
    assert.deepEqual(waiting.map((e) => e.data.value.runId).sort(), [rid("model"), rid("steer")].sort());
    assert.match(waiting.find((e) => e.data.value.runId === rid("model"))!.text, /after an agent error/);
    assert.match(waiting.find((e) => e.data.value.runId === rid("steer"))!.text, /safety check/);
  } finally { await mf.dispose(); }
});

test("B-141: a run that failed before anything was sent is tried again an hour later; a failure from before the mark is not", async () => {
  const { mf, command } = await fixture();
  try {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    await command("begin", { run: { ...b141, id: rid("due"), emailId: "due", status: "failed", failure: "model", createdAt: at(2), updatedAt: at(1.5) } });
    await command("begin", { run: { ...b141, id: rid("soon"), emailId: "soon", status: "failed", failure: "safety", createdAt: at(2), updatedAt: at(0.5) } });
    await command("begin", { run: { ...b141, id: rid("legacy"), emailId: "legacy", status: "failed", createdAt: at(2), updatedAt: at(1.5) } });
    await command("begin", { run: { ...b141, id: rid("unknown"), emailId: "unknown", status: "send_unknown", createdAt: at(2), updatedAt: at(1.5) } });
    const r = await command("retry-held", { now });
    assert.equal(r.queue, 1, "only the marked failure that is due");
    assert.equal(r.next, Date.parse(at(0.5)) + 3_600_000);
  } finally { await mf.dispose(); }
});

test("B-141: a held run is answered again at once when its knowledge changed, and its due try is skipped while the knowledge is the same", async () => {
  const { mf, command } = await fixture();
  try {
    const endpoint = "https://kb.project.invalid/mcp";
    const now = Date.now();
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const heldFacts = { agent: "support@1", revisions: { [endpoint]: "r1" } };
    await command("begin", { run: { ...b141, id: rid("moved"), emailId: "moved", status: "held", heldFacts, createdAt: at(3), updatedAt: at(2) } });
    await command("seedFacts", { rows: [{ endpoint, revision: "r2", at: now - 3_600_000 }] });
    let r = await command("retry-held", { now });
    assert.equal(r.queue, 1, "not due for ten more hours, but the knowledge moved: answered again now");
    const [moved] = await command("byIds", { ids: [rid("moved")] }) as { heldFacts?: unknown; attempt?: number }[];
    assert.deepEqual(moved.heldFacts, heldFacts, "an automatic retry keeps what it compares with");

    const fresh = await fixture();
    try {
      await fresh.command("begin", { run: { ...b141, id: rid("same"), emailId: "same", status: "held", heldFacts, createdAt: at(20), updatedAt: at(13) } });
      await fresh.command("seedFacts", { rows: [{ endpoint, revision: "r1", at: now - 3_600_000 }] });
      r = await fresh.command("retry-held", { now });
      assert.equal(r.queue, 0, "due, but a later run saw the same revision: nothing is called");
      assert.ok(Math.abs(r.next - (now + 12 * 3_600_000)) < 1000, "the next try moves on by its interval");
      // Without a later sighting the try goes ahead, and the runner compares the revision itself.
      await fresh.command("begin", { run: { ...b141, id: rid("unseen"), emailId: "unseen", status: "held", heldFacts: { agent: "support@1", revisions: { "https://other.project.invalid/mcp": "r1" } }, createdAt: at(20), updatedAt: at(13) } });
      assert.equal((await fresh.command("retry-held", { now })).queue, 1);
      // A person's answer again drops the comparison.
      await fresh.command("begin", { run: { ...b141, id: rid("person"), emailId: "person", status: "held", heldFacts, createdAt: at(2), updatedAt: at(1) } });
      assert.equal((await fresh.command("again", { id: rid("person") })).run.heldFacts, undefined);
    } finally { await fresh.mf.dispose(); }
  } finally { await mf.dispose(); }
});

test("B-153: a held message on an auto agent that holds gets one second look 30 minutes later, never twice, at most 20 a day", async () => {
  const look = async (policy: Record<string, unknown>, runs: [string, number][]) => {
    const f = await fixture();
    await f.command("create", { id: "support", input: { ...support, replyPolicy: { ...support.replyPolicy, ...policy } } });
    const now = Date.now();
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    for (const [id, min] of runs) await f.command("begin", { run: { ...b141, id: rid(id), emailId: id, status: "held", createdAt: at(min), updatedAt: at(min) } });
    return { ...f, now };
  };
  const { mf, command, now } = await look({ holdUnsure: true }, [["due", 31], ["soon", 10]]);
  try {
    let r = await command("retry-held", { now });
    assert.equal(r.queue, 1, "the one held 31 minutes ago");
    assert.ok(Math.abs(r.next - (now - 10 * 60_000 + 30 * 60_000)) < 1000, "the other's look is the next thing due");
    const [due] = await command("byIds", { ids: [rid("due")] }) as { secondLook?: { state: string; firstCited: string[] } }[];
    assert.equal(due.secondLook?.state, "running");
    assert.deepEqual(due.secondLook?.firstCited, []);
    await command("save", { run: { ...(await command("byIds", { ids: [rid("due")] }))[0], status: "held", secondLook: { ...due.secondLook, state: "done", cause: "data", rescued: false } } });
    r = await command("retry-held", { now: now + 60 * 60_000 });
    assert.equal(r.queue, 2, "the other one's look comes due; the first, held again after its look, gets no second");
    const [again] = await command("byIds", { ids: [rid("due")] }) as { secondLook?: { state: string } }[];
    assert.equal(again.secondLook?.state, "done");
  } finally { await mf.dispose(); }
  for (const policy of [{ holdUnsure: true, secondLook: false }, { holdUnsure: false }, { holdUnsure: true, mode: "draft" }]) {
    const f = await look(policy, [["due", 31]]);
    try { assert.equal((await f.command("retry-held", { now: f.now })).queue, 0, JSON.stringify(policy)); } finally { await f.mf.dispose(); }
  }
  const many = await look({ holdUnsure: true }, Array.from({ length: 22 }, (_, i) => [`m${i.toString(16)}`, 40 + i] as [string, number]));
  try { assert.equal((await many.command("retry-held", { now: many.now })).queue, 20, "at most 20 a day"); } finally { await many.mf.dispose(); }
});

test("B-189: a person grades a sent answer blind; the calibration compares it with the judge per check", async () => {
  const { mf, command } = await fixture();
  try {
    const now = Date.now();
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const pass = { language: "PASS", addressed: "PASS", policySafe: "PASS", routing: "PASS", actionable: "PASS", continuity: "PASS" };
    const judgement = { rubric: "v1", model: "deepseek/deepseek-v4.1-flash", checks: pass, question: true, helped: "yes", note: "fine" };
    const sent = { to: "x@y.invalid", subject: "Re: s", body: "Open Settings, then Privacy.", outboxId: "o" };
    await command("begin", { run: { ...b141, id: rid("a1"), emailId: "a1", status: "sent", sent, judgement, createdAt: at(5), updatedAt: at(5) } });
    await command("begin", { run: { ...b141, id: rid("a2"), emailId: "a2", status: "sent", sent, createdAt: at(1), updatedAt: at(1) } });
    await command("begin", { run: { ...b141, id: rid("a3"), emailId: "a3", status: "sent", sent, judgement, redacted: true, createdAt: at(3), updatedAt: at(3) } });
    await command("begin", { run: { ...b141, id: rid("a4"), emailId: "a4", status: "held", createdAt: at(2), updatedAt: at(2) } });
    let list = await command("toGrade", { now }) as Record<string, unknown>[];
    assert.deepEqual(list.map((r) => r.runId), [rid("a1"), rid("a2")], "judged first, then the newest; not a redacted or unsent run");
    assert.equal(list[0].answer, sent.body);
    assert.ok(!JSON.stringify(list).includes("deepseek"), "no judge verdict in the list");
    const grade = { rubric: "v1", checks: { ...pass, actionable: "FAIL" }, helped: "partly", by: "owner@owner.example", kind: "person", at: at(0) };
    assert.equal((await command("grade", { id: rid("a4"), grade })).status, 409, "a held run has no answer to grade");
    assert.equal((await command("grade", { id: rid("zz"), grade })).status, 404);
    assert.equal((await command("grade", { id: rid("a1"), grade })).ok, true);
    await command("grade", { id: rid("a2"), grade: { ...grade, kind: "relayed", by: "key:ops", source: "chat 2026-10-27" } });
    list = await command("toGrade", { now }) as Record<string, unknown>[];
    assert.deepEqual(list, [], "graded runs leave the list");
    const cal = await command("calibration", { now });
    assert.equal(cal.graded, 1, "one pair: the other graded run was never judged");
    assert.equal(cal.notJudged, 1);
    assert.equal(cal.byPerson, 1);
    assert.deepEqual({ ...cal.checks.actionable, kappa: undefined }, { pairs: 1, agree: 0, judgeHigher: 1, judgeLower: 0, naDiffers: 0, rate: 0, kappa: undefined, small: true });
    assert.equal(cal.checks.language.agree, 1);
    assert.equal(cal.helped.judgeHigher, 1);
    assert.deepEqual(cal.judgeModels, ["deepseek/deepseek-v4.1-flash"]);
  } finally { await mf.dispose(); }
});

test("B-153: a held message is answered again once the knowledge owner closes its gap; the list is read again only on a new ledger revision", async () => {
  const { mf, command } = await fixture();
  try {
    const kb = { name: "acme_kb", description: "Search the knowledge base", endpoint: "https://tools.project.invalid/mcp", tool: "kb.query",
      gaps: { tool: "kb.gaps.submit", list: "kb.gaps.list" } };
    const saved = await command("create", { id: "support", input: { ...support, tools: [kb] } });
    assert.deepEqual(saved.tools[0].gaps, kb.gaps);
    const now = Date.now();
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const held = (name: string, extra: Record<string, unknown> = {}) => ({ ...b141, id: rid(name), emailId: name, status: "held",
      gapsReported: ["unanswered"], createdAt: at(3), updatedAt: at(2), ...extra });
    await command("begin", { run: held("closed") });
    await command("begin", { run: held("open") });
    await command("begin", { run: held("other", { agentId: "elsewhere" }) });
    const reqOf = (name: string) => `${rid(name)}-0123456789ab`;
    const gaps = [
      { id: 7, requestId: reqOf("closed"), state: "closed", closedBy: { item: "fact:hidden-chats" } },
      { id: 8, requestId: reqOf("open"), state: "reported", closedBy: null },
      { id: 9, requestId: "someone-else-0123456789ab", state: "closed", closedBy: { item: "fact:x" } },
    ];
    await command("r2put", { key: "test/gap-list.json", text: JSON.stringify({ tool: "kb.gaps.list", revision: "r1", gaps }) });
    let r = await command("gaps", { now });
    assert.equal(r.next, now + 15 * 60_000);
    const byId = async (...names: string[]) => { const runs = await command("byIds", { ids: names.map(rid) }) as { id: string; gapClosed?: { item: string }; attempt?: number }[];
      return names.map((n) => runs.find((x) => x.id === rid(n))!); };
    const [closed, open] = await byId("closed", "open");
    assert.equal(closed.attempt, 2, "answered again (the fixture's queue runs it at once)");
    assert.deepEqual(closed.gapClosed, { at: new Date(now).toISOString(), item: "fact:hidden-chats", revision: "r1" });
    assert.equal(open.attempt, undefined, "its gap is still open");
    // The same revision 15 minutes later: one call asks it, nothing is read again.
    await command("r2put", { key: "test/gap-calls.json", text: "[]" });
    r = await command("gaps", { now: now + 15 * 60_000 });
    assert.deepEqual(await command("r2get", { key: "test/gap-calls.json" }), [{ limit: 1 }]);
    // Before it is due nothing is asked.
    await command("r2put", { key: "test/gap-calls.json", text: "[]" });
    await command("gaps", { now: now + 16 * 60_000 });
    assert.deepEqual(await command("r2get", { key: "test/gap-calls.json" }), []);
    // A new revision closes the other one.
    await command("r2put", { key: "test/gap-list.json", text: JSON.stringify({ tool: "kb.gaps.list", revision: "r2", gaps: [gaps[0], { ...gaps[1], state: "answered", closedBy: { item: "wiki:faq.md#2" } }] }) });
    await command("gaps", { now: now + 31 * 60_000 });
    const [openNow, closedNow] = await byId("open", "closed");
    assert.equal(openNow.attempt, 2);
    assert.equal(closedNow.attempt, 2, "a closed gap answers a message again once");
    assert.equal(openNow.gapClosed?.item, "wiki:faq.md#2");
  } finally { await mf.dispose(); }
});

test("B-153: a gap list the key may not read is left alone for six hours, and no held run moves", async () => {
  const { mf, command } = await fixture();
  try {
    const kb = { name: "acme_kb", description: "Search", endpoint: "https://tools.project.invalid/mcp", tool: "kb.query", gaps: { tool: "kb.gaps.submit", list: "kb.gaps.list" } };
    await command("create", { id: "support", input: { ...support, tools: [kb] } });
    const now = Date.now();
    await command("begin", { run: { ...b141, id: rid("h"), emailId: "h", status: "held", gapsReported: ["unanswered"], createdAt: new Date(now - 3_600_000).toISOString(), updatedAt: new Date(now - 3_600_000).toISOString() } });
    await command("r2put", { key: "test/gap-list.json", text: JSON.stringify({ tool: "kb.gaps.list", throw: "not-found: kb.gaps.list" }) });
    await command("gaps", { now });
    await command("r2put", { key: "test/gap-calls.json", text: "[]" });
    await command("gaps", { now: now + 3 * 3_600_000 });
    assert.deepEqual(await command("r2get", { key: "test/gap-calls.json" }), [], "not asked again within six hours");
    await command("gaps", { now: now + 7 * 3_600_000 });
    assert.equal((await command("r2get", { key: "test/gap-calls.json" })).length, 1, "asked again after");
    const [run] = await command("byIds", { ids: [rid("h")] }) as { status: string }[];
    assert.equal(run.status, "held");
  } finally { await mf.dispose(); }
});

test("B-141: day 30: a held message gets one closing reply naming another route and a second agent.waiting; a drafting address sends nothing", async () => {
  const { mf, command } = await fixture();
  try {
    const box = "support@project.invalid";
    const policy = { mode: "auto", holdUnsure: true, dailySendLimit: 20, allowedIntents: [],
      handoff: { categories: [], topics: [], reply: { en: "Write to @help_manager in Telegram.", ru: "Напишите @help_manager в Telegram." } } };
    await command("create", { id: "support", input: { ...support, replyPolicy: policy } });
    await command("setup", { mailbox: box, settings: { agent: { id: "support" } }, model: {} });
    const now = Date.now();
    const at = (d: number) => new Date(now - d * 86_400_000).toISOString();
    await command("seedThread", { mailbox: box, rows: [{ id: "old", folder: "inbox", date: at(30.1), thread: "t-old" }, { id: "older", folder: "inbox", date: at(40), thread: "t-older" },
      { id: "young", folder: "inbox", date: at(10), thread: "t-young" }] });
    const run = (id: string, days: number) => ({ ...b141, mailboxId: box, id: rid(id), emailId: id, status: "held", escalatedAt: at(days), createdAt: at(days), updatedAt: at(1) });
    await command("begin", { run: run("old", 30.1) });
    await command("begin", { run: run("older", 40) });
    await command("begin", { run: run("young", 10) });
    const first = await command("close", { now });
    const sent = await command("sent", { mailbox: box }) as { subject: string }[];
    assert.equal(sent.length, 1, "one closing reply, for the message whose retries just ended");
    const [closed] = await command("byIds", { ids: [rid("old")] }) as { closedAt?: string; closing?: { status: string } }[];
    assert.ok(closed.closedAt);
    assert.equal(closed.closing?.status, "accepted");
    const events = ((await command("events", {})).events as { kind: string; data: { value: { runId: string; closed?: boolean; closingSent?: boolean } } }[]).filter((e) => e.kind === "agent.waiting");
    assert.deepEqual(events.map((e) => [e.data.value.runId, e.data.value.closed, e.data.value.closingSent]), [[rid("old"), true, true]]);
    assert.ok(Math.abs(first.next - (Date.parse(at(10)) + 30 * 86_400_000)) < 1000, "the next is the young one's day 30");
    await command("close", { now: now + 1000 });
    assert.equal((await command("sent", { mailbox: box })).length, 1, "once");
    const [older] = await command("byIds", { ids: [rid("older")] }) as { closedAt?: string }[];
    assert.equal(older.closedAt, undefined, "a backlog from before the rule is left alone");
    // A drafting address: closed and escalated, nothing sent.
    await command("update", { id: "support", input: { ...support, replyPolicy: { ...policy, mode: "draft" } }, expected: 1 });
    await command("seedThread", { mailbox: box, rows: [{ id: "drafty", folder: "inbox", date: at(30.1), thread: "t-d" }] });
    await command("begin", { run: run("drafty", 30.1) });
    await command("close", { now });
    assert.equal((await command("sent", { mailbox: box })).length, 1);
    const [drafty] = await command("byIds", { ids: [rid("drafty")] }) as { closing?: { status: string } }[];
    assert.equal(drafty.closing?.status, "not_sent");
  } finally { await mf.dispose(); }
});

test("B-137: agent events go to a webhook in order, signed, from after the hook was made; a refusal waits and an event refused 8 times is passed over", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [], agentId: "support", agentVersion: 1 };
    const at = new Date().toISOString();
    const run = (n: string, status: string, extra: Record<string, unknown> = {}) => ({ ...base, id: "agent-" + n.repeat(32).slice(0, 32), emailId: "m" + n, status: "running", createdAt: at, updatedAt: at, ...extra, final: status });
    // An event from before the hook: never sent.
    const old = run("1", "failed");
    await command("begin", { run: { ...old, status: "running" } });
    await command("save", { run: { ...old, status: "failed" } });
    const hook = { id: "hook-0000aaaa", url: "https://hooks.example/fabric", kinds: ["agent.needs_look", "agent.handoff"], secret: "s3cret", createdAt: at };
    await command("r2put", { key: "config/event-hooks.json", text: JSON.stringify({ hooks: [hook] }) });
    const now = Date.now();
    assert.equal((await command("hooks", { now })).next, null, "the first pass only places the hook after the history");
    assert.deepEqual(await command("r2get", { key: "test/hook-calls.json" }), null);
    // Two new events: one of its kinds, one not.
    for (const [n, status] of [["2", "failed"], ["3", "sent"]] as const) {
      const r = run(n, status);
      await command("begin", { run: { ...r, status: "running" } });
      await command("save", { run: { ...r, status, ...(status === "sent" ? { sent: { to: "x@y.invalid", subject: "Re: s", body: "Hi", outboxId: "o" } } : {}) } });
    }
    await command("hooks", { now });
    const calls = await command("r2get", { key: "test/hook-calls.json" }) as { url: string; headers: Record<string, string>; body: string }[];
    assert.equal(calls.length, 1, "only the kinds it asked for");
    assert.equal(calls[0].url, "https://hooks.example/fabric");
    const event = JSON.parse(calls[0].body);
    assert.equal(event.kind, "agent.needs_look");
    assert.equal(calls[0].headers["X-Fabric-Event-Id"], event.id);
    const { createHmac } = await import("node:crypto");
    assert.equal(calls[0].headers["X-Fabric-Signature"], "sha256=" + createHmac("sha256", "s3cret").update(`${calls[0].headers["X-Fabric-Timestamp"]}.${calls[0].body}`).digest("hex"));
    // A refusal: tried again later, then passed over after 8 tries.
    await command("r2put", { key: "test/hook.json", text: JSON.stringify({ status: 500 }) });
    const r4 = run("4", "failed");
    await command("begin", { run: { ...r4, status: "running" } });
    await command("save", { run: { ...r4, status: "failed" } });
    let next = (await command("hooks", { now })).next;
    assert.equal(next, now + 60_000, "the first retry a minute later");
    assert.equal((await command("hookStates", { ids: [hook.id] }))[hook.id].attempts, 1);
    let t = now;
    for (let i = 0; i < 7; i++) { t = next; next = (await command("hooks", { now: t })).next ?? t; }
    const state = (await command("hookStates", { ids: [hook.id] }))[hook.id];
    assert.equal(state.attempts, 0, "passed over after 8 tries");
    assert.equal(state.lastError, "HTTP 500");
    assert.equal((await command("r2get", { key: "test/hook-calls.json" }) as unknown[]).length, 9, "one delivery, then eight refused tries");
  } finally { await mf.dispose(); }
});

test("B-87: model calls per day and model come from each run's own count, the checker apart from the writer", async () => {
  const { mf, command } = await fixture();
  try {
    const base = { mailboxId: "a@project.invalid", sender: "x@y.invalid", subject: "s", reason: "r", toolCalls: [], agentId: "support", agentVersion: 1, status: "sent" };
    const at = (d: string) => ({ createdAt: `2026-10-${d}T08:00:00.000Z`, updatedAt: `2026-10-${d}T08:00:00.000Z` });
    await command("begin", { run: { ...base, ...at("21"), id: "a", emailId: "a", model: "w/one", checkedBy: "c/two", modelCalls: { calls: 3, failed: 1, recovered: 1 } } });
    await command("begin", { run: { ...base, ...at("21"), id: "b", emailId: "b", model: "w/one", modelCalls: { calls: 1, failed: 0, recovered: 0 } } });
    // Before B-130 a run counted nothing: one writer call, one check when it names a checker.
    await command("begin", { run: { ...base, ...at("22"), id: "c", emailId: "c", model: "w/one", checkedBy: "c/two" } });
    // A run that called no model (a hand-off before the model, a skip) counts nothing.
    await command("begin", { run: { ...base, ...at("22"), id: "d", emailId: "d", status: "skipped" } });
    await command("begin", { run: { ...base, ...at("10"), id: "e", emailId: "e", model: "w/one", modelCalls: { calls: 1, failed: 0, recovered: 0 } } });
    // B-147: a run with receipts counts them, tokens and charge included; an unmeasured one adds no tokens.
    await command("begin", { run: { ...base, ...at("22"), id: "f", emailId: "f", model: "w/one", modelCalls: { calls: 2, failed: 1, recovered: 1 },
      usage: [{ model: "w/one", inputTokens: 0, outputTokens: 0, costUsd: null, measured: false }, { model: "w/three", inputTokens: 1500, outputTokens: 60, costUsd: 0.0021, measured: true }] } });
    const plain = (day: string, model: string, calls: number) => ({ day, model, calls, unpricedCalls: calls, unmeasuredCalls: calls, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    assert.deepEqual(await command("modelCalls", { since: "2026-10-15T00:00:00.000Z" }), [
      plain("2026-10-21", "c/two", 1), plain("2026-10-21", "w/one", 3),
      plain("2026-10-22", "c/two", 1), plain("2026-10-22", "w/one", 2),
      { day: "2026-10-22", model: "w/three", calls: 1, unpricedCalls: 0, unmeasuredCalls: 0, inputTokens: 1500, outputTokens: 60, costUsd: 0.0021 },
    ]);
  } finally { await mf.dispose(); }
});

test("A-2, A-3: a held message released after its hold ran out is answered again, as a fresh attempt whose tools may act", async () => {
  const { mf, command } = await fixture();
  try {
    const now = new Date().toISOString();
    const run = { id: "run-a2", mailboxId: "a@project.invalid", emailId: "e-a2", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [],
      agentId: "support", agentVersion: 1, status: "running", createdAt: now, updatedAt: now };
    assert.equal((await command("begin", { run })).claimed, true);
    await command("save", { run: { ...run, status: "skipped", injection: true, reason: "Held for review by the safety check" } });
    await command("release", { mailbox: "a@project.invalid", emailId: "e-a2" });
    const [after] = await command("byIds", { ids: ["run-a2"] });
    assert.equal(after.injection, undefined, "no longer the held skip");
    assert.equal(after.attempt, 2, "queued again");
    const again = await command("begin", { run: { ...run, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    assert.deepEqual([again.claimed, again.run.rerun], [true, false], "answered again on purpose is not an interrupted re-run");
    // A message whose run was not a safety skip is not woken by a late release.
    await command("save", { run: { ...run, id: "run-a2", status: "skipped", reason: "spam" } });
    await command("release", { mailbox: "a@project.invalid", emailId: "e-a2" });
    assert.equal((await command("byIds", { ids: ["run-a2"] }))[0].status, "skipped");
  } finally { await mf.dispose(); }
});

test("A-7: a run answered again whose message is gone ends as skipped with the reason, not 'running' for good", async () => {
  const { mf, command } = await fixture();
  try {
    const now = new Date().toISOString();
    const id = await command("runId", { mailbox: "gone@project.invalid", emailId: "e-gone" });
    const run = { id, mailboxId: "gone@project.invalid", emailId: "e-gone", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [],
      agentId: "support", agentVersion: 1, status: "running", createdAt: now, updatedAt: now };
    await command("begin", { run });
    await command("save", { run: { ...run, status: "drafted" } });
    assert.equal((await command("again", { id })).ok, true);
    const pumped = await command("pump");
    const [after] = await command("byIds", { ids: [id] });
    assert.equal(pumped.queue, 0);
    assert.equal(after.status, "skipped");
    assert.match(after.reason, /no longer there/);
  } finally { await mf.dispose(); }
});

test("A-5: the registry says whether the address's agent sent an answer in a conversation after a moment", async () => {
  const { mf, command } = await fixture();
  try {
    const at = (ms: number) => new Date(ms).toISOString();
    const run = { id: "run-a5", mailboxId: "gmail:a1", emailId: "e1", sender: "x@y.invalid", subject: "s", reason: "", toolCalls: [],
      agentId: "support", agentVersion: 1, status: "running", threadId: "t-1", createdAt: at(1000), updatedAt: at(1000) };
    await command("begin", { run });
    await command("save", { run: { ...run, status: "sent" } });
    const since = Date.now() - 60_000;
    assert.equal(await command("sentAfter", { mailbox: "gmail:a1", thread: "t-1", since }), true);
    assert.equal(await command("sentAfter", { mailbox: "gmail:a1", thread: "t-2", since }), false);
    assert.equal(await command("sentAfter", { mailbox: "gmail:a1", thread: "t-1", since: Date.now() + 60_000 }), false, "not after a later message");
  } finally { await mf.dispose(); }
});
