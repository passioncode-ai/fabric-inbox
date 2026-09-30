import { test } from "node:test";
import assert from "node:assert/strict";
import { B, C, D, S, fakeCloudflareAccounts, serverFixture } from "./fake-cloudflare-accounts";

/**
 * Several Cloudflare accounts (MA-2…MA-5, docs/app-store/tasks/2026-09-30-cloudflare-accounts.md):
 * the accounts every token reaches, which ones show by default, the operator's choice, connecting
 * one more with its own token and removing it — in workerd against a stateful fake.
 */
const tokens = { CLOUDFLARE_API_TOKEN: "server-token", [`CLOUDFLARE_API_TOKEN_${B}`]: "b-token", [`CLOUDFLARE_API_TOKEN_${C}`]: "c-token" };

test("accounts: every token's accounts are listed; the server's and those with mail show, one without mail waits", async () => {
  const cf = fakeCloudflareAccounts();
  const { mf, call } = await serverFixture(cf, tokens);
  try {
    const list = await call("/api/domains");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const accounts = Object.fromEntries(list.body.accounts.map((a: any) => [a.id, a]));
    assert.deepEqual(Object.keys(accounts).sort(), [B, C, S].sort());
    assert.deepEqual([accounts[S].server, accounts[S].via, accounts[S].shown], [true, "server", true]);
    assert.deepEqual([accounts[B].hasMail, accounts[B].via, accounts[B].shown], [true, "account", true], "a routing rule is mail");
    assert.deepEqual([accounts[C].hasMail, accounts[C].shown, accounts[C].domains], [false, false, 1], "no mail: listed, not shown");
    assert.equal(list.body.account, "Personal");
    const domains = Object.fromEntries(list.body.domains.map((d: any) => [d.domain, d]));
    assert.deepEqual(Object.keys(domains).sort(), ["apex.invalid", "base.test", "studio.invalid"]);
    assert.deepEqual(domains["studio.invalid"].account, { id: B, name: "Studio", server: false });
    assert.equal(domains["base.test"].served, true);
    // Where each domain lives is remembered, for sending and for the relay's check.
    const remembered = JSON.parse(await (await mf.dispatchFetch("https://server.test/r2?key=config/domain-accounts.json")).text());
    assert.equal(remembered["studio.invalid"], B);
    // The token never reaches the answer.
    assert.doesNotMatch(JSON.stringify(list.body), /b-token|c-token|server-token/);
  } finally { await mf.dispose(); }
});

test("accounts: showing and hiding is kept; an account whose domain receives here cannot be hidden", async () => {
  const cf = fakeCloudflareAccounts();
  const { mf, call } = await serverFixture(cf, tokens);
  try {
    assert.equal((await call(`/api/cloudflare/accounts/${C}`, "PUT", { shown: true })).status, 200);
    let names = (await call("/api/domains")).body.domains.map((d: any) => d.domain);
    assert.ok(names.includes("archive.invalid"), "shown on request");
    assert.equal((await call(`/api/cloudflare/accounts/${B}`, "PUT", { shown: false })).status, 200);
    names = (await call("/api/domains")).body.domains.map((d: any) => d.domain);
    assert.ok(!names.includes("studio.invalid"), "hidden on request");
    assert.equal((await call(`/api/cloudflare/accounts/${B}`, "PUT", { shown: null })).status, 200);
    assert.ok((await call("/api/domains")).body.domains.some((d: any) => d.domain === "studio.invalid"), "back to the default");
    const refused = await call(`/api/cloudflare/accounts/${S}`, "PUT", { shown: false });
    assert.equal(refused.status, 409, "base.test receives here");
    assert.deepEqual(refused.body.served, ["base.test"]);
    assert.equal((await call(`/api/cloudflare/accounts/not-an-id`, "PUT", { shown: true })).status, 400);
    assert.equal((await call(`/api/cloudflare/accounts/${D}`, "PUT", { shown: true })).status, 404, "no token reaches it");
  } finally { await mf.dispose(); }
});

test("connect another account: the token is checked, kept as the server's own secret for each new account, never echoed", async () => {
  const cf = fakeCloudflareAccounts();
  const { mf, call } = await serverFixture(cf, { CLOUDFLARE_API_TOKEN: "server-token" });
  try {
    const bad = await call("/api/cloudflare/accounts", "POST", { token: "not-a-real-token-at-all-000" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /does not accept this token/);
    assert.equal((await call("/api/cloudflare/accounts", "POST", { token: "short" })).status, 400);
    assert.deepEqual(Object.keys(cf.secrets), [], "nothing is saved for a token Cloudflare refused");
  } finally { await mf.dispose(); }
});

test("connect another account: saved per account it sees, skipping the server's; removing deletes it, and refuses while its domain receives here", async () => {
  const cf = fakeCloudflareAccounts();
  // A token as long as a real one, seeing the server's account and another (made under My Profile).
  const user = "user-token-0000000000000000";
  cf.alias(user, "user-token"); cf.alias("d-token-00000000000000000000", "d-token");
  const { mf, call } = await serverFixture(cf, { CLOUDFLARE_API_TOKEN: "server-token" });
  try {
    const made = await call("/api/cloudflare/accounts", "POST", { token: user });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.connected, [{ id: B, name: "Studio" }]);
    assert.equal(made.body.skipped[0].id, S, "the server's own account keeps its own token");
    assert.equal(cf.secrets[`${S}/fabric-inbox/CLOUDFLARE_API_TOKEN_${B}`], user, "kept as the server Worker's secret");
    assert.doesNotMatch(JSON.stringify(made.body), new RegExp(user));
    const again = await call("/api/cloudflare/accounts", "POST", { token: "d-token-00000000000000000000" });
    assert.deepEqual(again.body.connected, [{ id: D, name: "Later" }]);
  } finally { await mf.dispose(); }

  // The next version of the Worker carries the secrets.
  const next = await serverFixture(cf, { CLOUDFLARE_API_TOKEN: "server-token", [`CLOUDFLARE_API_TOKEN_${D}`]: "d-token-00000000000000000000", [`CLOUDFLARE_API_TOKEN_${B}`]: "user-token-0000000000000000" });
  try {
    const listed = (await next.call("/api/cloudflare/accounts")).body.accounts.map((a: any) => a.id).sort();
    assert.deepEqual(listed, [B, D, S].sort());
    assert.equal((await next.call(`/api/cloudflare/accounts/${S}`, "DELETE")).status, 404, "the server's account has no token of its own to remove");
    const removed = await next.call(`/api/cloudflare/accounts/${D}`, "DELETE");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(cf.secrets[`${S}/fabric-inbox/CLOUDFLARE_API_TOKEN_${D}`], undefined);
    // A served domain keeps its account's token.
    const connected = await next.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const kept = await next.call(`/api/cloudflare/accounts/${B}`, "DELETE");
    assert.equal(kept.status, 409);
    assert.deepEqual(kept.body.served, ["studio.invalid"]);
  } finally { await next.mf.dispose(); }
});

test("a token that reaches several accounts finds the server's account by its Worker", async () => {
  const cf = fakeCloudflareAccounts();
  cf.alias("user-token-0000000000000000", "user-token");
  const { mf, call } = await serverFixture(cf, { CLOUDFLARE_API_TOKEN: "user-token-0000000000000000" });
  try {
    const list = (await call("/api/domains")).body;
    const server = list.accounts.find((a: any) => a.server);
    assert.equal(server?.id, S, "the account whose Workers hold fabric-inbox");
    assert.equal(list.accounts.find((a: any) => a.id === B).via, "server");
  } finally { await mf.dispose(); }
});

test("Email Routing is turned on for a zone's own domain without a name (MA-1)", async () => {
  const cf = fakeCloudflareAccounts();
  const { mf, call } = await serverFixture(cf, tokens);
  try {
    const done = await call("/api/domains/apex.invalid/connect", "POST", { sending: false });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.steps.find((s: any) => s.id === "routing").outcome, "done");
    assert.equal(cf.zone("apex.invalid").routing.enabled, true);
  } finally { await mf.dispose(); }
});
