import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A-30: a server's state reads the same in the switch and in Settings' server groups, in Russian
 * as in English: a signed-out server says «Войти» (a verb, on a button) in both, one not reachable
 * now says «Сейчас недоступен» in both (S01's words, docs/brand/terminology.md).
 */
(globalThis as { React?: unknown }).React = React;
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("~/") ? next(new URL(specifier.slice(2), APP).href, context) : next(specifier, context);
  },
});

const { I18nProvider } = await import("../app/lib/i18n");
const { ServerGroups } = await import("../app/components/settings/servers");
const { default: ServerSwitch } = await import("../app/components/ServerSwitch");

const ru = (element: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, { locale: "ru", choice: "ru" }, element));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};

const servers = [
  { origin: "https://alpha.owner.example", label: "Alpha" },
  { origin: "https://beta.owner.example", label: "Beta" },
  { origin: "https://gamma.owner.example", label: "Gamma" },
];
const states = { "https://beta.owner.example": "signed_out", "https://gamma.owner.example": "unreachable" } as const;
const group = (origin: string, label: string, state: "ok" | "signed_out" | "unreachable", shown = false) =>
  ({ origin, label, shown, state, count: shown ? 0 : null, items: [] });

test("the switch and the server groups say signed out and not reachable in the same Russian words (A-30)", () => {
  const switchHtml = ru(createElement(ServerSwitch, {
    servers, states, current: servers[0].origin, allMode: "enabled", onChoose: noop, onRetry: noop, onSignIn: noop, layout: "segments",
  }));
  const groupsHtml = ru(createElement(ServerGroups, {
    kind: "accounts",
    groups: [group(servers[0].origin, "Alpha", "ok", true), group(servers[1].origin, "Beta", "signed_out"), group(servers[2].origin, "Gamma", "unreachable")],
    list: null, onOpen: noop, onRetry: noop,
  }));
  // Signed out: the verb «Войти», never the noun «Вход» (the sign-in window's title).
  assert.match(text(switchHtml), /Beta · Войти/);
  assert.match(text(groupsHtml), /Войти/);
  assert.doesNotMatch(text(groupsHtml), /Вход/);
  // Not reachable now: «Сейчас недоступен» in the switch's tooltip and in the group's note.
  assert.match(switchHtml, /title="Сейчас недоступен"/);
  assert.match(text(groupsHtml), /Сейчас недоступен/);
  assert.doesNotMatch(switchHtml + groupsHtml, /не отвечает/);
});
