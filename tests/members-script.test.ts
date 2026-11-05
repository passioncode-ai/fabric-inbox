// B-215: people and keys from a script, over the agent protocol, with nothing waiting for a person when the owner
// trusted the key; and the account token's way to trust a key (scripts/agent-standing.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailboxId, mcpClient, parseArgs, planOf, runTool, UsageError } from "../scripts/members.mjs";
import { applyStanding, auditEntry, KEYS_OBJECT } from "../scripts/agent-standing.mjs";

test("B-215: each command is the tool an agent would call, with mailboxes named as the server names them", () => {
  const plan = (s: string) => planOf(parseArgs(s.split(" ")));
  assert.deepEqual(plan("grant Ann@Acme.example --mailbox support@shop.invalid,gmail:g1 --read gmail:g1"),
    { tool: "save_member", args: { email: "Ann@Acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid", "gmail:g1"], readOnly: ["gmail:g1"] } });
  assert.deepEqual(plan("grant ann@acme.example --mailbox a@shop.invalid --agents a@shop.invalid").args.chooseAgent, ["cloudflare:a@shop.invalid"]);
  assert.deepEqual(plan("remove ann@acme.example"), { tool: "remove_member", args: { email: "ann@acme.example" } });
  assert.deepEqual(plan("list"), { tool: "list_members", args: {} });
  assert.deepEqual(plan("sign-in"), { tool: "sync_member_sign_in", args: {} });
  assert.deepEqual(plan("key Research --level read --mailbox support@shop.invalid --duration 1y --vault research-agent/prod"),
    { tool: "create_agent_key", vault: "research-agent/prod", args: { name: "Research", level: "read", accounts: ["cloudflare:support@shop.invalid"], duration: "1y" } });
  assert.equal(mailboxId("Support@Shop.invalid"), "cloudflare:support@shop.invalid");
  for (const bad of ["grant ann@acme.example", "grant ann@acme.example --mailbox a@x.invalid --read b@x.invalid", "key R --level read", "key R --level root --vault p/e", "grant ann@acme.example --mailbox", "explode", "list --force yes"])
    assert.throws(() => plan(bad), UsageError, bad);
});

test("B-215: a key's own code is used at once; an act waiting for the owner is returned, never retried", async () => {
  const seen: unknown[] = [];
  const trusted = async (tool: string, args: Record<string, unknown>) => { seen.push([tool, args]); return args.confirm ? { members: [] } : { needsConfirmation: true, confirm: "c-1", summary: "s" }; };
  const ok = await runTool(trusted, "save_member", { email: "a@b.invalid" });
  assert.deepEqual([ok.done, seen], [true, [["save_member", { email: "a@b.invalid" }], ["save_member", { email: "a@b.invalid", confirm: "c-1" }]]]);
  let calls = 0;
  const waits = async () => { calls++; return { needsApproval: true, summary: "Make a@b.invalid an administrator", confirm: "c-2" }; };
  const asked = await runTool(waits, "save_member", { email: "a@b.invalid", role: "admin" });
  assert.deepEqual([asked.done, calls, asked.answer.needsApproval], [false, 1, true]);
  assert.equal((await runTool(async () => ({ error: "no" }), "list_members", {})).done, false);
});

test("B-215: the client sends the key in headers, keeps the session and reads the tool's answer; the secret is in no body", async () => {
  const bodies: string[] = [];
  const fetcher = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    bodies.push(init.body);
    assert.equal(init.headers["CF-Access-Client-Secret"], "sekret");
    const m = JSON.parse(init.body);
    const result = m.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify({ members: [{ email: "a@b.invalid" }] }) }] } : {};
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`, { headers: { "mcp-session-id": "s1" } });
  };
  const call = mcpClient("https://inbox.example/mcp", "cid.access", "sekret", fetcher as never);
  assert.deepEqual(await call("list_members", {}), { members: [{ email: "a@b.invalid" }] });
  assert.ok(bodies.every((b) => !b.includes("sekret")));
  const refused = mcpClient("https://inbox.example/mcp", "c", "s", (async () => new Response("no", { status: 403 })) as never);
  await assert.rejects(refused("list_members", {}), /not let in/);
});

test("B-215: the account token trusts an Admin key only, keeps the rest of the record, and writes a People line", () => {
  const record = { keys: [{ id: "k1", name: "Ops", level: "admin", clientId: "c1" }, { id: "k2", name: "Reader", level: "read", clientId: "c2" }], extra: 1 };
  const out = applyStanding(record, "k1", ["keys", "people", "keys"]);
  assert.deepEqual([out.standing, out.previous, out.record.keys[0].standing, out.record.keys[1], out.record.extra], [["people", "keys"], [], ["people", "keys"], record.keys[1], 1]);
  const cleared = applyStanding(out.record, "k1", []);
  assert.equal("standing" in cleared.record.keys[0], false);
  assert.deepEqual(cleared.previous, ["people", "keys"]);
  assert.throws(() => applyStanding(record, "k2", ["people"]), /only an Admin key/);
  assert.throws(() => applyStanding(record, "k9", ["people"]), /No agent key k9/);
  assert.throws(() => applyStanding({}, "k1", []), new RegExp(KEYS_OBJECT));
  const entry = auditEntry({ kind: "key_standing_set", key: "k1", name: "Ops", standing: ["people"], previous: [] }, Date.parse("2026-11-05T22:00:00Z"));
  assert.match(entry.key, /^audit\/\d{13}-999999-[0-9a-f-]{36}$/);
  assert.deepEqual([entry.body.actor, entry.body.at, entry.body.kind], ["account-token", "2026-11-05T22:00:00.000Z", "key_standing_set"]);
});
