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

test("B-215: a key the owner let manage people or keys confirms those with its own code; administrators and trusted keys still wait", async () => {
  const people: Principal = { ...agent, standing: ["people"] };
  const keys: Principal = { ...agent, standing: ["keys"] };
  const routes = {
    "GET /api/members": ok({ members: [{ email: "boss@acme.example", role: "admin" }, { email: "ann@acme.example", role: "member" }] }),
    "GET /api/agent-keys": ok({ keys: [{ id: "k9", standing: [] }, { id: "k7", standing: ["people"] }] }),
    "PUT /api/members/ann%40acme.example": ok({ members: [] }), "PUT /api/members/bob%40acme.example": ok({ members: [] }),
    "DELETE /api/members/ann%40acme.example": ok({ members: [] }), "POST /api/agent-keys": ok({ key: { id: "k10" }, clientSecret: "s" }),
    "DELETE /api/agent-keys/k9": ok({ revoked: true }), "DELETE /api/agent-keys/k7": ok({ revoked: true }),
  };
  const asks: [Principal, string, Record<string, unknown>, "confirm" | "approval", string][] = [
    [people, "save_member", { email: "bob@acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"] }, "confirm", "a new member"],
    [people, "save_member", { email: "ann@acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"], readOnly: ["cloudflare:support@shop.invalid"] }, "confirm", "a member's level"],
    [people, "remove_member", { email: "ann@acme.example" }, "confirm", "removing a member"],
    [people, "save_member", { email: "bob@acme.example", role: "admin" }, "approval", "making an administrator"],
    [people, "save_member", { email: "boss@acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"] }, "approval", "unmaking an administrator"],
    [people, "remove_member", { email: "boss@acme.example" }, "approval", "removing an administrator"],
    [people, "create_agent_key", { name: "Research", level: "read" }, "approval", "keys are another permission"],
    [keys, "create_agent_key", { name: "Research", level: "read", accounts: ["cloudflare:support@shop.invalid"] }, "confirm", "issuing a key"],
    [keys, "revoke_agent_key", { keyId: "k9" }, "confirm", "revoking a plain key"],
    [keys, "revoke_agent_key", { keyId: "k7" }, "approval", "revoking a key the owner trusts"],
    [keys, "save_member", { email: "bob@acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"] }, "approval", "people are another permission"],
    [{ ...people, approval: "owner" }, "save_member", { email: "bob@acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"] }, "approval", "a key set to ask the owner always waits"],
  ];
  for (const [who, tool, args, expect, why] of asks) {
    const api = fakeApi(routes);
    const asked = await call(api.api, tool, args, who);
    if (expect === "confirm") assert.ok(asked.data.needsConfirmation && asked.data.confirm && !asked.data.needsApproval, `${why}: its own code`);
    else assert.equal(asked.data.needsApproval, true, `${why}: waits for the owner`);
    assert.deepEqual(api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`), [], `${why}: nothing changed on the first call`);
  }
});

test("B-250: a request-only key needs no level and is posted as a Read key; any other key without a level is refused", async () => {
  const api = fakeApi({ "POST /api/agent-keys": ok({ key: { id: "k9", requestOnly: true }, clientSecret: "s" }) });
  const done = await call(api.api, "create_agent_key", { name: "Outreach", requestOnly: true });
  assert.equal(done.isError ?? false, false, JSON.stringify(done));
  const posted = api.calls.find((c) => c.path === "/api/agent-keys")!;
  assert.deepEqual([(posted.body as any).level, (posted.body as any).requestOnly], ["read", true]);
  const refused = await call(fakeApi({}).api, "create_agent_key", { name: "Research" });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused), /Name the level/);
});
