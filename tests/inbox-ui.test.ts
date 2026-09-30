import test from "node:test";
import assert from "node:assert/strict";
import {
  replyRecipient,
  recipientAddresses,
  sendRecovery,
} from "../app/components/inbox/send-state";
import { messagePath } from "../app/components/inbox/model";
test("a late auth refusal cannot unlock an uncertain send across account namespaces", () => {
  for (const status of [400, 401, 403, 404, 413])
    assert.equal(sendRecovery(true, status, { error: "refused" }), "uncertain");
  assert.equal(sendRecovery(false, 403, { error: "refused" }), "editable");
  assert.equal(sendRecovery(true, 502, { status: "failed" }), "failed");
  assert.equal(sendRecovery(true, 409, { status: "unknown" }), "uncertain");
});
test("sent replies target original recipients, incoming replies target sender", () => {
  assert.equal(
    replyRecipient(
      "Alex <alex@example.com>",
      "Maya <maya@example.com>",
      "alex@example.com",
    ),
    "maya@example.com",
  );
  assert.equal(
    replyRecipient(
      "Maya <maya@example.com>",
      "alex@example.com",
      "alex@example.com",
    ),
    "maya@example.com",
  );
});
test("same provider message ID routes to the selected owning account", () => {
  const base = {
    id: "unique",
    providerMessageId: "123",
    subject: "Test",
    sender: "a@example.com",
    recipient: "b@example.com",
    date: "2026-09-26",
    read: false,
    starred: false,
    snippet: "",
  };
  assert.equal(
    messagePath({
      ...base,
      accountId: "cloudflare:studio@example.com",
      provider: "cloudflare",
    }),
    "/api/v1/mailboxes/studio%40example.com/emails/123",
  );
  assert.equal(
    messagePath({ ...base, accountId: "gmail:personal", provider: "gmail" }),
    "/api/accounts/personal/messages/123",
  );
});

test("quoted recipient names with commas become valid bare send addresses", () => {
  assert.deepEqual(
    recipientAddresses(
      '"Chen, Maya" <maya@example.com>, Jordan <jordan@example.com>',
    ),
    ["maya@example.com", "jordan@example.com"],
  );
  assert.equal(
    replyRecipient(
      "Alex <alex@example.com>",
      '"Chen, Maya" <maya@example.com>, Jordan <jordan@example.com>',
      "alex@example.com",
    ),
    "maya@example.com, jordan@example.com",
  );
  assert.throws(() =>
    recipientAddresses("maya@example.com\r\nBcc: other@example.com"),
  );
});

test("REQ-T2: Focus puts important mail first and keeps the rest in fixed-order groups, newest first inside", async () => {
  const { focusSections, groupCounts } = await import("../app/components/inbox/triage-view");
  const m = (id: string, group: string, importance: string, read = false) =>
    ({ id, sender: id + "@x.invalid", subject: id, read, starred: false, triage: { group, importance, reasons: [] } }) as any;
  const messages = [m("n1", "newsletters", "low"), m("p1", "people", "important"), m("d1", "dev", "low", true), m("p2", "people", "normal", true), m("n2", "newsletters", "low", true), m("s1", "security", "important")];
  const focus = focusSections(messages);
  assert.deepEqual(focus.important.map((x: any) => x.id), ["p1", "s1"]);
  assert.deepEqual(focus.groups.map((g: any) => [g.id, g.messages.map((x: any) => x.id), g.unread]), [
    ["people", ["p2"], 0], ["dev", ["d1"], 0], ["newsletters", ["n1", "n2"], 1],
  ]);
  const onlyNews = focusSections(messages, "newsletters");
  assert.deepEqual(onlyNews.important, []);
  assert.deepEqual(onlyNews.groups.map((g: any) => g.id), ["newsletters"]);
  assert.deepEqual(groupCounts(messages).map((c: any) => [c.id, c.count, c.unread]), [
    ["people", 2, 1], ["security", 1, 1], ["dev", 1, 0], ["newsletters", 2, 1],
  ]);
});

test("REQ-T2: a message from an older server without triage is placed by the same rules", async () => {
  const { focusSections } = await import("../app/components/inbox/triage-view");
  const focus = focusSections([{ id: "a", sender: "Ann <ann@friend.invalid>", subject: "Hi", read: false, starred: false }]);
  assert.deepEqual(focus.important.map((x) => x.id), ["a"]);
});

test("CF-1: addresses group by domain, catch-all last, Gmail first, unread summed", async () => {
  const { groupAccounts, addressLabel, totalUnread } = await import("../app/components/inbox/account-groups");
  const a = (id: string, email: string, provider: "cloudflare" | "gmail", unread?: number) => ({ id, email, provider, name: email, status: "connected", unread });
  const groups = groupAccounts([
    a("c1", "catch-all@product.invalid", "cloudflare", 2), a("c2", "support@product.invalid", "cloudflare", 1),
    a("c3", "contact@imaging.invalid", "cloudflare"), a("g1", "me@gmail.invalid", "gmail", 5),
  ]);
  assert.deepEqual(groups.map((g) => [g.key, g.accounts.map((x) => x.id), g.unread]), [
    ["gmail", ["g1"], 5], ["imaging.invalid", ["c3"], undefined], ["product.invalid", ["c2", "c1"], 3],
  ]);
  assert.equal(addressLabel(a("x", "catch-all@product.invalid", "cloudflare")), "everything else");
  assert.equal(addressLabel(a("y", "support@product.invalid", "cloudflare")), "support");
  assert.equal(totalUnread([a("a", "x@y.invalid", "cloudflare")]), undefined);
  assert.equal(totalUnread([a("a", "x@y.invalid", "cloudflare", 2), a("b", "z@y.invalid", "cloudflare")]), 2);
});

test("the rows as shown, the next message after one leaves, a pinned section, and dates (audit F6, F7, F20)", async () => {
  const { displayOrder, nextAfter, pinTriage, listDate, focusSections } = await import("../app/components/inbox/triage-view");
  const m = (id: string, over: Record<string, unknown> = {}) => ({ id, sender: "Ann <ann@friend.invalid>", subject: id, read: false, starred: false, ...over });
  const list = [m("a"), m("n1", { sender: "news@list.invalid", triage: { group: "newsletters", importance: "low", reasons: [] } }), m("b")];
  assert.deepEqual(displayOrder(list, "focus", undefined, new Set()).map((x: any) => x.id), ["a", "b"], "a closed group's rows are not shown");
  assert.deepEqual(displayOrder(list, "focus", undefined, new Set(["newsletters"])).map((x: any) => x.id), ["a", "b", "n1"]);
  assert.deepEqual(displayOrder(list, "newest", "newsletters", new Set()).map((x: any) => x.id), ["n1"], "Newest honours the group filter");
  assert.equal(nextAfter(list, "a")!.id, "n1");
  assert.equal(nextAfter(list, "b")!.id, "n1", "the last one falls back to the one above");
  assert.equal(nextAfter([m("only")], "only"), null);
  const opened = { id: "a", triage: { group: "people", importance: "important", reasons: ["Unread"] } } as const;
  const afterRead = [m("a", { read: true }), m("b")];
  assert.equal(focusSections(pinTriage(afterRead, opened as any)).important[0].id, "a", "the opened message stays in Important once read");
  const now = new Date("2026-09-29T15:00:00");
  assert.match(listDate("2026-09-29T09:05:00", now), /09[:.]05|9[:.]05/);
  assert.doesNotMatch(listDate("2026-03-02T09:05:00", now), /2026/);
  assert.match(listDate("2025-03-02T09:05:00", now), /2025/);
});

test("CAT-5: a category says where it looks and how its sorting stands", async () => {
  const { scopeSummary, progressText, blankCategory } = await import("../app/services/categories");
  const projects = [{ id: "p-acme", name: "Acme", domains: ["acme.invalid"], addresses: [], createdAt: "", updatedAt: "" }];
  assert.equal(scopeSummary({ scope: { all: true, accounts: [], domains: [], projects: [] } }, projects), "All inboxes");
  assert.equal(scopeSummary({ scope: { all: false, accounts: ["gmail:me@example.com"], domains: ["x.invalid"], projects: ["p-acme"] } }, projects),
    "Acme, x.invalid, me@example.com");
  assert.equal(scopeSummary({ scope: { all: false, accounts: ["cloudflare:a@x.invalid", "cloudflare:b@x.invalid"], domains: ["x.invalid", "y.invalid"], projects: [] } }, projects),
    "x.invalid, y.invalid, a@x.invalid and 1 more");
  const stats = { matched: 0, fresh: 0, classified: 0, pending: 0, errors: 0, waitingBudget: 0, backfill: { total: 0, done: 0, state: "idle" as const, detail: "" } };
  const base = { ...blankCategory(), id: "c", name: "Refunds", kind: "screened" as const, version: 1, createdAt: "", updatedAt: "", stats };
  assert.equal(progressText({ ...base, kind: "scope" }), null);
  assert.equal(progressText(base), null);
  assert.equal(progressText({ ...base, enabled: false }), "Paused: new mail is not sorted into it");
  assert.equal(progressText({ ...base, stats: { ...stats, backfill: { total: 200, done: 40, state: "running", detail: "" } } }), "Sorting recent mail: 40 of 200");
  assert.equal(progressText({ ...base, stats: { ...stats, waitingBudget: 1 } }), "1 message waits for tomorrow's model budget");
  assert.equal(progressText({ ...base, stats: { ...stats, errors: 3 } }), "3 messages could not be sorted");
});

test("SP-3: Report spam sends the message and its sender, says what happens next, and fails loudly when nothing moved", async () => {
  const { changeSpam } = await import("../app/components/inbox/MessageActions");
  const message = { id: "cloudflare:a@x.invalid:m1", accountId: "cloudflare:a@x.invalid", provider: "cloudflare" as const, providerMessageId: "m1", starred: false, sender: "Deals <deals@promo.invalid>" };
  const calls: { url: string; body: any }[] = [];
  const ok = async (url: string, body: unknown) => { calls.push({ url, body }); return { moved: 1, listed: ["deals@promo.invalid"] }; };
  const change = await changeSpam(message, true, ok);
  assert.deepEqual(calls[0], { url: "/api/spam/report", body: { messages: [{ accountId: "cloudflare:a@x.invalid", providerMessageId: "m1", sender: "Deals <deals@promo.invalid>" }], list: "sender" } });
  assert.deepEqual(change, { id: message.id, removed: true, notice: "Moved to Spam. New mail from deals@promo.invalid goes to Spam too; change it on Spam rules." });
  const back = await changeSpam(message, false, ok);
  assert.equal(calls[1].url, "/api/spam/release");
  assert.match((back as { notice: string }).notice, /^Moved to the inbox\. Mail from deals@promo\.invalid is no longer treated as spam\.$/);
  const listFailed = await changeSpam(message, true, async () => ({ moved: 1, listed: [], listError: "The messages moved, but the spam rules were not changed: busy" }));
  assert.equal((listFailed as { notice: string }).notice, "The messages moved, but the spam rules were not changed: busy");
  await assert.rejects(changeSpam(message, false, async () => ({ moved: 0, failed: [{ error: "It is no longer in Spam" }] })), /It is no longer in Spam/);
});

test("the sidebar lists addresses with mail, catch-alls and the open one; hidden ones apart; the rest can be hidden in one go", async () => {
  const { sidebarAccounts } = await import("../app/components/inbox/account-groups");
  const a = (email: string, over: Record<string, unknown> = {}) => ({ id: "cloudflare:" + email, provider: "cloudflare" as const, email, name: email, status: "connected", ...over });
  const accounts = [
    a("sales@x.invalid", { total: 3, unread: 0 }), a("empty@x.invalid", { total: 0, unread: 0 }), a("catch-all@x.invalid", { total: 0, catchAll: true }),
    a("new@x.invalid"), a("open@x.invalid", { total: 0 }), a("muted@x.invalid", { total: 9 }),
  ];
  const r = sidebarAccounts(accounts, { filter: "mail", hidden: new Set(["cloudflare:muted@x.invalid"]), selectedId: "cloudflare:open@x.invalid" });
  assert.deepEqual(r.visible.map((x) => x.email), ["sales@x.invalid", "catch-all@x.invalid", "new@x.invalid", "open@x.invalid"]);
  assert.deepEqual(r.hidden.map((x) => x.email), ["muted@x.invalid"]);
  assert.deepEqual(r.withoutMail.map((x) => x.email), ["empty@x.invalid", "open@x.invalid"], "a catch-all and an unknown count are never taken");
  assert.equal(sidebarAccounts(accounts, { filter: "all", hidden: new Set() }).visible.length, 6);
});
