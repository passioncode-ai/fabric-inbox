import { test } from "node:test";
import assert from "node:assert/strict";
import { agentState, agentStatusOn, type ThreadFacts } from "../shared/mail/agent-state";

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
  assert.equal(agentState(facts(), "skipped"), "unanswered");
  assert.equal(agentState(facts({ agentAnsweredBefore: true, lastSent: { id: "s", at: 50, by: "agent" } }), undefined), "new_after_agent");
  assert.equal(agentState(facts({ agentAnsweredBefore: true }), "skipped"), "new_after_agent");
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
