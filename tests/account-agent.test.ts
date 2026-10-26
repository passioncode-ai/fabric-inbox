import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsRouter } from "../workers/routes/agents";
import { memberGate } from "../workers/lib/member-gate";
import { fakeBucket } from "./fake-r2";

/**
 * B-171 phase 2 (REQ-5): choosing the reply agent of a Gmail, IMAP or Outlook account. The choice is
 * R2 `accounts/<provider>:<id>.json`, the file GmailAccountsDO.drain reads before it hands an
 * account's new mail to the agents (tests/agents-accounts-workerd.test.ts).
 */
function harness() {
  const bucket = fakeBucket();
  const agents = new Map([
    ["sender", { id: "sender", name: "Sender", replyPolicy: { mode: "auto" } }],
    ["drafter", { id: "drafter", name: "Drafter", replyPolicy: { mode: "draft" } }],
  ]);
  const env = {
    BUCKET: bucket,
    AGENT_REGISTRY: { getByName: () => ({
      getAgent: async (id: string) => agents.get(id) ?? null,
      updateAgent: async (id: string, agent: any) => { agents.set(id, { ...agents.get(id)!, ...agent }); return agents.get(id); },
      listAgents: async () => [...agents.values()],
      listVersions: async () => [{ version: 1, createdAt: '2026-10-26T00:00:00.000Z' }],
    }) },
    GMAIL_ACCOUNTS: { getByName: () => ({
      listAccounts: async () => ({ accounts: [
        { id: "a1", provider: "gmail", email: "ann@example.invalid", capabilities: { drafts: true } },
        { id: "o1", provider: "outlook", email: "bob@example.invalid", capabilities: { drafts: false } },
      ] }),
    }) },
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await agentsRouter.request("https://inbox.test" + path, { method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) }, env as never);
    return { status: response.status, body: (await response.json()) as any };
  };
  const stored = (key: string) => { const o = bucket.objects.get(key); return o ? JSON.parse(o.value) : undefined; };
  return { call, stored };
}

test("an agent is chosen for an account and written where the accounts object reads it; Off keeps the file and stops it", async () => {
  const h = harness();
  const set = await h.call("PUT", "/api/accounts/a1/agent", { agent: { id: "drafter" } });
  assert.deepEqual([set.status, set.body], [200, { accountId: "gmail:a1", email: "ann@example.invalid", agent: { id: "drafter" } }]);
  assert.deepEqual(h.stored("accounts/gmail:a1.json"), { agent: { id: "drafter" } });
  const listed = await h.call("GET", "/api/agents");
  assert.deepEqual(listed.body.agents.map((a: any) => [a.id, a.accounts]), [["sender", []], ["drafter", ["gmail:a1"]]]);
  assert.deepEqual((await h.call("GET", "/api/agents/drafter")).body.accounts, ["gmail:a1"]);
  const off = await h.call("PUT", "/api/accounts/a1/agent", { agent: "off" });
  assert.equal(off.status, 200);
  assert.deepEqual(h.stored("accounts/gmail:a1.json"), { agent: "off" });
  assert.deepEqual((await h.call("GET", "/api/agents/drafter")).body.accounts, [], "Off answers nothing");
});

test("an agent that drafts is refused on an account that cannot keep drafts; one that sends is taken", async () => {
  const h = harness();
  const refused = await h.call("PUT", "/api/accounts/o1/agent", { agent: { id: "drafter" } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /^Drafter leaves its answers as drafts, and this account cannot keep drafts/);
  assert.equal(h.stored("accounts/outlook:o1.json"), undefined, "nothing written");
  const taken = await h.call("PUT", "/api/accounts/o1/agent", { agent: { id: "sender" } });
  assert.deepEqual([taken.status, taken.body.accountId], [200, "outlook:o1"]);
  assert.deepEqual(h.stored("accounts/outlook:o1.json"), { agent: { id: "sender" } });
});

test("an unknown agent, an unknown account and a malformed choice are refused and write nothing", async () => {
  const h = harness();
  assert.deepEqual([(await h.call("PUT", "/api/accounts/a1/agent", { agent: { id: "nobody" } })).status], [400]);
  assert.equal((await h.call("PUT", "/api/accounts/zz/agent", { agent: "off" })).status, 404);
  assert.equal((await h.call("PUT", "/api/accounts/a1/agent", { agent: "on" })).status, 400);
  assert.equal((await h.call("PUT", "/api/accounts/a1/agent", { agent: "off", extra: 1 })).status, 400);
  assert.equal(h.stored("accounts/gmail:a1.json"), undefined);
});

test("a member is refused choosing the agent of their own account: it is an administrator's, like disconnecting it", () => {
  assert.equal(memberGate("PUT", "/api/accounts/a1/agent", ["gmail:a1"]), "refuse");
  assert.equal(memberGate("GET", "/api/accounts/a1/messages", ["gmail:a1"]), "pass", "control: their account's mail passes");
});

test("A-12: an agent answering an account that cannot keep drafts is not switched to drafting", async () => {
  const h = harness();
  assert.equal((await h.call("PUT", "/api/accounts/o1/agent", { agent: { id: "sender" } })).status, 200);
  const refused = await h.call("PUT", "/api/agents/sender", { expectedVersion: 1, agent: { name: "Sender", replyPolicy: { mode: "draft" } } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /bob@example\.invalid, which cannot keep drafts/);
  assert.equal((await h.call("PUT", "/api/agents/sender", { expectedVersion: 1, agent: { name: "Sender", replyPolicy: { mode: "auto" } } })).status, 200, "still sending is fine");
  assert.equal((await h.call("PUT", "/api/agents/drafter", { expectedVersion: 1, agent: { name: "Drafter", replyPolicy: { mode: "draft" } } })).status, 200, "an agent on no such account drafts as before");
});
