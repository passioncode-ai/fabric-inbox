// UI walk 2026-10-13 (B-110, defects A–D): the agent panel's suggestions showed a raw 70-character
// message id and overflowed; after a question was sent, focus fell to the page so J moved the mail
// selection; a failed answer lost its error when the panel was reopened; and every Compose closed
// untouched left an empty draft behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unanswered } from "../app/components/agent-chat";
import { untouchedDraft, type Draft } from "../app/components/inbox/draft-store";

const panel = readFileSync("app/components/AgentPanel.tsx", "utf8");
const inbox = readFileSync("app/routes/unified-inbox.tsx", "utf8");

test("A: a suggestion shows a short label and sends the full text with the message id", () => {
  assert.match(panel, /label: t\("Explain the open message “\{subject\}”"/);
  assert.match(panel, /onClick=\{\(\) => sendMessage\(\{ text: prompt\.text \}\)\}/);
  assert.match(panel, /\{prompt\.label\}/);
  assert.match(panel, /\[overflow-wrap:anywhere\]/, "a long word never overflows the button");
});

test("B: while an answer streams, focus stays in the panel; after it, back in the text box", () => {
  assert.match(panel, /ref=\{stopRef\}/);
  assert.match(panel, /if \(isStreaming\) stopRef\.current\?\.focus\(\);/);
  assert.match(panel, /else if \(wasStreaming\.current\) inputRef\.current\?\.focus\(\);/);
});

const user = (text: string) => ({ id: text, role: "user", parts: [{ type: "text", text }] }) as never;
const bot = (text: string) => ({ id: text, role: "assistant", parts: [{ type: "text", text }] }) as never;

test("C: a question left without an answer is shown as failed again after the panel reopens", () => {
  assert.equal(unanswered([user("hi")], false), true);
  assert.equal(unanswered([user("hi")], true), false, "not while it streams");
  assert.equal(unanswered([user("hi"), bot("hello")], false), false);
  assert.equal(unanswered([], false), false);
  assert.match(panel, /const failed = turnFailed\(status, error\) \|\| unanswered\(messages, isStreaming\);/);
});

const blank = (over: Partial<Draft> = {}): Draft => ({ id: "d", accountId: "cloudflare:a@x.invalid", to: "", subject: "", text: "", idempotencyKey: "k", mode: "new", ...over });

test("D: an untouched new draft is discarded when Compose closes; anything typed keeps it", () => {
  assert.equal(untouchedDraft(blank()), true);
  assert.equal(untouchedDraft(blank({ signature: "-- \nAnn", text: "\n\n-- \nAnn" })), true, "only the signature it was made with");
  for (const over of [{ to: "b@x.invalid" }, { subject: "Hi" }, { text: "Hello" }, { cc: "c@x.invalid" },
    { attachments: [{ id: "f" }] as never }, { mode: "reply" as const }, { mode: "forward" as const }]) {
    assert.equal(untouchedDraft(blank(over)), false, JSON.stringify(over));
  }
  assert.match(inbox, /if \(untouchedDraft\(draft\)\) void saved\.discard\(draft\)\.catch\(\(\) => \{\}\);/);
});
