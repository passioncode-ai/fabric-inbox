import type { T } from "../../shared/i18n";
import type { Rule } from "../../workers/automation/policy";

/**
 * A rule said as one sentence (S10, B-275): "When mail arrives from **ann@acme.example** with
 * **invoice** in the subject → **forward it to accounts@owner.example**. Asks you first. Up to 20 a
 * day." The values a person typed come back as `{ strong }` parts so the screen can set them in
 * bold; `partsText` joins them for a title, a screen reader or a test. Every template is a whole
 * clause per combination of conditions, so the Russian keeps its own word order.
 */
export type Part = string | { strong: string };

/** What the sentence needs of a rule: the saved model or the editor's values. */
export type RuleShape = Pick<Rule, "conditions" | "action" | "mode" | "dailyLimit">;

const strong = (value: string): Part => ({ strong: value });

/** The parts as plain text. */
export function partsText(parts: readonly Part[]): string {
  return parts.map((p) => (typeof p === "string" ? p : p.strong)).join("");
}

/** A typed value, trimmed; an empty one counts as not set. */
const set = (value: string | undefined) => (value && value.trim() ? value.trim() : "");

/** The tool server's host, or the address as it was typed when it does not read as one. */
export function toolHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/** The "When …" clause: every condition the rule has, none of the empty ones. */
export function whenParts(conditions: RuleShape["conditions"], t: T): Part[] {
  const from = set(conditions.from);
  const subject = set(conditions.subject);
  const about = set(conditions.ai);
  const p = { from: strong(from), subject: strong(subject), about: strong(about) };
  if (from && subject && about) return t.rich("When mail arrives from {from} with {subject} in the subject and is about {about}", p);
  if (from && subject) return t.rich("When mail arrives from {from} with {subject} in the subject", p);
  if (from && about) return t.rich("When mail arrives from {from} and is about {about}", p);
  if (subject && about) return t.rich("When mail arrives with {subject} in the subject and is about {about}", p);
  if (from) return t.rich("When mail arrives from {from}", p);
  if (subject) return t.rich("When mail arrives with {subject} in the subject", p);
  if (about) return t.rich("When mail arrives that is about {about}", p);
  return [t("When any new mail arrives")];
}

/** What the rule does, as the second half of its sentence ("forward it to …"). */
export function actionParts(action: RuleShape["action"], t: T): Part[] {
  switch (action.type) {
    case "archive":
      return [strong(t("archive it"))];
    case "mark_read":
      return [strong(t("mark it as read"))];
    case "draft":
      return [strong(t("prepare a reply draft"))];
    case "forward":
      return set(action.to)
        ? [strong(t("forward it to {to}", { to: action.to.trim() }))]
        : [strong(t("forward it (no address yet)"))];
    case "mcp":
      return set(action.tool) && set(action.endpoint)
        ? [strong(t("call {tool} on {host}", { tool: action.tool.trim(), host: toolHost(action.endpoint.trim()) }))]
        : [strong(t("call a tool (not chosen yet)"))];
  }
}

/** The whole sentence of a rule card. */
export function ruleSentence(rule: RuleShape, t: T): Part[] {
  const how = rule.mode === "automatic" ? t("Acts on its own.") : t("Asks you first.");
  return [
    ...whenParts(rule.conditions, t),
    " → ",
    ...actionParts(rule.action, t),
    ". ",
    how,
    " ",
    t("Up to {n} a day.", { n: rule.dailyLimit }),
  ];
}

/** Whether a rule has at least one condition (the editor's When step asks for one). */
export function hasCondition(conditions: RuleShape["conditions"]): boolean {
  return !!(set(conditions.from) || set(conditions.subject) || set(conditions.ai));
}

/** A name for a rule saved with none: its sentence, cut to the model's 100 characters. */
export function defaultRuleName(rule: RuleShape, t: T): string {
  const text = partsText([...whenParts(rule.conditions, t), " → ", ...actionParts(rule.action, t)]);
  return text.length > 100 ? text.slice(0, 99).trimEnd() + "…" : text;
}

/** What a test run answers (workers/automation/index.ts dryRun): nothing is executed. */
export interface TestRunResult {
  matched: boolean;
  analysis: { matches: boolean; summary: string; draft: string };
  action: RuleShape["action"] | { type: string };
  executed: false;
}

/** The message a test run was tried on, as the picker knows it. */
export interface TriedMessage {
  sender: string;
  subject: string;
}

/** What a matching test run would have done, in a sentence. */
export function wouldDo(action: RuleShape["action"] | { type: string }, t: T): string {
  const a = action as RuleShape["action"];
  switch (a.type) {
    case "archive": return t("Would archive it.");
    case "mark_read": return t("Would mark it as read.");
    case "draft": return t("Would prepare a reply draft.");
    case "forward": return t("Would forward it to {to}.", { to: a.to });
    case "mcp": return t("Would call {tool} on {host}.", { tool: a.tool, host: toolHost(a.endpoint) });
    default: return t("Would act on it.");
  }
}

/** The address in a From header ("Ann <ann@acme.example>" → ann@acme.example). */
const senderAddress = (sender: string) => (sender.match(/<([^<>]+)>/)?.[1] ?? sender).trim().toLowerCase();

/**
 * Why a test run would not act, in words. The server only says it did not match; the picked
 * message's sender and subject show which condition failed, read as `matchesRule` reads them
 * (workers/automation/policy.ts). When those match, the model judged the "about" condition.
 */
export function whyNot(rule: RuleShape, message: TriedMessage | undefined, t: T): string {
  const from = set(rule.conditions.from);
  const subject = set(rule.conditions.subject);
  const about = set(rule.conditions.ai);
  if (message && from && senderAddress(message.sender) !== from.toLowerCase())
    return t("the sender is not {from}", { from });
  if (message && subject && !message.subject.toLowerCase().includes(subject.toLowerCase()))
    return t("the subject does not contain “{subject}”", { subject });
  if (message && about) return t("it is not about “{about}”", { about });
  return t("it does not match the conditions");
}

/** A test run's result in words: what would happen, or why nothing would. */
export function testRunSentence(rule: RuleShape, result: TestRunResult, message: TriedMessage | undefined, t: T): string {
  return result.matched ? wouldDo(result.action, t) : t("Would not act: {reason}", { reason: whyNot(rule, message, t) });
}
