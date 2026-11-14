// S11 (B-276, SCN-099): Settings name their server and list every server's accounts, addresses and domains.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ALL_SECTIONS, addChoices, allModeFor, choiceAfterSection, mailChoseAll, nextSwitchIndex, openingChoice, readOtherSettings,
	settingsGroups, switchLayout, otherItemPath,
} from "../app/lib/settings-servers";

const own = { origin: "https://own.example", label: "Owner" };
const acme = { origin: "https://acme.example", label: "Acme" };
const down = { origin: "https://down.example", label: "Down" };

test("All is enabled on Accounts, Addresses and Domains, disabled with its reason elsewhere, hidden with one server", () => {
	assert.deepEqual([...ALL_SECTIONS], ["accounts", "addresses", "domains"]);
	for (const s of ["accounts", "addresses", "domains"] as const) assert.equal(allModeFor(s, 2), "enabled");
	for (const s of ["agents", "knowledge", "agent-access", "app", "destinations", "people"] as const) assert.equal(allModeFor(s, 3), "disabled");
	assert.equal(allModeFor("accounts", 1), "hidden");
	assert.equal(allModeFor("agents", 0), "hidden");
});

test("Settings open on the mail's choice: All on the three lists, the shown server on the other sections", () => {
	assert.equal(mailChoseAll(null), true, "the mail opens on All until the person chooses one server");
	assert.equal(mailChoseAll("all"), true);
	assert.equal(mailChoseAll("own"), false);
	assert.equal(openingChoice("accounts", true), "all");
	assert.equal(openingChoice("domains", true), "all");
	assert.equal(openingChoice("agents", true), "shown");
	assert.equal(openingChoice("accounts", false), "shown");
	// All chosen in Settings stays the wish: a section of one server shows the shown one, the next list is on All again.
	assert.equal(choiceAfterSection(true, "agents"), "shown");
	assert.equal(choiceAfterSection(true, "addresses"), "all");
	assert.equal(choiceAfterSection(false, "addresses"), "shown");
});

test("segments up to four servers, the menu for five or more", () => {
	assert.equal(switchLayout(2), "segments");
	assert.equal(switchLayout(4), "segments");
	assert.equal(switchLayout(5), "menu");
	assert.equal(switchLayout(9), "menu");
});

test("arrow keys move between the choices and skip a disabled All", () => {
	const choices = [{ disabled: true }, { disabled: false }, { disabled: false }, { disabled: false }];
	assert.equal(nextSwitchIndex(choices, 1, "ArrowRight"), 2);
	assert.equal(nextSwitchIndex(choices, 3, "ArrowRight"), 1, "wraps past the disabled All");
	assert.equal(nextSwitchIndex(choices, 1, "ArrowLeft"), 3, "never lands on the disabled All");
	assert.equal(nextSwitchIndex(choices, 2, "Home"), 1);
	assert.equal(nextSwitchIndex(choices, 2, "End"), 3);
	assert.equal(nextSwitchIndex([{ disabled: false }, { disabled: false }], 0, "ArrowLeft"), 1);
	assert.equal(nextSwitchIndex(choices, 2, "Enter"), 2, "another key does not move");
});

test("the bridge's answer is kept to well-formed servers, states and items with a plain id", () => {
	const read = readOtherSettings({
		kind: "accounts",
		servers: [
			{ origin: acme.origin, label: "Acme", state: "ok", items: [{ id: "gmail:a1", title: "ann@acme.example", detail: "Gmail" }, { id: 4 }, { id: "", title: "x" }] },
			{ origin: down.origin, label: "Down", state: "unreachable", items: [] },
			{ origin: "https://bad.example", label: "Bad", state: "weird" },
			null,
		],
	}, "accounts");
	assert.deepEqual(read.map((s) => [s.label, s.state, s.items.map((i) => i.id)]), [["Acme", "ok", ["gmail:a1"]], ["Down", "unreachable", []]]);
	assert.deepEqual(readOtherSettings({ kind: "domains", servers: [] }, "accounts"), [], "an answer for another kind is not shown");
	assert.deepEqual(readOtherSettings(undefined, "accounts"), []);
});

test("grouping: the shown server first with its own count, then every other held server with its count and state", () => {
	const others = readOtherSettings({
		kind: "addresses",
		servers: [
			{ origin: down.origin, label: "Down", state: "unreachable", items: [] },
			{ origin: acme.origin, label: "Acme", state: "ok", items: [{ id: "support@acme.example", title: "support@acme.example" }, { id: "sales@acme.example", title: "sales@acme.example" }] },
		],
	}, "addresses");
	const signedOut = { origin: "https://out.example", label: "Out" };
	const groups = settingsGroups({ ...own, count: 3 }, [acme, down, signedOut], others, false);
	assert.deepEqual(groups.map((g) => [g.label, g.shown, g.state, g.count]),
		[["Owner", true, "ok", 3], ["Acme", false, "ok", 2], ["Down", false, "unreachable", null], ["Out", false, "loading", null]]);
	// A server the read did not name (an older answer) waits; once the read is done it reads as not reachable.
	assert.equal(settingsGroups({ ...own, count: 0 }, [signedOut], others, true)[1].state, "unreachable");
	assert.equal(settingsGroups({ ...own, count: null }, [], [], true)[0].count, null, "the shown server's count is unknown while it loads");
});

test("another server's item opens that server's settings at that item", () => {
	assert.equal(otherItemPath("accounts", "gmail:a1"), "/settings/accounts/gmail%3Aa1");
	assert.equal(otherItemPath("addresses", "support@acme.example"), "/settings/addresses/support%40acme.example");
	assert.equal(otherItemPath("domains", "acme.example"), "/settings/domains/acme.example");
});

test("adding asks which server, defaulting to the one shown; a server not reachable now cannot take it", () => {
	const choices = addChoices([acme, own, down], own.origin, { [down.origin]: "unreachable", [acme.origin]: "ok" });
	assert.deepEqual(choices.map((c) => [c.label, c.shown, c.chosen, c.disabled]),
		[["Owner", true, true, false], ["Acme", false, false, false], ["Down", false, false, true]]);
});
