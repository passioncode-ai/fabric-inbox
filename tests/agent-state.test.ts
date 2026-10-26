import { test } from "node:test";
import assert from "node:assert/strict";
import { ABANDONED_AFTER_MS, agentState, agentStatusOn, isAbandoned, OPEN_STATES, type ThreadFacts } from "../shared/mail/agent-state";

// B-138: where a conversation on an address with a reply agent stands.
const facts = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  threadId: "t", lastInbound: { id: "in", at: 100 }, lastSent: null, agentAnsweredBefore: false, ...over,
});

test("B-138: the last word decides: the agent's answer, a person's reply, or the agent's waiting reply (still waiting for knowledge)", () => {
  assert.equal(agentState(facts({ lastSent: { id: "s", at: 200, by: "agent" } }), "sent"), "agent_replied");
  assert.equal(agentState(facts({ lastSent: { id: "s", at: 200, by: "person" } }), "drafted"), "person_replied");
  assert.equal(agentState(facts({ lastSent: { id: "s", at: 200, by: "agent_waiting" } }), "held"), "needs_data");
});

test("B-138: a message with no reply after it reads from the agent's run on it", () => {
  for (const [status, state] of [["failed", "error"], ["interrupted", "error"], ["send_failed", "error"], ["send_unknown", "error"],
    ["held", "needs_data"], ["drafted", "agent_draft"], ["running", "working"], ["sent", "agent_replied"]] as const) {
    assert.equal(agentState(facts({ lastSent: { id: "old", at: 50, by: "agent" } }), status), state, status);
  }
});

test("B-138: nobody answered the last message: unanswered, or new after the agent when it had answered before", () => {
  assert.equal(agentState(facts(), undefined), "unanswered");
  assert.equal(agentState(facts(), "off"), "unanswered", "a run from before the address had an agent");
  assert.equal(agentState(facts({ agentAnsweredBefore: true, lastSent: { id: "s", at: 50, by: "agent" } }), undefined), "new_after_agent");
  assert.equal(agentState(facts({ lastInbound: null, lastSent: { id: "s", at: 50, by: "person" } }), undefined), null, "only mail you sent");
});

test("B-138: the reply status is off by default; an address follows its domain, a domain the workspace", () => {
  const off = { enabled: false, domains: {}, addresses: {} };
  assert.equal(agentStatusOn(off, "a@shop.invalid"), false);
  assert.equal(agentStatusOn({ ...off, enabled: true }, "a@shop.invalid"), true);
  assert.equal(agentStatusOn({ enabled: true, domains: { "shop.invalid": false }, addresses: {} }, "A@Shop.invalid"), false);
  assert.equal(agentStatusOn({ enabled: false, domains: { "shop.invalid": true }, addresses: { "b@shop.invalid": false } }, "a@shop.invalid"), true);
  assert.equal(agentStatusOn({ enabled: false, domains: { "shop.invalid": true }, addresses: { "b@shop.invalid": false } }, "b@shop.invalid"), false);
  assert.equal(agentStatusOn({ enabled: false, domains: {}, addresses: { "b@shop.invalid": true } }, "b@shop.invalid"), true);
});

test("B-170: a message the agent skipped on purpose needs no reply; one the safety check held back still waits", () => {
  assert.equal(agentState(facts(), "skipped"), "no_reply_needed");
  assert.equal(agentState(facts(), { status: "skipped" }), "no_reply_needed");
  assert.equal(agentState(facts({ agentAnsweredBefore: true }), "skipped"), "no_reply_needed", "a thank-you after the agent's answer");
  assert.equal(agentState(facts(), { status: "skipped", injection: true }), "unanswered");
  assert.equal(agentState(facts({ agentAnsweredBefore: true }), { status: "skipped", injection: true }), "new_after_agent");
  assert.equal(agentState(facts({ lastSent: { id: "s", at: 200, by: "person" } }), "skipped"), "person_replied", "a person answered it anyway");
  assert.equal(OPEN_STATES.includes("no_reply_needed"), false);
});

test("B-170: an open conversation with no reply for 48 hours is abandoned; a waiting reply is no answer", () => {
  const at = Date.parse("2026-10-20T00:00:00Z");
  const f = facts({ lastInbound: { id: "in", at } });
  assert.equal(isAbandoned("unanswered", f, at + ABANDONED_AFTER_MS - 1), false, "one millisecond early");
  assert.equal(isAbandoned("unanswered", f, at + ABANDONED_AFTER_MS), true);
  for (const s of ["new_after_agent", "error", "needs_data", "agent_draft"] as const) assert.equal(isAbandoned(s, f, at + ABANDONED_AFTER_MS), true, s);
  for (const s of ["agent_replied", "person_replied", "working", "no_reply_needed"] as const) assert.equal(isAbandoned(s, f, at + 10 * ABANDONED_AFTER_MS), false, s);
  const waited = facts({ lastInbound: { id: "in", at }, lastSent: { id: "w", at: at + 1000, by: "agent_waiting" } });
  assert.equal(agentState(waited, "held"), "needs_data");
  assert.equal(isAbandoned("needs_data", waited, at + ABANDONED_AFTER_MS), true);
});

test("A-8: a message passed to a person waits for that person; it is not a decision that no reply is needed", () => {
  assert.equal(agentState(facts(), { status: "skipped", handoff: true }), "unanswered");
  assert.equal(agentState(facts({ agentAnsweredBefore: true }), { status: "skipped", handoff: true }), "new_after_agent");
});
