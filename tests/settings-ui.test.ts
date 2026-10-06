import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SECTION, SECTIONS, SECTION_IDS, isSection, legacyTarget, parseSettingsPath, settingsPath,
} from "../app/components/settings/paths";
import { count, groupRows, matches, nextIndex, stableGroup, visibleRows, type ListEntry } from "../app/components/settings/list-model";
import { stepsSummary, stepsFailed } from "../app/components/settings/sections/steps";
import { PROVIDERS, availability } from "../app/components/settings/sections/providers";

/** SCR-02 Settings: one screen, its addresses, and the list behaviour behind the 2026-10-06 scroll fix. */

test("every old settings address lands in its section, keeping what it pointed at", () => {
  assert.equal(legacyTarget("/projects"), "/settings/addresses");
  assert.equal(legacyTarget("/projects", "?domain=example.com"), "/settings/domains/example.com");
  assert.equal(legacyTarget("/mailboxes"), "/settings/addresses");
  assert.equal(legacyTarget("/accounts"), "/settings/accounts");
  assert.equal(legacyTarget("/accounts/"), "/settings/accounts", "a trailing slash is the same address");
  assert.equal(legacyTarget("/ai-agents"), "/settings/agents");
  assert.equal(legacyTarget("/agents"), "/settings/agents");
  assert.equal(legacyTarget("/knowledge", "?c=kc1"), "/settings/knowledge/kc1");
  assert.equal(legacyTarget("/knowledge"), "/settings/knowledge");
  assert.equal(legacyTarget("/categories", "?c=cat%201"), "/settings/categories/cat%201");
  assert.equal(legacyTarget("/spam"), "/settings/spam");
  assert.equal(legacyTarget("/agent-access"), "/settings/agent-access");
  assert.equal(legacyTarget("/setup"), "/settings/app/setup");
  assert.equal(legacyTarget("/setup", "?source=desktop"), "/settings/app/setup?source=desktop", "the desktop's pending setup survives the redirect");
  assert.equal(legacyTarget("/mailbox/support%40x.invalid/settings"), "/settings/addresses/support%40x.invalid/signature");
  assert.equal(legacyTarget("/mailbox/x/emails/inbox"), null, "a mail page is not a settings page");
  assert.equal(legacyTarget("/"), null);
});

test("every old address is registered as a redirect route", () => {
  const routes = readFileSync("app/routes.ts", "utf8");
  for (const path of ["mailboxes", "accounts", "ai-agents", "agents", "knowledge", "categories", "spam", "agent-access", "projects", "setup"]) {
    assert.match(routes, new RegExp(`"${path}"`), path);
    assert.notEqual(legacyTarget(`/${path}`), null, path);
  }
  assert.match(routes, /route\("settings", "routes\/settings-redirect\.tsx"/, "the legacy mailbox settings redirect");
});

test("a settings address is built and read back the same way", () => {
  assert.equal(settingsPath("addresses"), "/settings/addresses");
  assert.equal(settingsPath("addresses", "a+b@x.invalid", "copy"), "/settings/addresses/a%2Bb%40x.invalid/copy");
  assert.equal(settingsPath("addresses", null, "copy"), "/settings/addresses", "a tab needs an item");
  assert.equal(settingsPath("accounts", null, null, { connect: "gmail" }), "/settings/accounts?connect=gmail");
  assert.deepEqual(parseSettingsPath("/settings/addresses/a%2Bb%40x.invalid/copy"), { section: "addresses", id: "a+b@x.invalid", tab: "copy" });
  assert.deepEqual(parseSettingsPath("/settings"), { section: DEFAULT_SECTION, id: null, tab: null });
  assert.equal(parseSettingsPath("/settings/nope"), null);
  assert.equal(parseSettingsPath("/projects"), null);
  assert.ok(SECTION_IDS.every(isSection));
  assert.equal(isSection("projects"), false);
  assert.deepEqual(SECTIONS.map((s) => s.id).sort(), [...SECTION_IDS].sort(), "every section is listed once");
  for (const s of SECTIONS) assert.match(s.label, /^[A-Z][a-z]/, `${s.label} is sentence case`);
});

const row = (key: string, group: string, text = key): ListEntry => ({ key, group, text });

test("a row keeps the group it was first shown in, so a change of state never moves it", () => {
  const seen = new Map<string, string>();
  const first = stableGroup(seen, [row("a.com", "other"), row("b.com", "served")]);
  assert.deepEqual(first.map((r) => r.group), ["other", "served"]);
  // a.com starts receiving here: by its state it belongs to "served" now, but it stays where it is.
  const after = stableGroup(seen, [row("a.com", "served"), row("b.com", "served"), row("c.com", "other")]);
  assert.deepEqual(after.map((r) => [r.key, r.group]), [["a.com", "other"], ["b.com", "served"], ["c.com", "other"]]);
  // It left and came back: still its first group.
  stableGroup(seen, [row("b.com", "served")]);
  assert.equal(stableGroup(seen, [row("a.com", "served")])[0]!.group, "other");
});

test("groups keep their order and their rows' order; an unknown group falls into the last one", () => {
  const groups = groupRows([row("x", "b"), row("y", "a"), row("z", "b"), row("w", "zzz")], [{ id: "a", label: "A" }, { id: "b", label: "B" }]);
  assert.deepEqual(groups.map((g) => [g.id, g.rows.map((r) => r.key)]), [["a", ["y"]], ["b", ["x", "z", "w"]]]);
  assert.deepEqual(groupRows([row("x", "a")], [{ id: "a", label: "A" }, { id: "b", label: "B" }]).map((g) => g.id), ["a"], "an empty group is left out");
  assert.deepEqual(groupRows([row("x", "a")], []), []);
});

test("a search matches every word in any order, and never hides the selected row", () => {
  assert.equal(matches({ text: "support@acme.com Support agent" }, "acme support"), true);
  assert.equal(matches({ text: "support@acme.com" }, "billing"), false);
  assert.equal(matches({ text: "anything" }, "   "), true);
  const rows = [row("support@acme.com", "acme.com"), row("billing@acme.com", "acme.com"), row("hi@other.org", "other.org")];
  assert.deepEqual(visibleRows(rows, "billing", null).map((r) => r.key), ["billing@acme.com"]);
  assert.deepEqual(visibleRows(rows, "billing", "hi@other.org").map((r) => r.key), ["billing@acme.com", "hi@other.org"]);
});

test("arrow keys, Home and End move through the list and stop at its ends", () => {
  assert.equal(nextIndex(0, "ArrowDown", 3), 1);
  assert.equal(nextIndex(2, "ArrowDown", 3), 2);
  assert.equal(nextIndex(0, "ArrowUp", 3), 0);
  assert.equal(nextIndex(-1, "ArrowDown", 3), 0);
  assert.equal(nextIndex(-1, "ArrowUp", 3), 2);
  assert.equal(nextIndex(1, "Home", 3), 0);
  assert.equal(nextIndex(1, "End", 3), 2);
  assert.equal(nextIndex(0, "ArrowDown", 0), -1);
  assert.equal(count(1, "address", "addresses"), "1 address");
  assert.equal(count(3, "domain"), "3 domains");
});

test("a domain action is summed up in one sentence; a failed step says running it again continues", () => {
  const step = (outcome: "done" | "already" | "skipped" | "failed", label = "Turn on Email Routing") => ({ id: label, label, outcome, detail: "Detail." });
  assert.match(stepsSummary("acme.com", [step("done"), step("already", "Sending")]), /acme\.com: done, 1 step changed/);
  assert.match(stepsSummary("acme.com", [step("already")]), /already so/);
  assert.match(stepsSummary("acme.com", []), /nothing to do/);
  const failed = [step("done"), step("failed", "Bring addresses here")];
  assert.match(stepsSummary("acme.com", failed), /not finished — Bring addresses here\. Detail\. Running it again continues/);
  assert.equal(stepsFailed(failed), true);
  assert.equal(stepsFailed([step("done")]), false);
});

test("the provider cards connect only what this build can; the rest say they are not available", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids.slice(0, 2), ["cloudflare", "gmail"]);
  const state = { cloudflareConnected: true, gmail: "configured" as const };
  assert.equal(availability(PROVIDERS.find((p) => p.id === "gmail")!, state), "available");
  assert.equal(availability(PROVIDERS.find((p) => p.id === "gmail")!, { ...state, gmail: "not-configured" }), "not-configured");
  assert.equal(availability(PROVIDERS.find((p) => p.id === "gmail")!, { ...state, gmail: "loading" }), "checking");
  assert.equal(availability(PROVIDERS.find((p) => p.id === "gmail")!, { ...state, gmail: "unavailable" }), "unknown", "a failed load never claims Gmail is not configured");
  assert.equal(availability(PROVIDERS.find((p) => p.id === "cloudflare")!, { ...state, cloudflareConnected: null }), "checking");
  assert.equal(availability(PROVIDERS.find((p) => p.id === "cloudflare")!, { ...state, cloudflareConnected: false }), "not-configured");
  for (const p of PROVIDERS.filter((x) => x.connect === "none")) assert.equal(availability(p, state), "unavailable", p.id);
});

test("Settings never resets the scroll on a selection: every row, tab and close navigates with preventScrollReset", () => {
  const ui = readFileSync("app/components/settings/ui.tsx", "utf8");
  const rowLink = ui.slice(ui.indexOf("const row = (key"), ui.indexOf("return (\n    <div ref={root}"));
  assert.match(rowLink, /preventScrollReset/);
  assert.match(ui.slice(ui.indexOf("export function PanelTabs")), /preventScrollReset/);
  assert.match(ui.slice(ui.indexOf("export function Panel(")), /navigate\(closeTo, \{ preventScrollReset: true/);
  const css = readFileSync("app/styles/settings.css", "utf8");
  assert.match(css, /\.fi-settings \{[^}]*height: 100dvh;[^}]*overflow: hidden;/s, "the page never scrolls: list and panel scroll on their own");
  assert.match(css, /\.fi-section-scroll \{[^}]*overflow-y: auto/s);
  // Below 930px the hidden list stays laid out, so it keeps its scroll position under the panel.
  assert.match(css, /has-selection \.fi-section-list,[\s\S]*visibility: hidden/);
});

test("the inbox sidebar has one Settings entry, and its add links open the right section", () => {
  const inbox = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const bottom = inbox.slice(inbox.indexOf('<div className="fi-sidebar-bottom">'), inbox.indexOf('<div className="fi-theme-row">'));
  assert.match(bottom, /to="\/settings"/);
  assert.doesNotMatch(bottom, /Manage accounts|\/projects|\/ai-agents|\/agent-access|\/knowledge/);
  const sidebar = readFileSync("app/components/inbox/AccountSidebar.tsx", "utf8");
  assert.match(sidebar, /to="\/settings\/addresses\?add=1"/);
  assert.match(sidebar, /to="\/settings\/accounts\?connect=gmail"/);
  assert.doesNotMatch(sidebar, /key === domain \|\|/, "selecting a domain does not open or fold groups");
});
