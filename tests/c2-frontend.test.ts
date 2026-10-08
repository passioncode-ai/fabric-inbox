import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { gmailDraftKey, keepGmailDraft, restoreGmailDraft, type GmailDraft } from "../app/lib/gmail-draft";
import { showFeedChange } from "../app/lib/mail-refresh";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, type Store } from "../workers/providers/google-oauth";
import { accountsRouter } from "../workers/routes/accounts";

/**
 * C2 test-hardening packet, front-end branches (UX audit 2026-10-07): draft restore on the
 * account page (AUD-B1-04, SCN-019), the unified inbox's search failure and empty states
 * (AUD-B6-02, SCN-005) and a refused mark-read (AUD-B7-01, SCN-026).
 */

// ── AUD-B1-04: the account page's draft comes back from this device ─────────────────────────

class DeviceStorage {
  rows = new Map<string, string>();
  full = false;
  getItem(k: string) { return this.rows.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.full) throw new Error("QuotaExceededError"); this.rows.set(k, v); }
  removeItem(k: string) { this.rows.delete(k); }
}
const gmailDraft = (over: Partial<GmailDraft> = {}): GmailDraft => ({
  to: "maya@example.invalid",
  subject: "Re: Invoice",
  text: "Paid on Friday.",
  threadId: "thread-1",
  inReplyTo: "<m1@example.invalid>",
  references: "<m0@example.invalid> <m1@example.invalid>",
  idempotencyKey: "attempt-1",
  ...over,
});

test("AUD-B1-04: a saved draft and its locked send attempt come back after a restart, per account", () => {
  const storage = new DeviceStorage();
  keepGmailDraft(storage, "g1", gmailDraft(), false);
  keepGmailDraft(storage, "g2", gmailDraft({ to: "alex@example.invalid", idempotencyKey: "attempt-2" }), true);
  assert.deepEqual(restoreGmailDraft(storage, "g1"), { draft: gmailDraft(), locked: false }, "every field, the reply references included");
  const locked = restoreGmailDraft(storage, "g2");
  assert.equal(locked.locked, true, "an uncertain send stays locked");
  assert.equal(locked.draft?.idempotencyKey, "attempt-2", "with the same recovery key, so a retry is the same attempt");
  assert.equal(locked.draft?.to, "alex@example.invalid", "one account's draft never opens on another");
  assert.ok(storage.rows.has(gmailDraftKey("g1")) && gmailDraftKey("g1") === "fabric-draft:g1");
});

test("AUD-B1-04: no saved entry restores no draft; a sent or discarded draft leaves nothing behind", () => {
  const storage = new DeviceStorage();
  assert.deepEqual(restoreGmailDraft(storage, "g1"), { draft: null, locked: false });
  keepGmailDraft(storage, "g1", gmailDraft(), true);
  keepGmailDraft(storage, "g1", null, false);
  assert.equal(storage.rows.has("fabric-draft:g1"), false);
  assert.deepEqual(restoreGmailDraft(storage, "g1"), { draft: null, locked: false });
  // Entries that parse but hold no draft restore as nothing, not as a broken form.
  for (const raw of ["null", "5", "\"text\"", "{}", "{\"locked\":true}"]) {
    storage.rows.set("fabric-draft:g1", raw);
    assert.equal(restoreGmailDraft(storage, "g1").draft, null, raw);
  }
});

test("AUD-B1-04: an unreadable saved entry is refused (the page says the draft could not be restored)", () => {
  const storage = new DeviceStorage();
  storage.rows.set("fabric-draft:g1", '{"draft":{"to":"maya@example.invalid"');
  assert.throws(() => restoreGmailDraft(storage, "g1"), SyntaxError);
  assert.equal(storage.rows.get("fabric-draft:g1"), '{"draft":{"to":"maya@example.invalid"', "reading never rewrites the entry");
  const page = readFileSync("app/routes/gmail-inbox.tsx", "utf8");
  assert.match(page, /restoreGmailDraft\(localStorage, accountId\)[\s\S]{0,200}catch \{\n\s+setNotice\(t\("Saved draft could not be restored\."\)\)/,
    "the account page turns the refusal into its notice");
});

test("AUD-B1-04: a device that refuses the save throws, so the page can say so and never sends without its lock", () => {
  const storage = new DeviceStorage();
  storage.full = true;
  assert.throws(() => keepGmailDraft(storage, "g1", gmailDraft(), true), /Quota/);
  assert.equal(storage.rows.size, 0);
  const page = readFileSync("app/routes/gmail-inbox.tsx", "utf8");
  assert.match(page, /keepGmailDraft\(localStorage, accountId, draft, true\);\n\s+\} catch \{\n\s+sending\.current = false;/,
    "the lock is saved before the send; a refused save stops the send");
});

// ── AUD-B6-02: the unified inbox when a search fails or finds nothing ─────────────────────────

// The route imports through the app's aliases (~/ and shared/), which tsx does not resolve here;
// esbuild bundles the app code with them and leaves packages to Node, so React is one instance.
const OUT = join(process.cwd(), "node_modules", ".cache", "c2-frontend", "unified-inbox.mjs");
mkdirSync(join(process.cwd(), "node_modules", ".cache", "c2-frontend"), { recursive: true });
await build({
  stdin: { contents: "export { default } from './app/routes/unified-inbox';", resolveDir: process.cwd(), loader: "ts" },
  bundle: true, write: true, outfile: OUT, format: "esm", platform: "node", packages: "external",
  alias: { "~": "./app", shared: "./shared" }, jsx: "automatic", loader: { ".svg": "text", ".css": "empty" }, logLevel: "error",
});
const UnifiedInbox = (await import(pathToFileURL(OUT).href)).default as ComponentType;

const account = { id: "gmail:g1", provider: "gmail", email: "me@example.invalid", name: "Me", status: "connected" };
const row = {
  id: '["gmail:g1","m1"]', accountId: "gmail:g1", provider: "gmail", providerMessageId: "m1", subject: "Invoice 12",
  sender: "vendor@example.invalid", recipient: "me@example.invalid", date: "2026-10-06T10:00:00.000Z", read: true, starred: false, snippet: "Invoice",
};
const page = (over: Record<string, unknown> = {}) => ({ accounts: [account], messages: [], issues: [], hasMore: false, ...over });

/** The inbox at `?query=…` with the list query already in the given state (no request is made). */
function renderSearch(query: string, state: Record<string, unknown>) {
  // retryOnMount false: a list that already failed is shown as failed, not fetched again on render.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  const listKey = ["unified-inbox", "", "", "", "", "inbox", query, false];
  client.getQueryCache().build(client, { queryKey: listKey }).setState({ fetchStatus: "idle", ...state } as never);
  const router = createMemoryRouter([{ path: "/", element: createElement(UnifiedInbox) }], { initialEntries: ["/?query=" + encodeURIComponent(query)] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
}
const loaded = (data: unknown) => ({ status: "success", data: { pages: [data], pageParams: [""] }, dataUpdatedAt: Date.now() });

test("AUD-B6-02: a search that fails with nothing shown says why and offers Try again, keeping the query and Clear search", () => {
  const html = renderSearch("invoice", { status: "error", error: new Error("Search could not reach Gmail"), errorUpdatedAt: Date.now() });
  assert.match(html, /role="alert"><h2>Mail could not load<\/h2><p>Search could not reach Gmail<\/p><button[^>]*>Try again<\/button>/);
  assert.match(html, /“invoice”<button>Clear search<\/button>/, "the query stays named, with a way out");
  assert.doesNotMatch(html, /No matching mail/, "a failure is never shown as no results");
  assert.doesNotMatch(html, /Loading your mail/);
});

test("AUD-B6-02: a search that fails while results are shown keeps them and says they may be older", () => {
  const html = renderSearch("invoice", {
    status: "error", error: new Error("timeout"), errorUpdatedAt: Date.now(),
    data: { pages: [page({ messages: [row] })], pageParams: [""] }, dataUpdatedAt: Date.now() - 60_000,
  });
  assert.match(html, /role="alert"><span>The list could not be refreshed; the mail shown may be older\.<\/span><button[^>]*>Retry<\/button>/);
  assert.match(html, /Invoice 12/, "the results already found stay on screen");
  assert.doesNotMatch(html, /Mail could not load/, "no full error panel over results");
});

test("AUD-B6-02: a search with no match says so and offers Clear search", () => {
  const html = renderSearch("invoice", loaded(page()));
  assert.match(html, /<h2>No matching mail<\/h2><p>Try another search or return to your inbox\.<\/p><button class="fi-secondary">Clear search<\/button>/);
  assert.doesNotMatch(html, /role="alert"><h2>/);
});

test("AUD-B6-02: no match while some inboxes could not be searched says the answer is partial", () => {
  const html = renderSearch("invoice", loaded(page({ issues: [{ accountId: "gmail:g1", provider: "gmail", error: "provider_unavailable" }] })));
  assert.match(html, /<h2>No matching mail<\/h2><p>Some inboxes could not be searched; the others have no match\.<\/p>/);
});

// ── AUD-B7-01: a refused mark-read leaves the message unread and says so ─────────────────────

class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix = "" } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>; }
  async transaction<T>(fn: (s: Store) => Promise<T>) { return fn(this); }
}
const env = { GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic", PUBLIC_APP_URL: "https://mail.example.invalid", GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url") };
async function gmailFixture() {
  const store = new MemoryStore();
  let labels = ["INBOX", "UNREAD"], failure = "";
  const calls: { path: string; method?: string }[] = [];
  await store.put<AccountRecord>("account:a", {
    id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(env.GMAIL_TOKEN_ENCRYPTION_KEY, "a", { accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Date.now() + 3600000 }), sync: { mode: "initial" },
  });
  const service = new AccountService(store, env, async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method });
    if (failure === "write" && init?.method === "POST") throw new Error("timeout");
    if (failure === "read" && !init?.method) throw new Error("timeout");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path.endsWith("/modify")) labels = [...new Set([...labels.filter((l) => !body.removeLabelIds.includes(l)), ...body.addLabelIds])];
    return new Response(JSON.stringify({ id: "same", threadId: "thread", labelIds: labels, payload: { headers: [{ name: "Subject", value: "Synthetic" }] } }));
  });
  return { service, calls, fail: (mode: string) => { failure = mode; } };
}

test("AUD-B7-01: Gmail refuses a mark-read it could not confirm, and the message stays unread on the server", async () => {
  const { service, calls, fail } = await gmailFixture();
  assert.equal((await service.setRead("a", "same", false)).read, false, "the message is cached unread");
  assert.equal((await service.getMessage("a", "same")).read, false);
  for (const mode of ["write", "read"]) {
    fail(mode);
    await assert.rejects(service.setRead("a", "same", true), /provider_unavailable/);
    assert.equal((await service.getMessage("a", "same")).read, false, `a ${mode} failure never reports read`);
  }
  fail("");
  assert.equal((await service.setRead("a", "same", true)).read, true, "the same request succeeds once Gmail answers");
  assert.ok(calls.some((c) => c.path.endsWith("/modify")));
});

test("AUD-B7-01: a malformed mark-read is refused before Gmail is asked", async () => {
  const { service, calls } = await gmailFixture();
  const before = calls.length;
  for (const value of [undefined, null, "true", 1, {}]) await assert.rejects(service.setRead("a", "same", value as boolean), /invalid_read_state/);
  const bindings = { ...env, GMAIL_ACCOUNTS: { getByName: () => service } };
  const response = await accountsRouter.request(env.PUBLIC_APP_URL + "/api/accounts/a/messages/same/read", {
    method: "POST", headers: { Origin: env.PUBLIC_APP_URL, "Content-Type": "application/json" }, body: JSON.stringify({ read: "true" }),
  }, bindings as never);
  assert.equal(response.status, 400);
  assert.equal(calls.length, before, "no provider request for a refused body");
});

test("AUD-B7-01: the row shown as read goes back to unread when the server refuses, and the inbox says so", async () => {
  const client = new QueryClient();
  const listKey = ["unified-inbox", "", "", "", "", "inbox", "", false];
  const headKey = ["unified-inbox-head", "", "", "", "inbox", "", false];
  const unread = () => ({ pages: [{ messages: [{ id: "m", read: false, starred: false }], hasMore: true }], pageParams: [""] });
  client.setQueryData(listKey, unread());
  client.setQueryData(headKey, { messages: [{ id: "m", read: false, starred: false }], hasMore: true });
  // The open-marks-read chain of unified-inbox.tsx: show read at once, ask the server, undo on refusal.
  let undo: (() => void) | undefined;
  let notice = "";
  await showFeedChange(client, { id: "m", patch: { read: true } })
    .then((rollback) => { undo = rollback; })
    .then(() => { assert.equal((client.getQueryData(listKey) as ReturnType<typeof unread>).pages[0].messages[0].read, true, "read at once"); })
    .then(() => Promise.reject(Object.assign(new Error("provider_unavailable"), { status: 503 })))
    .catch(() => { undo?.(); notice = "This message could not be marked read. It stays unread."; });
  assert.deepEqual(client.getQueryData(listKey), unread(), "the row is unread again");
  assert.equal((client.getQueryData(headKey) as { messages: { read: boolean }[] }).messages[0].read, false);
  assert.ok(notice);
  const ui = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(ui, /showChange\(\{ id: selected\.id, patch: \{ read: true \} \}\)\.then\(\(rollback\) => \{ undo = rollback; \}\)/);
  assert.match(ui, /\.catch\(\(\) => \{\n\s+undo\?\.\(\);\n\s+setNotice\(t\("This message could not be marked read\. It stays unread\."\)\);/,
    "the inbox runs exactly this chain and says the message stays unread");
});
