// Anonymous usage counts (passioncode-ai/fabric-inbox#27, docs/ANALYTICS.md): the shared
// PassionCode installation file, the one switch every app honours, what leaves the Mac and when.
// A synthetic server stands in for analytics.sshlg.me; nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const usage = require("../desktop/analytics.cjs");

const HOST = "https://analytics.example.org";
const BUNDLE = { appKey: "A-SH-0123456789", host: HOST, debug: false };
const DAY = 24 * 3600 * 1000;

function machine() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-analytics-"));
  const appData = path.join(root, "Application Support");
  const userData = path.join(appData, "Fabric Inbox");
  mkdirSync(userData, { recursive: true });
  return { appData, userData, shared: path.join(appData, "PassionCode", "installation.json") };
}

/** A synthetic Aptabase: records each batch and answers with the next queued status (200 by default). */
function server(statuses: number[] = []) {
  const batches: any[][] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init: any) => {
    requests.push({ url, headers: init.headers });
    batches.push(JSON.parse(init.body));
    const status = statuses.length ? statuses.shift()! : 200;
    if (status === 0) throw new Error("offline");
    return { status };
  };
  return { fetch, batches, requests, events: () => batches.flat() };
}

function client(m: ReturnType<typeof machine>, extra: Record<string, unknown> = {}) {
  let clock = Date.parse("2026-10-05T10:00:00Z");
  const lines: any[] = [];
  const srv = (extra.server as ReturnType<typeof server>) || server();
  const a = usage.createAnalytics({ fs: fsPromises, appData: m.appData, userData: m.userData, bundle: BUNDLE, fetch: srv.fetch,
    uuid: randomUUID, now: () => clock, appVersion: "0.10.0", osVersion: "26.0", locale: "en-US", engineVersion: "41.0.0",
    log: (l: unknown) => lines.push(l), ...extra });
  return { a, srv, lines, advance: (ms: number) => { clock += ms; }, at: () => clock };
}

test("a build without an App Key sends nothing and never creates the shared file", async () => {
  const m = machine();
  const srv = server();
  const a = usage.createAnalytics({ fs: fsPromises, appData: m.appData, userData: m.userData, bundle: null, fetch: srv.fetch, uuid: randomUUID });
  await a.start({});
  await a.active({ gmail: 1 });
  assert.deepEqual(a.status(), { available: false, enabled: false });
  assert.equal(srv.batches.length, 0);
  assert.equal(existsSync(m.shared), false);
  assert.equal(await a.setEnabled(true), false);
  for (const text of ["", "{}", '{"appKey":"secret"}', '{"appKey":"A-SH-12"}', "not json"]) assert.equal(usage.readBundledKey(text), null, text);
  assert.equal(usage.readBundledKey('{"appKey":"A-SH-0123456789"}'), null, "no host, nothing sent");
  for (const host of ["http://analytics.example.org", "https://analytics.example.org/path", "https://u:p@analytics.example.org", "nope"]) {
    assert.equal(usage.readBundledKey(JSON.stringify({ appKey: "A-SH-0123456789", host })), null, host);
  }
  assert.deepEqual(usage.readBundledKey(JSON.stringify({ appKey: "A-SH-0123456789", host: HOST })), { appKey: "A-SH-0123456789", host: HOST, debug: false });
});

test("the first PassionCode app creates the shared installation; the install is counted once per app", async () => {
  const m = machine();
  const { a, srv } = client(m);
  await a.start({ serverConfigured: false });
  const file = JSON.parse(readFileSync(m.shared, "utf8"));
  assert.equal(file.version, 1);
  assert.equal(file.analytics, true);
  assert.match(file.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isInteger(file.created_at));
  const events = srv.events();
  assert.deepEqual(events.map((e) => e.eventName), ["app_installed", "app_started"]);
  assert.equal(events[0].props.first_passioncode_app, true);
  assert.equal(events[1].props.launch, "ordinary");
  for (const e of events) {
    assert.equal(e.props.install_id, file.id);
    assert.equal(e.props.iid, file.id, "sshlg-growth counts installs by iid");
    assert.equal(e.props.environment, "production");
    assert.match(e.sessionId, /^\d{18}$/);
    assert.equal(e.systemProps.sdkVersion, usage.SDK);
    assert.equal(e.systemProps.osName, "macOS");
    assert.equal(e.systemProps.isDebug, false);
  }
  assert.equal(srv.requests[0].url, `${HOST}/api/v0/events`);
  assert.equal(srv.requests[0].headers["App-Key"], BUNDLE.appKey);
  // The next start: no second install.
  const again = client(m);
  await again.a.start({ launch: "link" });
  assert.deepEqual(again.srv.events().map((e) => [e.eventName, e.props.launch]), [["app_started", "link"]]);
});

test("a debug key or a pre-release version is the sandbox environment", async () => {
  for (const [extra, expected] of [[{ bundle: { ...BUNDLE, debug: true } }, "sandbox"], [{ appVersion: "0.11.0-rc.1" }, "sandbox"], [{}, "production"]] as const) {
    const { a, srv } = client(machine(), extra as any);
    await a.start({});
    assert.ok(srv.events().every((e) => e.props.environment === expected), JSON.stringify(extra));
    // Aptabase build modes (sshlg-analytics client contract, "Build modes"): isDebug is true exactly when the event is
    // not production, so a pre-release lands in the dashboard's Debug view, not in Release.
    assert.ok(srv.events().every((e) => e.systemProps.isDebug === (expected !== "production")), `isDebug ${JSON.stringify(extra)}`);
  }
});

test("an update shows once as app_updated with the version it came from", async () => {
  const m = machine();
  const first = client(m);
  await first.a.start({});
  const later = client(m, { appVersion: "0.10.1" });
  await later.a.start({});
  const events = later.srv.events();
  assert.deepEqual(events.map((e) => e.eventName), ["app_updated", "app_started"]);
  assert.equal(events[0].props.from, "0.10.0");
  assert.equal(events[0].systemProps.appVersion, "0.10.1");
  const again = client(m, { appVersion: "0.10.1" });
  await again.a.start({});
  assert.deepEqual(again.srv.events().map((e) => e.eventName), ["app_started"]);
});

test("an installation made by another PassionCode app is read, never overwritten, and its fields are kept", async () => {
  const m = machine();
  mkdirSync(path.dirname(m.shared), { recursive: true });
  const id = randomUUID();
  writeFileSync(m.shared, JSON.stringify({ version: 1, id, analytics: true, created_at: 1, switchboard: { note: "kept" } }));
  const { a, srv } = client(m);
  await a.start({});
  assert.equal(srv.events()[0].props.first_passioncode_app, false);
  assert.equal(srv.events()[0].props.install_id, id);
  assert.equal(await a.setEnabled(false), true);
  const off = JSON.parse(readFileSync(m.shared, "utf8"));
  assert.deepEqual(off, { version: 1, id, analytics: false, created_at: 1, switchboard: { note: "kept" } });
});

test("two apps creating the file at the same moment end with one id: the loser reads the winner's", async () => {
  const m = machine();
  const winner = randomUUID();
  const racing = {
    ...fsPromises,
    link: async (from: string, to: string) => {
      writeFileSync(to, JSON.stringify({ version: 1, id: winner, analytics: true, created_at: 1 }));
      return fsPromises.link(from, to);
    },
  };
  const { a, srv } = client(m, { fs: racing });
  await a.start({});
  assert.equal(srv.events()[0].props.install_id, winner);
  assert.equal(srv.events()[0].props.first_passioncode_app, false);
  assert.equal(JSON.parse(readFileSync(m.shared, "utf8")).id, winner);
});

test("a broken installation file is never repaired: analytics stays off", async () => {
  for (const text of ["{not json", '{"id":"not-a-uuid","analytics":true}', "[]"]) {
    const m = machine();
    mkdirSync(path.dirname(m.shared), { recursive: true });
    writeFileSync(m.shared, text);
    const { a, srv, lines } = client(m);
    await a.start({});
    await a.active({ gmail: 2 });
    assert.equal(srv.batches.length, 0, text);
    assert.equal(readFileSync(m.shared, "utf8"), text, "left as it was");
    assert.equal(lines[0].reason, "installation_unreadable");
    assert.equal(await a.setEnabled(true), false);
  }
});

test("analytics: false in the shared file is the one switch: nothing is sent until it is turned on again", async () => {
  const m = machine();
  mkdirSync(path.dirname(m.shared), { recursive: true });
  const id = randomUUID();
  writeFileSync(m.shared, JSON.stringify({ version: 1, id, analytics: false, created_at: 1, fabric: true }));
  const { a, srv } = client(m);
  await a.start({});
  await a.active({ gmail: 1 });
  await a.event("server_connected", { method: "entered" });
  assert.equal(srv.batches.length, 0);
  assert.deepEqual(a.status(), { available: true, enabled: false });
  assert.equal(await a.setEnabled(true), true);
  assert.deepEqual(JSON.parse(readFileSync(m.shared, "utf8")), { version: 1, id, analytics: true, created_at: 1, fabric: true });
  await a.active({ gmail: 3 });
  // Turned on: today's active event, and the counts are a fresh baseline (nothing "added" while off).
  assert.deepEqual(srv.events().map((e) => e.eventName), ["app_active"]);
});

test("turning it off drops what is waiting", async () => {
  const m = machine();
  const srv = server([503]);
  const { a } = client(m, { server: srv });
  await a.start({});
  assert.equal(srv.batches.length, 1, "the first send was refused and kept");
  await a.setEnabled(false);
  await a.event("server_connected", { method: "created" });
  await a.wake();
  assert.equal(srv.batches.length, 1, "nothing more leaves");
});

test("events carry counts and the installation id, never a planted address, domain, name or key", async () => {
  const m = machine();
  const { a, srv } = client(m);
  await a.start({});
  const planted = ["owner@private-domain.example", "private-domain.example", "Secret Agent Name", "kid-planted-0001", "cf-client-planted.access", "gmail-id-planted"];
  const answers: Record<string, unknown> = {
    "/api/accounts": { accounts: [{ id: planted[5], email: planted[0], name: planted[2] }] },
    "/api/v1/mailboxes": [{ id: planted[0], email: planted[0], name: planted[2] }, { id: "b@" + planted[1], email: "b@" + planted[1], name: "B" }],
    "/api/agents": { agents: [{ id: planted[3], name: planted[2], addresses: [planted[0]] }], templates: [] },
    "/api/agent-keys": { keys: [{ id: planted[3], clientId: planted[4], name: planted[2], accounts: [planted[0]] }] },
  };
  const ses = { fetch: async (url: string) => {
    const body = answers[new URL(url).pathname];
    return { status: 200, headers: { get: () => "application/json; charset=utf-8" }, json: async () => body };
  } };
  const counts = await usage.countsWith(ses, "https://inbox.private-domain.example")();
  assert.deepEqual(counts, { gmail: 1, cloudflare: 2, agents: 1, agent_keys: 1 });
  await a.active({ ...counts, email: planted[0] } as any);
  const sent = JSON.stringify(srv.batches);
  for (const value of planted) assert.ok(!sent.includes(value), `${value} must never leave the Mac`);
  const active = srv.events().find((e) => e.eventName === "app_active");
  assert.deepEqual(active.props, { server: true, gmail: 1, cloudflare: 2, agents: 1, agent_keys: 1, install_id: active.props.install_id, iid: active.props.install_id, environment: "production" });
});

test("counts are read only from a signed-in server: a sign-in redirect or an HTML page gives none", async () => {
  const redirect = { fetch: async () => ({ status: 302, headers: { get: () => "" }, json: async () => ({}) }) };
  assert.equal(await usage.countsWith(redirect, "https://inbox.example.com")(), null);
  const html = { fetch: async () => ({ status: 200, headers: { get: () => "text/html" }, json: async () => ({}) }) };
  assert.equal(await usage.countsWith(html, "https://inbox.example.com")(), null);
  const offline = { fetch: async () => { throw new Error("offline"); } };
  assert.equal(await usage.countsWith(offline, "https://inbox.example.com")(), null);
});

test("app_active once per UTC day; accounts added or removed since the last counts, the first counts a baseline", async () => {
  const m = machine();
  const { a, srv, advance } = client(m);
  await a.start({});
  assert.equal(a.activeDue(), true);
  await a.active({ gmail: 1, cloudflare: 4, agents: 0, agent_keys: 0 });
  assert.equal(a.activeDue(), false);
  await a.active({ gmail: 1, cloudflare: 4, agents: 0, agent_keys: 0 });
  advance(DAY);
  assert.equal(a.activeDue(), true);
  await a.active({ gmail: 2, cloudflare: 3, agents: 1, agent_keys: 1 });
  const names = srv.events().map((e) => e.eventName);
  assert.deepEqual(names, ["app_installed", "app_started", "app_active", "app_active", "account_added", "account_removed"]);
  const [added, removed] = srv.events().slice(-2);
  assert.deepEqual([added.props.provider, added.props.added, added.props.accounts], ["gmail", 1, 2]);
  assert.deepEqual([removed.props.provider, removed.props.removed, removed.props.accounts], ["cloudflare", 1, 3]);
  // Without a server (no counts) the day still counts.
  advance(DAY);
  await a.active(null);
  assert.deepEqual(srv.events().pop().props.server, false);
});

test("a busy server keeps the batch and waits 60 s, then 10 min; a refusing one drops it; batches hold 25", async () => {
  const m = machine();
  const srv = server([503, 0, 200, 400]);
  const { a, advance, lines } = client(m, { server: srv });
  await a.start({});
  assert.equal(srv.batches.length, 1);
  await a.wake();
  assert.equal(srv.batches.length, 1, "no retry before 60 s");
  advance(61 * 1000);
  await a.wake();
  assert.equal(srv.batches.length, 2, "retried after 60 s and failed in transport");
  advance(5 * 60 * 1000);
  await a.wake();
  assert.equal(srv.batches.length, 2, "the second wait is 10 min");
  advance(6 * 60 * 1000);
  await a.wake();
  assert.equal(srv.batches.length, 3);
  assert.deepEqual(srv.batches[2].map((e: any) => e.eventName), ["app_installed", "app_started"], "the same events, sent once accepted");
  await a.event("server_connected", { method: "entered" });
  assert.equal(srv.batches.length, 4, "a 400 is not retried");
  await a.wake();
  assert.equal(srv.batches.length, 4);
  assert.ok(lines.some((l) => l.event === "analytics_flush" && l.outcome === "deferred"));
  assert.ok(lines.some((l) => l.event === "analytics_flush" && l.outcome === "dropped"));
});

test("what waited goes out in batches of at most 25 once the server accepts again", async () => {
  const m = machine();
  const srv = server([503]);
  const { a, advance } = client(m, { server: srv });
  await a.start({});
  for (let i = 0; i < 40; i++) await a.event("hub_connected", {});
  assert.equal(srv.batches.length, 1, "nothing is sent while the wait lasts");
  advance(61 * 1000);
  await a.wake();
  assert.deepEqual(srv.batches.slice(1).map((b) => b.length), [25, 17]);
});

test("events older than 23 hours are dropped, never sent late", async () => {
  const m = machine();
  const srv = server([503]);
  const { a, advance } = client(m, { server: srv });
  await a.start({});
  advance(24 * 3600 * 1000);
  await a.event("hub_connected", {});
  assert.deepEqual(srv.batches.at(-1)!.map((e: any) => e.eventName), ["hub_connected"]);
});

test("only the release workflow puts an App Key in the app, and the store package carries none", async () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /FABRIC_INBOX_ANALYTICS_APP_KEY: \$\{\{ secrets\.FABRIC_INBOX_ANALYTICS_APP_KEY \}\}/);
  assert.match(workflow, /FABRIC_INBOX_ANALYTICS_HOST: \$\{\{ vars\.FABRIC_INBOX_ANALYTICS_HOST \}\}/);
  const dist = readFileSync("desktop/dist-mac.mjs", "utf8");
  assert.match(dist, /analytics\.json/);
  assert.ok(!/ANALYTICS/.test(readFileSync("desktop/mas-package.mjs", "utf8")), "the store package sends nothing");
  assert.match(readFileSync(".gitignore", "utf8"), /^desktop\/analytics\.json$/m);
  const { analyticsBundle } = await import("../desktop/dist-mac.mjs");
  assert.equal(analyticsBundle({}), null);
  const key = { FABRIC_INBOX_ANALYTICS_APP_KEY: "A-SH-0123456789", FABRIC_INBOX_ANALYTICS_HOST: HOST };
  assert.deepEqual(analyticsBundle({ ...key, GITHUB_ACTIONS: "true" }), { appKey: "A-SH-0123456789", host: HOST, debug: false });
  assert.deepEqual(analyticsBundle(key), { appKey: "A-SH-0123456789", host: HOST, debug: true });
  assert.throws(() => analyticsBundle({ FABRIC_INBOX_ANALYTICS_APP_KEY: "A-SH-0123456789" }), /https origin/);
  assert.throws(() => analyticsBundle({ FABRIC_INBOX_ANALYTICS_APP_KEY: "wrong" }), /App Key/);
});

test("usage counts are sent with Node's fetch, so a pending Keychain prompt cannot hold them back (0.11.0)", async () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const start = main.slice(main.indexOf("async function startAnalytics"), main.indexOf("async function startUpdates"));
  assert.match(start, /const send = globalThis\.fetch;/);
  assert.ok(!/net\.fetch/.test(start), "Chromium's fetch waits for the cookie key from the Keychain");
});

test("a development run has its own app name, so its cookie key lives in its own Keychain item", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /app\.setName\(app\.isPackaged \? 'Fabric Inbox' : 'Fabric Inbox Development'\);/);
});
