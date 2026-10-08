import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import Automation, { dryRunSentence, enableLocked, feedAccount, previewLabel, ruleReviewKey } from "../app/routes/automation";
import type { Rule, Run } from "../workers/automation/policy";

/** The Rules and history screen (SCR-07/08) rendered with the server's answers already in the cache. */
function render(account: string, data: { rules?: unknown; runs?: unknown }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (data.rules) client.setQueryData(["rules", account], data.rules);
  if (data.runs) client.setQueryData(["runs", account], data.runs);
  const element = createElement(Automation);
  const router = createMemoryRouter([{ path: "/automation/:account", element }], {
    initialEntries: ["/automation/" + encodeURIComponent(account)],
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
    conditions: {},
    action: { type: "archive" },
    dailyLimit: 20,
    ...over,
  }) as Rule;

test("the dry-run review key ignores the saved version and the enabled flag only", () => {
  const key = ruleReviewKey(rule());
  assert.equal(ruleReviewKey(rule({ version: 7, enabled: true })), key);
  for (const change of [
    { name: "Other" },
    { mode: "automatic" },
    { dailyLimit: 5 },
    { conditions: { subject: "invoice" } },
    { action: { type: "mark_read" } },
  ]) {
    assert.notEqual(ruleReviewKey(rule(change)), key, JSON.stringify(change));
  }
});

test("Enable stays locked until a dry-run of the current values, and re-locks on any edit (B11-04, FLW-05)", () => {
  const key = ruleReviewKey(rule());
  const savedNew = { key, enabled: false };
  assert.equal(enableLocked(key, savedNew, ""), true, "a new rule cannot be enabled without a dry-run");
  assert.equal(enableLocked(key, savedNew, key), false, "a dry-run of the current values unlocks Enable");
  const edited = ruleReviewKey(rule({ name: "Edited" }));
  assert.equal(enableLocked(edited, savedNew, key), true, "any edit after the dry-run re-locks Enable");
  assert.equal(enableLocked(null, savedNew, key), true, "unreadable form values (bad MCP JSON) keep Enable locked");
});

test("an enabled rule saved unchanged, and any pause, needs no dry-run", () => {
  const key = ruleReviewKey(rule({ enabled: true }));
  const savedEnabled = { key, enabled: true };
  assert.equal(enableLocked(key, savedEnabled, ""), false, "an unchanged enabled rule saves freely");
  assert.equal(enableLocked(ruleReviewKey(rule({ name: "Edited" })), savedEnabled, ""), true, "editing it re-locks Enable");
  assert.equal(enableLocked(ruleReviewKey(rule({ name: "Edited" })), savedEnabled, ruleReviewKey(rule({ name: "Edited" }))), false);
});

test("a rule row and a run card carry the rule version; a run card carries attempts and an honest cost label (B11-06, B11-08)", () => {
  const account = "gmail:g1";
  const savedRule = rule({ version: 2, enabled: true });
  const run: Run = {
    id: "run-1",
    key: "k",
    account,
    emailId: "m1",
    subject: "Invoice 12",
    rule: savedRule,
    status: "succeeded",
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:01.000Z",
    attempts: 2,
  };
  const html = render(account, { rules: [savedRule], runs: [run] });
  assert.ok((html.match(/· v2 ·/g) ?? []).length >= 2, "the rule row and the run card show v2");
  assert.match(html, /2 attempts/);
  assert.match(html, /Cost unavailable/, "cost is labeled, never invented");
});

test("the runs list says it is loading before the first answer arrives (B11-09)", () => {
  const html = render("gmail:g1", { rules: [] });
  assert.match(html, /Loading…/);
  assert.doesNotMatch(html, /No runs yet/, "the empty state waits for the first answer");
});

// UI walk 2026-10-08: the dry-run gate asked for a typed internal message id; the editor now offers
// this account's newest mail by sender and subject, and says the result in a sentence.
const tt = Object.assign((s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? "")), { text: (s: string) => s }) as never;

test("the dry-run picker reads this account's feed and names messages by sender and subject", () => {
  assert.equal(feedAccount("support@example.com"), "cloudflare:support@example.com");
  assert.equal(feedAccount("gmail:abc"), "gmail:abc");
  assert.equal(feedAccount("imap:x"), "imap:x");
  assert.equal(previewLabel({ sender: "Customer <ana@shop.test>", subject: "Order 4412" }, tt), "Customer — Order 4412");
  assert.equal(previewLabel({ sender: "ana@shop.test", subject: "" }, tt), "ana@shop.test — No subject");
});

test("a dry-run is said in a sentence: what would happen, and that nothing was done", () => {
  const base = { analysis: { matches: true, summary: "Matched rule conditions", draft: "" }, executed: false as const };
  assert.equal(dryRunSentence({ ...base, matched: true, action: { type: "archive" } }, tt), "This message matches. The rule would: Archive. Nothing was done.");
  assert.equal(dryRunSentence({ ...base, matched: false, analysis: { matches: false, summary: "Conditions did not match", draft: "" }, action: { type: "archive" } }, tt),
    "This message does not match: Conditions did not match");
  assert.equal(dryRunSentence({ ...base, matched: true, action: { type: "mcp" } }, tt), "This message matches. The rule would: Call a cloud tool (MCP). Nothing was done.");
});
