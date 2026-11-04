// B-199 step 4 (channel-agent standard 5.3): eval tickets from what an agent got wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evalError, evalReasonOf, evalTextOf, evalVerdict, type EvalTicket } from "../workers/agents/evals";
import { evalFailedEvent } from "../workers/agents/events";
import type { AgentRun } from "../workers/agents/run";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
let n = 0;
const run = (over: Partial<AgentRun>, ageMs = DAY): AgentRun => {
  const at = new Date(NOW - ageMs).toISOString();
  return { id: "agent-" + String(++n).padStart(32, "0"), mailboxId: "support@acme.example", emailId: "m" + n, sender: "ann@customer.invalid",
    subject: "Question " + n, status: "sent", reason: "", toolCalls: [], agentId: "support", summary: "Wants to know how to export contacts",
    createdAt: at, updatedAt: at, receivedAt: at, ...over };
};
const verdict = { rubric: "v1", model: "m", checks: {} as never, question: true, note: "" };

test("B-199: a run is a ticket when the agent got it wrong, and only with a paraphrase and an agent", () => {
  const cases: [Partial<AgentRun>, string | null][] = [
    [{ judgement: { ...verdict, helped: "no" } }, "unhelpful"],
    [{ judgement: { ...verdict, helped: "yes" } }, null],
    [{ personGrade: { rubric: "v1", checks: {} as never, helped: "no", by: "a@owner.example", kind: "person" } }, "unhelpful"],
    [{ status: "sent", fallback: true }, "expired"],
    [{ status: "send_failed" }, "unanswered"],
    [{ status: "held", secondLook: { at: "x", state: "done", firstCited: [], cause: "retrieval", rescued: false } }, "handed_with_knowledge"],
    [{ status: "held", secondLook: { at: "x", state: "done", firstCited: [], cause: "data", rescued: false } }, null],
    [{ status: "held" }, null],
    [{ status: "sent" }, null],
    [{ status: "sent", fallback: true, agentId: undefined }, null],
    [{ status: "sent", fallback: true, redacted: true }, null],
    [{ status: "sent", fallback: true, summary: undefined, question: undefined }, null],
  ];
  for (const [over, expected] of cases) assert.equal(evalReasonOf(run(over), NOW), expected, JSON.stringify(over));
});

test("B-199: a ticket's text is the paraphrase without personal details, the question first", () => {
  assert.equal(evalTextOf(run({ question: "Can I pay by invoice? Write to ann@customer.invalid" })), "Can I pay by invoice? Write to […]");
  assert.equal(evalTextOf(run({ question: undefined })), "Wants to know how to export contacts");
  assert.equal(evalTextOf(run({ question: "hi", summary: undefined })), null, "too short to test anything");
});

test("B-199: a preview passes when it does what the ticket expects", () => {
  const sent = { status: "sent", run: { grounded: true }, reply: { text: "It costs 10 EUR." }, draft: null };
  assert.equal(evalVerdict("answer", sent, 3, "t").verdict, "pass");
  assert.equal(evalVerdict("handoff", sent, 3, "t").verdict, "fail");
  for (const p of [{ ...sent, run: { grounded: true, handoff: true } }, { ...sent, run: { grounded: true, fallback: true } }, { ...sent, run: { grounded: false } },
    { status: "held", run: {}, reply: null, draft: null }])
    assert.equal(evalVerdict("answer", p, 3, "t").verdict, "fail", JSON.stringify(p));
  assert.equal(evalVerdict("handoff", { ...sent, run: { handoff: true } }, 3, "t").verdict, "pass");
  assert.equal(evalVerdict("handoff", { status: "drafted", run: {}, reply: null, draft: { text: "d" } }, 3, "t").verdict, "pass");
  const r = evalVerdict("answer", sent, 3, "t");
  assert.deepEqual([r.version, r.reply, r.got], [3, "It costs 10 EUR.", { status: "sent", handoff: false, fallback: false, grounded: true }]);
  assert.deepEqual([evalError(new Error("model down"), 3, "t").verdict, evalError(new Error("model down"), 3, "t").reply], ["error", "model down"]);
});

test("B-199: agent.eval_failed fits the published agent event schema, for a ticket from a run and one a person wrote", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const validate = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false }).compile(JSON.parse(readFileSync("docs/agents/agent-event.schema.json", "utf8")));
  const ticket: EvalTicket = { id: "eval-" + "a".repeat(32), agentId: "support", address: "support@acme.example", subject: "", text: "How do I export contacts?",
    expect: "answer", reason: "unhelpful", sourceRun: "agent-" + "0".repeat(32), createdAt: "t", last: null, failingSince: null };
  for (const [t, status] of [[ticket, "held"], [{ ...ticket, sourceRun: null, reason: "person" }, "not_answered"], [ticket, "error"]] as const) {
    const result = status === "error" ? evalError(new Error("x"), 4, "t") : evalVerdict("answer", { status, run: {}, reply: null, draft: null }, 4, "t");
    const e = evalFailedEvent(t, result, new Date(NOW).toISOString());
    assert.equal(e.kind, "agent.eval_failed");
    assert.equal(e.level, "warning");
    assert.ok(validate(e.data.value), JSON.stringify(validate.errors));
    assert.equal((e.data.value as { runId: string }).runId, t.sourceRun ?? t.id);
  }
});
