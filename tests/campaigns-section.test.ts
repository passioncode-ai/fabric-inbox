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
import { primaryAction, progress, reasonText, statusLabel } from "../app/components/settings/sections/campaigns-model";
import { isSection, SECTIONS } from "../app/components/settings/paths";

/**
 * SCN-091 (SCR-18): Settings → Campaigns. The words for states and reasons, the actions each state offers, and the
 * section rendered from its data in English and in Russian with no English left a person would read.
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
const { default: CampaignsSection } = await import("../app/components/settings/sections/CampaignsSection");

function render(element: ReactElement, data: [unknown[], unknown][], path: string, locale: "en" | "ru") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of data) client.setQueryData(key, value);
  const wrapped = createElement(I18nProvider, { locale, choice: locale }, createElement(ConfirmProvider, null, createElement(WorkProvider, null, element)));
  const router = createMemoryRouter([{ path: "*", element: wrapped }], { initialEntries: [path] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Toasty, null, createElement(RouterProvider, { router }))));
}
// Names, and the campaign's own words (its name and steps are what the agent wrote, not the interface).
const SAME = /^(Gmail|Outlook|IMAP|UTC|Acme|Pilot|About|there|Any|thoughts)$/;
function englishLeft(html: string): string[] {
  const attrs = [...html.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<(script|style|code)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ");
  const words = `${text} ${attrs.join(" ")}`.replace(/&[a-z#0-9]+;/g, " ").replace(/\S+@\S+|https?:\/\/\S+|[\w-]+\.[a-z]{2,}(\/\S*)?|save_campaign/g, " ")
    .match(/\b[A-Za-z][a-z]{2,}\b/g) ?? [];
  return [...new Set(words.filter((w) => !SAME.test(w)))];
}

const campaign = {
  id: "c1", name: "Pilot", sender: "gmail:sales@acme.example", timezone: "UTC", window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  dailyCap: 30, gapMinutes: [5, 10], steps: [{ subject: "About Acme", body: "Hi there", delayDays: 3 }, { subject: "", body: "Any thoughts?", delayDays: 3 }],
  stopOnReply: true, companyStop: true, unsubscribeText: "x", state: "paused", version: 2, createdAt: "2026-10-27T09:00:00Z", updatedAt: "2026-10-27T09:00:00Z",
  reason: "bounces", launchedAt: "2026-10-27T09:00:00Z", counts: { queued: 3, replied: 1, bounced: 1 },
};
const report = { campaign, sent: 2, perStep: [2, 0], contacted: 2, replyRate: 0.5, bounceRate: 0.5, lastSentAt: "2026-10-27T09:05:00Z", nextSendAt: null, failures: [] };
const people = { recipients: [{ email: "ann@acme.example", fields: {}, status: "stopped", step: 1, detail: "company_replied" }], total: 5 };
const data: [unknown[], unknown][] = [[["campaigns"], { campaigns: [campaign] }], [["campaign-report", "c1"], report], [["campaign-people", "c1", ""], people],
  [["suppression"], { suppression: [{ value: "beta.example", reason: "replied_unsubscribe", addedAt: "2026-10-27T10:00:00Z" }] }]];

test("SCN-091: the section is listed under Agents; states, reasons and the primary action read as words", () => {
  assert.ok(isSection("campaigns"));
  assert.equal(SECTIONS.find((s) => s.id === "campaigns")?.group, "agents");
  assert.deepEqual(progress(campaign), { open: 3, total: 5 });
  assert.deepEqual(["draft", "paused", "running", "stopped", "finished"].map((s) => primaryAction(s as never)), ["start", "resume", "pause", null, null]);
  assert.match(reasonText("bounces"), /5% of its messages bounced/);
  assert.equal(reasonText("unknown_code"), "unknown_code", "an unknown code is shown as it is");
  assert.equal(statusLabel("unsubscribed"), "Asked to stop");
});

test("SCN-091: a paused campaign shows why, its report, steps and people, and offers Resume; in Russian nothing is left in English", () => {
  const en = render(createElement(CampaignsSection, { id: "c1" }), data, "/settings/campaigns/c1", "en");
  for (const text of ["Paused by itself: 5% of its messages bounced", "2 people written to", "Replies: 50%", "Reply in the same conversation",
    "Someone at the same company replied.", "The first 1 of 5.", ">Resume<", "Do-not-write list"]) assert.ok(en.includes(text), text);
  const ru = render(createElement(CampaignsSection, { id: "c1" }), data, "/settings/campaigns/c1", "ru");
  assert.match(ru, /Остановилась сама: 5% писем не доставлено/);
  assert.match(ru, /Возобновить/);
  assert.deepEqual(englishLeft(ru), []);
  const list = render(createElement(CampaignsSection, { id: "do-not-write" }), data, "/settings/campaigns/do-not-write", "ru");
  assert.match(list, /Стоп-лист/);
  assert.match(list, /Ответил просьбой больше не писать/);
  assert.deepEqual(englishLeft(list), []);
  const empty = render(createElement(CampaignsSection, { id: null }), [[["campaigns"], { campaigns: [] }]], "/settings/campaigns", "en");
  assert.match(empty, /No campaign yet\./);
  assert.match(empty, /Your agent prepares a campaign/);
});
