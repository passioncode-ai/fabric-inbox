// Send guards of an auto-sending reply agent: follow-ups, topics a person answers, and evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isFollowUpSubject, matchedTopic, type ModelDecision } from "../workers/agents/policy";
import { evidenceOf } from "../workers/agents/runner";
import { ReplyPolicySchema } from "../workers/agents/definition";

const send: ModelDecision = { decision: "send", intent: "how-to", grounded: true, body: "Do this.", reason: "" };
const policy = (over: Record<string, unknown> = {}) => ReplyPolicySchema.parse({ mode: "auto", allowedIntents: ["how-to"], dailySendLimit: 50, ...over });
const ctx = { sentToday: 0, toolFailures: 0, rateLimited: null, evidence: true };

test("reply and forward prefixes, in any number, case and language", () => {
  for (const s of ["Re: Premium", "RE: Premium", "Fwd: x", "FW: x", "Fw: x", "AW: Premium", "WG: x", "Отв: Премиум", "Пересл: x", "Ответ: x",
    "  re: Re: AW: x", "Re[2]: x", "SV: x", "TR: x"]) assert.equal(isFollowUpSubject(s), true, s);
  for (const s of ["Premium not active", "Regarding Premium", "Reply needed", "Fwdx", "Отвязка аккаунта"]) assert.equal(isFollowUpSubject(s), false, s);
});

test("a topic entry: | alternatives, all ' + ' groups must match, any case", () => {
  const wallet = "wallet|кошел|att|scroll-to-earn|autopilot|автопилот";
  const login = "code|код|sms|смс|otp|verification + login|log in|sign in|signin|вход|войти|авторизац|not arriv|not com|not receiv|не приход|не пришел|не пришёл|не получ";
  assert.equal(matchedTopic([wallet], "My Wallet balance is wrong"), wallet);
  assert.equal(matchedTopic([wallet], "Не работает Автопилот"), wallet);
  assert.equal(matchedTopic([login], "The SMS code is not arriving"), login);
  assert.equal(matchedTopic([login], "Не приходит код для входа"), login);
  assert.equal(matchedTopic([login], "Promo code for Premium"), null, "a code alone is not a login-code mail");
  assert.equal(matchedTopic([wallet, login], "How do I change the theme?"), null);
  // An alternative matches where a word starts; in quotes it must be the whole word.
  const att = '"att"|app tracking';
  assert.equal(matchedTopic([att], "What is ATT in the app?"), att);
  assert.equal(matchedTopic([att], "See the attachment"), null);
  assert.equal(matchedTopic(["кошел"], "Мой кошелёк пуст"), "кошел");
  assert.equal(matchedTopic(["code"], "the barcode"), null, "not inside a word");
});

test("the policy drafts follow-ups, topics and answers with no evidence; otherwise it sends", () => {
  assert.equal(decide(policy(), send, ctx).action, "send");
  assert.equal(decide(policy({ draftFollowUps: true }), send, { ...ctx, followUp: true }).action, "draft");
  assert.equal(decide(policy(), send, { ...ctx, followUp: true }).action, "send", "only when the policy asks for it");
  const topic = decide(policy(), send, { ...ctx, topic: "wallet|кошел" });
  assert.equal(topic.action, "draft");
  assert.match(topic.reason, /a person answers \(wallet\|кошел\)/);
  assert.equal(decide(policy({ requireEvidence: true }), send, { ...ctx, evidence: false }).action, "draft");
  assert.equal(decide(policy({ requireEvidence: true }), send, ctx).action, "send");
  assert.equal(decide(policy({ mode: "draft" }), send, ctx).action, "draft");
});

test("evidence: an abstained answer or coverage below 0.6 rests on nothing; a confident one is traced", () => {
  assert.equal(evidenceOf("facts", JSON.stringify({ abstained: true, coverage: 0.9 })), null);
  assert.equal(evidenceOf("facts", JSON.stringify({ abstained: false, coverage: 0.4 })), null);
  assert.deepEqual(evidenceOf("facts", JSON.stringify({ abstained: false, coverage: 0.8, requestId: "req-1",
    items: [{ id: "fact:login-code" }, { id: 7 }], revision: { data: "abc", docs: "def" } })),
    { tool: "facts", requestId: "req-1", items: ["fact:login-code", "7"], revision: '{"data":"abc","docs":"def"}' });
  assert.deepEqual(evidenceOf("facts", "plain text answer"), { tool: "facts" });
  // Coverage per cited item (the data agent's shape): one item at 0.6 or more is needed, and only those are cited.
  assert.equal(evidenceOf("facts", JSON.stringify({ abstained: false, results: [{ id: "fact:a", coverage: 0.4 }, { id: "fact:b", coverage: 0.5 }] })), null);
  assert.deepEqual(evidenceOf("facts", JSON.stringify({ abstained: false, trace: "t-9", revision: { data: "x" },
    results: [{ id: "fact:a", coverage: 0.4 }, { id: "fact:b", coverage: 0.8 }] })),
    { tool: "facts", requestId: "t-9", items: ["fact:b"], revision: '{"data":"x"}' });
});

test("older agents keep working: the new policy fields default off", () => {
  const old = ReplyPolicySchema.parse({ mode: "auto", allowedIntents: [], dailySendLimit: 20 });
  assert.deepEqual([old.draftFollowUps, old.draftTopics, old.requireEvidence], [false, [], false]);
});
