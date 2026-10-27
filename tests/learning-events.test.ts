// B-162: what a sent answer cited and why a message went unanswered (workers/agents/learning-events.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerCitedEvent, causeOf, CITED_MAX, citedOf, secondLookCause, supportDiagnosedEvent } from "../workers/agents/learning-events";
import { evidenceOf } from "../workers/agents/runner";
import type { AgentRun } from "../workers/agents/run";

const base: AgentRun = { id: "run-1", mailboxId: "support@acme.example", emailId: "e1", sender: "person@mail.example", subject: "Refund for order 42",
  status: "sent", reason: "", toolCalls: [], agentId: "support", agentVersion: 3, category: "billing",
  summary: "Asks how to get a refund; write to refunds@acme.example or +1 555 123 4567.", createdAt: "2026-10-27T10:00:00.000Z", updatedAt: "2026-10-27T10:01:00.000Z" };

test("B-162: the evidence keeps each cited item's coverage at the same index; a tool without coverage keeps none", () => {
  assert.deepEqual(evidenceOf("facts", JSON.stringify({ requestId: "r", revision: "rev-9", items: [{ id: "a", coverage: 0.9, answer: true }, { id: "b", answer: true }, { id: "c", coverage: 0.7, answer: false }] })),
    { tool: "facts", requestId: "r", items: ["a", "b"], coverage: [0.9, null], revision: "rev-9" });
  assert.deepEqual(evidenceOf("facts", JSON.stringify({ items: [{ id: "a" }] })), { tool: "facts", items: ["a"] });
});

test("B-162: answer.cited names the items once each with their coverage, and no word of the mail", () => {
  const run = { ...base, repliedAt: "2026-10-27T10:00:30.000Z", evidence: [
    { tool: "facts", items: ["a", "b"], coverage: [0.9, null], revision: "rev-9" }, { tool: "kb", items: ["b", "c"] }] };
  const event = answerCitedEvent(run)!;
  assert.equal(event.kind, "answer.cited");
  assert.deepEqual(event.data.value, { at: "2026-10-27T10:00:30.000Z", channel: "email", address: "support@acme.example", runId: "run-1", agentId: "support", agentVersion: 3,
    category: "billing", question: "Asks how to get a refund; write to […] or […].", status: "answered", cited: ["a", "b", "c"], coverage: [0.9, null, null], revision: "rev-9" });
  const json = JSON.stringify(event);
  for (const word of ["person@mail.example", "Refund for order 42", "refunds@acme.example", "555"]) assert.equal(json.includes(word), false, word);
  const general = answerCitedEvent({ ...run, evidence: undefined })!.data.value as { status: string; cited: string[]; revision: unknown };
  assert.deepEqual([general.status, general.cited, general.revision], ["general", [], null]);
  const many = citedOf({ ...run, evidence: [{ tool: "facts", items: Array.from({ length: 20 }, (_, i) => `i${i}`) }] });
  assert.equal(many.cited.length, CITED_MAX);
  assert.equal(many.coverage.length, CITED_MAX);
});

test("B-162: a hand-off, the safe reply, a draft or a held message is not an answer cited", () => {
  for (const run of [{ ...base, handoff: true }, { ...base, fallback: true }, { ...base, status: "drafted" as const }, { ...base, status: "held" as const }])
    assert.equal(answerCitedEvent(run), null);
});

test("B-162: the cause a turn reads: person, data, draft-or-check; none for an answer, a failure or a failed lookup", () => {
  assert.equal(causeOf({ ...base, handoff: true }), "person");
  assert.equal(causeOf({ ...base, status: "held", unanswered: true, question: "How do refunds work?" }), "data");
  assert.equal(causeOf({ ...base, status: "held" }), "draft-or-check");
  assert.equal(causeOf({ ...base, fallback: true, unanswered: true }), "data");
  assert.equal(causeOf({ ...base, fallback: true, toolCalls: [{ name: "check", host: "model", ok: false, ms: 1, result: "rejected" }] }), "draft-or-check");
  assert.equal(causeOf({ ...base, status: "held", unanswered: true, toolCalls: [{ name: "facts", host: "kb.example", ok: false, ms: 1, result: "Error: 503" }] }), null, "an outage is not a gap");
  assert.equal(causeOf({ ...base, status: "held", toolCalls: [{ name: "facts:gap", host: "kb.example", ok: false, ms: 1, result: "" }] }), "draft-or-check", "a failed gap report is bookkeeping");
  for (const status of ["sent", "drafted", "skipped", "failed", "running"] as const) assert.equal(causeOf({ ...base, status }), null, status);
  const event = supportDiagnosedEvent({ ...base, status: "held", unanswered: true, question: "How do refunds work for order 42?" }, "data");
  assert.deepEqual(event.data.value, { at: base.updatedAt, channel: "email", address: "support@acme.example", runId: "run-1", agentId: "support", agentVersion: 3,
    category: "billing", question: "How do refunds work for order 42?", cause: "data", rescued: false, look: "turn" });
  assert.equal(event.kind, "support.diagnosed");
});

test("B-162: the published schemas name every field the events carry and nothing else", () => {
  const cited = JSON.parse(readFileSync("docs/agents/answer-cited.schema.json", "utf8"));
  const diagnosed = JSON.parse(readFileSync("docs/agents/support-diagnosed.schema.json", "utf8"));
  const run = { ...base, evidence: [{ tool: "facts", items: ["a"], coverage: [0.8], revision: "r" }] };
  for (const [schema, value] of [[cited, answerCitedEvent(run)!.data.value], [diagnosed, supportDiagnosedEvent({ ...base, handoff: true }, "person").data.value]] as const) {
    const keys = Object.keys(value as object);
    for (const key of schema.required) assert.ok(keys.includes(key), key);
    for (const key of keys) assert.ok(key in schema.properties, key);
  }
  assert.deepEqual(diagnosed.properties.cause.enum, ["retrieval", "draft-or-check", "data", "person"]);
});

test("B-153: a second look that sends is rescued: retrieval with a new cited item, else draft-or-check; one that holds reads as the turn does", () => {
  const sent = { ...base, evidence: [{ tool: "facts", items: ["a", "b"] }] };
  assert.deepEqual(secondLookCause(sent, ["a"]), { cause: "retrieval", rescued: true });
  assert.deepEqual(secondLookCause(sent, ["a", "b"]), { cause: "draft-or-check", rescued: true });
  assert.deepEqual(secondLookCause({ ...base, status: "held", unanswered: true }, []), { cause: "data", rescued: false });
  assert.deepEqual(secondLookCause({ ...base, status: "held" }, []), { cause: "draft-or-check", rescued: false });
  assert.deepEqual(secondLookCause({ ...base, status: "skipped" }, []), { cause: null, rescued: false }, "a person answered meanwhile");
  const event = supportDiagnosedEvent(sent, "retrieval", "second", true);
  const value = event.data.value as { look: string; rescued: boolean; cause: string };
  assert.deepEqual([value.look, value.rescued, value.cause, event.level], ["second", true, "retrieval", "info"]);
  const schema = JSON.parse(readFileSync("docs/agents/support-diagnosed.schema.json", "utf8"));
  assert.deepEqual(schema.properties.look.enum, ["turn", "second"]);
  assert.ok(schema.required.includes("look"));
});
