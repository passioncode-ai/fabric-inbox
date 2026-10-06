import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readInbox } from "../workers/routes/inbox";
import { inboxSources } from "../workers/lib/inbox-sources";
import { syncLabel } from "../app/components/inbox/AccountSidebar";
import type { InboxAccount } from "../shared/mail/inbox";

/** P2-10 and P2-11: what the sidebar says about an account's sync and its counts. */
const accounts: InboxAccount[] = [
  { id: "gmail:a", provider: "gmail", email: "a@example.invalid", name: "A", status: "connected" },
  { id: "gmail:b", provider: "gmail", email: "b@example.invalid", name: "B", status: "connected" },
];

test("a count that cannot be read is marked stale, never silently kept (P2-11)", async () => {
  const sources = {
    cloudflareAccounts: async () => [],
    remoteAccounts: async () => structuredClone(accounts),
    messages: async () => [],
    counts: async (a: InboxAccount) => { if (a.id === "gmail:b") throw new Error("cache_scan_limit"); return { unread: 3, total: 9 }; },
  };
  const page = await readInbox(new URLSearchParams(), sources);
  const a = page.accounts.find((x) => x.id === "gmail:a")!, b = page.accounts.find((x) => x.id === "gmail:b")!;
  assert.deepEqual([a.unread, a.countsStale], [3, undefined]);
  assert.deepEqual([b.unread, b.countsStale], [undefined, true], "the client keeps the last count and shows it as stale");
});

test("a Gmail account importing says so, with its progress when known (P2-10)", async () => {
  const env = { GMAIL_ACCOUNTS: { getByName: () => ({ listAccounts: async () => ({ accounts: [
    { id: "a", email: "a@example.invalid", status: "syncing", sync: { mode: "initial", phase: "backfill", imported: 250, total: 1000 } },
    { id: "b", email: "b@example.invalid", status: "syncing", sync: { mode: "initial", phase: "recent" } },
    { id: "c", email: "c@example.invalid", status: "connected", sync: { mode: "history", historyId: "9" } },
  ] }) }) } };
  const listed = await inboxSources(env as never).remoteAccounts();
  assert.deepEqual(listed.map((a) => [a.status, a.importing]), [["syncing", 25], ["syncing", undefined], ["connected", undefined]]);
  assert.deepEqual(listed.map((a) => syncLabel(a)), ["importing 25%", "importing", ""]);
});

test("the sidebar's counts and the categories are read with the list, not on separate clocks (P2-11)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const categories = code.slice(code.indexOf('queryKey: ["categories"]'), code.indexOf("const listReadAt"));
  assert.doesNotMatch(categories, /refetchInterval/);
  assert.match(code, /if \(!first\) void categoryList\.refetch\(\);/);
});
