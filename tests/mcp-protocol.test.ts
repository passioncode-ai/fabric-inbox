import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ApiError, defineTool, runTool, sendOutcome, type Ledger } from "../workers/mcp/protocol";
import type { Principal } from "../workers/mcp/keys";

const admin: Principal = { kind: "agent", label: "Admin", level: "admin", send: "send", dailySendLimit: 5, keyId: "k", accounts: null };
const ledger = (over: Partial<Ledger> = {}): Ledger => ({
  issueConfirmation: async () => ({ code: "CODE", expiresAt: 0 }), consumeConfirmation: async () => true,
  reserveSend: async () => ({ ok: true, used: 1, limit: 5 }), refundSend: async () => {}, record: async () => {}, ...over,
});
const change = defineTool({ name: "change_thing", title: "Change", description: "Changes a thing for the test, and says so when asked to.", level: "admin", input: { x: z.string() }, routes: ["POST /x"], call: async () => ({ changed: true }) });
const ctx = { api: { request: async () => ({ status: 200, data: {}, contentType: "application/json" }) }, principal: admin };

test("a change the journal could not record says so instead of passing unrecorded (review 11)", async () => {
  const out = await runTool(change, { x: "1" }, ctx, ledger({ record: async () => { throw new Error("ledger down"); } }));
  const data = JSON.parse(out.content[0]!.text);
  assert.equal(data.changed, true);
  assert.match(data.warning, /could not be written to the owner's journal/);
  const fine = JSON.parse((await runTool(change, { x: "1" }, ctx, ledger())).content[0]!.text);
  assert.equal(fine.warning, undefined);
});

test("a tool whose confirmation depends on its arguments runs at once when they change nothing irreversible", async () => {
  const maybe = defineTool({ ...change, name: "maybe_prune", confirm: (a: { x: string }) => (a.x === "prune" ? "Deletes the rest." : null) } as never);
  const now = JSON.parse((await runTool(maybe, { x: "keep" }, ctx, ledger())).content[0]!.text);
  assert.equal(now.changed, true);
  const asked = JSON.parse((await runTool(maybe, { x: "prune" }, ctx, ledger())).content[0]!.text);
  assert.equal(asked.needsConfirmation, true);
});

test("B-38: a key the owner approves for is told to wait for the person, and a code not yet approved changes nothing", async () => {
  const careful: Principal = { ...admin, label: "Careful", approval: "owner" } as Principal;
  const ran: string[] = [];
  const del = defineTool({ ...change, name: "delete_thing", confirm: () => "Deletes the thing.", call: async () => { ran.push("x"); return { deleted: true }; } } as never);
  let issued: Record<string, unknown> = {};
  const asked = JSON.parse((await runTool(del, { x: "1" }, { ...ctx, principal: careful }, ledger({ issueConfirmation: async (input) => { issued = input; return { code: "CODE", expiresAt: 0 }; } }))).content[0]!.text);
  assert.equal(asked.needsApproval, true);
  assert.equal(issued.owner, true);
  assert.equal(issued.callerLabel, "Careful");
  const waiting = await runTool(del, { x: "1", confirm: "CODE" }, { ...ctx, principal: careful }, ledger({ consumeConfirmation: async () => "waiting" }));
  assert.equal(waiting.isError, true);
  assert.equal(JSON.parse(waiting.content[0]!.text).waitingForApproval, true);
  assert.deepEqual(ran, [], "nothing ran before the approval");
  const plain = JSON.parse((await runTool(del, { x: "1" }, ctx, ledger({ issueConfirmation: async (input) => { issued = input; return { code: "CODE", expiresAt: 0 }; } }))).content[0]!.text);
  assert.equal(plain.needsConfirmation, true, "a key without owner approval keeps the code as before");
  assert.equal(issued.owner, undefined);
});

test("B-155: a send that failed says whether anything left; a refusal never reads like an unknown outcome", async () => {
  const refunds: string[] = [];
  const send = (error: unknown) => defineTool({ ...change, name: "send_thing", sends: true, call: async () => { throw error; } } as never);
  const run = async (error: unknown) => JSON.parse((await runTool(send(error), { x: "1" }, ctx, ledger({ refundSend: async () => { refunds.push("r"); } }))).content[0]!.text);
  // Refused before anything was handed over: the key's send is given back, nothing left.
  const refused = await run(new ApiError(400, "invalid_message", { error: "invalid_message" }));
  assert.deepEqual([refused.outcome, refused.next], ["not_sent", "Nothing left. Fix what the error names, then send again."]);
  // The transport refused it outright (an outbox entry failed): nothing left either.
  const rejected = await run(new ApiError(502, "Email was not accepted by the transport", { id: "o1", mailboxId: "a@x.invalid", status: "failed", errorCode: "E_RECIPIENT_SUPPRESSED" }));
  assert.equal(rejected.outcome, "not_sent");
  // Handed over, then the answer was lost: it may have left.
  const lost = await run(new ApiError(409, "Send outcome is unknown; do not resend automatically", { id: "o2", mailboxId: "a@x.invalid", status: "unknown", errorCode: "TRANSPORT_OUTCOME_UNKNOWN" }));
  assert.equal(lost.outcome, "unknown");
  assert.match(lost.next, /^It may have left\. Whether it went out is in get_send_status .*never a new one\.$/);
  assert.equal(lost.details.outboxId, "o2");
  // A server error, or an error with no answer at all: never claimed as not sent.
  assert.equal((await run(new ApiError(500, "internal", null))).outcome, "unknown");
  assert.equal((await run(new Error("connection reset"))).outcome, "unknown");
  assert.equal(refunds.length, 1, "only the refusal before dispatch gives the send back");
  // A tool that does not send carries no outcome.
  const plain = JSON.parse((await runTool(defineTool({ ...change, name: "plain_thing", call: async () => { throw new ApiError(400, "no", null); } } as never), { x: "1" }, ctx, ledger())).content[0]!.text);
  assert.equal(plain.outcome, undefined);
  assert.equal(sendOutcome(new ApiError(409, "conflict", { code: "IDEMPOTENCY_CONFLICT" })), "not_sent", "a conflict sent nothing under this call");
});
