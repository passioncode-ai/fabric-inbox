// The mail-window audit of 2026-11-14 (docs/reports/2026-11-14-mail-window-audit), wave F2: the agent's draft card
// (S06, S07), its list row, the run panel and the tuning box. A-5, A-6, A-7, A-15, A-26, A-27.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThreadRow } from "../app/components/inbox/thread";

(globalThis as { React?: unknown }).React = React;
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("~/") ? next(new URL(specifier.slice(2), APP).href, context) : next(specifier, context);
  },
});

const { cardNeedsScroll, cardPlacement, cardToShow, retiredCards, statusRepeatsDraft, CARD_SEEN_PX } = await import("../app/components/inbox/draft-card");
const { RetiredDraftNotice } = await import("../app/components/inbox/AgentDraftCard");
const { WhoChip } = await import("../app/components/inbox/ConversationList");
const { default: AgentRunPanel } = await import("../app/components/inbox/AgentRunPanel");
const { default: TriagedList } = await import("../app/components/inbox/TriagedList");
const { AgentChatConnected } = await import("../app/components/AgentPanel");
const { chatInputSize, INPUT_MAX_PX } = await import("../app/components/agent-chat");
const { agentLabel } = await import("../app/components/inbox/agent-name");
const { I18nProvider } = await import("../app/lib/i18n");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RU } = await import("../shared/i18n/ru/index");

const RUN = "agent-" + "b".repeat(32);
const D1 = RUN + "-draft";
const row = (id: string, kind: ThreadRow["kind"], over: Partial<ThreadRow> = {}, run?: Record<string, unknown>): ThreadRow => ({
  message: { id: `x:${id}`, accountId: "cloudflare:help@owner.example", provider: "cloudflare", providerMessageId: id, subject: "Hello", sender: "maya@acme.example",
    recipient: "help@owner.example", date: "", read: true, starred: false, snippet: "", ...(run ? { agentRun: { id: RUN, status: "drafted", ...run } as never } : {}) },
  kind, open: false, at: 0, ...over,
});

/** Renders with a query cache seeded as the server would answer, inside a router (the card's links). */
function render(element: React.ReactElement, seed: [readonly unknown[], unknown][] = [], locale?: "ru") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) client.setQueryData(key, data);
  const router = createMemoryRouter([{ path: "*", element }], { initialEntries: ["/"] });
  const tree = createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }));
  return renderToStaticMarkup(locale ? createElement(I18nProvider, { locale, choice: locale }, tree) : tree);
}
const ADMIN: [readonly unknown[], unknown] = [["me"], { role: "admin", email: "owner@owner.example", accounts: null, listed: true }];

// ── A-5: Discard draft is not "A reply was sent" ────────────────────

test("A-5: a card set aside with Discard draft goes as discarded, a card a reply retired as retired", () => {
  const before = [row("m1", "received", { rfcMessageId: "<a@acme.example>" }, { draftId: D1 }), row(D1, "draft", { inReplyTo: "m1" }, { draftId: D1 })];
  const shown = retiredCards(new Map(), before, cardPlacement(before)).now;
  const after = (kind: string) => [row("m1", "received", {}, { draftId: D1, outcome: { kind, at: "" } })];
  for (const [kind, gone] of [["superseded", "discarded"], ["answered_by_person", "retired"], ["answered_by_agent", "retired"]] as const) {
    const rows = after(kind);
    assert.deepEqual(retiredCards(shown, rows, cardPlacement(rows)).gone, [{ answered: "x:m1", draftId: D1, kind: gone }], kind);
  }
});

test("A-5: the discarded notice says nothing was sent and offers the way back, never 'A reply was sent'", () => {
  const run = { id: RUN, status: "drafted", draftId: D1, draftKept: true, outcome: { kind: "superseded" as const, at: "" } };
  const props = { run, accountId: "cloudflare:help@owner.example", draftId: D1, onChanged: () => {}, onClose: () => {} };
  const discarded = render(createElement(RetiredDraftNotice, { ...props, kind: "discarded" }));
  assert.match(discarded, /You discarded the agent&#x27;s draft\. Nothing was sent\./);
  assert.match(discarded, />Make a draft of it again</);
  assert.match(discarded, />Close</);
  assert.doesNotMatch(discarded, /A reply was sent/);
  assert.doesNotMatch(discarded, /Keep as my draft/);
  const retired = render(createElement(RetiredDraftNotice, { ...props, kind: "retired" }));
  assert.match(retired, /A reply was sent; this draft is no longer needed/);
  assert.match(retired, />Keep as my draft</);
  assert.match(render(createElement(RetiredDraftNotice, { ...props, kind: "discarded" }), [], "ru"), /Вы выбросили черновик агента\. Ничего не отправлено\..*Снова сделать черновиком/s);
});

// ── A-6: the open message's card in view ────────────────────────────

test("A-6: the card brought into view is the one answering the open message, else the last waiting one", () => {
  const D2 = "agent-" + "c".repeat(32) + "-draft";
  const rows = [
    row("m1", "received", { rfcMessageId: "<a@acme.example>" }, { draftId: D1 }),
    row(D1, "draft", { inReplyTo: "m1" }, { draftId: D1 }),
    row("m2", "received", { rfcMessageId: "<b@acme.example>" }, { draftId: D2 }),
    row(D2, "draft", { inReplyTo: "m2" }, { draftId: D2 }),
  ];
  const placed = cardPlacement(rows);
  assert.equal(cardToShow(rows, placed, "m2"), `x:${D2}`, "the open message's own card, not the thread's first");
  assert.equal(cardToShow(rows, placed, "m1"), `x:${D1}`);
  assert.equal(cardToShow(rows, placed, "elsewhere"), `x:${D2}`, "no card answers the open row: the last waiting card");
  const orphan = [row("m1", "received"), row(D1, "draft", { inReplyTo: "gone" }, { draftId: D1 })];
  assert.equal(cardToShow(orphan, cardPlacement(orphan), "m1"), `x:${D1}`);
  assert.equal(cardToShow([row("m1", "received")], cardPlacement([row("m1", "received")]), "m1"), null);
});

test("A-6: a card whose top is above the pane, or too near its bottom, is scrolled to; one already in view is not", () => {
  const pane = { top: 100, bottom: 800 };
  assert.equal(cardNeedsScroll(60, pane), true, "its header is cut off above (the 900 px walk)");
  assert.equal(cardNeedsScroll(790, pane), true, "only its top line shows");
  assert.equal(cardNeedsScroll(800 - CARD_SEEN_PX + 1, pane), true);
  assert.equal(cardNeedsScroll(400, pane), false, "in view under the open message: nothing moves");
  assert.equal(cardNeedsScroll(100, pane), false);
  assert.equal(cardNeedsScroll(260, { top: 0, bottom: 300 }), true, "a short pane wants half of it");
});

// ── A-7: the prepared tuning message is readable ────────────────────

test("A-7: the chat box grows with its text; the prepared tuning message to half the panel, then it scrolls", () => {
  assert.deepEqual(chatInputSize(40, false, 900), { height: 40, overflow: "hidden", max: INPUT_MAX_PX });
  assert.deepEqual(chatInputSize(856, false, 900), { height: 100, overflow: "auto", max: 100 }, "an ordinary message stays small");
  assert.deepEqual(chatInputSize(300, true, 900), { height: 300, overflow: "hidden", max: 450 }, "the tuning message is shown whole");
  assert.deepEqual(chatInputSize(856, true, 900), { height: 450, overflow: "auto", max: 450 });
  assert.equal(chatInputSize(856, true, 120).max, INPUT_MAX_PX, "never smaller than the ordinary box");
});

test("A-7: a tuning session opens with the prepared message in a tall box, named for what it is, not sent", () => {
  let sent = 0;
  const useAgent = (() => ({})) as never;
  const useAgentChat = (() => ({ status: "ready", messages: [], sendMessage: () => { sent++; }, setMessages: () => {}, stop: () => {},
    clearError: () => {}, regenerate: async () => {}, clearHistory: () => {} })) as never;
  const prepared = "I want to tune a reply agent from one of its drafts.\n\nThe agent's instructions:\nBe brief.";
  const out = renderToStaticMarkup(createElement(AgentChatConnected, { mailboxId: "help@owner.example", useAgent, useAgentChat,
    tune: { runId: RUN, agentName: "Support desk", prepared } }));
  const box = /<textarea[^>]*>[^<]*<\/textarea>/.exec(out)?.[0] ?? "";
  assert.match(box, /rows="8"/);
  assert.match(box, /aria-label="The prepared message: read and change it before you send it"/);
  assert.ok(box.includes("I want to tune a reply agent from one of its drafts."), "the prepared text is in the box from the first render");
  assert.doesNotMatch(box, /max-h-\[100px\]/, "no fixed 100 px cap while tuning");
  assert.equal(sent, 0, "nothing is sent by itself");
  const ordinary = renderToStaticMarkup(createElement(AgentChatConnected, { mailboxId: "help@owner.example", useAgent, useAgentChat }));
  assert.match(/<textarea[^>]*>/.exec(ordinary)![0], /rows="1"[\s\S]*aria-label="Chat message input"/);
});

// ── A-15: one mark for a waiting draft in the list row ──────────────

test("A-15: a row whose draft waits shows 'Draft waiting' once, not again as its status; another state still shows", () => {
  const waiting = { id: RUN, status: "drafted", draftId: D1 };
  assert.equal(statusRepeatsDraft({ agentRun: waiting, agentState: "agent_draft" }), true);
  assert.equal(statusRepeatsDraft({ agentRun: waiting }), true);
  assert.equal(statusRepeatsDraft({ agentRun: waiting, agentState: "new_after_agent" }), false);
  assert.equal(statusRepeatsDraft({ agentRun: { ...waiting, outcome: { kind: "superseded", at: "" } }, agentState: "agent_draft" }), false);
  const message = (agentState?: string) => ({ ...row("m1", "received", {}, { draftId: D1 }).message, threadId: "t1", ...(agentState ? { agentState } : {}) }) as never;
  const list = (m: never) => render(createElement(TriagedList, { messages: [m], accounts: [], onSelect: () => {}, view: "newest", open: new Set(),
    onToggleGroup: () => {}, onClearGroup: () => {} } as never));
  for (const state of ["agent_draft", undefined]) {
    const out = list(message(state));
    assert.equal(out.split("Draft waiting").length - 1, 1, `one 'Draft waiting' (${state})`);
    assert.doesNotMatch(out, /Agent&#x27;s draft/, `no second chip (${state})`);
  }
  assert.match(list(message("new_after_agent")), /New after the agent/);
});

// ── A-26: the agent by its name everywhere ──────────────────────────

test("A-26: the sent cell and the run panel name the agent as the card does, falling back to its id", () => {
  assert.equal(agentLabel("support", "Support desk"), "Support desk");
  assert.equal(agentLabel("support", "  "), "support");
  assert.equal(agentLabel("support", undefined), "support");
  const sent = row("s1", "sent", { sentBy: "agent" }, { status: "sent", agentId: "support", agentVersion: 2 });
  const named: [readonly unknown[], unknown] = [["agent-name", "support"], { name: "Support desk" }];
  assert.match(render(createElement(WhoChip, { row: sent }), [ADMIN, named]), /Sent by Support desk, version 2/);
  assert.match(render(createElement(WhoChip, { row: sent }), [ADMIN]), /Sent by support, version 2/, "the id while the name is not read");
  const member: [readonly unknown[], unknown] = [["me"], { role: "member", email: "m@owner.example", accounts: [], listed: true }];
  assert.match(render(createElement(WhoChip, { row: sent }), [member, named]), /Sent by support, version 2/, "a member is not given agents' names");
  const message = { ...row("m1", "received", {}, { status: "sent", agentId: "support", agentVersion: 2 }).message };
  const panel = render(createElement(AgentRunPanel, { message, onOpenDraft: () => {} }), [ADMIN, named,
    [["agent-run", RUN], { id: RUN, status: "sent", reason: "", agentId: "support", agentVersion: 2, toolCalls: [] }]]);
  assert.match(panel, /Support desk, version 2/);
  assert.doesNotMatch(panel, /support v2/);
  assert.match(render(createElement(AgentRunPanel, { message, onOpenDraft: () => {} }), [ADMIN, named], "ru"), /Support desk, версия 2/);
});

// ── A-27: one Russian word for Discard draft ────────────────────────

test("A-27: 'Discard draft' reads «Выбросить черновик» on the card and in the composer, and their messages agree", async () => {
  assert.equal(RU["Discard draft"], "Выбросить черновик");
  // The legacy screens' dictionary ("[draft] Discard", "Discard this draft?") is outside the mail window.
  const { LEGACY } = await import("../shared/i18n/ru/legacy");
  for (const [key, value] of Object.entries(RU))
    if (/discard/i.test(key) && /draft/i.test(key) && !(key in LEGACY)) assert.doesNotMatch(String(value), /удали(ть|те)/i, `${key} -> ${value}`);
});
