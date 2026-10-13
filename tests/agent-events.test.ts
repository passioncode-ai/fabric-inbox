// B-118 (M5): where agent answers go. Each run that ends appends one event to a feed other agents
// read by cursor (the fabric-service/0.1 events page): what the agent did, the question it could not
// answer (a paraphrase), the passages it used — never the sender, the subject or a message's text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEvent } from "../workers/agents/events";

const run = (over: Record<string, unknown> = {}) => ({
  id: "agent-0123456789abcdef0123456789abcdef", mailboxId: "support@x.invalid", emailId: "e1", sender: "Ann Lee <ann@private.invalid>",
  subject: "My account ZX-QWERTY", agentId: "support", agentVersion: 3, status: "drafted", reason: "This agent drafts only",
  intent: "how-to", grounded: true, toolCalls: [], sources: [{ ref: "r", collectionId: "c", title: "Double Bottom", sourceUri: "u" }],
  createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:05.000Z", ...over,
}) as never;

test("an ended run becomes one event with a sentence and machine-readable fields", () => {
  const e = runEvent(run())!;
  assert.equal(e.kind, "agent.drafted");
  assert.equal(e.level, "info");
  assert.match(e.text, /^Agent support drafted an answer for support@x\.invalid\.$/);
  assert.equal(e.at, "2026-10-14T08:00:05.000Z");
  assert.deepEqual(e.data.value, { runId: "agent-0123456789abcdef0123456789abcdef", address: "support@x.invalid", agentId: "support", agentVersion: 3,
    status: "drafted", intent: "how-to", grounded: true, unanswered: false, sources: ["Double Bottom"] });
  assert.match(e.data.schema, /^https:\/\//);
});

test("no sender, subject or text reaches the event", () => {
  const all = JSON.stringify(runEvent(run({ sent: { to: "ann@private.invalid", subject: "Re", body: "Hi Ann", outboxId: "o" } })));
  for (const leak of ["ann@private.invalid", "Ann Lee", "ZX-QWERTY", "Hi Ann"]) assert.ok(!all.includes(leak), leak);
});

test("a question without an answer is its own kind, with the paraphrase; trouble is a warning", () => {
  const u = runEvent(run({ unanswered: true, question: "How to move chats to a new phone", grounded: false }))!;
  assert.equal(u.kind, "agent.unanswered");
  assert.equal(u.level, "notice");
  assert.equal(u.data.value.question, "How to move chats to a new phone");
  assert.equal(runEvent(run({ status: "sent" }))!.kind, "agent.sent");
  assert.equal(runEvent(run({ status: "skipped" }))!.kind, "agent.skipped");
  const bad = runEvent(run({ status: "send_unknown" }))!;
  assert.equal(bad.kind, "agent.needs_look");
  assert.equal(bad.level, "warning");
  assert.equal(runEvent(run({ status: "running" })), null, "a run still going is not an event");
});
