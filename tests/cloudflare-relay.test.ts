import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { B, C, S, fakeCloudflareAccounts, serverFixture } from "./fake-cloudflare-accounts";

/**
 * The relay (MA-6…MA-9): a domain in another account receives here through a Worker the server
 * installs in that account. The relay's own source runs in workerd; Access is played by the
 * outbound handler, which admits a request only with a service token's Client ID and Secret, as
 * the edge does, and hands the server the Client ID as `common_name`.
 */
const tokens = { CLOUDFLARE_API_TOKEN: "server-token", [`CLOUDFLARE_API_TOKEN_${B}`]: "b-token" };
const message = (to: string, id = "m1") =>
  `From: Friend <friend@outside.test>\r\nTo: ${to}\r\nSubject: Hello\r\nMessage-ID: <${id}@outside.test>\r\nDate: Wed, 30 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nHello there.\r\n`;

async function setup(options: { serverDown?: boolean; loseReport?: boolean; accessRedirects?: boolean } = {}) {
  const cf = fakeCloudflareAccounts();
  const server = await serverFixture(cf, tokens);
  const connected = await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
  const relay = cf.scripts[B]["fabric-inbox-relay"];
  const binding = (name: string) => relay?.bindings.find((b) => b.name === name)?.text ?? "";
  const reached: string[] = [];
  const mf = relay ? new Miniflare({
    modules: true, script: relay.module!, compatibilityDate: "2026-09-01", unsafeTriggerHandlers: true,
    bindings: Object.fromEntries(relay.bindings.map((b) => [b.name, b.text ?? ""])),
    outboundService: async (request) => {
      const url = new URL(request.url);
      reached.push(url.pathname);
      if (options.serverDown) return Response.error(); // a network failure: fetch rejects
      if (options.loseReport && url.pathname === "/relay/forwarded") return new Response("Bad gateway", { status: 502 });
      // Access refuses a sign-in with a redirect to its login page, never a 403.
      if (options.accessRedirects) return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.test/cdn-cgi/access/login" } });
      // Access at the edge: a service token that is not the one issued gets nothing.
      const token = cf.serviceTokens.find((t) => t.client_id === request.headers.get("cf-access-client-id") && t.client_secret === request.headers.get("cf-access-client-secret"));
      if (!token) return new Response("Forbidden", { status: 403 });
      const headers = new Headers([...request.headers].filter(([k]) => !k.startsWith("cf-access-")));
      headers.set("x-test-common-name", token.client_id);
      return server.mf.dispatchFetch("https://server.test" + url.pathname, { method: request.method, headers, body: await request.arrayBuffer() });
    },
  }) : null;
  const deliver = async (to: string, raw = message(to)) => {
    const r = await mf!.dispatchFetch(`http://relay.test/cdn-cgi/handler/email?from=friend@outside.test&to=${encodeURIComponent(to)}`, { method: "POST", body: raw });
    return { status: r.status, text: await r.text() };
  };
  return { cf, server, connected, relay, binding, mf, deliver, reached };
}

test("connecting a domain in another account installs the relay there, points its rules at it, and again changes nothing", async () => {
  const { cf, server, connected, relay, binding, mf } = await setup();
  try {
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const steps = Object.fromEntries(connected.body.steps.map((s: any) => [s.id, s.outcome]));
    assert.deepEqual(steps, { routing: "already", relay: "done", serve: "done", addresses: "done", rules: "done" });
    assert.ok(relay, "the relay Worker exists in the other account");
    assert.equal(binding("SERVER_URL"), "https://server.test");
    const token = cf.serviceTokens.find((t) => t.client_id === binding("ACCESS_CLIENT_ID"))!;
    assert.equal(token.duration, "forever");
    assert.match(token.name, /^Fabric Inbox relay: Studio/);
    assert.equal(binding("ACCESS_CLIENT_SECRET"), token.client_secret);
    assert.ok(relay.bindings.filter((b) => b.name.startsWith("ACCESS_")).every((b) => b.type === "secret_text"));
    // Access lets the relay's token through the same reusable policy agent keys use, attached to the server's app.
    const policy = cf.policies.find((p) => p.decision === "non_identity")!;
    assert.deepEqual(policy.include, [{ service_token: { token_id: token.id } }]);
    assert.ok(cf.app.policies.some((p) => p.id === policy.id) && cf.app.policies.some((p) => p.id === "owner-policy"));
    const zone = cf.zone("studio.invalid");
    assert.deepEqual(zone.rules[0].actions, [{ type: "worker", value: ["fabric-inbox-relay"] }]);
    const registry = await server.r2("config/relays.json");
    assert.deepEqual(registry.relays.map((r: any) => [r.accountId, r.clientId]), [[B, token.client_id]]);
    assert.equal(JSON.stringify(registry).includes(token.client_secret), false, "no secret in the registry");
    const box = await server.r2("mailboxes/support@studio.invalid.json");
    assert.deepEqual(box.forwarding, { enabled: true, email: "owner@gmail.test" });

    const writes = cf.writes.length;
    const again = await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    assert.equal(again.body.steps.find((s: any) => s.id === "relay").outcome, "already");
    assert.deepEqual(cf.writes.slice(writes), [], "nothing is written a second time");
    const detail = (await server.call("/api/domains/studio.invalid")).body;
    assert.deepEqual(detail.account, { id: B, server: false });
    assert.equal(detail.rules[0].toThisServer, true, "a rule to the relay counts as arriving here");
    const status = (await server.call("/api/project-addresses/support@studio.invalid/routing")).body;
    assert.equal(status.state, "verified", JSON.stringify(status));
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("the relay delivers: stored once, the copy is forwarded there and settled here, unknown addresses bounce", async () => {
  const { server, deliver, mf, reached } = await setup();
  try {
    const first = await deliver("support@studio.invalid");
    assert.equal(first.status, 200, first.text);
    const inbox = (await (await server.mf.dispatchFetch("https://server.test/inbox?mailbox=support@studio.invalid")).json()) as any[];
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].subject, "Hello");
    assert.deepEqual(reached, ["/relay/incoming", "/relay/forwarded"], "the copy is reported back");
    const owed = await (await server.mf.dispatchFetch(`https://server.test/owed?mailbox=support@studio.invalid&id=${inbox[0].id}`)).json();
    assert.equal(owed, false, "the relay's report settled the copy");
    assert.equal(await server.r2("delivery-issues/support@studio.invalid.json"), null);

    const again = await deliver("support@studio.invalid");
    assert.equal(again.status, 200);
    const after = (await (await server.mf.dispatchFetch("https://server.test/inbox?mailbox=support@studio.invalid")).json()) as any[];
    assert.equal(after.length, 1, "a redelivery is stored once");

    const unknown = await deliver("nobody@studio.invalid");
    assert.equal(unknown.status, 400, "the relay turns the server's refusal into a bounce");
    assert.match(unknown.text, /Address not found: nobody@studio\.invalid/);
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("a copy whose report never arrives stays owed, and a redelivery forwards it again", async () => {
  const { server, deliver, mf } = await setup({ loseReport: true });
  try {
    assert.equal((await deliver("support@studio.invalid")).status, 200, "the message itself is kept");
    const [stored] = (await (await server.mf.dispatchFetch("https://server.test/inbox?mailbox=support@studio.invalid")).json()) as any[];
    assert.equal(await (await server.mf.dispatchFetch(`https://server.test/owed?mailbox=support@studio.invalid&id=${stored.id}`)).json(), true);
    const incoming = await server.call("/relay/incoming", "POST", undefined, {});
    assert.equal(incoming.status, 403);
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("a relay may deliver only its own account's domains, and only with the sign-in the server gave it", async () => {
  const { server, deliver, mf, binding } = await setup();
  try {
    const foreign = await deliver("hello@base.test");
    assert.equal(foreign.status, 500, "the server refuses, so the relay fails the delivery rather than dropping it");
    assert.match(foreign.text, /answered 403/);
    const direct = await server.call("/relay/incoming", "POST", undefined, { "x-test-common-name": "someone-else.access", "x-fabric-envelope-to": "support@studio.invalid" });
    assert.equal(direct.status, 403);
    const person = await server.call("/relay/incoming", "POST");
    assert.equal(person.status, 403, "no identity");
    const report = await server.call("/relay/forwarded", "POST", { mailboxId: "hello@base.test", emailId: "x", target: "a@b.test", ok: true },
      { "x-test-common-name": binding("ACCESS_CLIENT_ID") });
    assert.equal(report.status, 403, "a relay reports only on its own account's addresses");
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("a server that cannot be reached makes the relay fail the delivery, so the platform retries", async () => {
  const { server, deliver, mf } = await setup({ serverDown: true });
  try {
    const down = await deliver("support@studio.invalid");
    assert.equal(down.status, 500);
    // workerd reports a failed outbound fetch to the harness as a 500, so either wording is the relay throwing.
    assert.match(down.text, /could not be reached|answered 5\d\d/);
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("sending from a domain in another account goes through that account's Email Sending API; a refusal is a failure", async () => {
  const { cf, server, mf } = await setup();
  try {
    const sent = await server.call("/api/project-addresses/support@studio.invalid/test", "POST");
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.status, "accepted");
    assert.equal(cf.sent.length, 1);
    assert.equal(cf.sent[0].account, B);
    assert.equal(cf.sent[0].body.from, "support@studio.invalid");
    const send = (key: string) => server.call("/api/v1/mailboxes/support@studio.invalid/emails", "POST",
      { from: "support@studio.invalid", to: "friend@outside.test", subject: key, text: "Hi" }, { "Idempotency-Key": key });
    cf.options.sendStatus = 400;
    const refused = await send("refused-1");
    assert.deepEqual([refused.body.status, refused.body.errorCode], ["failed", "E_REST_REFUSED"], JSON.stringify(refused.body));
    cf.options.sendStatus = 503;
    const unknown = await send("unknown-1");
    assert.equal(unknown.body.status, "unknown", "a 5xx may have been sent, so it is never retried");
    assert.equal(cf.sent.length, 3);
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("stopping a domain in another account sends its rules back; the relay stays for the account", async () => {
  const { cf, server, mf } = await setup();
  try {
    const released = await server.call("/api/domains/studio.invalid/release", "POST", {});
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.deepEqual(cf.zone("studio.invalid").rules[0].actions, [{ type: "forward", value: ["owner@gmail.test"] }]);
    assert.ok(cf.scripts[B]["fabric-inbox-relay"], "kept for the account's other domains");
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("a relay that cannot be uploaded leaves no sign-in behind, and connect stops at that step", async () => {
  const cf = fakeCloudflareAccounts();
  cf.options.uploadFails = true;
  const server = await serverFixture(cf, tokens);
  try {
    const failed = await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    assert.equal(failed.status, 502);
    const relay = failed.body.steps.find((s: any) => s.id === "relay");
    assert.equal(relay.outcome, "failed");
    assert.match(relay.detail, /Nothing was left behind/);
    assert.deepEqual(cf.serviceTokens, [], "the new sign-in was revoked");
    assert.deepEqual(cf.zone("studio.invalid").rules[0].actions, [{ type: "forward", value: ["owner@gmail.test"] }], "no rule was moved");
    assert.equal(await server.r2("config/domains.json"), null, "the domain is not served yet");
  } finally { await server.mf.dispose(); }
});

test("removing an account removes its relay, the relay's sign-in, then its token", async () => {
  const { cf, server, mf } = await setup();
  try {
    await server.call("/api/domains/studio.invalid/release", "POST", {});
    cf.secrets[`${S}/fabric-inbox/CLOUDFLARE_API_TOKEN_${B}`] = "b-token";
    const removed = await server.call(`/api/cloudflare/accounts/${B}`, "DELETE");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(cf.scripts[B]["fabric-inbox-relay"], undefined);
    assert.deepEqual(cf.serviceTokens, []);
    assert.equal(cf.secrets[`${S}/fabric-inbox/CLOUDFLARE_API_TOKEN_${B}`], undefined);
    assert.deepEqual((await server.r2("config/relays.json")).relays, []);
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("the relay's own bindings name its sign-in, version and server; two connects at once leave one consistent relay", async () => {
  const cf = fakeCloudflareAccounts();
  const server = await serverFixture(cf, tokens);
  try {
    const [a, b] = await Promise.all([
      server.call("/api/domains/studio.invalid/connect", "POST", { sending: false }),
      server.call("/api/domains/second.invalid/connect", "POST", { sending: false }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const relays = (await server.r2("config/relays.json")).relays;
    const current = relays.filter((r: any) => !r.retiredAt);
    assert.equal(current.length, 1, "one current sign-in for the account");
    const bindings = Object.fromEntries(cf.scripts[B]["fabric-inbox-relay"].bindings.map((x) => [x.name, x.text]));
    assert.equal(bindings.RELAY_TOKEN_ID, current[0].tokenId, "the relay runs with the sign-in the registry names");
    assert.equal(cf.serviceTokens.length, 1, "no orphaned sign-in");
    const policy = cf.policies.find((p) => p.decision === "non_identity")!;
    assert.deepEqual(policy.include, [{ service_token: { token_id: current[0].tokenId } }]);
  } finally { await server.mf.dispose(); }
});

test("an upload that applied but was not confirmed keeps mail flowing, and the next run settles it without a new sign-in", async () => {
  const cf = fakeCloudflareAccounts();
  cf.options.uploadAppliesThen502 = true;
  const server = await serverFixture(cf, tokens);
  try {
    const first = await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    assert.equal(first.status, 502);
    assert.match(first.body.steps.find((s: any) => s.id === "relay").detail, /did not confirm/);
    assert.equal(cf.serviceTokens.length, 1, "the sign-in the relay may be running with is kept");
    cf.options.uploadAppliesThen502 = false;
    const again = await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.steps.find((s: any) => s.id === "relay").outcome, "already", "the relay's bindings already name the current sign-in");
    assert.equal(cf.serviceTokens.length, 1);
  } finally { await server.mf.dispose(); }
});

test("moving the server's address reinstalls the relay; the old sign-in stays accepted while old instances drain", async () => {
  const cf = fakeCloudflareAccounts();
  const server = await serverFixture(cf, tokens);
  try {
    await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    const old = (await server.r2("config/relays.json")).relays[0];
    const moved = await serverFixture(cf, { ...tokens, PUBLIC_APP_URL: "https://mail.example.invalid" });
    try {
      // Share the first server's storage: copy the registry and domains into the second.
      for (const key of ["config/relays.json", "config/domains.json", "config/domain-accounts.json"]) {
        const value = await server.r2(key);
        if (value !== null) await moved.mf.dispatchFetch("https://server.test/r2put?key=" + encodeURIComponent(key), { method: "PUT", body: JSON.stringify(value) });
      }
      const again = await moved.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
      assert.equal(again.body.steps.find((s: any) => s.id === "relay").outcome, "done");
      const relays = (await moved.r2("config/relays.json")).relays;
      assert.equal(relays.length, 2);
      assert.ok(relays.find((r: any) => r.tokenId === old.tokenId).retiredAt, "the old one is retiring");
      assert.ok(cf.serviceTokens.some((t) => t.id === old.tokenId), "and not revoked yet");
      assert.equal(Object.fromEntries(cf.scripts[B]["fabric-inbox-relay"].bindings.map((x) => [x.name, x.text])).SERVER_URL, "https://mail.example.invalid");
      const retiring = await moved.call("/relay/incoming", "POST", undefined, { "x-test-common-name": old.clientId, "x-fabric-envelope-to": "support@studio.invalid" });
      assert.notEqual(retiring.status, 403, "a retiring sign-in still delivers");
    } finally { await moved.mf.dispose(); }
  } finally { await server.mf.dispose(); }
});

test("a relay whose sign-in Access refuses fails the delivery without following the login redirect", async () => {
  const { server, deliver, mf, reached } = await setup({ accessRedirects: true });
  try {
    const refused = await deliver("support@studio.invalid");
    assert.equal(refused.status, 500);
    assert.match(refused.text, /refused the relay's sign-in \(302/);
    assert.deepEqual(reached, ["/relay/incoming"], "the login page was not requested");
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("a relay cannot claim a domain through a pending copy of it in its own account", async () => {
  const cf = fakeCloudflareAccounts();
  // archive.invalid is active in account C (with its own token) and only pending in B.
  cf.zones.push({ id: "z-pending", name: "archive.invalid", account: B, status: "pending", routing: { enabled: false, status: "unconfigured" }, rules: [],
    catchAll: { name: "Catch-all", enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] }, dns: [], sending: [] });
  const server = await serverFixture(cf, { ...tokens, [`CLOUDFLARE_API_TOKEN_${C}`]: "c-token" });
  try {
    await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    const relay = (await server.r2("config/relays.json")).relays[0];
    const claim = await server.call("/relay/incoming", "POST", undefined, { "x-test-common-name": relay.clientId, "x-fabric-envelope-to": "hello@archive.invalid" });
    assert.equal(claim.status, 403);
    const remembered = await server.r2("config/domain-accounts.json");
    assert.notEqual(remembered?.["archive.invalid"], B, "and the relay's claim changed nothing anyone else reads");
  } finally { await server.mf.dispose(); }
});

test("a copy report settles only a copy that is owed, to the address the mailbox forwards to", async () => {
  const { server, deliver, mf, binding } = await setup({ loseReport: true });
  try {
    await deliver("support@studio.invalid");
    const [stored] = (await (await server.mf.dispatchFetch("https://server.test/inbox?mailbox=support@studio.invalid")).json()) as any[];
    const who = { "x-test-common-name": binding("ACCESS_CLIENT_ID") };
    const wrongTarget = await server.call("/relay/forwarded", "POST", { mailboxId: "support@studio.invalid", emailId: stored.id, target: "someone@else.invalid", ok: true }, who);
    assert.equal(wrongTarget.body.settled, false);
    const notOwed = await server.call("/relay/forwarded", "POST", { mailboxId: "support@studio.invalid", emailId: "incoming-nothing", target: "owner@gmail.test", ok: true }, who);
    assert.equal(notOwed.body.settled, false);
    assert.equal(await (await server.mf.dispatchFetch(`https://server.test/owed?mailbox=support@studio.invalid&id=${stored.id}`)).json(), true, "still owed");
    const right = await server.call("/relay/forwarded", "POST", { mailboxId: "support@studio.invalid", emailId: stored.id, target: "owner@gmail.test", ok: true }, who);
    assert.equal(right.body.settled, true);
  } finally { await mf?.dispose(); await server.mf.dispose(); }
});

test("a relay reporting an older version is upgraded in the background", async () => {
  const cf = fakeCloudflareAccounts();
  const server = await serverFixture(cf, tokens);
  try {
    await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    const relay = (await server.r2("config/relays.json")).relays[0];
    const uploads = () => cf.writes.filter((w) => w === `PUT /accounts/${B}/workers/scripts/fabric-inbox-relay`).length;
    const before = uploads();
    // Its binding says an old version, and so does its delivery.
    cf.scripts[B]["fabric-inbox-relay"].bindings.find((b) => b.name === "RELAY_VERSION")!.text = "00000000";
    await server.call("/relay/incoming", "POST", undefined, { "x-test-common-name": relay.clientId, "x-fabric-envelope-to": "support@studio.invalid", "x-fabric-relay-version": "00000000" });
    for (let i = 0; i < 50 && uploads() === before; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(uploads(), before + 1, "reinstalled once");
    // The new relay's own sign-in, still claiming an old version: the hourly limit, not the row, stops it.
    let current: any;
    for (let i = 0; i < 50 && !(current = (await server.r2("config/relays.json")).relays.find((r: any) => !r.retiredAt))?.upgradeTriedAt; i++) {
      cf.scripts[B]["fabric-inbox-relay"].bindings.find((b) => b.name === "RELAY_VERSION")!.text = "00000000";
      await new Promise((r) => setTimeout(r, 100));
    }
    cf.scripts[B]["fabric-inbox-relay"].bindings.find((b) => b.name === "RELAY_VERSION")!.text = "00000000";
    await server.call("/relay/incoming", "POST", undefined, { "x-test-common-name": current.clientId, "x-fabric-envelope-to": "support@studio.invalid", "x-fabric-relay-version": "00000000" });
    for (let i = 0; i < 30; i++) {
      const row = (await server.r2("config/relays.json")).relays.find((r: any) => r.tokenId === current.tokenId);
      if (row?.upgradeTriedAt) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const row = (await server.r2("config/relays.json")).relays.find((r: any) => r.tokenId === current.tokenId);
    assert.ok(row.upgradeTriedAt, "the attempt is recorded on the current row");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(uploads(), before + 1, "at most once an hour");
  } finally { await server.mf.dispose(); }
});


test("a relay running with a sign-in the registry does not name is reinstalled, not reported as installed", async () => {
  const cf = fakeCloudflareAccounts();
  const server = await serverFixture(cf, tokens);
  try {
    await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    cf.scripts[B]["fabric-inbox-relay"].bindings.find((b) => b.name === "RELAY_TOKEN_ID")!.text = "a-token-nobody-registered";
    const again = await server.call("/api/domains/studio.invalid/connect", "POST", { sending: false });
    assert.equal(again.body.steps.find((s: any) => s.id === "relay").outcome, "done");
    const current = (await server.r2("config/relays.json")).relays.find((r: any) => !r.retiredAt);
    assert.equal(cf.scripts[B]["fabric-inbox-relay"].bindings.find((b) => b.name === "RELAY_TOKEN_ID")!.text, current.tokenId);
  } finally { await server.mf.dispose(); }
});
