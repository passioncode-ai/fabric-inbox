import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOMAIN_STATE, NAME_HINT, agentLine, batchBody, createBody, displayNameOf, domainOptions, filterDomains, nameView, receiveStep,
  startDomain, stepsSentence, testStep, testWaiting, type AddressForm,
} from "../app/components/settings/sections/add-address-model";
import { checkLocalPart } from "../shared/address-name";
import type { DomainList } from "../app/services/domains";
import type { AgentInput, NameCheck, TestStatus } from "../app/services/agents";

// The Add address dialog (SCN-061…065): what it shows and sends, decided outside React.

const list = (over: Partial<DomainList> = {}): DomainList => ({
  connected: true, accounts: [{ id: "a1", name: "Main", server: true, via: "server", shown: true, choice: null, hasMail: true, domains: 4, served: 2, relay: null }],
  permissions: [], accountPermissions: [], tokenUrl: "",
  domains: [
    { domain: "zeta.test", zoneId: "z1", account: { id: "a1", name: "Main", server: true }, served: true, fixed: false, addresses: 1 },
    { domain: "acme.test", zoneId: "z2", account: { id: "a1", name: "Main", server: true }, served: true, fixed: false, addresses: 2 },
    { domain: "hidden.test", zoneId: null, account: null, served: true, fixed: true, addresses: 0 },
    { domain: "new.test", zoneId: "z3", account: { id: "a1", name: "Main", server: true }, served: false, fixed: false, addresses: 0 },
  ],
  ...over,
});

test("the domain choice lists receiving domains first, then the ones that can receive, each with its state (SCN-063)", () => {
  const options = domainOptions(list(), { "zeta.test": "needs_fix" });
  assert.deepEqual(options.map((o) => [o.domain, o.group, o.label]), [
    ["acme.test", "receiving", "Receiving here"],
    ["hidden.test", "receiving", "Token cannot see it"],
    ["zeta.test", "receiving", "Needs fixing"],
    ["new.test", "can_receive", "Can receive here"],
  ]);
  const noToken = domainOptions(list({ connected: false }));
  assert.deepEqual(noToken.map((o) => o.domain), ["acme.test", "hidden.test", "zeta.test"], "without a token only served domains can be chosen");
  assert.ok(noToken.every((o) => o.label === "Receiving here"));
  assert.deepEqual(domainOptions(undefined), []);
  assert.deepEqual(filterDomains(options, "@ze").map((o) => o.domain), ["zeta.test"]);
  assert.deepEqual(filterDomains(options, "nothing", "acme.test").map((o) => o.domain), ["acme.test"], "the chosen domain is never filtered away");
  assert.equal(startDomain(options, "NEW.test"), "new.test");
  assert.equal(startDomain(options, "gone.test"), "acme.test");
  assert.equal(startDomain([], null), "");
  for (const s of Object.values(DOMAIN_STATE)) assert.ok(s.label.length > 3);
});

test("the address field says what is wrong at once, then what the server found (SCN-061)", () => {
  const check = (over: Partial<NameCheck>): NameCheck => ({ localPart: "support", email: "support@acme.test", status: "available", detail: "", notes: [], ...over });
  assert.deepEqual(nameView(checkLocalPart(""), undefined, false, false), { tone: "neutral", text: NAME_HINT, canCreate: false, notes: [] });
  const bad = nameView(checkLocalPart("sup port"), undefined, true, false);
  assert.equal(bad.tone, "bad");
  assert.match(bad.text, /Spaces are not allowed/);
  assert.equal(nameView(checkLocalPart("support"), undefined, true, false).text, "Checking…");
  assert.equal(nameView(checkLocalPart("support"), undefined, true, false).canCreate, false, "Create waits for the check");
  const free = nameView(checkLocalPart("support"), check({ notes: ["Today its mail is kept in hello@acme.test"] }), false, false);
  assert.deepEqual([free.tone, free.text, free.canCreate, free.notes.length], ["ok", "support@acme.test is free.", true, 1]);
  const taken = nameView(checkLocalPart("support"), check({ status: "exists", detail: "support@acme.test already exists here." }), false, false);
  assert.deepEqual([taken.tone, taken.canCreate], ["bad", false]);
  const elsewhere = nameView(checkLocalPart("support"), check({ status: "elsewhere", detail: "A Cloudflare rule forwards support@acme.test to me@x.test." }), false, false);
  assert.equal(elsewhere.canCreate, false);
  const stale = nameView(checkLocalPart("supportx"), check({}), true, false);
  assert.equal(stale.canCreate, false, "an answer about another name never enables Create");
  const offline = nameView(checkLocalPart("abuse"), undefined, false, true);
  assert.deepEqual([offline.tone, offline.canCreate], ["warn", true], "a check that failed does not block Create");
  assert.match(offline.notes[0]!, /RFC 2142/);
});

const form = (over: Partial<AddressForm> = {}): AddressForm => ({
  domain: "acme.test", localPart: " Alex.Morgan ", displayName: "", displayNameEdited: false, signatureOn: false, signature: "",
  agent: "off", copy: "", makeRule: true, ...over,
});

test("the request carries every setting, the display name follows the name until edited", () => {
  assert.equal(displayNameOf(form()), "Alex Morgan");
  assert.deepEqual(createBody(form()), { localPart: "alex.morgan", domain: "acme.test", name: "Alex Morgan", agent: "off", createRoute: "auto" });
  assert.deepEqual(createBody(form({ displayName: "Acme Support", displayNameEdited: true, signatureOn: true, signature: "Alex\nAcme", agent: "a1", copy: "me@x.test", makeRule: false })), {
    localPart: "alex.morgan", domain: "acme.test", name: "Acme Support", agent: { id: "a1" }, signature: { enabled: true, text: "Alex\nAcme" }, createRoute: false, forwardTo: "me@x.test",
  });
  assert.equal("signature" in createBody(form({ signatureOn: true, signature: "  " })), false, "an empty signature is not sent");
  assert.deepEqual(batchBody(form(), ["sales", "hello"]), { domain: "acme.test", localParts: ["sales", "hello"], agent: "off", createRoute: "auto" },
    "several: each its own name");
  assert.equal(batchBody(form({ displayName: "Acme", displayNameEdited: true }), ["a"]).name, "Acme");
});

test("an agent is described in one line: its first sentence and its reply policy", () => {
  const agent: AgentInput = { name: "Support", instructions: "Answer customers about orders. Be brief.", knowledge: "", collections: [], tools: [],
    replyPolicy: { mode: "draft", allowedIntents: [], dailySendLimit: 20 } };
  assert.equal(agentLine(agent), "Answer customers about orders. · Drafts every answer for you");
  const long = agentLine({ ...agent, instructions: "x".repeat(300), replyPolicy: { mode: "auto", allowedIntents: ["faq"], dailySendLimit: 5 } });
  assert.ok(long.startsWith("x".repeat(109) + "…"));
  assert.match(long, /Sends faq · up to 5 a day per address$/);
});

test("each step says what happened; the test is watched until it arrives (SCN-062, SCN-063)", () => {
  const steps = [{ id: "a", label: "Turn on Email Routing", outcome: "done" as const, detail: "On." }];
  assert.equal(receiveStep("new.test", { running: true, steps: null, foreignMx: null, error: null }).outcome, "running");
  const mx = receiveStep("new.test", { running: false, steps: null, foreignMx: ["mx.other.test", "mx.other.test"], error: null });
  assert.equal(mx.outcome, "waiting");
  assert.match(mx.detail, /MX mx\.other\.test\)/);
  assert.equal(receiveStep("new.test", { running: false, steps, foreignMx: null, error: null }).outcome, "done");
  const failed = receiveStep("new.test", { running: false, steps: [{ id: "r", label: "Turn on Email Routing", outcome: "failed", detail: "Denied." }], foreignMx: null, error: null });
  assert.match(failed.detail, /Turn on Email Routing: Denied\. Nothing was created/);

  const t = (over: Partial<TestStatus>): TestStatus => ({ subject: "s", sentAt: "2026-10-06T10:00:00Z", sendStatus: "accepted", state: "waiting", detail: "Waiting.", ...over });
  assert.equal(testStep("off", null).outcome, "skipped");
  assert.equal(testStep("sending", null).outcome, "running");
  assert.equal(testStep("sent", t({})).outcome, "waiting");
  assert.equal(testStep("sent", t({ state: "arrived", arrivedAt: "2026-10-06T10:00:20Z", folder: "inbox" })).outcome, "done");
  assert.match(testStep("sent", t({ state: "arrived", arrivedAt: "x", folder: "spam" })).detail, /in spam/);
  assert.equal(testStep("sent", t({ state: "not_arrived", detail: "Not after 3 minutes." })).outcome, "failed");
  assert.equal(testStep("error", null, "Refused").detail, "Refused");
  assert.equal(testWaiting(null), true);
  assert.equal(testWaiting(t({ state: "arrived" })), false);

  const done = { id: "address", label: "Create the address", outcome: "done" as const, detail: "" };
  assert.match(stepsSentence("a@acme.test", [done, { ...testStep("sent", t({ state: "arrived", arrivedAt: "x" })) }]), /is ready: the test message arrived/);
  assert.match(stepsSentence("a@acme.test", [done, { id: "rule", label: "Send its mail here", outcome: "failed", detail: "No.", fix: { action: "route_here", label: "Fix it" } }]),
    /was created; send its mail here did not happen\. Fix it fixes it\./);
  assert.match(stepsSentence("a@acme.test", [{ ...done, outcome: "failed", detail: "Taken." }]), /was not created\. Taken\./);
  assert.match(stepsSentence("a@acme.test", [done, testStep("sent", t({}))]), /Waiting for the test message/);
});

test("every entry point opens the one dialog, and the dialog keeps the keyboard contract", () => {
  const section = readFileSync("app/components/settings/sections/AddressesSection.tsx", "utf8");
  const domains = readFileSync("app/components/settings/sections/DomainsSection.tsx", "utf8");
  const dialog = readFileSync("app/components/settings/sections/AddAddress.tsx", "utf8");
  assert.match(section, /import AddAddressDialog from "\.\/AddAddress"/);
  assert.doesNotMatch(section, /function AddAddressDialog/, "one dialog, in its own module");
  assert.match(domains, /Add an address on \{domain\}/);
  assert.match(domains, /Add the first address on \{domain\}/);
  assert.match(dialog, /data-autofocus/, "the focus lands in the field for the part before @");
  assert.match(dialog, /aria-live="polite"/, "the field's message is announced");
  assert.match(dialog, /role="combobox"/, "the domain choice is a searchable combobox");
  assert.match(dialog, /aria-activedescendant/);
  assert.match(dialog, /TEST_POLL_MS/, "the test is polled");
});
