import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { builtinModules } from "node:module";

/**
 * B-171 phase 3 in workerd: the reply status of a Gmail, IMAP or Outlook account's conversations. The
 * production accounts object reads each conversation from its cache (stubbed here: the thread index and
 * the rows) and tells the agent's sends by the send receipts its runs left (`<run>`, `<run>:waiting`);
 * the status library then lists and marks them under the account's email, like an address's.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { GmailAccountsDO } from './workers/providers/accounts-do';
      import { listAgentThreads, attachAgentStates, changeAgentStatus } from './workers/lib/agent-status';
      import { runIdFor } from './workers/agents/run';
      const HOUR = 3600000;
      export class TestAccounts extends GmailAccountsDO {
        async seed(now) {
          await this.ctx.storage.put('account:ab1', { id: 'ab1', provider: 'gmail', email: 'Help@Acme.example', runtime: 'cloud', status: 'connected', createdAt: 1,
            credentials: { v: 1 }, sync: { mode: 'history', historyId: '1', generation: 'g' } });
          const rows = {
            t1: [['in1', now - 2 * HOUR, ['INBOX']], ['out1', now - HOUR, ['SENT']]],
            t2: [['in2', now - 72 * HOUR, ['INBOX', 'UNREAD']]],
            t3: [['in3', now - 3 * HOUR, ['INBOX']], ['ack3', now - 2 * HOUR, ['SENT']]],
            t4: [['in4', now - 5 * HOUR, ['INBOX']], ['mine4', now - 4 * HOUR, ['SENT']]],
          };
          const at = new Map(Object.values(rows).flat().map(([id, t]) => [id, t]));
          const cache = this.service.cache;
          cache.inboxPage = async () => Object.entries(rows).map(([threadId, list]) => ({ threadId, id: list[0][0] }));
          cache.threadMembers = async (_a, threadId) => this.index === false ? undefined : (rows[threadId] || []).map(([id, , labels]) => ({ id, labels }));
          cache.row = async (_a, id) => ({ message: { timestamp: at.get(id) } });
          this.service.inboxMessagesByIds = async (accountId, ids) => ids.map((id) => ({ id: 'gmail:' + accountId + ':' + id, accountId: 'gmail:' + accountId,
            providerMessageId: id, threadId: Object.keys(rows).find((t) => rows[t].some((r) => r[0] === id)), subject: 's', from: 'x', date: new Date(at.get(id)).toISOString(), timestamp: at.get(id) }));
          // The agent answered in1 and sent a waiting reply on in3; mine4 was a person's.
          for (const [inbound, suffix, sent] of [['in1', '', 'out1'], ['in3', ':waiting', 'ack3']])
            await this.ctx.storage.put('send:ab1:' + (await runIdFor('gmail:ab1', inbound)) + suffix, { providerMessageId: sent, status: 'sent' });
          await this.ctx.storage.put('send:ab1:' + (await runIdFor('gmail:ab1', 'in4')), { providerMessageId: 'mine4', status: 'failed' });
        }
        noIndex() { this.index = false; }
      }
      export class FakeRegistry extends DurableObject {
        async runsByIds(ids) {
          const out = [];
          for (const [email, status] of [['in1', 'sent'], ['in3', 'held']]) {
            const id = await runIdFor('gmail:ab1', email);
            if (ids.includes(id)) out.push({ id, status, emailId: email });
          }
          return out;
        }
      }
      export default { async fetch(request, env) {
        const c = await request.json();
        const accounts = env.GMAIL_ACCOUNTS.getByName('workspace');
        if (c.op === 'setup') {
          await accounts.seed(c.now);
          await env.BUCKET.put('accounts/gmail:ab1.json', JSON.stringify({ agent: { id: 'support' } }));
          await changeAgentStatus(env.BUCKET, { addresses: { 'help@acme.example': true } });
          return Response.json(true);
        }
        if (c.op === 'facts') return Response.json(await accounts.agentThreads('ab1', 'gmail:ab1', c.options || {}));
        if (c.op === 'noIndex') { await accounts.noIndex(); return Response.json(true); }
        if (c.op === 'list') return Response.json(await listAgentThreads(env, c.options || {}));
        if (c.op === 'attach') { const page = c.page; await attachAgentStates(env, page); return Response.json(page); }
        return new Response('unknown op', { status: 400 });
      } };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser",
  external: ["cloudflare:*", "node:*", ...builtinModules], alias: { mimetext: "mimetext/browser" }, target: "es2022",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/');" },
});

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { GMAIL_ACCOUNTS: { className: "TestAccounts", useSQLite: true }, AGENT_REGISTRY: { className: "FakeRegistry", useSQLite: true } },
    r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (op: string, fields: Record<string, unknown> = {}): Promise<any> => {
    const r = await mf.dispatchFetch("http://localhost/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...fields }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  await call("setup", { now: Date.now() });
  return { mf, call };
}

test("an account's conversations: the agent's sends by its run's receipts, a person's otherwise, a failed receipt names no one", async () => {
  const { mf, call } = await fixture();
  try {
    const facts = await call("facts");
    const by = Object.fromEntries(facts.map((f: any) => [f.threadId, [f.lastInbound?.id, f.lastSent?.by ?? null]]));
    assert.deepEqual(by, { t1: ["in1", "agent"], t2: ["in2", null], t3: ["in3", "agent_waiting"], t4: ["in4", "person"] });
    assert.deepEqual((await call("facts", { options: { threadIds: ["t3"] } })).map((f: any) => f.threadId), ["t3"], "only the conversations asked for");
    await call("noIndex");
    assert.deepEqual(await call("facts"), [], "no thread index yet: nothing, never a guess");
  } finally {
    await mf.dispose();
  }
});

test("list_agent_threads and the feed show the account under its email, with the states, counts and abandonment of an address", async () => {
  const { mf, call } = await fixture();
  try {
    const all = await call("list");
    assert.deepEqual(all.addresses, ["help@acme.example"]);
    assert.deepEqual(all.counts, { agent_replied: 1, unanswered: 1, needs_data: 1, person_replied: 1 });
    assert.equal(all.abandoned, 1, "the 72-hour-old unanswered conversation");
    assert.deepEqual(all.issues, []);
    const open = await call("list", { options: { states: ["unanswered", "needs_data"], abandoned: true } });
    assert.deepEqual(open.messages.map((m: any) => [m.providerMessageId, m.agentState, !!m.agentAbandoned]), [["in2", "unanswered", true]]);
    const named = await call("list", { options: { address: "gmail:ab1" } });
    assert.equal(named.messages.length, 4, "the account named by its id, as the inbox filter names it");
    const page = await call("attach", { page: [
      { id: "1", accountId: "gmail:ab1", providerMessageId: "in3", threadId: "t3" },
      { id: "2", accountId: "gmail:other", providerMessageId: "x", threadId: "t1" },
    ] });
    assert.deepEqual(page.map((m: any) => m.agentState ?? null), ["needs_data", null], "only the account with an agent and the status on");
  } finally {
    await mf.dispose();
  }
});
