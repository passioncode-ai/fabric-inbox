import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// B-138: a mailbox's conversations by reply status. The production MailboxDO and the status library
// run in workerd over a local R2; the reply agent's registry is a stub answering the runs it was given.
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { listAgentThreads, attachAgentStates, changeAgentStatus, readAgentStatus } from './workers/lib/agent-status';
      import { runIdFor } from './workers/agents/run';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
        async seed(rows) {
          for (const r of rows) {
            this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id) VALUES (?, ?, 's', 'x@outside.invalid', 'a', ?, '', ?)",
              r.id, r.folder, new Date(Date.UTC(2026, 9, 20, 0, r.at)).toISOString(), r.thread);
            if (r.key) this.ctx.storage.sql.exec("INSERT INTO outbox (id, mailbox_id, idempotency_key, payload_hash, status, created_at, updated_at, projection_status) VALUES (?, 'a', ?, 'h', 'accepted', 0, 0, 'complete')", r.id, r.key);
          }
        }
      }
      const registry = (env, statuses) => ({ getByName: () => ({ runsByIds: async (ids) => {
        const out = [];
        for (const [email, status] of Object.entries(statuses)) {
          const id = await runIdFor(env.ADDRESS, email);
          if (ids.includes(id)) out.push({ id, status, emailId: email });
        }
        return out;
      } }) });
      export default {
        async fetch(request, env) {
          const c = await request.json();
          const box = (m) => env.MAILBOX.get(env.MAILBOX.idFromName(m));
          const full = { ...env, ADDRESS: c.address, AGENT_REGISTRY: registry({ ADDRESS: c.address }, c.statuses || {}) };
          if (c.op === 'setup') {
            await env.BUCKET.put('mailboxes/' + c.address + '.json', JSON.stringify({ fromName: 'Support' }));
            await box(c.address).seed(c.rows);
            return Response.json(true);
          }
          if (c.op === 'facts') return Response.json(await box(c.address).agentThreads(c.options || {}));
          if (c.op === 'sentBy') return Response.json(await box(c.address).sentByIds(c.ids));
          if (c.op === 'list') return Response.json(await listAgentThreads(full, c.options || {}));
          if (c.op === 'attach') { const page = c.page; await attachAgentStates(full, page); return Response.json(page); }
          if (c.op === 'change') { try { return Response.json(await changeAgentStatus(env.BUCKET, c.change)); } catch (e) { return Response.json({ threw: e.message }); } }
          if (c.op === 'read') return Response.json(await readAgentStatus(env.BUCKET));
          return new Response('unknown op', { status: 400 });
        }
      };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } },
    r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (op: string, fields: Record<string, unknown> = {}): Promise<any> => {
    const r = await mf.dispatchFetch("http://localhost/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...fields }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { mf, call };
}

const ADDRESS = "a@shop.invalid";
const RUN = "agent-" + "1".repeat(32);
// Seven conversations, each ending a different way.
const rows = [
  { id: "m1", folder: "inbox", at: 1, thread: "t1" }, { id: "s1", folder: "sent", at: 2, thread: "t1", key: RUN },
  { id: "m2", folder: "inbox", at: 1, thread: "t2" }, { id: "s2", folder: "sent", at: 2, thread: "t2", key: "agent-" + "2".repeat(32) }, { id: "m3", folder: "inbox", at: 3, thread: "t2" },
  { id: "m4", folder: "inbox", at: 4, thread: "t3" },
  { id: "m5", folder: "inbox", at: 5, thread: "t4" }, { id: "s5", folder: "sent", at: 6, thread: "t4", key: "agent-" + "5".repeat(32) + ":waiting" },
  { id: "m6", folder: "inbox", at: 6, thread: "t5" }, { id: "s6", folder: "sent", at: 7, thread: "t5", key: "a-person-key" },
  { id: "m7", folder: "inbox", at: 8, thread: "t6" },
  { id: "m8", folder: "inbox", at: 9, thread: "t7" }, { id: "x8", folder: "spam", at: 10, thread: "t7" },
];
const statuses = { m1: "sent", m3: "skipped", m4: "failed", m5: "held", m6: "drafted", m8: "drafted" };

test("B-138: a mailbox's conversations read as their reply status: who answered last, or why nobody did", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { address: ADDRESS, rows });
    const facts = await call("facts", { address: ADDRESS }) as any[];
    assert.equal(facts.length, 7);
    const t2 = facts.find((f) => f.threadId === "t2");
    assert.equal(t2.lastInbound.id, "m3");
    assert.equal(t2.agentAnsweredBefore, true);
    assert.equal(facts.find((f) => f.threadId === "t7").lastInbound.id, "m8", "Spam is not a message that came in");
    assert.deepEqual(await call("sentBy", { address: ADDRESS, ids: ["s1", "s5", "s6", "m1"] }), { s1: "agent", s5: "agent_waiting", s6: "person" });

    const all = await call("list", { address: ADDRESS, statuses, options: { address: ADDRESS } });
    const state = (id: string) => all.messages.find((m: any) => m.providerMessageId === id)?.agentState;
    assert.equal(state("m1"), "agent_replied");
    assert.equal(state("m3"), "new_after_agent");
    assert.equal(state("m4"), "error");
    assert.equal(state("m5"), "needs_data", "the agent's waiting reply is not an answer");
    assert.equal(state("m6"), "person_replied");
    assert.equal(state("m7"), "unanswered");
    assert.equal(state("m8"), "agent_draft");
    assert.equal(all.counts.agent_replied, 1);
    assert.equal(all.messages[0].providerMessageId, "m8", "newest first");

    const open = await call("list", { address: ADDRESS, statuses, options: { address: ADDRESS, states: ["unanswered", "new_after_agent", "error"] } });
    assert.deepEqual(open.messages.map((m: any) => m.providerMessageId).sort(), ["m3", "m4", "m7"]);
    assert.equal(open.counts.person_replied, 1, "counts are every state's, before the filter");
  } finally { await mf.dispose(); }
});

test("B-138: off by default: nothing is marked or listed until the workspace, the domain or the address turns it on", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { address: ADDRESS, rows });
    const page = [{ accountId: `cloudflare:${ADDRESS}`, providerMessageId: "m7", threadId: "t6" }, { accountId: `cloudflare:${ADDRESS}`, providerMessageId: "m3", threadId: "t2" }];
    assert.deepEqual((await call("attach", { address: ADDRESS, statuses, page })).map((m: any) => m.agentState), [undefined, undefined]);
    assert.equal((await call("list", { address: ADDRESS, statuses })).messages.length, 0);
    assert.equal((await call("read")).enabled, false);

    await call("change", { change: { domains: { "shop.invalid": true } } });
    assert.deepEqual((await call("attach", { address: ADDRESS, statuses, page })).map((m: any) => m.agentState), ["unanswered", "new_after_agent"]);
    assert.equal((await call("list", { address: ADDRESS, statuses })).messages.length, 7);

    await call("change", { change: { addresses: { [ADDRESS]: false } } });
    assert.deepEqual((await call("attach", { address: ADDRESS, statuses, page })).map((m: any) => m.agentState), [undefined, undefined], "the address's own choice wins");
    const after = await call("change", { change: { addresses: { [ADDRESS]: null }, enabled: true } });
    assert.deepEqual(after, { enabled: true, domains: { "shop.invalid": true }, addresses: {} }, "null follows the level above again");
    assert.match((await call("change", { change: { domains: { "not a domain": true } } })).threw, /Not a domain/);
    assert.match((await call("change", { change: { addresses: { [ADDRESS]: "yes" } } })).threw, /on, off or null/);
  } finally { await mf.dispose(); }
});
