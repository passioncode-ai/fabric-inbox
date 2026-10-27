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
 * O-5 (B-184, SCN-031): Settings → Domains with Cloudflare connected and no domain listed was a dead end ("No domain
 * is listed yet." and nothing to do). It now says why that can be, links Cloudflare's own Add a domain page and
 * checks again; a hidden account is named with the way back to it.
 */
(globalThis as { React?: unknown }).React = React;
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("~/") ? next(new URL(specifier.slice(2), APP).href, context) : next(specifier, context);
  },
});
const { I18nProvider } = await import("../app/lib/i18n");
const { ConfirmProvider, WorkProvider } = await import("../app/components/settings/ui");
const { default: DomainsSection, ADD_SITE_URL } = await import("../app/components/settings/sections/DomainsSection");

function render(element: ReactElement, domains: unknown, locale: "en" | "ru") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["domains"], domains);
  client.setQueryData(["project-addresses"], { projects: [] });
  const wrapped = createElement(I18nProvider, { locale, choice: locale }, createElement(ConfirmProvider, null, createElement(WorkProvider, null, element)));
  const router = createMemoryRouter([{ path: "*", element: wrapped }], { initialEntries: ["/settings/domains"] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Toasty, null, createElement(RouterProvider, { router }))));
}

const account = (id: string, shown: boolean) => ({ id, name: `Acme ${id}`, server: id === "a", via: "server", shown, choice: shown ? null : "hidden", hasMail: true, domains: 0, served: 0, relay: null });
const list = (accounts: unknown[], extra: object = {}) => ({ connected: true, accounts, permissions: [], accountPermissions: [], tokenUrl: "https://dash.cloudflare.com/profile/api-tokens", domains: [], ...extra });

test("O-5: connected with no domain, the list says what to do, links Add a domain and checks again", () => {
  const en = render(createElement(DomainsSection, { id: null }), list([account("a", true)]), "en");
  assert.ok(!en.includes("No domain is listed yet."), "the dead-end sentence is gone");
  assert.match(en, /has no domain yet\. Add your domain in Cloudflare, then check again/);
  assert.ok(en.includes(`href="${ADD_SITE_URL}"`), "Cloudflare's Add a domain page is linked");
  assert.match(en, /Open Add a domain in Cloudflare/);
  assert.match(en, />Check again</);
  assert.match(en, /A domain you add to Cloudflare is listed here/);
  assert.ok(!en.includes("are hidden"), "no hidden-account sentence when every account is shown");
});

test("O-5: a hidden account and a token problem are named; in Russian the sentences are Russian", () => {
  const data = list([account("a", true), account("b", false)], { problems: ["A token could not be read."] });
  const en = render(createElement(DomainsSection, { id: null }), data, "en");
  assert.match(en, /1 Cloudflare account is hidden, so its domains are not listed\./);
  assert.match(en, /href="\/settings\/accounts"/);
  assert.match(en, /A token could not be read\./);
  const ru = render(createElement(DomainsSection, { id: null }), data, "ru");
  assert.match(ru, /В вашем аккаунте Cloudflare пока нет доменов/);
  assert.match(ru, /1 аккаунт Cloudflare скрыт, поэтому его домены не показаны\./);
  assert.match(ru, /Проверить ещё раз/);
});

test("O-5: not connected keeps the Connect Cloudflare row and no empty-account advice", () => {
  const en = render(createElement(DomainsSection, { id: null }), { ...list([]), connected: false, problem: "" }, "en");
  assert.match(en, /Connect Cloudflare/);
  assert.ok(!en.includes("has no domain yet"));
});
