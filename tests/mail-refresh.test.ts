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
