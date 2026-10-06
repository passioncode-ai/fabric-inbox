import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeAge, syncStatus, type StatusAccount } from "../app/lib/sync-status";

// The status beside Refresh (operator, 2026-10-06): when the server last read the accounts in view
// (not when the list was last fetched), Updating… while a refresh or a read runs, live for
// Cloudflare mail, and which account failed and what to do.
const NOW = Date.parse("2026-10-06T12:00:00Z");
const gmail = (o: Partial<StatusAccount> = {}): StatusAccount => ({ id: "gmail:a", provider: "gmail", email: "ann@gmail.com", status: "connected", lastSyncAt: NOW - 120_000, ...o });
const cf: StatusAccount = { id: "cloudflare:hi@shop.example", provider: "cloudflare", email: "hi@shop.example", status: "connected" };

test("relative ages read like a person says them", () => {
  assert.equal(relativeAge(NOW - 5_000, NOW), "just now");
  assert.equal(relativeAge(NOW - 50_000, NOW), "1 min ago");
  assert.equal(relativeAge(NOW - 125_000, NOW), "2 min ago");
  assert.equal(relativeAge(NOW - 59 * 60_000, NOW), "59 min ago");
  assert.equal(relativeAge(NOW - 3 * 3_600_000, NOW), "3 h ago");
  assert.match(relativeAge(NOW - 3 * 86_400_000, NOW), /^on /);
  assert.equal(relativeAge(NOW + 10_000, NOW), "just now", "a server clock ahead is not the future");
});

test("the headline is the oldest successful read among the accounts in view", () => {
  const s = syncStatus({ accounts: [gmail(), gmail({ id: "imap:b", provider: "imap", email: "b@icloud.com", lastSyncAt: NOW - 30_000 })], now: NOW, checking: false, fetching: false });
  assert.equal(s.tone, "idle");
  assert.equal(s.headline, "Updated 2 min ago");
  assert.deepEqual(s.rows.map((r) => r.text), ["Updated 2 min ago", "Updated just now"]);
});

test("Cloudflare mail is live: alone it says so, beside others it is a row of its own", () => {
  const alone = syncStatus({ accounts: [cf], now: NOW, checking: false, fetching: false });
  assert.equal(alone.tone, "live");
  assert.equal(alone.headline, "Live");
  assert.equal(alone.rows[0]!.state, "live");
  assert.equal(alone.rows[0]!.text, "Live: mail arrives as it is sent");
  const mixed = syncStatus({ accounts: [cf, gmail()], now: NOW, checking: false, fetching: false });
  assert.equal(mixed.headline, "Updated 2 min ago");
  assert.equal(mixed.rows.length, 2);
});

test("Updating… while Refresh or a read of the list runs", () => {
  assert.equal(syncStatus({ accounts: [gmail()], now: NOW, checking: true, fetching: false }).headline, "Updating…");
  assert.equal(syncStatus({ accounts: [gmail()], now: NOW, checking: false, fetching: true }).tone, "updating");
  assert.equal(syncStatus({ accounts: [cf], now: NOW, checking: false, fetching: true }).tone, "updating");
});

test("an import shows its progress; a throttled account says until when; an account never read says so", () => {
  const importing = syncStatus({ accounts: [gmail({ status: "syncing", importing: 40 })], now: NOW, checking: false, fetching: false });
  assert.equal(importing.headline, "Updated 2 min ago · importing 40%");
  assert.equal(importing.rows[0]!.state, "importing");
  assert.equal(importing.rows[0]!.text, "Importing older mail: 40% · updated 2 min ago");
  const waiting = syncStatus({ accounts: [gmail({ status: "rate_limited", retryAt: Date.parse("2026-10-06T12:05:00Z") })], now: NOW, checking: false, fetching: false });
  assert.equal(waiting.rows[0]!.state, "waiting");
  assert.match(waiting.rows[0]!.text, /^Gmail asked to slow down; next try at /);
  assert.equal(waiting.tone, "idle", "a wait the provider asked for is not a failure");
  const fresh = syncStatus({ accounts: [gmail({ lastSyncAt: undefined, status: "syncing" })], now: NOW, checking: false, fetching: false });
  assert.equal(fresh.headline, "Not updated yet");
});

test("a failed account turns the line into an error that names it, with what to do", () => {
  const reconnect = syncStatus({ accounts: [gmail({ status: "reconnect_required", error: "reconnect_required" }), cf], now: NOW, checking: false, fetching: false });
  assert.equal(reconnect.tone, "error");
  assert.equal(reconnect.headline, "ann@gmail.com needs to be connected again");
  assert.equal(reconnect.rows[0]!.action?.kind, "reconnect");
  assert.equal(reconnect.rows[0]!.action?.href, "/api/accounts/gmail/connect");
  const password = syncStatus({ accounts: [gmail({ id: "imap:b", provider: "imap", email: "b@icloud.com", status: "reconnect_required", error: "reconnect_required" })], now: NOW, checking: false, fetching: false });
  assert.equal(password.rows[0]!.action?.kind, "password");
  assert.equal(password.rows[0]!.action?.href, "/settings/accounts/imap%3Ab");
  const outlook = syncStatus({ accounts: [gmail({ id: "outlook:c", provider: "outlook", email: "c@outlook.com", status: "reconnect_required", error: "reconnect_required" })], now: NOW, checking: false, fetching: false });
  assert.equal(outlook.rows[0]!.action?.href, "/api/accounts/outlook/connect");
  const failing = syncStatus({ accounts: [gmail({ status: "error", error: "provider_unavailable", retryAt: Date.parse("2026-10-06T12:01:00Z") }), gmail({ id: "gmail:z", email: "z@gmail.com", status: "error", error: "gmail_api_disabled", reason: "gmail_api_disabled" })],
    now: NOW, checking: false, fetching: false });
  assert.equal(failing.headline, "2 accounts could not be updated");
  assert.match(failing.rows[0]!.text, /could not be reached; next try at/);
  assert.equal(failing.rows[0]!.action?.kind, "settings");
});

test("a refresh that could not read an account says so until the next one, even if the account looks fine", () => {
  const s = syncStatus({ accounts: [gmail()], now: NOW, checking: false, fetching: false,
    outcomes: [{ accountId: "gmail:a", email: "ann@gmail.com", result: "failed", error: "provider_unavailable" }] });
  assert.equal(s.tone, "error");
  assert.equal(s.headline, "ann@gmail.com could not be updated");
  assert.match(s.rows[0]!.text, /Gmail could not be reached/);
  const late = syncStatus({ accounts: [gmail()], now: NOW, checking: false, fetching: false,
    outcomes: [{ accountId: "gmail:a", email: "ann@gmail.com", result: "not_reached" }] });
  assert.equal(late.tone, "idle", "not reached in time is not a failure: it syncs on its own");
});

test("no account in view: nothing to say", () => {
  const s = syncStatus({ accounts: [], now: NOW, checking: false, fetching: false });
  assert.equal(s.headline, "");
  assert.equal(s.rows.length, 0);
});
