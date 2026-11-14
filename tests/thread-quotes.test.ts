// S05 (B-221): quoted history folded, and which earlier message each reply answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answeredRows, foldQuotedHtml, isNested, QUOTE_SELECTORS, splitQuotedText } from "../app/components/inbox/quotes";

test("a text reply folds from its English or Russian attribution line", () => {
  const en = splitQuotedText("Thanks, that works.\n\nOn Mon, 10 Nov 2026 at 10:00, Maya Chen <maya@acme.example> wrote:\n> Can we move it?\n> Maya");
  assert.equal(en.main, "Thanks, that works.");
  assert.match(en.quote ?? "", /^On Mon/);
  const ru = splitQuotedText("Спасибо, подходит.\n\n10 нояб. 2026 г., 10:00, Майя <maya@acme.example> пишет:\n> Перенесём?");
  assert.equal(ru.main, "Спасибо, подходит.");
  assert.match(ru.quote ?? "", /пишет:/);
});

test("a trailing block of > lines folds; text with no quote, or only a quote, stays whole", () => {
  const t = splitQuotedText("Yes.\n\n> earlier line\n>\n> another");
  assert.equal(t.main, "Yes.");
  assert.equal(t.quote, "> earlier line\n>\n> another");
  assert.deepEqual(splitQuotedText("Just a note, no quote."), { main: "Just a note, no quote.", quote: null });
  assert.deepEqual(splitQuotedText("> only a quote"), { main: "> only a quote", quote: null });
  assert.deepEqual(splitQuotedText("Inline > is not a quote"), { main: "Inline > is not a quote", quote: null });
});

test("HTML folding knows Apple Mail, Gmail and Outlook, and leaves a body unchanged without a DOM parser", () => {
  assert.ok(QUOTE_SELECTORS.includes('blockquote[type="cite"]'));
  assert.ok(QUOTE_SELECTORS.includes("div.gmail_quote"));
  assert.ok(QUOTE_SELECTORS.includes("div#divRplyFwdMsg"));
  const html = '<p>Mine</p><div class="gmail_quote">Old</div>';
  assert.equal(foldQuotedHtml(html, { show: "Show quoted text", hide: "Hide quoted text" }), html);
  const src = readFileSync("app/components/inbox/quotes.ts", "utf8");
  assert.match(src, /if \(!own\.trim\(\)\) return html;/, "a message that is only a quote is not folded");
  assert.match(src, /escapeHtml\(labels\.show\)/, "the labels are escaped");
});

test("each reply finds the message it answers by In-Reply-To, then References; a draft by internal id", () => {
  const rows = [
    { internalId: "c1", rfcMessageId: "<a@acme.example>" },
    { internalId: "c2", rfcMessageId: "<b@owner.example>", inReplyTo: "<a@acme.example>" },
    { internalId: "c3", rfcMessageId: "<c@acme.example>", inReplyTo: "<b@owner.example>" },
    { internalId: "c4", rfcMessageId: "<d@acme.example>", references: "<a@acme.example>" },
    { internalId: "c5", rfcMessageId: "<e@acme.example>", inReplyTo: "<gone@acme.example>" },
    { internalId: "d1", inReplyTo: "c3", draft: true },
  ];
  const answered = answeredRows(rows);
  assert.deepEqual(answered, [-1, 0, 1, 0, -2, 2]);
  assert.deepEqual(answered.map((a, i) => isNested(a, i)), [false, false, false, true, false, true]);
});

test("the conversation shows what a reply answered, nested, with a disclosure and Go to message", () => {
  const list = readFileSync("app/components/inbox/ConversationList.tsx", "utf8");
  assert.match(list, /aria-expanded=\{showing\}/);
  assert.match(list, /t\("In reply to \{name\}, \{date\}"/);
  assert.match(list, /t\("In reply to an earlier message"\)/);
  assert.match(list, /t\("Go to message"\)/);
  assert.match(list, /is-nested/);
});

test("rule and safety events of a thread's messages, oldest first, from the runs and the safety lookup", async () => {
  const { threadEvents } = await import("../app/components/inbox/quotes");
  const rule = (type: string, extra = {}) => ({ name: "Invoices", action: { type, ...extra } });
  const events = threadEvents(["m1", "m2", "m3"], [
    { emailId: "m1", status: "succeeded", updatedAt: "2026-11-14T10:00:00Z", rule: rule("forward", { to: "accounts@owner.example" }) },
    { emailId: "m2", status: "waiting_approval", updatedAt: "2026-11-14T11:00:00Z", rule: rule("archive") },
    { emailId: "m3", status: "pending", updatedAt: "2026-11-14T12:00:00Z", rule: rule("archive") },
    { emailId: "other", status: "succeeded", updatedAt: "2026-11-14T09:00:00Z", rule: rule("archive") },
  ], {
    m2: { state: "held", checkedAt: Date.parse("2026-11-14T10:30:00Z") },
    m3: { state: "released", decidedBy: "review", decidedAt: Date.parse("2026-11-14T12:30:00Z") },
    m1: { state: "clear", checkedAt: 1 },
  });
  assert.deepEqual(events.map((e) => [e.messageId, e.code]), [
    ["m1", "rule_forwarded"], ["m2", "safety_held"], ["m2", "rule_waiting"], ["m3", "safety_released_by_review"],
  ]);
  assert.deepEqual(events[0]!.values, { name: "Invoices", to: "accounts@owner.example" });
});
