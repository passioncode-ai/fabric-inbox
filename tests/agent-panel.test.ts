import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";

/**
 * The AI panel (SCN-013, FLW-04): mounted on the unified inbox with a header toggle and a sheet on
 * narrow windows (B11-01), a failed turn shown with Retry (B11-02), and the messages an answer read
 * linked into the reader (B11-03). The app's `~/` imports resolve as Vite resolves them.
 */
(globalThis as { React?: unknown }).React = React;
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("~/") ? next(new URL(specifier.slice(2), APP).href, context) : next(specifier, context);
  },
});

const chat = await import("../app/components/agent-chat");
const { AgentChatConnected, ChatErrorBubble, MessageBubble, SourceLinks } = await import("../app/components/AgentPanel");
const { default: AgentDock } = await import("../app/components/inbox/AgentDock");
const { I18nProvider } = await import("../app/lib/i18n");
import type { InboxAccount, InboxMessage } from "../app/components/inbox/model";

const html = (element: React.ReactElement) => renderToStaticMarkup(element);
const ru = (element: React.ReactElement) => renderToStaticMarkup(createElement(I18nProvider, { locale: "ru", choice: "ru" }, element));

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const answer = (id: string, parts: unknown[]): UIMessage => ({ id, role: "assistant", parts: parts as UIMessage["parts"] });
const tool = (name: string, output: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: `tool-${name}`, toolCallId: name + "-1", state: "output-available", input: {}, output, ...extra });

const account = (id: string, provider: InboxAccount["provider"], email: string): InboxAccount =>
  ({ id, provider, email, name: email, status: "ok" });
const studio = account("cloudflare:studio@example.com", "cloudflare", "studio@example.com");
const sales = account("cloudflare:sales@example.com", "cloudflare", "sales@example.com");
const gmail = account("gmail:me", "gmail", "me@gmail.com");

// ── B11-02: a failed model turn ─────────────────────────────────────────────

test("a failed turn is the chat's error state, not a stream still running", () => {
  assert.equal(chat.turnFailed("error", new Error("x")), true);
  assert.equal(chat.turnFailed("ready", new Error("x")), true);
  assert.equal(chat.turnFailed("streaming", new Error("x")), false);
  assert.equal(chat.turnFailed("ready", undefined), false);
});

test("Retry sends the last prompt again, once, and never while an answer streams", async () => {
  const messages = [user("u1", "First"), answer("a1", [{ type: "text", text: "ok" }]), user("u2", " Summarise the thread "), answer("a2", [])];
  assert.equal(chat.lastPrompt(messages), "Summarise the thread");
  assert.equal(chat.lastPrompt([answer("a", [])]), null);
  const calls: string[] = [];
  const fake = { messages, clearError: () => calls.push("clear"), regenerate: async () => { calls.push("regenerate"); } };
  assert.equal(chat.retryTurn({ ...fake, streaming: true }), false);
  assert.deepEqual(calls, []);
  assert.equal(chat.retryTurn({ ...fake, streaming: false }), true);
  assert.deepEqual(calls, ["clear", "regenerate"]);
  // No prompt to repeat: nothing is sent.
  assert.equal(chat.retryTurn({ ...fake, messages: [], streaming: false }), false);
  // A retry the transport refuses lands in the chat's error state again, not as an unhandled rejection.
  assert.equal(chat.retryTurn({ ...fake, streaming: false, regenerate: () => Promise.reject(new Error("socket closed")) }), true);
  await new Promise((r) => setTimeout(r, 0));
});

test("the error bubble says the answer failed, as an alert, with Retry only when there is a prompt", () => {
  const withRetry = html(createElement(ChatErrorBubble, { canRetry: true, onRetry: () => {} }));
  assert.match(withRetry, /role="alert"/);
  assert.match(withRetry, /The AI could not finish this answer\./);
  assert.match(withRetry, />Retry</);
  const without = html(createElement(ChatErrorBubble, { canRetry: false, onRetry: () => {} }));
  assert.doesNotMatch(without, />Retry</);
  assert.match(ru(createElement(ChatErrorBubble, { canRetry: true, onRetry: () => {} })), /ИИ не смог закончить этот ответ\..*Повторить/s);
});

/** The chat as it renders for a given state of the agent client (the hooks are fakes). */
function chatWith(state: { status: string; error?: Error; messages: UIMessage[] }, props: Record<string, unknown> = {}) {
  const useAgent = (() => ({})) as never;
  const useAgentChat = (() => ({ ...state, sendMessage: () => {}, setMessages: () => {}, stop: () => {},
    clearError: () => {}, regenerate: async () => {} })) as never;
  return html(createElement(AgentChatConnected, { mailboxId: "studio@example.com", useAgent, useAgentChat, ...props }));
}

test("the chat renders a failed turn as an error bubble with Retry after the question (B11-02)", () => {
  const failed = chatWith({ status: "error", error: new Error("Stream error"), messages: [user("u1", "Any unread emails?")] });
  assert.match(failed, /Any unread emails\?/);
  assert.match(failed, /role="alert".*The AI could not finish this answer\..*>Retry</s);
  assert.doesNotMatch(failed, /Stream error/, "the transport's words are not shown");
  const fine = chatWith({ status: "ready", messages: [user("u1", "Hi"), answer("a1", [{ type: "text", text: "Hello" }])] });
  assert.doesNotMatch(fine, /role="alert"/);
  // A failure before any message still shows the bubble instead of the empty state.
  const early = chatWith({ status: "error", error: new Error("x"), messages: [] });
  assert.match(early, /role="alert"/);
  assert.doesNotMatch(early, />Retry</);
});

test("with a message open on the panel's address, it is offered as the first prompts", () => {
  const out = chatWith({ status: "ready", messages: [] }, { focus: { emailId: "m-42", subject: "Invoice" } });
  assert.match(out, /Explain the open message “Invoice” \(message id m-42\).*Draft a reply to the open message “Invoice”.*Show me the latest inbox emails/s);
  assert.doesNotMatch(chatWith({ status: "ready", messages: [] }), /open message/);
});

// ── Drafts stay proposals: "Edit & send in composer" ───────────────────────

test("the draft an answer saved is read from the tool's output (and from older saved chats)", () => {
  const saved = { status: "draft_saved", draftId: "d-1", draft: { originalEmailId: "m-1", to: "maya@example.com", subject: "Re: Hi", body: "Thanks" } };
  assert.deepEqual(chat.draftOf(answer("a", [tool("draft_reply", saved)])), { draftId: "d-1", to: "maya@example.com", subject: "Re: Hi", body: "Thanks", originalEmailId: "m-1" });
  // Saved by an older client: `toolName` + `result`.
  assert.equal(chat.draftOf(answer("a", [{ type: "dynamic-tool", toolName: "draft_email", state: "output-available", result: { draftId: "d-2" } }]))?.draftId, "d-2");
  // A refused draft (verification failed) opens nothing.
  assert.equal(chat.draftOf(answer("a", [tool("draft_reply", { error: "Draft verification failed" })])), null);
  assert.equal(chat.usesDraftTool(answer("a", [tool("draft_email", { draftId: "x" })])), true);
  assert.equal(chat.usesDraftTool(answer("a", [tool("get_email", {})])), false);
});

// ── B11-03: sources link into the reader ───────────────────────────────────

test("the messages an answer read are its sources, each once, in reading order", () => {
  const message = answer("a", [
    tool("list_emails", [{ id: "m-1", subject: "Invoice", sender: "billing@acme.test", read: false }, { id: "m-2", subject: "Lunch", sender: "sam@example.com", read: true }]),
    tool("get_email", { id: "m-1", subject: "Invoice", sender: "billing@acme.test", thread_id: "t-1" }),
    tool("get_thread", { thread_id: "t-1", messages: [{ id: "m-3", subject: "Re: Invoice", sender: "me@example.com" }] }),
    tool("search_emails", [{ id: "m-4", subject: "Quote" }]),
    { type: "tool-get_email", toolCallId: "x", state: "input-available", input: { emailId: "m-9" } },
    tool("get_email", { error: "Email not found" }),
    tool("draft_reply", { draftId: "d-1" }, { input: { originalEmailId: "m-5" } }),
    { type: "text", text: "Done" },
  ]);
  const sources = chat.sourcesOf(message);
  assert.deepEqual(sources.map((s) => s.emailId), ["m-1", "m-2", "m-3", "m-4", "m-5"]);
  assert.equal(sources[0]!.read, false);
  assert.equal(sources[0]!.subject, "Invoice");
});

test("sources render as reader links, at most five, the rest counted", () => {
  const sources = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => ({ emailId: id, subject: i === 1 ? "" : `Subject ${id}`, sender: i === 1 ? "sam@example.com" : "" }));
  const out = html(createElement(SourceLinks, { sources, onOpen: () => {} }));
  assert.equal((out.match(/<button/g) ?? []).length, 5);
  assert.match(out, /aria-label="Open Subject a in the reader"/);
  assert.match(out, /Message from sam@example\.com/);
  assert.match(out, /and 2 more messages/);
  assert.equal(html(createElement(SourceLinks, { sources: [], onOpen: () => {} })), "");
});

test("an answer lists its sources only where the panel can open them", () => {
  const message = answer("a", [tool("get_email", { id: "m-1", subject: "Invoice", sender: "x@y.test" }), { type: "text", text: "It is an invoice." }]);
  assert.match(html(createElement(MessageBubble, { message, isStreaming: false, onOpenSource: () => {} })), /Read for this answer.*Invoice/s);
  assert.doesNotMatch(html(createElement(MessageBubble, { message, isStreaming: false })), /Read for this answer/);
});

test("a source opens the listed row, or one with the server's identity for that row", () => {
  const listed: InboxMessage = { id: "row", accountId: studio.id, provider: "cloudflare", providerMessageId: "m-1", subject: "Invoice", sender: "", recipient: "", date: "", read: false, starred: false, snippet: "" };
  assert.equal(chat.sourceMessage(studio.id, { emailId: "m-1", subject: "", sender: "" }, [listed]), listed);
  const made = chat.sourceMessage(studio.id, { emailId: "m-2", subject: "Lunch", sender: "sam@example.com", threadId: "t-2" }, [listed]);
  assert.equal(made.id, JSON.stringify([studio.id, "m-2"]), "inboxIdentity (shared/mail/inbox.ts)");
  assert.equal(made.provider, "cloudflare");
  assert.equal(made.providerMessageId, "m-2");
  assert.equal(made.threadId, "t-2");
});

// ── B11-01: which address, and the workbench mount ─────────────────────────

test("the panel reads the open message's address, else the person's pick, else the view's", () => {
  const accounts = [gmail, studio, sales];
  assert.equal(chat.agentAccount({ accounts, inScope: accounts, openAccountId: sales.id, chosenAccountId: studio.id })?.account, sales);
  assert.equal(chat.agentAccount({ accounts, inScope: accounts, openAccountId: sales.id })?.by, "message");
  // A Gmail message open: the panel cannot read it and falls back.
  assert.deepEqual(chat.agentAccount({ accounts, inScope: accounts, openAccountId: gmail.id, chosenAccountId: sales.id }), { account: sales, by: "choice" });
  assert.deepEqual(chat.agentAccount({ accounts, inScope: [gmail, sales], filterAccountId: null }), { account: sales, by: "scope" });
  assert.equal(chat.agentAccount({ accounts, inScope: [gmail], filterAccountId: studio.id })?.account, studio);
  assert.equal(chat.agentAccount({ accounts, inScope: [gmail] })?.account, studio);
  assert.equal(chat.agentAccount({ accounts: [gmail], inScope: [gmail] }), null);
  assert.equal(chat.mailboxOf(studio), "studio@example.com");
});

const dock = (props: Partial<Parameters<typeof AgentDock>[0]> = {}) => html(createElement(AgentDock, {
  open: true, wide: true, onClose: () => {}, addresses: [studio, sales], reading: { account: studio, by: "scope" },
  onChoose: () => {}, onOpenSource: () => {}, onEditDraft: () => {}, ...props,
}));

test("closed, the panel renders nothing, so no chat or socket exists", () => {
  assert.equal(dock({ open: false }), "");
});

test("wide windows get a labelled column that names the address it reads, with a picker", () => {
  const out = dock();
  assert.match(out, /^<aside id="fi-agent-panel" class="fi-agent-panel" aria-labelledby="fi-agent-title">/);
  assert.match(out, /<h2 id="fi-agent-title">Ask AI<\/h2>/);
  assert.match(out, /Reads studio@example\.com\./);
  assert.match(out, /<select[^>]*>.*sales@example\.com/s);
  assert.match(out, /aria-label="Close AI panel"/);
  assert.match(out, /Loading agent/, "the chat itself loads lazily");
});

test("narrow windows get a modal sheet; an open message decides the address, without a picker", () => {
  const out = dock({ wide: false, reading: { account: sales, by: "message" } });
  assert.match(out, /^<dialog id="fi-agent-panel" class="fi-agent-panel fi-agent-sheet" aria-labelledby="fi-agent-title">/);
  assert.match(out, /Reads sales@example\.com, where the open message is\./);
  assert.doesNotMatch(out, /<select/);
});

test("the panel says what it cannot read instead of failing", () => {
  assert.match(dock({ unreadableOpen: "me@gmail.com" }), /The open message is in me@gmail\.com\. The AI panel reads only your Cloudflare addresses\./);
  const none = dock({ addresses: [], reading: null });
  assert.match(none, /you have none yet/);
  assert.doesNotMatch(none, /Loading agent/);
  assert.match(ru(createElement(AgentDock, { open: true, wide: true, onClose: () => {}, addresses: [studio], reading: { account: studio, by: "scope" },
    onChoose: () => {}, onOpenSource: () => {}, onEditDraft: () => {} })), /Спросить ИИ.*Читает studio@example\.com/s);
});

test("the unified inbox mounts the panel with an accessible header toggle (B11-01)", () => {
  const source = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(source, /\[agentOpen, setAgentOpen\] = useState\(false\)/, "closed until asked for");
  assert.match(source, /aria-label=\{t\("AI panel"\)\}[^>]*aria-expanded=\{agentOpen\} aria-controls="fi-agent-panel"/);
  assert.match(source, /<AgentDock open=\{agentOpen\} wide=\{agentWide\} onClose=\{closeAgent\}/);
  assert.match(source, /closest\?\.\("\.fi-agent-panel"\)\) return;/, "keys typed in the panel never archive or discard mail");
  assert.match(source, /agentToggle\.current\?\.focus\(\)/, "closing gives focus back to the toggle");
  // The legacy mailbox page keeps its own panel.
  assert.match(readFileSync("app/routes/mailbox.tsx", "utf8"), /<AgentSidebar \/>/);
  // The column has room only on wide windows; elsewhere the sheet.
  assert.match(readFileSync("app/styles/workbench.css", "utf8"), /@media \(min-width: 1400px\) \{\n  \.fi-app\.fi-agent-open \{ grid-template-columns: 232px minmax\(0, 1fr\) 360px; \}/);
});

test("a failed tool call shows as failed, never with the success check", () => {
  const bubble = (state: string) => html(createElement(MessageBubble, { isStreaming: false,
    message: answer("a1", [{ type: "tool-get_email", toolCallId: "t1", state, input: { emailId: "m-1" }, ...(state === "output-error" ? { errorText: "boom" } : { output: {} }) }]) }));
  const failed = bubble("output-error");
  assert.match(failed, /text-kumo-error[^>]*>.*Failed/s);
  assert.doesNotMatch(failed, /text-kumo-success/);
  assert.doesNotMatch(failed, /boom/, "the tool's raw error is not shown");
  assert.match(bubble("output-available"), /text-kumo-success/);
});
