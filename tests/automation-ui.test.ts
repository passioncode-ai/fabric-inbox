import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import Automation, { enableLocked, feedAccount, previewLabel, ruleReviewKey, runState, startingPoints } from "../app/routes/automation";
import { switchOnStep } from "../app/lib/rule-gate";
import { createT } from "../shared/i18n";
import type { Rule, Run } from "../workers/automation/policy";

/** The Rules screen (S10, SCN-014..016) rendered with the server's answers already in the cache. */
function render(account: string, data: { rules?: unknown; runs?: unknown; outbox?: unknown }, entry: { search?: string; state?: unknown } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (data.rules) client.setQueryData(["rules", account], data.rules);
  if (data.runs) client.setQueryData(["runs", account], data.runs);
  if (data.outbox) client.setQueryData(["outbox", account], data.outbox);
  const element = createElement(Automation);
  const router = createMemoryRouter([{ path: "/automation/:account", element }], {
    initialEntries: [{ pathname: "/automation/" + encodeURIComponent(account), search: entry.search ?? "", state: entry.state }],
  });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
}

const rule = (over: Record<string, unknown> = {}): Rule =>
  ({
    id: "r1",
    version: 1,
    name: "Invoices",
    enabled: false,
    mode: "approval",
    conditions: { subject: "invoice" },
    action: { type: "archive" },
    dailyLimit: 20,
    ...over,
  }) as Rule;

const run = (over: Partial<Run> = {}): Run => ({
  id: "run-1",
  key: "k",
  account: "gmail:g1",
  emailId: "m1",
  subject: "Invoice 12",
  rule: rule({ version: 2, enabled: true }),
  status: "succeeded",
  createdAt: "2026-10-06T10:00:00.000Z",
  updatedAt: "2026-10-06T10:00:01.000Z",
  attempts: 2,
  ...over,
});

test("the test-run review key ignores the saved version and the on flag only", () => {
  const key = ruleReviewKey(rule());
  assert.equal(ruleReviewKey(rule({ version: 7, enabled: true })), key);
  for (const change of [
    { name: "Other" },
    { mode: "automatic" },
    { dailyLimit: 5 },
    { conditions: { subject: "receipt" } },
    { action: { type: "mark_read" } },
  ]) {
    assert.notEqual(ruleReviewKey(rule(change)), key, JSON.stringify(change));
  }
});

test("Turn on stays locked until a test run of the current values, and locks again on any change (FLW-05, S10)", () => {
  const key = ruleReviewKey(rule());
  const savedNew = { key, enabled: false };
  assert.equal(enableLocked(key, savedNew, new Set()), true, "a new rule cannot be turned on without a test run");
  assert.equal(enableLocked(key, savedNew, new Set([key])), false, "a test run of the current values unlocks Turn on");
  const edited = ruleReviewKey(rule({ name: "Edited" }));
  assert.equal(enableLocked(edited, savedNew, new Set([key])), true, "any change after the test run locks it again");
  assert.equal(enableLocked(key, savedNew, new Set([key, edited])), false, "going back to values already tried unlocks it");
  assert.equal(enableLocked(null, savedNew, new Set([key])), true, "unreadable values (bad tool arguments) keep it locked");
});

test("a rule that is on, saved unchanged, needs no test run; changing it does", () => {
  const key = ruleReviewKey(rule({ enabled: true }));
  const savedOn = { key, enabled: true };
  assert.equal(enableLocked(key, savedOn, new Set()), false);
  const edited = ruleReviewKey(rule({ name: "Edited" }));
  assert.equal(enableLocked(edited, savedOn, new Set()), true);
  assert.equal(enableLocked(edited, savedOn, new Set([edited])), false);
});

test("the switch on a rule never test-run opens its Test run step; on a tried one it turns it on (S10)", () => {
  const paused = rule();
  assert.equal(switchOnStep(paused, new Set()), "test-run");
  assert.equal(switchOnStep(paused, new Set([ruleReviewKey(rule({ name: "Other" }))])), "test-run", "another rule's test run does not count");
  assert.equal(switchOnStep(paused, new Set([ruleReviewKey(paused)])), "turn-on");
});

test("the empty Rules tab says what a rule is and offers three starting points that fill in the editor", () => {
  const html = render("support@acme.example", { rules: [], runs: [] });
  assert.match(html, /A rule acts on new mail that arrives here\./);
  for (const label of ["Archive newsletters from a sender", "Prepare a reply draft when a customer asks about something", "Forward invoices to another address"])
    assert.ok(html.includes(label), label);
  const [newsletters, questions, invoices] = startingPoints(createT("en")).map((s) => s.rule());
  assert.deepEqual([newsletters!.action.type, questions!.action.type, invoices!.action.type], ["archive", "draft", "forward"]);
  assert.equal(invoices!.conditions.subject, "invoice");
  assert.equal(startingPoints(createT("ru"))[2]!.rule().conditions.subject, "счёт");
});

test("a rule is a sentence card with its switch; a paused one says Paused; no version or raw token on the card", () => {
  const html = render("gmail:g1", { rules: [rule({ conditions: { from: "ann@acme.example", subject: "invoice" }, action: { type: "forward", to: "accounts@owner.example" } })], runs: [] });
  assert.match(html, /When mail arrives from <strong>ann@acme\.example<\/strong> with <strong>invoice<\/strong> in the subject → <strong>forward it to accounts@owner\.example<\/strong>\. Asks you first\. Up to 20 a day\./);
  assert.match(html, /role="switch" aria-checked="false"/);
  assert.match(html, /Paused/);
  assert.doesNotMatch(html, /v1|dry-run|MCP|gmail:g1/, "no version, jargon or raw account id on the card");
});

test("the header names the screen Rules and comes back to Settings unless the person came from the mail", () => {
  const fromSettings = render("support@acme.example", { rules: [], runs: [] });
  assert.match(fromSettings, /<h1>Rules for support@acme\.example<\/h1>/);
  assert.match(fromSettings, /href="\/settings\/addresses\/support%40acme\.example\/rules"[^>]*>Back to settings</);
  const fromMail = render("support@acme.example", { rules: [], runs: [] }, { state: { from: "mail" } });
  assert.match(fromMail, />Back to mail</);
  const remote = render("gmail:g1", { rules: [], runs: [] });
  assert.match(remote, /<h1>Rules for this account<\/h1>/, "a provider account never shows its raw id");
  assert.match(remote, /href="\/settings\/accounts\/gmail%3Ag1"/);
});

test("History says each run's state in words, keeps version, attempts and ids under Details, and shows no invented cost", () => {
  const html = render("gmail:g1", { rules: [], runs: [run()] }, { search: "?tab=history" });
  assert.match(html, />Done</);
  assert.match(html, /Invoices → <strong>archive it<\/strong>/);
  assert.match(html, /<summary>Details<\/summary>[\s\S]*Rule version 2[\s\S]*2 attempts[\s\S]*Run run-1/);
  assert.doesNotMatch(html, /Cost unavailable|\[run\]/);
  assert.match(html, />Find it in mail</);
});

test("a run waiting for the person offers Approve and Cancel and is counted on the History tab", () => {
  const waiting = run({ id: "w1", status: "waiting_approval" });
  const html = render("gmail:g1", { rules: [], runs: [waiting, run()] }, { search: "?tab=history" });
  assert.match(html, />Waiting for your approval</);
  assert.match(html, />Approve</);
  assert.match(html, />Cancel</);
  assert.match(html, /class="fi-rules-count" aria-label="1 waits for you">1</);
});

test("run states in words, a reason set inside the sentence (S10)", () => {
  const t = createT("en");
  assert.equal(runState({ status: "skipped", detail: "Conditions did not match" }, t).text, "Skipped: it did not match");
  assert.equal(runState({ status: "skipped", detail: "Daily rule limit reached" }, t).text, "Skipped: daily rule limit reached");
  assert.equal(runState({ status: "failed", detail: "Approval is no longer available" }, t).text, "Failed: approval is no longer available");
  assert.equal(runState({ status: "unknown" }, t).text, "Not sure it happened");
  assert.equal(runState({ status: "waiting_approval" }, createT("ru")).text, "Ждёт вашего одобрения");
});

test("History is empty in words, and says it is loading before the first answer", () => {
  assert.match(render("gmail:g1", { rules: [], runs: [] }, { search: "?tab=history" }), /Nothing yet\. When a turned-on rule matches new mail, it shows here\./);
  const loading = render("gmail:g1", { rules: [] }, { search: "?tab=history" });
  assert.match(loading, /Loading…/);
  assert.doesNotMatch(loading, /Nothing yet/);
});

test("the Sending tab appears only when something is being sent, its states in words", () => {
  const none = render("support@acme.example", { rules: [], runs: [], outbox: [] });
  assert.doesNotMatch(none, /role="tab"[^>]*>Sending</);
  const some = render("support@acme.example", { rules: [], runs: [], outbox: [{ id: "o1", status: "accepted", createdAt: "2026-10-06T10:00:00.000Z" }] }, { search: "?tab=sending" });
  assert.match(some, /role="tab"[^>]*>Sending</);
  assert.match(some, />Handed to the mail provider</);
});

test("the rules failing to load say why and offer Retry, never an empty list", () => {
  // No refetch on mount: a query that failed with no data would otherwise render as loading again.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  const account = "gmail:g1";
  client.setQueryData(["runs", account], []);
  const query = client.getQueryCache().build(client, { queryKey: ["rules", account] });
  query.setState({ status: "error", error: new Error("The server could not be reached."), fetchStatus: "idle" });
  const router = createMemoryRouter([{ path: "/automation/:account", element: createElement(Automation) }], {
    initialEntries: ["/automation/" + encodeURIComponent(account)],
  });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
  assert.match(html, /The rules could not load: The server could not be reached\./);
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, /A rule acts on new mail/);
});

// UI walk 2026-10-08: the test-run picker reads this account's newest mail by sender and subject.
const tt = Object.assign((s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? "")), { text: (s: string) => s }) as never;

test("the test-run picker reads this account's feed and names messages by sender and subject", () => {
  assert.equal(feedAccount("support@acme.example"), "cloudflare:support@acme.example");
  assert.equal(feedAccount("gmail:abc"), "gmail:abc");
  assert.equal(feedAccount("imap:x"), "imap:x");
  assert.equal(previewLabel({ sender: "Customer <ana@shop.test>", subject: "Order 4412" }, tt), "Customer: Order 4412");
  assert.equal(previewLabel({ sender: "ana@shop.test", subject: "" }, tt), "ana@shop.test: No subject");
});
