import { test } from "node:test";
import assert from "node:assert/strict";
import { accountThreadFacts } from "../workers/agents/account-threads";
import { agentState } from "../shared/mail/agent-state";

// B-171 phase 3: an account's conversation read like an address's, from the cache's labels and times.
const m = (id: string, at: number, ...labels: string[]) => ({ id, at, labels });

test("the last message that came in and the last one sent; the agent's by its receipts, anyone else's is a person's", () => {
  const facts = accountThreadFacts("t1", [m("in1", 10, "INBOX"), m("out1", 20, "SENT"), m("in2", 30, "INBOX", "UNREAD"), m("out2", 40, "SENT")],
    new Map([["out1", "agent" as const], ["out2", "agent" as const]]));
  assert.deepEqual(facts, { threadId: "t1", lastInbound: { id: "in2", at: 30 }, lastSent: { id: "out2", at: 40, by: "agent" }, agentAnsweredBefore: true });
  assert.equal(agentState(facts, undefined), "agent_replied");
  const person = accountThreadFacts("t1", [m("in1", 10, "INBOX"), m("mine", 20, "SENT")], new Map());
  assert.equal(agentState(person, undefined), "person_replied");
});

test("the waiting reply is no answer; a draft, Trash, Spam and Discarded are not part of the conversation", () => {
  const waiting = accountThreadFacts("t", [m("in", 10, "INBOX"), m("ack", 20, "SENT")], new Map([["ack", "agent_waiting" as const]]));
  assert.equal(agentState(waiting, { status: "held" }), "needs_data");
  const drafted = accountThreadFacts("t", [m("in", 10, "INBOX"), m("d", 20, "DRAFT"), m("spam", 30, "SPAM"), m("gone", 40, "SENT", "TRASH")], new Map());
  assert.deepEqual([drafted.lastInbound?.id, drafted.lastSent], ["in", null]);
  assert.equal(agentState(drafted, { status: "drafted" }), "agent_draft");
  // An archived message (no INBOX label) still came in; a conversation of only sent mail has no state.
  assert.equal(accountThreadFacts("t", [m("old", 5)], new Map()).lastInbound?.id, "old");
  assert.equal(agentState(accountThreadFacts("t", [m("s", 5, "SENT")], new Map()), undefined), null);
  // New mail after the agent answered.
  const again = accountThreadFacts("t", [m("in1", 10, "INBOX"), m("a", 20, "SENT"), m("in2", 30, "INBOX")], new Map([["a", "agent" as const]]));
  assert.equal(agentState(again, undefined), "new_after_agent");
});
