import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilter, parseStoredHeaders, type PrefilterInput } from "../workers/agents/prefilter";
import { decide, type ModelDecision } from "../workers/agents/policy";
import { AgentInputSchema, agentId, legacyAgentId, readAssignment, ReplyPolicySchema } from "../workers/agents/definition";

const base: PrefilterInput = { mailboxId: "support@example.com", sender: "ann@customer.invalid", headers: [], answeredAfter: false };
const withHeader = (key: string, value: string) => ({ ...base, headers: [{ key, value }] });

test("a person writing to the address is not filtered", () => {
  assert.equal(prefilter(base), null);
  assert.equal(prefilter(withHeader("Auto-Submitted", "no")), null);
});

test("each automated-mail signal skips before any model call (REQ-P3)", () => {
  assert.equal(prefilter(withHeader("Auto-Submitted", "auto-replied")), "auto_submitted");
  assert.equal(prefilter(withHeader("precedence", "Bulk")), "bulk");
  assert.equal(prefilter(withHeader("Precedence", "list")), "bulk");
  assert.equal(prefilter(withHeader("Precedence", "junk")), "bulk");
  assert.equal(prefilter(withHeader("List-Unsubscribe", "<mailto:u@x.invalid>")), "mailing_list");
  assert.equal(prefilter(withHeader("List-Id", "news.x.invalid")), "mailing_list");
  assert.equal(prefilter(withHeader("X-Autoreply", "yes")), "auto_reply");
  assert.equal(prefilter(withHeader("X-Auto-Response-Suppress", "OOF, AutoReply")), "auto_reply");
  assert.equal(prefilter(withHeader("Content-Type", "multipart/report; report-type=delivery-status")), "delivery_report");
  assert.equal(prefilter(withHeader("Return-Path", "<>")), "delivery_report");
});

test("no-reply senders, loops, empty senders and answered threads are skipped", () => {
  for (const sender of ["noreply@x.invalid", "no-reply@x.invalid", "do-not-reply@x.invalid", "mailer-daemon@x.invalid", "notifications+abc@github.invalid"])
    assert.equal(prefilter({ ...base, sender }), "no_reply_sender", sender);
  assert.equal(prefilter({ ...base, sender: "SUPPORT@example.com" }), "own_address");
  assert.equal(prefilter({ ...base, sender: "" }), "no_sender");
  assert.equal(prefilter({ ...base, answeredAfter: true }), "already_answered");
  // A person whose name merely contains "reply" is still answered.
  assert.equal(prefilter({ ...base, sender: "replyguy@x.invalid" }), null);
});

test("stored headers parse defensively", () => {
  assert.deepEqual(parseStoredHeaders(JSON.stringify([{ key: "list-id", value: "a" }, null, { nokey: 1 }])), [{ key: "list-id", value: "a" }]);
  assert.deepEqual(parseStoredHeaders("{broken"), []);
  assert.deepEqual(parseStoredHeaders(null), []);
});

const proposal = (over: Partial<ModelDecision> = {}): ModelDecision =>
  ({ decision: "send", intent: "question", grounded: true, body: "Hello, yes.", reason: "", ...over });
const auto = ReplyPolicySchema.parse({ mode: "auto", allowedIntents: ["question"], dailySendLimit: 2 });
const calm = { sentToday: 0, toolFailures: 0, rateLimited: null };

test("the policy sends only what is positively allowed (REQ-P3)", () => {
  assert.equal(decide(auto, proposal(), calm).action, "send");
  assert.equal(decide(ReplyPolicySchema.parse({}), proposal(), calm).action, "draft", "new agents draft by default");
  assert.deepEqual(decide(auto, proposal({ grounded: false }), calm).action, "draft");
  assert.match(decide(auto, proposal({ intent: "refund" }), calm).reason, /not allowed/);
  assert.equal(decide(auto, proposal({ intent: " Question " }), calm).action, "send", "intent match ignores case and spaces");
  assert.match(decide(auto, proposal(), { ...calm, sentToday: 2 }).reason, /limit of 2/);
  assert.equal(decide(auto, proposal(), { ...calm, toolFailures: 1 }).action, "draft");
  assert.equal(decide(auto, proposal(), { ...calm, rateLimited: "Rate limit exceeded" }).action, "draft");
  assert.equal(decide(auto, proposal({ decision: "draft", reason: "unsure" }), calm).reason, "unsure");
  assert.equal(decide(auto, proposal({ decision: "skip" }), calm).action, "skip");
  assert.equal(decide(auto, proposal({ body: "  " }), calm).action, "skip", "an empty answer is never sent or drafted");
  const anyIntent = ReplyPolicySchema.parse({ mode: "auto" });
  assert.equal(decide(anyIntent, proposal({ intent: "anything" }), calm).action, "send");
});

test("agent definitions validate and ids are stable", () => {
  assert.equal(agentId("Support — Fabric!"), "support-fabric");
  assert.equal(agentId("???"), "agent");
  assert.equal(legacyAgentId("Help@Example.com"), "mailbox-help-example-com");
  assert.deepEqual(readAssignment({ agent: { id: "support" } }), { id: "support" });
  assert.equal(readAssignment({ agent: "off" }), "off");
  assert.equal(readAssignment({}), undefined);
  const tool = { name: "lookup", description: "Find an order", endpoint: "https://tools.example.com/mcp", tool: "order_lookup" };
  assert.throws(() => AgentInputSchema.parse({ name: "a", instructions: "b", tools: [tool, tool] }), /unique/);
  assert.throws(() => AgentInputSchema.parse({ name: "a", instructions: "b", tools: [{ ...tool, name: "Bad Name" }] }));
  assert.throws(() => AgentInputSchema.parse({ name: "a", instructions: "b", extra: 1 }));
  assert.equal(AgentInputSchema.parse({ name: "a", instructions: "b" }).replyPolicy.mode, "draft");
});
