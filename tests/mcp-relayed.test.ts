import { test } from "node:test";
import assert from "node:assert/strict";
import type { Principal } from "../workers/mcp/keys";
import { TOOLS } from "../workers/mcp/tools";
import { call, fakeApi, ok } from "./mcp-fake-api";

/**
 * B-154 step 3 (DEC-0121): the acts that change people and agent keys are tools, and each waits for the owner's
 * approval on every call whatever the key's setting (the server's callers are T2, so the owner's approval of B-38 is
 * the approval); nothing changes before it.
 */
const agent: Principal = { kind: "agent", label: "Helper", level: "admin", send: "send", dailySendLimit: 5, keyId: "k1", accounts: null };
const RELAYED = ["save_member", "remove_member", "create_agent_key", "revoke_agent_key"];

test("every act on people and keys is a tool that always waits for the owner, with a summary naming what changes", () => {
  for (const name of RELAYED) {
    const tool = TOOLS.find((t) => t.name === name)!;
    assert.ok(tool, name);
    assert.equal(tool.ownerApproval, true, `${name} always goes to the owner`);
    assert.equal(tool.level, "admin");
  }
});

test("an agent's call waits for the owner's approval and changes nothing; the owner's own call goes straight through", async () => {
  const routes = {
    "PUT /api/members/ann%40acme.example": ok({ members: [] }), "DELETE /api/members/ann%40acme.example": ok({ members: [] }),
    "POST /api/agent-keys": ok({ key: { id: "k9" }, clientSecret: "s" }), "DELETE /api/agent-keys/k9": ok({ revoked: true }),
  };
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["save_member", { email: "Ann@Acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"] }, /member reaching only cloudflare:support@shop\.invalid/],
    ["save_member", { email: "ann@acme.example", role: "admin" }, /administrator of this server/],
    ["remove_member", { email: "ann@acme.example" }, /Remove ann@acme\.example/],
    ["create_agent_key", { name: "Research", level: "read", accounts: ["domain:shop.invalid"] }, /read key named "Research" limited to domain:shop\.invalid/],
    ["revoke_agent_key", { keyId: "k9" }, /Revoke the agent key k9/],
  ];
  for (const [tool, args, summary] of cases) {
    const api = fakeApi(routes);
    const asked = await call(api.api, tool, args, agent);
    assert.equal(asked.data.needsApproval, true, `${tool}: the owner approves, not the key`);
    assert.match(String(asked.data.summary), summary);
    assert.deepEqual(api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`), [], `${tool}: nothing changed yet`);
  }
  const owner: Principal = { kind: "owner", label: "owner@shop.invalid", level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null };
  const api = fakeApi(routes);
  const first = await call(api.api, "save_member", { email: "Ann@Acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"] }, owner);
  assert.ok(first.data.confirm && !first.data.needsApproval, "the owner confirms with a code, no approval to wait for");
  // What the confirmed call sends: the address lower-cased in the path, the mailboxes as account ids.
  const tool = TOOLS.find((t) => t.name === "save_member")!;
  await tool.call({ email: "ann@acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"] } as never, { api: api.api, principal: owner } as never);
  const put = api.calls.find((c) => c.method === "PUT")!;
  assert.deepEqual([put.path, put.body], ["/api/members/ann%40acme.example", { role: "member", accounts: ["cloudflare:support@shop.invalid"] }]);
});
