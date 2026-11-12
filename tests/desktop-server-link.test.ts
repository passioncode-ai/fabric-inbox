// B-236 (SCN-092): an agent on this Mac adds a server by a `fabric-inbox://server` link; the person allows it first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseServerLink, promptFor, planFor } = require("../desktop/server-link.cjs");
const policy = require("../desktop/policy.cjs");

const ORIGIN = "https://acme-inbox.someone.workers.dev";
const link = (q: Record<string, string>) => `fabric-inbox://server?${new URLSearchParams(q)}`;

test("a server link names an HTTPS origin, an optional Access team and who asks; anything else is refused", () => {
  const ok = parseServerLink(link({ origin: ORIGIN, access: "https://someone.cloudflareaccess.com", from: "Acme onboarding" }), policy.validateConfig);
  assert.deepEqual(ok, { ok: true, value: { origin: ORIGIN, accessOrigin: "https://someone.cloudflareaccess.com", from: "Acme onboarding" } });
  assert.deepEqual(parseServerLink(link({ origin: ORIGIN + "/" }), policy.validateConfig).value, { origin: ORIGIN, accessOrigin: "", from: "" });
  for (const bad of [
    "not a link", "fabric-inbox://connect?origin=" + ORIGIN, "https://server?origin=" + ORIGIN,
    link({ origin: "http://acme.example" }), link({ origin: ORIGIN + "/inbox" }), link({}),
    link({ origin: ORIGIN, access: "https://evil.example" }), link({ origin: ORIGIN, from: "x".repeat(81) }),
    link({ origin: ORIGIN, from: "line\nbreak" }), "fabric-inbox://user:pw@server?origin=" + encodeURIComponent(ORIGIN),
  ]) assert.equal(parseServerLink(bad, policy.validateConfig).ok, false, bad);
});

test("a held server is shown without a question; a new one is asked, Deny first, naming the host and not the link's name", () => {
  const parsed = parseServerLink(link({ origin: ORIGIN, from: "Totally Your Bank" }), policy.validateConfig);
  assert.equal(planFor(parsed, [ORIGIN]).action, "show");
  const plan = planFor(parsed, ["https://mine.example"]);
  assert.equal(plan.action, "ask");
  const prompt = promptFor(plan.server);
  assert.match(prompt.title, /acme-inbox\.someone\.workers\.dev/);
  assert.equal(prompt.defaultId, 0);
  assert.equal(prompt.cancelId, 0);
  assert.equal(prompt.buttons[0], "Deny");
  assert.match(prompt.detail, /calls itself “Totally Your Bank”/);
  assert.equal(planFor(parseServerLink("nonsense", policy.validateConfig), []).action, "refuse");
});

test("main adds a server only after the person's Add Server, then shows it as Account's servers are", () => {
  const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const handler = main.slice(main.indexOf("async function handleServerLink"), main.indexOf("async function handleConnectLink"));
  assert.ok(handler.indexOf("answer.response !== 1") < handler.indexOf("saveServers(serverList.remember"), "nothing is saved before the answer");
  assert.match(handler, /await switchServer\(plan\.server\.origin\)/);
  assert.match(main, /await handleLink\(pendingLinks\.shift\(\)\)/);
  assert.match(main, /kind === 'server' \? handleServerLink\(url\) : handleConnectLink\(url\)/);
});
