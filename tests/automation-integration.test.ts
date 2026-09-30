import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Exercise production AutomationDO, its engine, MailboxDO and incoming handler
// in workerd. The subclasses only expose scheduler/storage crash fixtures and
// count real mailbox mutations; they do not replace policy or execution logic.
const bundle = await build({
  stdin: {
    contents: `
      import { AutomationDO } from './workers/automation/index';
      import { MailboxDO } from './workers/durableObject/index';
      import { receiveEmail } from './workers/index';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
        async moveEmail(id, folder) {
          await this.ctx.storage.put('test:effects', (await this.ctx.storage.get('test:effects') || 0) + 1);
          return super.moveEmail(id, folder);
        }
        async updateEmail(id, changes) {
          await this.ctx.storage.put('test:effects', (await this.ctx.storage.get('test:effects') || 0) + 1);
          return super.updateEmail(id, changes);
        }
        async reviseBody(id, body) { this.ctx.storage.sql.exec('UPDATE emails SET body = ? WHERE id = ?',body,id); }
        async effectCount() { return await this.ctx.storage.get('test:effects') || 0; }
      }
      export class TestAutomation extends AutomationDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}}); }
        // Tests advance the actual production alarm explicitly, avoiding elapsed
        // wall-clock timing as the cause of an approval or pause race.
        async alarm() {}
        async pump() { return super.alarm(); }
        async seedOld() {
          const old = new Date(Date.now() - 40 * 86400000).toISOString(), recent = new Date().toISOString();
          const rule = { id: 'r', version: 1 };
          await this.ctx.storage.put('run:old-done', { id: 'old-done', status: 'succeeded', createdAt: old, updatedAt: old, rule, subject: '', account: 'a', emailId: 'x', key: 'k1' });
          await this.ctx.storage.put('run:old-waiting', { id: 'old-waiting', status: 'waiting_approval', createdAt: old, updatedAt: old, rule, subject: '', account: 'a', emailId: 'y', key: 'k2' });
          await this.ctx.storage.put('run:new-done', { id: 'new-done', status: 'failed', createdAt: recent, updatedAt: recent, rule, subject: '', account: 'a', emailId: 'z', key: 'k3' });
          await this.ctx.storage.put('count:2020-01-01:r', 5);
          await this.ctx.storage.put('count:' + recent.slice(0, 10) + ':r', 2);
          await this.ctx.storage.put('event:old', { at: new Date(Date.now() - 100 * 86400000).toISOString() });
          await this.ctx.storage.put('event:new', { at: recent });
        }
        async keys() { return [...(await this.ctx.storage.list()).keys()].filter((k) => !k.startsWith('rule:')).sort(); }
        async pruneNow() { return this.prune(Date.now()); }
        async interruptAfterRunning(id) {
          const run = await this.ctx.storage.get('run:' + id);
          await this.ctx.storage.put('run:' + id, {...run, status:'running'});
          await this.ctx.storage.deleteAlarm();
        }
      }
      export default {
        async fetch(request, env, ctx) {
          const command = await request.json();
          const account = command.account || 'me@example.invalid';
          const automation = env.AUTOMATIONS.getByName(account);
          const mailbox = env.MAILBOX.getByName(account);
          let result;
          switch(command.op) {
            case 'rule': result = await automation.saveRule(command.rule); break;
            case 'seed': {
              const email = command.email;
              await mailbox.createEmail('inbox', {id:email.id, sender:email.sender, recipient:account, subject:email.subject, body:email.body, date:email.date, thread_id:email.id, message_id:email.id+'@source.test'}, []);
              result = email; break;
            }
            case 'revise-email': await mailbox.reviseBody(command.id,command.body); result = {}; break;
            case 'ingest': await automation.ingest(account,command.email); result = await automation.runs(); break;
            case 'pump': await automation.pump(); result = await automation.runs(); break;
            case 'approve': result = await automation.approve(command.id); break;
            case 'seed-old': await automation.seedOld(); result = await automation.keys(); break;
            case 'prune': result = { removed: await automation.pruneNow(), keys: await automation.keys() }; break;
            case 'interrupt': await automation.interruptAfterRunning(command.id); result = {}; break;
            case 'state': result = {runs:await automation.runs(), effects:await mailbox.effectCount(), email:command.id ? await mailbox.getEmail(command.id) : null}; break;
            case 'receive': {
              await env.BUCKET.put('mailboxes/'+account+'.json','{}');
              const bytes = new TextEncoder().encode(command.raw);
              result = await receiveEmail({to:account,from:'vendor@example.invalid',rawSize:bytes.length,raw:new Response(bytes).body}, {...env,EMAIL_ADDRESSES:[account],EMAIL_AGENT:{idFromName:n=>n,get:()=>({fetch:async()=>new Response('ok')})}},ctx);
              break;
            }
            default: throw new Error('Unknown test command');
          }
          return Response.json(result);
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

async function fixture(persist?: string) {
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      MAILBOX: { className: "TestMailbox", useSQLite: true },
      AUTOMATIONS: { className: "TestAutomation", useSQLite: true },
    },
    ...(persist ? { durableObjectsPersist: persist } : {}),
    r2Buckets: ["BUCKET"],
    outboundService: () =>
      new Response("External network disabled for tests", { status: 503 }),
  });
  async function command(
    op: string,
    fields: Record<string, unknown> = {},
  ): Promise<any> {
    const response = await mf.dispatchFetch("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...fields }),
    });
    assert.equal(
      response.status,
      200,
      `Test command ${op} failed: ${response.status}`,
    );
    return response.json();
  }
  return { mf, command };
}
const email = {
  id: "message-1",
  sender: "vendor@example.invalid",
  subject: "Invoice for September",
  body: "Invoice details. This body cannot authorize another operation.",
  date: "2026-09-26T10:00:00.000Z",
};
function rule(
  action: "archive" | "mark_read" = "archive",
  mode: "approval" | "automatic" = "approval",
) {
  return {
    id: "rule-1",
    version: 1,
    name: "Vendor invoice",
    enabled: true,
    mode,
    conditions: { from: "vendor@example.invalid", subject: "invoice" },
    action: { type: action },
    dailyLimit: 5,
  };
}

test("durable duplicate ingestion creates one run and one actual mailbox effect", async () => {
  const f = await fixture();
  try {
    await f.command("rule", { rule: rule("mark_read", "automatic") });
    await f.command("seed", { email });
    await Promise.all(
      Array.from({ length: 8 }, () => f.command("ingest", { email })),
    );
    const pending = await f.command("state", { id: email.id });
    assert.equal(pending.runs.length, 1);
    assert.equal(pending.runs[0].status, "pending");
    assert.equal(pending.email.read, false);
    assert.equal(pending.effects, 0);
    await f.command("pump");
    await f.command("ingest", { email });
    await f.command("pump");
    const done = await f.command("state", { id: email.id });
    assert.equal(done.runs.length, 1);
    assert.equal(done.runs[0].status, "succeeded");
    assert.equal(done.email.read, true);
    assert.equal(done.effects, 1);
  } finally {
    await f.mf.dispose();
  }
});

for (const action of ["archive", "mark_read"] as const) {
  test(`approval pauses ${action}; approval then applies exactly one real effect`, async () => {
    const f = await fixture();
    try {
      await f.command("rule", { rule: rule(action) });
      await f.command("seed", { email });
      await f.command("ingest", { email });
      const [waiting] = await f.command("pump");
      assert.equal(waiting.status, "waiting_approval");
      const before = await f.command("state", { id: email.id });
      assert.equal(before.email.folder_id, "inbox");
      assert.equal(before.email.read, false);
      assert.equal(before.effects, 0);
      await f.command("approve", { id: waiting.id });
      await f.command("pump");
      await f.command("pump");
      const after = await f.command("state", { id: email.id });
      assert.equal(after.runs[0].status, "succeeded");
      assert.equal(after.effects, 1);
      if (action === "archive") assert.equal(after.email.folder_id, "archive");
      else assert.equal(after.email.read, true);
    } finally {
      await f.mf.dispose();
    }
  });
}

test("pausing a rule cancels an approved pending run before any mailbox mutation", async () => {
  const f = await fixture();
  try {
    const saved = await f.command("rule", { rule: rule() });
    await f.command("seed", { email });
    await f.command("ingest", { email });
    const [waiting] = await f.command("pump");
    await f.command("approve", { id: waiting.id });
    await f.command("rule", { rule: { ...saved, enabled: false } });
    await f.command("pump");
    const state = await f.command("state", { id: email.id });
    assert.equal(state.runs[0].status, "cancelled");
    assert.equal(state.effects, 0);
    assert.equal(state.email.folder_id, "inbox");
  } finally {
    await f.mf.dispose();
  }
});

test("incoming receipt hands off durably to the actual automation object once", async () => {
  const f = await fixture();
  try {
    await f.command("rule", { rule: rule("archive", "automatic") });
    const raw =
      "From: vendor@example.invalid\r\nTo: me@example.invalid\r\nSubject: Invoice arrival\r\nMessage-ID: <fixture@vendor.invalid>\r\n\r\nInvoice details";
    const first = await f.command("receive", { raw });
    assert.equal(first.inserted, true);
    const replay = await f.command("receive", { raw });
    assert.equal(replay.inserted, false);
    assert.equal(replay.emailId, first.emailId);
    const before = await f.command("state", { id: first.emailId });
    assert.equal(before.runs.length, 1);
    assert.equal(before.runs[0].emailId, first.emailId);
    await f.command("pump");
    const after = await f.command("state", { id: first.emailId });
    assert.equal(after.runs[0].status, "succeeded");
    assert.equal(after.email.folder_id, "archive");
    assert.equal(after.effects, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("workerd restart recovers interrupted running as unknown without replaying its effect", async () => {
  const persist = mkdtempSync(join(tmpdir(), "automation-durable-test-"));
  let f = await fixture(persist);
  try {
    await f.command("rule", { rule: rule("archive", "automatic") });
    await f.command("seed", { email });
    const [run] = await f.command("ingest", { email });
    await f.command("interrupt", { id: run.id });
    await f.mf.dispose();
    f = await fixture(persist);
    const recovered = await f.command("state", { id: email.id });
    assert.equal(recovered.runs[0].status, "unknown");
    assert.equal(recovered.email.folder_id, "inbox");
    await f.command("ingest", { email });
    await f.command("pump");
    const after = await f.command("state", { id: email.id });
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0].status, "unknown");
    assert.equal(after.effects, 0);
    assert.equal(after.email.folder_id, "inbox");
  } finally {
    await f.mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
});

test("incoming event replay after a rule version edit cannot create another run", async () => {
  const f = await fixture();
  try {
    const saved = await f.command("rule", {
      rule: rule("archive", "automatic"),
    });
    await f.command("seed", { email });
    const [first] = await f.command("ingest", { email });
    await f.command("pump");
    const changed = await f.command("rule", {
      rule: { ...saved, name: "Edited invoice rule" },
    });
    assert.equal(changed.version, saved.version + 1);
    await f.command("ingest", { email });
    await f.command("pump");
    const state = await f.command("state", { id: email.id });
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].id, first.id);
    assert.equal(state.runs[0].status, "succeeded");
    assert.equal(state.effects, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("an approval cannot apply a proposal to message content changed after preparation", async () => {
  const f = await fixture();
  try {
    await f.command("rule", { rule: rule() });
    await f.command("seed", { email });
    await f.command("ingest", { email });
    const [waiting] = await f.command("pump");
    assert.equal(waiting.status, "waiting_approval");
    assert.equal(waiting.proposal.action.type, "archive");
    assert.ok(waiting.proposal.emailDigest);
    await f.command("revise-email", {
      id: email.id,
      body: "The provider replaced the original invoice body",
    });
    await f.command("approve", { id: waiting.id });
    await f.command("pump");
    const state = await f.command("state", { id: email.id });
    assert.equal(state.runs[0].status, "cancelled");
    assert.equal(state.effects, 0);
    assert.equal(state.email.folder_id, "inbox");
  } finally {
    await f.mf.dispose();
  }
});

test("old finished runs, day counters and event receipts are pruned; waiting and recent ones stay (reliability audit M5)", async () => {
  const f = await fixture();
  try {
    await f.command("seed-old");
    const r = await f.command("prune");
    assert.equal(r.removed, 3);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(r.keys, [`count:${today}:r`, "event:new", "run:new-done", "run:old-waiting"]);
  } finally { await f.mf.dispose(); }
});
