import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, type Store } from "../workers/providers/google-oauth";

// The settings sections import through the app's "~/" alias (tsconfig.cloudflare.json); tsx reads only
// tsconfig.json, so the alias is resolved here before the section is loaded.
const appRoot = pathToFileURL(process.cwd() + "/app/").href;
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { return next(s.startsWith("~/") ? ${JSON.stringify(appRoot)} + s.slice(2) : s, c); }`));
// The section is compiled with the classic JSX runtime (React.createElement) outside a Vite build.
(globalThis as { React?: unknown }).React = React;
const { default: SpamSection } = await import("../app/components/settings/sections/SpamSection");

/**
 * C2 test-hardening packet, spam (UX audit 2026-10-07, batch B8: SCN-039…SCN-042). The error and
 * recovery branches the audit found without an executable receipt, exercised at the route, the
 * provider and the screen. The routes (they load Durable Object code), arrival with unreadable lists and
 * revival of set-aside mail run in workerd: tests/c2-spam-workerd.test.ts.
 */

// ── SCN-039: a Spam that cannot be emptied in some addresses says how many ─────────────────────

test("SCN-039 / B8: the Spam notice names how many addresses could not be emptied (unified inbox)", () => {
  // The notice is built in app/routes/unified-inbox.tsx from the route's { deleted, failed }.
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const empty = code.slice(code.indexOf('"/api/spam/empty"'), code.indexOf('"/api/spam/empty"') + 900);
  assert.match(empty, /r\.failed \?/, "the failure count is said only when there is one");
  assert.match(empty, /\{n\} address could not be emptied; try again\./);
  assert.match(empty, /\{n\} addresses could not be emptied; try again\./);
});

// ── SCN-040: Report spam / Not spam when something does not go through ─────────────────────────

// Gmail's setSpam through the real AccountService and Gmail client (fetch scripted, as in mail-actions.test.ts).
class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix = "" } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>; }
  async transaction<T>(fn: (s: Store) => Promise<T>) { return fn(this); }
}
const gmailEnv = { GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic", PUBLIC_APP_URL: "https://mail.example.invalid", GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url") };
async function gmail() {
  const store = new MemoryStore();
  let labels = ["INBOX", "UNREAD"], failure = "";
  const calls: { path: string; method?: string; body?: any }[] = [];
  await store.put<AccountRecord>("account:a", {
    id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(gmailEnv.GMAIL_TOKEN_ENCRYPTION_KEY, "a", { accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Date.now() + 3600000 }), sync: { mode: "initial" },
  });
  const service = new AccountService(store, gmailEnv, async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init?.method, body });
    if (failure === "write" && init?.method === "POST") throw new Error("timeout");
    if (path.endsWith("/modify")) labels = [...new Set([...labels.filter((l) => !body.removeLabelIds.includes(l)), ...body.addLabelIds])];
    return new Response(JSON.stringify({ id: "m1", threadId: "t1", labelIds: labels, payload: { headers: [{ name: "Subject", value: "Synthetic" }, { name: "From", value: "deals@spam.invalid" }] } }));
  });
  return { service, calls, labels: () => labels, fail: (v: string) => { failure = v; } };
}

test("SCN-040 / B8 Gmail setSpam: Report spam swaps INBOX for SPAM through Gmail's modify, Not spam swaps it back, both read back", async () => {
  const { service, calls, labels } = await gmail();
  const reported = await service.setSpam("a", "m1", true);
  const modify = calls.filter((c) => c.path.endsWith("/modify"));
  assert.deepEqual(modify.at(-1)?.body, { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] }, "Gmail's own label, which trains Gmail");
  assert.equal(modify.at(-1)?.method, "POST");
  assert.ok(reported.labels.includes("SPAM") && !reported.labels.includes("INBOX"), "the answer is Gmail's state read back");
  assert.ok((await service.getMessage("a", "m1")).labels.includes("SPAM"), "the cache holds the confirmed labels");

  const released = await service.setSpam("a", "m1", false);
  assert.deepEqual(calls.filter((c) => c.path.endsWith("/modify")).at(-1)?.body, { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] });
  assert.ok(released.labels.includes("INBOX") && !released.labels.includes("SPAM"));
  assert.deepEqual(labels().sort(), ["INBOX", "UNREAD"], "Not spam leaves the other labels alone");
  assert.ok(calls.every((c) => c.method !== "DELETE"), "never a delete");
});

test("SCN-040 / B8 Gmail setSpam: a non-boolean is refused before Gmail is asked; a failed write keeps the cache and claims nothing", async () => {
  const { service, calls, fail } = await gmail();
  for (const value of [undefined, null, "true", 1, {}]) await assert.rejects(service.setSpam("a", "m1", value as boolean), /invalid_spam_state/);
  assert.equal(calls.length, 0, "no provider I/O for a refused value");
  await service.setSpam("a", "m1", false);
  const before = await service.getMessage("a", "m1");
  fail("write");
  await assert.rejects(service.setSpam("a", "m1", true), /provider_unavailable/);
  assert.deepEqual((await service.getMessage("a", "m1")).labels, before.labels, "the previous state stays: no optimistic SPAM");
});

// ── SCN-041: the model's count cannot be read ──────────────────────────────────────────────────

function renderSpam(data: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["spam"], data);
  const router = createMemoryRouter([{ path: "*", element: createElement(SpamSection, { id: "overview" }) }], { initialEntries: ["/settings/spam/overview"] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
}
const lists = { blockedSenders: [], blockedDomains: [], allowedSenders: [], allowedDomains: [] };

test("SCN-041 / B8: Spam rules → Today says the count could not be read instead of showing zeros or a spent budget", () => {
  const html = renderSpam({ lists, retentionDays: 30, model: { used: 0, limit: 40, spamToday: 0, screenedToday: 0, unavailable: true } });
  assert.match(html, /The model’s count could not be read right now\.|The model&#x27;s count could not be read right now\./);
  assert.doesNotMatch(html, /allowance: 0 of 40/, "no invented numbers");
  assert.doesNotMatch(html, /until tomorrow/, "an unread count is never shown as a spent budget");

  const spent = renderSpam({ lists, retentionDays: 30, model: { used: 40, limit: 40, spamToday: 2, screenedToday: 40, unavailable: false } });
  assert.match(spent, /allowance: 40 of 40 a day/);
  assert.match(spent, /stays in the inbox until tomorrow/, "a readable, spent budget says what happens next");
  assert.doesNotMatch(spent, /could not be read/);
});

// ── SCN-042: a change to the hidden addresses that cannot be saved ────────────────────────────

test("SCN-042 / B8: a failed hide reaches the person as a notice, and the stuck-mail Retry reports what it revived (unified inbox)", () => {
  // Static receipt: unified-inbox.tsx is owned by another change in this pass. The hide goes through
  // perform(), whose catch puts the server's error in the notice; the Retry sums `revived`.
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const perform = code.slice(code.indexOf("async function perform("), code.indexOf("async function perform(") + 500);
  assert.match(perform, /catch \(e\) \{[\s\S]*setNotice\(t\.text\(\(e as Error\)\.message\)\)/, "a refusal becomes the notice");
  assert.match(code, /onHidden=\{\(change\) => perform\(async \(\) => \{\s*const r = await fabric<\{ hidden: string\[\] \}>\("\/api\/inbox\/hidden", change, "PUT"\)/);
  const retry = code.slice(code.indexOf("/incoming/retry"), code.indexOf("/incoming/retry") + 400);
  assert.match(retry, /results\.reduce\(\(n, r\) => n \+ r\.revived, 0\)/);
  assert.match(retry, /\{n\} set-aside messages sent to rules, agents and categories again\./);
});
