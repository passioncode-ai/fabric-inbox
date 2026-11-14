import { test } from "node:test";
import assert from "node:assert/strict";
import { createT } from "../shared/i18n";
import {
  actionParts, defaultRuleName, hasCondition, partsText, ruleSentence, testRunSentence, whenParts, whyNot, wouldDo,
  type RuleShape,
} from "../app/lib/rule-sentence";

// S10 (B-275): every rule is said as one sentence, in English and in Russian, for every condition
// and every action; a test run's result is said in words.
const en = createT("en");
const ru = createT("ru");

const rule = (over: Partial<RuleShape> = {}): RuleShape => ({
  conditions: {},
  action: { type: "archive" },
  mode: "approval",
  dailyLimit: 20,
  ...over,
});

test("the spec's own example reads as written, with the typed values set apart", () => {
  const parts = ruleSentence(rule({
    conditions: { from: "ann@acme.example", subject: "invoice" },
    action: { type: "forward", to: "accounts@owner.example" },
  }), en);
  assert.equal(partsText(parts),
    "When mail arrives from ann@acme.example with invoice in the subject → forward it to accounts@owner.example. Asks you first. Up to 20 a day.");
  assert.deepEqual(parts.filter((p) => typeof p !== "string"), [
    { strong: "ann@acme.example" }, { strong: "invoice" }, { strong: "forward it to accounts@owner.example" },
  ]);
  assert.equal(partsText(ruleSentence(rule({
    conditions: { from: "ann@acme.example", subject: "invoice" },
    action: { type: "forward", to: "accounts@owner.example" },
  }), ru)), "Когда приходит письмо от ann@acme.example с invoice в теме → переслать его на accounts@owner.example. Сначала спрашивает вас. Не больше 20 в день.");
});

test("every combination of conditions has its own clause in both languages", () => {
  const from = "ann@acme.example", subject = "invoice", ai = "a customer asks to move a meeting";
  const cases: [RuleShape["conditions"], string, string][] = [
    [{}, "When any new mail arrives", "Когда приходит любое новое письмо"],
    [{ from }, "When mail arrives from ann@acme.example", "Когда приходит письмо от ann@acme.example"],
    [{ subject }, "When mail arrives with invoice in the subject", "Когда приходит письмо с invoice в теме"],
    [{ ai }, "When mail arrives that is about a customer asks to move a meeting", "Когда приходит письмо о том, что a customer asks to move a meeting"],
    [{ from, subject }, "When mail arrives from ann@acme.example with invoice in the subject", "Когда приходит письмо от ann@acme.example с invoice в теме"],
    [{ from, ai }, "When mail arrives from ann@acme.example and is about a customer asks to move a meeting",
      "Когда приходит письмо от ann@acme.example, и оно о том, что a customer asks to move a meeting"],
    [{ subject, ai }, "When mail arrives with invoice in the subject and is about a customer asks to move a meeting",
      "Когда приходит письмо с invoice в теме, и оно о том, что a customer asks to move a meeting"],
    [{ from, subject, ai }, "When mail arrives from ann@acme.example with invoice in the subject and is about a customer asks to move a meeting",
      "Когда приходит письмо от ann@acme.example с invoice в теме, и оно о том, что a customer asks to move a meeting"],
  ];
  for (const [conditions, english, russian] of cases) {
    assert.equal(partsText(whenParts(conditions, en)), english, JSON.stringify(conditions));
    assert.equal(partsText(whenParts(conditions, ru)), russian, JSON.stringify(conditions));
  }
  // A blank field is no condition at all.
  assert.equal(partsText(whenParts({ from: " ", subject: "", ai: "  " }, en)), "When any new mail arrives");
  assert.equal(hasCondition({ from: " ", subject: "" }), false);
  assert.equal(hasCondition({ subject: "invoice" }), true);
});

test("every action is said in both languages, an unfinished one says what is missing", () => {
  const cases: [RuleShape["action"], string, string][] = [
    [{ type: "archive" }, "archive it", "архивировать его"],
    [{ type: "mark_read" }, "mark it as read", "отметить его прочитанным"],
    [{ type: "draft" }, "prepare a reply draft", "подготовить черновик ответа"],
    [{ type: "forward", to: "accounts@owner.example" }, "forward it to accounts@owner.example", "переслать его на accounts@owner.example"],
    [{ type: "forward", to: "" }, "forward it (no address yet)", "переслать его (адрес пока не указан)"],
    [{ type: "mcp", endpoint: "https://tools.acme.example/mcp", tool: "file_ticket", arguments: {}, location: "cloud" },
      "call file_ticket on tools.acme.example", "вызвать file_ticket на tools.acme.example"],
    [{ type: "mcp", endpoint: "", tool: "", arguments: {}, location: "cloud" }, "call a tool (not chosen yet)", "вызвать инструмент (пока не выбран)"],
  ];
  for (const [action, english, russian] of cases) {
    assert.equal(partsText(actionParts(action, en)), english, action.type);
    assert.equal(partsText(actionParts(action, ru)), russian, action.type);
  }
});

test("how the rule acts and its daily limit close the sentence", () => {
  const own = rule({ conditions: { subject: "invoice" }, mode: "automatic", dailyLimit: 5 });
  assert.match(partsText(ruleSentence(own, en)), /→ archive it\. Acts on its own\. Up to 5 a day\.$/);
  assert.match(partsText(ruleSentence(own, ru)), /→ архивировать его\. Действует само\. Не больше 5 в день\.$/);
});

test("a rule saved without a name is named by its sentence, never longer than the model allows", () => {
  assert.equal(defaultRuleName(rule({ conditions: { subject: "invoice" } }), en), "When mail arrives with invoice in the subject → archive it");
  const long = defaultRuleName(rule({ conditions: { ai: "x".repeat(300) } }), en);
  assert.ok(long.length <= 100, String(long.length));
});

test("a test run that matches says what would happen; one that does not says which condition failed", () => {
  const invoices = rule({ conditions: { from: "ann@acme.example", subject: "invoice" }, action: { type: "forward", to: "accounts@owner.example" } });
  const matched = { matched: true, analysis: { matches: true, summary: "Matched rule conditions", draft: "" }, action: invoices.action, executed: false as const };
  assert.equal(testRunSentence(invoices, matched, undefined, en), "Would forward it to accounts@owner.example.");
  assert.equal(testRunSentence(invoices, matched, undefined, ru), "Правило переслало бы письмо на accounts@owner.example.");
  const missed = { ...matched, matched: false, analysis: { matches: false, summary: "Conditions did not match", draft: "" } };
  assert.equal(testRunSentence(invoices, missed, { sender: "Bob <bob@acme.example>", subject: "Invoice 12" }, en),
    "Would not act: the sender is not ann@acme.example.");
  assert.equal(testRunSentence(invoices, missed, { sender: "Ann <ANN@acme.example>", subject: "Hello" }, en),
    "Would not act: the subject does not contain “invoice”.");
  assert.equal(testRunSentence(invoices, missed, { sender: "Ann <ANN@acme.example>", subject: "Hello" }, ru),
    "Правило не сработало бы: в теме нет «invoice».");
  const about = rule({ conditions: { ai: "a refund request" } });
  assert.equal(whyNot(about, { sender: "x@acme.example", subject: "Hi" }, en), "it is not about “a refund request”");
  assert.equal(whyNot(about, { sender: "x@acme.example", subject: "Hi" }, ru), "письмо не подходит под условие «a refund request»");
  assert.equal(whyNot(about, undefined, en), "it does not match the conditions");
  for (const [action, english] of [
    [{ type: "archive" }, "Would archive it."],
    [{ type: "mark_read" }, "Would mark it as read."],
    [{ type: "draft" }, "Would prepare a reply draft."],
    [{ type: "mcp", endpoint: "https://tools.acme.example/mcp", tool: "file_ticket", arguments: {}, location: "cloud" }, "Would call file_ticket on tools.acme.example."],
  ] as const) assert.equal(wouldDo(action, en), english);
  assert.equal(wouldDo({ type: "mark_read" }, ru), "Правило отметило бы письмо прочитанным.");
  // A-28: every result is a whole sentence, so the "Nothing was changed." after it never runs on.
  for (const message of [{ sender: "Bob <bob@acme.example>", subject: "Invoice 12" }, { sender: "Ann <ann@acme.example>", subject: "Hello" }, undefined])
    for (const locale of [en, ru]) assert.match(testRunSentence(invoices, missed, message, locale), /\.$/);
});
