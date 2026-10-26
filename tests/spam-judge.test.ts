import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { judgeSpam, verdictOf, SPAM_KINDS, CLEAN_KINDS, SPAM_SYSTEM } from "../workers/spam/judge";

// B-172: the spam check names the message's kind first; spam is decided by the kind alone.
const answering = (answer: unknown, seen: string[] = []) => new MockLanguageModelV3({ doGenerate: async (options) => {
  seen.push(JSON.stringify(options.prompt));
  return { content: [{ type: "text", text: JSON.stringify(answer) }], finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
} });

test("only the four spam kinds are spam; every other kind keeps the message", () => {
  assert.deepEqual(SPAM_KINDS.filter(verdictOf), [...SPAM_KINDS]);
  assert.deepEqual(CLEAN_KINDS.filter(verdictOf), []);
});

test("the model sees the shown name, the address, the verified domain, the subject and the text; its kind decides", async () => {
  const seen: string[] = [];
  const out = await judgeSpam(answering({ kind: "transactional", reason: "A sign-in code from the service's own domain." }, seen),
    { sender: "no-reply@acme.invalid", senderName: "Acme Pay", to: "contact@shop.invalid", subject: "Your code", text: "Your code is 482913.", verified: "acme.invalid" });
  assert.deepEqual(out, { spam: false, kind: "transactional", reason: "A sign-in code from the service's own domain." });
  const prompt = seen[0].replace(/\\"/g, '"');
  for (const part of ['"from":"Acme Pay <no-reply@acme.invalid>"', '"to":"contact@shop.invalid"', '"verified":"acme.invalid"', '"subject":"Your code"', "482913"])
    assert.ok(prompt.includes(part), part);
  const phish = await judgeSpam(answering({ kind: "phishing", reason: "Claims to be a bank from an unrelated domain." }),
    { sender: "alerts@bank-secure.invalid", to: "contact@shop.invalid", subject: "Account limited", text: "Sign in to restore access." });
  assert.equal(phish.spam, true);
});

test("an answer outside the closed list is a failure, never a guess", async () => {
  await assert.rejects(judgeSpam(answering({ kind: "probably_fine", reason: "?" }), { sender: "a@b.invalid", to: "c@d.invalid", subject: "s", text: "t" }));
});

test("the instructions name the cases that went wrong live: codes and account notices, customers of support addresses, phishing by brand", () => {
  assert.match(SPAM_SYSTEM, /one-time code/);
  assert.match(SPAM_SYSTEM, /verified domain belongs to the service it names is transactional/);
  assert.match(SPAM_SYSTEM, /a stranger asking about the product or their purchase is customer, not spam/);
  assert.match(SPAM_SYSTEM, /does not belong to the brand it names is phishing/);
});
