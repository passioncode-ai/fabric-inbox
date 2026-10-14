import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeHead, refreshScope, refreshSummary, WakeRefresh, type FeedPage, type FeedRow } from "../app/lib/mail-refresh";
import { SYNC_TEXT } from "../app/lib/sync-status";

const row = (id: string, timestamp: number): FeedRow => ({ id, date: new Date(timestamp).toISOString(), accountId: "gmail:a", providerMessageId: id });
const page = (rows: FeedRow[], hasMore = true, cursor = "c-" + rows.at(-1)?.id): FeedPage => ({ messages: rows, hasMore, cursor });

test("after Load older, a newly read first page joins the loaded pages: new mail on top, nothing lost (P1-3)", () => {
  const loaded = { pages: [page([row("m9", 900), row("m8", 800), row("m7", 700)]), page([row("m6", 600), row("m5", 500)])], pageParams: ["", "c-m7"] };
  // Two new messages arrived; the new first page (three rows) now ends at m9.
  const head = page([row("n2", 1200), row("n1", 1100), row("m9", 900)]);
  const merged = mergeHead(loaded, head);
  assert.deepEqual(merged.pages.flatMap((p) => p.messages.map((m) => m.id)), ["n2", "n1", "m9", "m8", "m7", "m6", "m5"]);
  assert.deepEqual(merged.pages[0].messages.map((m) => m.id), ["n2", "n1", "m9", "m8", "m7"], "rows older than the new page's last stay: no gap before page 2");
  assert.deepEqual(merged.pageParams, ["", "c-m7"], "page 2 and its cursor are kept");
  assert.equal(merged.pages[0].cursor, "c-m7");
  const archived = mergeHead(loaded, page([row("n1", 1100), row("m9", 900), row("m7", 700)]));
  assert.deepEqual(archived.pages[0].messages.map((m) => m.id), ["n1", "m9", "m7"], "a row in the new page's range that it lacks was archived and goes");
});

test("coming back to the window or waking the Mac reads the list again, not more than every 10 s (P1-4)", () => {
  const wake = new WakeRefresh(10_000);
  assert.equal(wake.activity(true, 1_000), false, "already active: nothing to do");
  assert.equal(wake.activity(false, 2_000), false);
  assert.equal(wake.activity(true, 20_000), true, "back from elsewhere: read now");
  assert.equal(wake.activity(false, 21_000), false);
  assert.equal(wake.activity(true, 22_000), false, "a quick switch away and back does not read again");
  assert.equal(wake.resume(40_000), true, "the Mac woke");
  wake.read(60_000);
  assert.equal(wake.resume(65_000), false, "the list was just read by its poll");
});

test("the inbox polls through the window-activity policy and keeps polling the first page after Load older (P1-3, P1-4)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.doesNotMatch(code, /refetchInterval:\s*\d/, "no fixed interval: polling stops while the window is not active");
  assert.match(code, /> 1 \? false : pollInterval\(windowActive, INBOX_POLL_MS\)/);
  assert.match(code, /queryKey: \["unified-inbox-head"/);
  assert.match(code, /refetchInterval: olderLoaded \? pollInterval\(windowActive, INBOX_POLL_MS\) : false/);
  assert.match(code, /mergeHead\(data, fresh\)/);
  assert.match(code, /subscribeWindowActivity\(window, document/);
  assert.match(code, /onResume\?\.\(/);
});

test("Refresh asks Gmail only for the Gmail accounts in view (P1-5)", () => {
  assert.equal(refreshScope({ accountId: "", domain: "" }), undefined, "every Gmail account");
  assert.deepEqual(refreshScope({ accountId: "gmail:a", domain: "" }), ["gmail:a"]);
  assert.equal(refreshScope({ accountId: "cloudflare:me@example.com", domain: "" }), null, "a Cloudflare address arrives by push");
  assert.equal(refreshScope({ accountId: "", domain: "example.com" }), null, "a domain is its Cloudflare addresses");
});

test("Refresh says Updated just now, or which account was not read and why (P1-5)", () => {
  assert.deepEqual(refreshSummary([]), { ok: true, text: "Updated just now." });
  assert.deepEqual(refreshSummary([{ accountId: "gmail:a", email: "a@example.com", result: "synced" }]), { ok: true, text: "Updated just now." });
  const importing = refreshSummary([{ accountId: "gmail:a", email: "a@example.com", result: "synced", importing: 40 }]);
  assert.equal(importing.ok, true);
  assert.match(importing.text, /a@example\.com is still importing older mail \(40%\)/);
  const mixed = refreshSummary([
    { accountId: "gmail:a", email: "a@example.com", result: "synced" },
    { accountId: "gmail:b", email: "b@example.com", result: "backoff", retryAt: Date.UTC(2026, 9, 6, 14, 5) },
    { accountId: "gmail:c", email: "c@example.com", result: "reconnect" },
    { accountId: "gmail:d", email: "d@example.com", result: "failed", error: "rate_limited" },
    { accountId: "gmail:e", email: "e@example.com", result: "not_reached" },
  ]);
  assert.equal(mixed.ok, false);
  assert.match(mixed.text, /^Updated, except:/);
  assert.match(mixed.text, /b@example\.com: Gmail failed a moment ago; it tries again at /);
  assert.match(mixed.text, /c@example\.com needs to be connected again/);
  assert.match(mixed.text, /d@example\.com: Gmail asked us to slow down/);
  assert.match(mixed.text, /e@example\.com was not checked in time/);
  assert.doesNotMatch(mixed.text, /a@example\.com/, "an account that synced is not mentioned");
});

test("the inbox's refresh button reads Gmail, not only the browser's cache (P1-5)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(code, /fabric<RefreshResponse>\("\/api\/inbox\/refresh"/);
  assert.match(code, /<SyncStatus [^>]*\n?[^>]*onRefresh=\{\(\) => void checkForMail\(\)\}/);
  const status = readFileSync("app/components/inbox/SyncStatus.tsx", "utf8");
  assert.match(status, /aria-label=\{T\.checkNow\}[\s\S]{0,200}onClick=\{onRefresh\}/);
  assert.equal(SYNC_TEXT.checkNow, "Check for new mail");
  assert.doesNotMatch(code, /Refresh cached mail/);
});

test("a failed background refresh keeps the shown mail behind a one-line Retry bar (B6-01)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(code, /list\.isError \|\| list\.isRefetchError \|\| \(olderLoaded && \(head\.isError \|\| head\.isRefetchError\)\)/, "a background read that failed is caught, not only the first load");
  assert.match(code, /\{refreshFailed && messages\.length > 0 && \([\s\S]{0,300}role="alert"/);
  assert.match(code, /list\.isError && !messages\.length \? \(/, "the full Mail could not load panel is only for a list with nothing to show");
  assert.doesNotMatch(code, /\) : list\.isError \? \(/, "an error with mail already shown no longer replaces the list");
});

test("Refresh sits on the left, under the list's title, before the folder and the search (operator, 2026-10-06)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const toolbar = code.slice(code.indexOf('<header className="fi-toolbar">'), code.indexOf("</header>", code.indexOf('<header className="fi-toolbar">')));
  const title = toolbar.indexOf("<h1>{scopeName}</h1>"), sync = toolbar.indexOf("<SyncStatus"), folder = toolbar.indexOf("fi-folder-select"), search = toolbar.indexOf('role="search"');
  assert.ok(title > 0 && sync > title && sync < folder && sync < search, "title, then Refresh and its status, then the folder and the search");
  assert.doesNotMatch(toolbar.slice(search), /Check for new mail/, "nothing of Refresh is left on the right");
  // The status is the server's last read of each account in view, ticking only while visible.
  const status = readFileSync("app/components/inbox/SyncStatus.tsx", "utf8");
  assert.match(status, /useVisibleClock\(15_000\)/);
  assert.match(code, /fetching=\{list\.isFetching \|\| head\.isFetching\}/);
});

test("a full new first page that ends newer than everything loaded is a gap: the list restarts from it, nothing skipped (bug hunt 2026-10-12)", () => {
  const loaded = { pages: [page([row("m9", 900), row("m8", 800)]), page([row("m7", 700)])], pageParams: ["", "c-m8"] };
  // More than a page of mail arrived: the new first page (full, hasMore) ends at n2, newer than m9.
  const head = page([row("n4", 1400), row("n3", 1300), row("n2", 1200)], true, "c-n2");
  const merged = mergeHead(loaded, head);
  assert.deepEqual(merged.pages.map((p) => p.messages.map((m) => m.id)), [["n4", "n3", "n2"]], "Load older continues from n2, not past n1 to m7");
  assert.equal(merged.pages[0].cursor, "c-n2");
  assert.deepEqual(merged.pageParams, [""]);
  // A complete new page (no more after it) is not a gap.
  const whole = mergeHead(loaded, page([row("n1", 1100)], false));
  assert.deepEqual(whole.pages[0].messages.map((m) => m.id), ["n1", "m9", "m8"]);
});

test("undoing one refused change puts back only that row, not other changes made since (bug hunt 2026-10-12)", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { showFeedChange } = await import("../app/lib/mail-refresh");
  const client = new QueryClient();
  const key = ["unified-inbox", "all"];
  client.setQueryData(key, { pages: [{ messages: [{ id: "a", read: false }, { id: "b", read: false }, { id: "c", read: false }], hasMore: false }], pageParams: [""] });
  const undoA = await showFeedChange(client, { id: "a", removed: true });
  await showFeedChange(client, { id: "b", removed: true });
  await showFeedChange(client, { id: "c", patch: { read: true } });
  undoA(); // archiving a failed; b's archive and c's read stand
  const rows = (client.getQueryData(key) as any).pages[0].messages;
  assert.deepEqual(rows.map((m: any) => m.id), ["a", "c"], "a is back where it was; b stays archived");
  assert.equal(rows.find((m: any) => m.id === "c").read, true, "c stays read");
  const undoRead = await showFeedChange(client, { id: "c", patch: { read: false } });
  await showFeedChange(client, { id: "a", patch: { read: true } });
  undoRead();
  const after = (client.getQueryData(key) as any).pages[0].messages;
  assert.equal(after.find((m: any) => m.id === "c").read, true, "c's read flag is what it was before the refused change");
  assert.equal(after.find((m: any) => m.id === "a").read, true, "a's later change is kept");
});

test("a read that started before the server had a shown change keeps the change (B-95)", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { showFeedChange, withPendingChanges, forgetFeedChanges } = await import("../app/lib/mail-refresh");
  const client = new QueryClient();
  client.setQueryData(["unified-inbox", "b95"], { pages: [{ messages: [{ id: "x1", read: false }, { id: "x2", read: false }], hasMore: false }], pageParams: [""] });
  const stale = { messages: [{ id: "x1", read: false }, { id: "x2", read: false }], hasMore: false };
  const archived = await showFeedChange(client, { id: "x1", removed: true });
  const read = await showFeedChange(client, { id: "x2", patch: { read: true } });
  // A poll started after the change was shown, answered before the server applied it.
  const startedAt = Date.now();
  assert.deepEqual(withPendingChanges(stale, startedAt).messages, [{ id: "x2", read: true }], "the archived row stays gone, the read flag stays");
  await new Promise((resolve) => setTimeout(resolve, 5)); // the server answers a moment later
  archived.settle();
  read.settle();
  // A read started once the server had both answers with the server's own rows.
  const later = Date.now() + 1;
  const fresh = { messages: [{ id: "x2", read: false }], hasMore: false };
  assert.deepEqual(withPendingChanges(fresh, later).messages, [{ id: "x2", read: false }], "settled changes leave later reads alone (x2 marked unread elsewhere)");
  assert.deepEqual(withPendingChanges(stale, startedAt).messages, [{ id: "x2", read: true }], "an older read in flight still gets them");
  // Undo of the archive put x1 back on the server: the change no longer hides it.
  forgetFeedChanges(["x1"]);
  assert.deepEqual(withPendingChanges(stale, startedAt).messages.map((m) => m.id), ["x1", "x2"]);
  // A refused change, taken back, is never applied again; a forgotten change does not linger past its time.
  const refused = await showFeedChange(client, { id: "x3", removed: true });
  refused();
  assert.deepEqual(withPendingChanges({ messages: [{ id: "x3" }], hasMore: false }, Date.now()).messages, [{ id: "x3" }]);
  const unsettled = await showFeedChange(client, { id: "x4", removed: true });
  assert.deepEqual(withPendingChanges({ messages: [{ id: "x4" }], hasMore: false }, Date.now(), Date.now() + 61_000).messages, [{ id: "x4" }], "dropped after a minute");
  void unsettled;
  forgetFeedChanges(["x2"]);
});

test("the inbox applies shown changes to every page it reads, settles them and forgets what Undo restored (B-95)", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(route, /\.then\(\(page\) => withPendingChanges\(page, startedAt\)\)/);
  assert.match(route, /for \(const u of undo\) u\.settle\(\);/);
  assert.match(route, /undo\?\.settle\(\);/);
  assert.match(route, /forgetFeedChanges\(done\.items\.map\(\(item\) => item\.message\.id\)\)/);
});
