// O-10 (B-184): after Create my server the app waits for a new workers.dev name and sign-in page to
// appear in DNS before it opens the server, instead of showing "could not reach the server".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { waitForHosts, hostsOf, WAIT_MS, POLL_MS } = require("../desktop/address-wait.cjs");

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

test("hosts that resolve at once are opened without a word and without a wait", async () => {
  const c = clock();
  let told = 0;
  const r = await waitForHosts(["fabric-inbox.acme.workers.dev", "acme.cloudflareaccess.com"], {
    ...c, resolve: async () => ["192.0.2.1"], onWaiting: () => { told++; } });
  assert.deepEqual(r, { ok: true, waitedMs: 0 });
  assert.equal(told, 0);
});

test("a host that appears after a while is waited for, polled, and said once", async () => {
  const c = clock();
  const seen: string[] = [];
  let told = 0;
  const r = await waitForHosts(["fabric-inbox.acme.workers.dev", "acme.cloudflareaccess.com"], {
    ...c, onWaiting: (host: string) => { told++; seen.push(host); },
    resolve: async (host: string) => { if (host.endsWith("workers.dev") && c.now() < 40_000) throw new Error("ENOTFOUND"); return ["192.0.2.1"]; } });
  assert.equal(r.ok, true);
  assert.equal(r.waitedMs, 40_000);
  assert.equal(told, 1);
  assert.deepEqual(seen, ["fabric-inbox.acme.workers.dev"]);
});

test("past the deadline the wait ends with the hosts still missing; nothing waits forever", async () => {
  const c = clock();
  let calls = 0;
  const r = await waitForHosts(["fabric-inbox.acme.workers.dev"], { ...c, resolve: async () => { calls++; throw new Error("ENOTFOUND"); } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pending, ["fabric-inbox.acme.workers.dev"]);
  assert.ok(r.waitedMs <= WAIT_MS);
  assert.equal(calls, Math.floor(WAIT_MS / POLL_MS) + 1);
});

test("the hosts are the server's own and its sign-in page's; a missing or bad origin is left out", () => {
  assert.deepEqual(hostsOf("https://fabric-inbox.acme.workers.dev", "https://acme.cloudflareaccess.com"),
    ["fabric-inbox.acme.workers.dev", "acme.cloudflareaccess.com"]);
  assert.deepEqual(hostsOf("https://inbox.example.com", undefined), ["inbox.example.com"]);
  assert.deepEqual(hostsOf("not a url", ""), []);
});

test("Create my server waits for the address before it opens the mail window, and the setup page shows the step", () => {
  const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const wait = main.indexOf("addressWait.waitForHosts(");
  assert.ok(wait > 0, "the deploy handler waits for the hosts");
  assert.ok(wait < main.indexOf("loadMail();", wait), "the mail window opens after the wait");
  assert.match(main, /cacheUsage: 'disallowed'/, "a negative answer is not read back from the cache");
  const setup = readFileSync(new URL("../desktop/setup.js", import.meta.url), "utf8");
  assert.match(setup, /\['online', \(\) => t\('Reachable on the internet'\)\]/);
});
