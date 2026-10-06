import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Toasty } from "@cloudflare/kumo";

/**
 * SCN-076: key screens rendered in Russian leave no English a person would read. The app's own
 * `~/` imports are resolved here the way Vite resolves them, so whole sections render as in the app.
 */
// Components without the automatic-runtime pragma compile to React.createElement under tsx.
(globalThis as { React?: unknown }).React = React;
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("~/") ? next(new URL(specifier.slice(2), APP).href, context) : next(specifier, context);
  },
});

const { I18nProvider } = await import("../app/lib/i18n");
const { ConfirmProvider, WorkProvider } = await import("../app/components/settings/ui");

/** Renders inside the Russian provider, a router and a query cache filled with `data`. */
function render(element: ReactElement, data: [unknown[], unknown][] = [], path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of data) client.setQueryData(key, value);
  const wrapped = createElement(I18nProvider, { locale: "ru", choice: "ru" },
    createElement(ConfirmProvider, null, createElement(WorkProvider, null, element)));
  const router = createMemoryRouter([{ path: "*", element: wrapped }], { initialEntries: [path] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Toasty, null, createElement(RouterProvider, { router }))));
}

/** Names, codes and examples that read the same in Russian. */
const SAME = /^(Fabric|Inbox|Gmail|Google|Cloud|Cloudflare|Outlook|Microsoft|Entra|IMAP|SMTP|OAuth|MCP|Claude|Code|Cursor|Codex|PassionCode|Access|Email|Routing|Workers|API|Tokens?|Mac|iCloud|Mail|Yahoo|Fastmail|Zoho|AOL|GMX|Yandex|JSON|HTTPS?|DMARC|MX|SPF|DNS|ID|Client|Secret|Value|Expires|Esc|Enter|Tab|Shift|Ctrl|Backspace|Delete|Cmd|Option|Alt)$/;

/** The words a person reads: text between tags and the titles, labels and placeholders. */
function englishLeft(html: string): string[] {
  const attrs = [...html.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<(script|style|code)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ");
  const words = `${text} ${attrs.join(" ")}`.replace(/&[a-z#0-9]+;/g, " ")
    .replace(/\S+@\S+|https?:\/\/\S+|[\w-]+\.[a-z]{2,}(\/\S*)?/g, " ") // addresses, links, hosts
    .match(/\b[A-Za-z][a-z]{2,}\b/g) ?? [];
  return [...new Set(words.filter((w) => !SAME.test(w)))];
}

test("Settings → App with the Language choice is all Russian (SCN-076)", async () => {
  const { default: AppSection } = await import("../app/components/settings/sections/AppSection");
  const list = render(createElement(AppSection, { id: null }), [], "/settings/app");
  assert.match(list, /Язык/);
  assert.match(list, /Оформление/);
  assert.deepEqual(englishLeft(list), ["English"], "only the language's own name, «Системный, English или Русский»");
  const language = render(createElement(AppSection, { id: "language" }), [], "/settings/app/language");
  assert.match(language, /Системный/);
  assert.match(language, /lang="en"[^>]*>.*English/s, "the language names are written in their own language");
  assert.deepEqual(englishLeft(language).filter((w) => w !== "English"), []);
});

test("the keyboard help and the sync status are all Russian, keys unchanged (SCN-071, SCN-070)", async () => {
  const { default: ShortcutsDialog } = await import("../app/components/inbox/ShortcutsDialog");
  const help = render(createElement(ShortcutsDialog, { open: true, mac: true, onClose: () => {} }));
  assert.match(help, /Сочетания клавиш/);
  assert.match(help, /⌘⌫/, "key labels stay as they are");
  assert.deepEqual(englishLeft(help), []);
  const { default: SyncStatus } = await import("../app/components/inbox/SyncStatus");
  const now = new Date(Date.now() - 3 * 60_000).toISOString();
  const status = render(createElement(SyncStatus, {
    accounts: [{ id: "gmail:1", kind: "gmail", label: "owner@example.com", lastSyncAt: now } as never],
    checking: false, fetching: false, onRefresh: () => {}, mac: true,
  }));
  assert.deepEqual(englishLeft(status), []);
});

test("Settings → Agent access and Discard rules are all Russian, counts in their forms", async () => {
  const { default: AgentAccessSection } = await import("../app/components/settings/sections/AgentAccessSection");
  const key = { id: "t1", clientId: "abc.access", name: "Support assistant", level: "mail", send: "send", dailySendLimit: 22,
    createdAt: "2026-09-29T10:00:00Z", expiresAt: "2027-09-29T10:00:00Z" };
  const html = render(createElement(AgentAccessSection, { id: null }), [[["agent-keys"], { keys: [key], mcpUrl: "https://inbox.example/mcp", canIssue: true }]], "/settings/agent-access");
  assert.match(html, /Доступ агентов/);
  assert.deepEqual(englishLeft(html).filter((w) => !["Support", "assistant"].includes(w)), [], "only the key's own name stays");
  const { default: DiscardSection } = await import("../app/components/settings/sections/DiscardSection");
  const discard = render(createElement(DiscardSection, { id: null }), [], "/settings/discard");
  assert.match(discard, /Правила выбрасывания/);
  assert.deepEqual(englishLeft(discard), []);
});

test("the Gmail setup steps are Russian around Google's own button names", async () => {
  const { GmailSetupWizard } = await import("../app/components/settings/sections/GmailSetup");
  const { GOOGLE_CONSOLE, GOOGLE_HELP, gmailSetupValues } = await import("../shared/mail/gmail-setup");
  const origin = "https://fabric-inbox.owner.workers.dev";
  const html = render(createElement(GmailSetupWizard, { onSaved: () => {}, setup: {
    configured: false, missing: ["GOOGLE_CLIENT_ID"], values: gmailSetupValues(origin), clientId: null, projectNumber: null,
    credentialKey: "missing", publicAppUrl: null, addressMatches: null, canSave: true, links: { ...GOOGLE_CONSOLE }, help: { ...GOOGLE_HELP },
  } as never }));
  assert.match(html, /Сохранить и проверить|Сохранить/);
  // Google's console names the person clicks stay English; nothing else does.
  const left = englishLeft(html);
  const googleNames = /^(Branding|Audience|Publish|app|Data|Clients|Create|Web|application|Authorized|redirect|URIs|Internal|External|Testing|Project|Enable|New|project|Library|Save|Continue|Add|Users|users|scopes|Scopes|User|Support|support|email|Developer|contact|information|name|Name|Type|Application|type|JavaScript|origins|Authorised|Get|started|Next|Finish|Agree|Policy|Services|Terms|Of|Use|the|and|of|The|Dashboard|Credentials|Auth|Platform|Overview|Metrics|Verification|Center|Center|Clients|Client|ID|secret|Secret|Download|OK|gmail|modify|Apps|Script|domains|Workspace|Advanced|remove|Update|client|com|googleapis|auth|www)$/;
  assert.deepEqual(left.filter((w) => !googleNames.test(w)), []);
});
