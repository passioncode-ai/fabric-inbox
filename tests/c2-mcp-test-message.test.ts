// C2 test-hardening (UX audit 2026-10-07): the send_test_message tool at the MCP surface (SCN-066).
// The route itself (sendRoutingTest) has its own tests; here the tool runs through runTool against a
// recording API (tests/mcp-fake-api.ts), with ledgers that say what was reserved, refunded and journalled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TOOLS } from "../workers/mcp/tools";
import { runTool, type Ledger } from "../workers/mcp/protocol";
import type { Principal } from "../workers/mcp/keys";
import { CF, fakeApi, ok, owner } from "./mcp-fake-api";

const tool = TOOLS.find((t) => t.name === "send_test_message")!;
const PATH = `/api/project-addresses/${encodeURIComponent(CF)}/test`;
const SENT = { subject: "Fabric Inbox routing test 2026-10-07 10:00 UTC · 1a2b3c4d", status: "accepted", errorCode: null,
  test: { state: "waiting", subject: "Fabric Inbox routing test 2026-10-07 10:00 UTC · 1a2b3c4d" } };

const agent = (over: Partial<Extract<Principal, { kind: "agent" }>> = {}): Principal =>
  ({ kind: "agent", label: "hub", level: "admin", send: "send", dailySendLimit: 5, keyId: "k1", accounts: null, ...over });

function recordingLedger(allow = true) {
  const seen = { reserved: 0, refunded: 0, journal: [] as { outcome: string; target: string; detail: string }[] };
  const ledger: Ledger = {
    issueConfirmation: async () => ({ code: "CODE", expiresAt: 0 }), consumeConfirmation: async () => true,
    reserveSend: async (_caller, limit) => { seen.reserved++; return { ok: allow, used: allow ? 1 : (limit ?? 0), limit }; },
    refundSend: async () => { seen.refunded++; },
    record: async (e) => { seen.journal.push({ outcome: e.outcome, target: e.target, detail: e.detail }); },
  };
  return { ledger, seen };
}

async function run(args: Record<string, unknown>, answer: Parameters<typeof fakeApi>[0][string] | null, principal: Principal = owner, allow = true) {
  const { api, calls } = fakeApi(answer ? { [`POST ${PATH}`]: answer } : {});
  const { ledger, seen } = recordingLedger(allow);
  const result = await runTool(tool, z.object(tool.input).parse(args), { api, principal }, ledger);
  return { isError: !!result.isError, data: JSON.parse(result.content[0]!.text), calls, seen };
}

test("AUD-B14-02: send_test_message posts to the address's test route (lower-cased) and returns the route's answer", async () => {
  const r = await run({ address: CF.toUpperCase() }, ok(SENT));
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.calls.map((c) => [c.method, c.path]), [["POST", PATH]], "one POST, the address lower-cased and encoded");
  assert.deepEqual(r.calls[0]!.body, {}, "nothing but the address is sent: the server writes the message");
  assert.deepEqual(r.data, SENT, "subject, send status and the test's state reach the agent as the route gave them");
  assert.equal(r.seen.reserved, 1, "a test message counts against the key's sends");
  assert.equal(r.seen.refunded, 0);
  assert.deepEqual(r.seen.journal, [{ outcome: "done", target: CF.toUpperCase(), detail: "" }], "the owner's journal names the address");
});

test("AUD-B14-02: send_test_message is declared as an admin tool that sends, on the route the app uses", () => {
  assert.equal(tool.level, "admin");
  assert.equal(tool.sends, true);
  assert.deepEqual(tool.routes, ["POST /api/project-addresses/:email/test"]);
  assert.throws(() => z.object(tool.input).parse({ address: "not an address" }), "a non-address is refused before any call");
  assert.throws(() => z.object(tool.input).parse({}), "the address is required");
});

test("AUD-B14-02: a key below admin, or one that may only draft, is refused and nothing is posted", async () => {
  for (const principal of [agent({ level: "mail" }), agent({ level: "read" }), agent({ send: "drafts" })]) {
    const r = await run({ address: CF }, ok(SENT), principal);
    assert.equal(r.isError, true, `${principal.level}/${principal.send} must be refused`);
    assert.match(r.data.error, /may not use send_test_message/);
    assert.equal(r.calls.length, 0, "no request reaches the server");
    assert.equal(r.seen.reserved, 0, "no send is reserved");
    assert.equal(r.seen.journal[0]?.outcome, "refused");
  }
});

test("AUD-B14-02: a key at its daily send limit is refused before the route is called", async () => {
  const r = await run({ address: CF }, ok(SENT), agent({ dailySendLimit: 3 }), false);
  assert.equal(r.isError, true);
  assert.match(r.data.error, /sent its 3 messages for today/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.seen.journal[0]?.outcome, "refused");
});

test("AUD-B14-02: an unknown address (404) or a refused send (400) is an error with its status, and the send is given back", async () => {
  for (const [status, error] of [[404, "Address not found"], [400, "Invalid send request or sender"]] as const) {
    const r = await run({ address: CF }, ok({ error }, status));
    assert.equal(r.isError, true);
    assert.equal(r.data.status, status);
    assert.match(r.data.error, new RegExp(error));
    assert.equal(r.seen.refunded, 1, "a refusal sent nothing, so the reserved send is refunded");
    assert.equal(r.seen.journal.at(-1)?.outcome, "failed");
  }
});

test("AUD-B14-02: a server failure (5xx) keeps the send counted: whether the test left is unknown", async () => {
  const r = await run({ address: CF }, ok({ error: "upstream failed" }, 502));
  assert.equal(r.isError, true);
  assert.equal(r.data.status, 502);
  assert.equal(r.seen.refunded, 0);
});
