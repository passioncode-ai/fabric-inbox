import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Toasty } from "@cloudflare/kumo";
import AgentAccessSection, { JOURNAL, LEVELS, scopeText, sendingText } from "../app/components/settings/sections/AgentAccessSection";
import { ConfirmProvider, WorkProvider } from "../app/components/settings/ui";
import { msg, translateText } from "../shared/i18n";

/** Settings → Agent access (SCR-15, SCN-043, SCN-044) rendered with the server's answers already in the cache. */
function render(id: string | null, keys: unknown, journal?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (keys) client.setQueryData(["agent-keys"], keys);
  if (journal) client.setQueryData(["agent-journal", null], journal);
  const element = createElement(ConfirmProvider, null, createElement(WorkProvider, null, createElement(AgentAccessSection, { id })));
  const router = createMemoryRouter([{ path: "*", element }], { initialEntries: ["/settings/agent-access"] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Toasty, null, createElement(RouterProvider, { router }))));
}

const key = (over: Record<string, unknown> = {}) => ({
  id: "t1", clientId: "abc.access", name: "Support assistant", level: "mail", send: "send", dailySendLimit: 20,
  createdAt: "2026-09-29T10:00:00Z", expiresAt: "2027-09-29T10:00:00Z", ...over,
});

test("each level says what it may do, and sending reads the way the key sends (SCN-043)", () => {
  assert.deepEqual(LEVELS.map((l) => l.title), ["Read", "Mail", "Admin"]);
  assert.match(LEVELS[0]!.hint, /Changes nothing/);
  assert.equal(sendingText({ level: "read", send: "send", dailySendLimit: 9 }), "Sends nothing");
  assert.equal(sendingText({ level: "mail", send: "drafts", dailySendLimit: 9 }), "Drafts only");
  assert.equal(sendingText({ level: "admin", send: "send", dailySendLimit: 9 }), "Can send, 9 a day");
});

test("the list shows each key with how it sends, never a secret, and says these are not the reply agents (SCN-043)", () => {
  const html = render(null, { keys: [key()], mcpUrl: "https://inbox.example/mcp", canIssue: true });
  assert.match(html, /These are not the reply agents/);
  assert.match(html, /Support assistant/);
  assert.match(html, /Can send, 20 a day/);
  assert.match(html, /What agents changed/, "the journal is the first row of the list");
  assert.match(html, /New key/);
  assert.doesNotMatch(html, /Client Secret/, "the secret appears only in the dialog right after a key is made");
});

test("a key's panel offers Revoke only behind its ⋯ menu, and names what it reaches (SCN-044, AP-11)", () => {
  const html = render("t1", { keys: [key({ accounts: ["cloudflare:research@sshlg.me"] })], mcpUrl: "https://inbox.example/mcp", canIssue: true });
  assert.match(html, /More actions for Support assistant/);
  assert.doesNotMatch(html, />Revoke…</, "the menu is closed until opened");
  assert.match(html, /Only research@sshlg\.me/);
  assert.match(html, /shown once/);
});

test("the journal lists what agents changed, and says so when nothing was (SCN-044)", () => {
  const keys = { keys: [], mcpUrl: "https://inbox.example/mcp", canIssue: true };
  const html = render(JOURNAL, keys, { entries: [{ at: Date.parse("2026-09-29T11:00:00Z"), callerLabel: "Support assistant", tool: "send_email", target: "cloudflare:support@x.invalid → ann@y.invalid", outcome: "done", detail: "" }], nextBefore: null });
  assert.match(html, /send_email/);
  assert.match(html, /Done/);
  assert.match(render(JOURNAL, keys, { entries: [], nextBefore: null }), /No agent has changed anything yet/);
});

test("with no keys and no Cloudflare token, the list says so and where to go (SCN-043)", () => {
  const html = render(null, { keys: [], mcpUrl: "https://inbox.example/mcp", canIssue: false });
  assert.match(html, /No agent has a key yet/);
  assert.match(html, /has no Cloudflare token, so it cannot make keys/);
});

test("a key says which mailboxes it reaches (AP-11)", () => {
  assert.equal(scopeText({ accounts: null }), "All mailboxes");
  assert.equal(scopeText({ accounts: ["cloudflare:research@sshlg.me"] }), "Only research@sshlg.me");
  assert.equal(scopeText({ accounts: ["cloudflare:a@x.invalid", "gmail:g1"] }), "Only a@x.invalid, gmail:g1");
  assert.equal(scopeText({ accounts: [] }), "No mailbox");
});

test("the revoke confirmation keeps the key with Keep, and a failed save says to try again (B2-01, B2-02)", () => {
  const section = readFileSync("app/components/settings/sections/AgentAccessSection.tsx", "utf8");
  assert.match(section, /confirmLabel: t\("Revoke"\), cancelLabel: t\("Keep"\)/, "the cancel of a revoke reads Keep");
  const route = readFileSync("workers/routes/agent-keys.ts", "utf8");
  assert.match(route, /could not be completed: \{error\}\. Try again\./, "a failed save says to try again");
  // What the key panel shows (t.text(errorText(error))), in both languages.
  const answer = msg("{action} could not be completed: {error}. Try again.", { action: msg("Saving the key"), error: "R2 timed out" });
  assert.equal(translateText("en", answer), "Saving the key could not be completed: R2 timed out. Try again.");
  assert.match(translateText("ru", answer), /^Сохранение ключа: не удалось выполнить\. R2 timed out Попробуйте ещё раз\.$/);
  assert.equal(translateText("ru", msg("Keep")), "Оставить", "the revoke's Keep has its Russian");
});
