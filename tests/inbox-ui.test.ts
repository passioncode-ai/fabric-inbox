import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  replyAllRecipients,
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

// B10-06: Reply all seeds every participant except the account itself — the sender and the other
// To addresses in To, the other Cc addresses in Cc, each address once (as the server's reply-all,
// tests/mcp-tools.test.ts). With no one else on the message there is no Reply all at all.
test("reply all answers every participant except the account itself, once each (B10-06)", () => {
  assert.deepEqual(
    replyAllRecipients("Ann <ann@x.invalid>", "Me <me@x.invalid>, bob@x.invalid", "carol@x.invalid, ME@x.invalid", "me@x.invalid"),
    { to: "ann@x.invalid, bob@x.invalid", cc: "carol@x.invalid" },
  );
  assert.deepEqual(
    replyAllRecipients("ann@x.invalid", "bob@x.invalid", "bob@x.invalid, carol@x.invalid", "me@x.invalid"),
    { to: "ann@x.invalid, bob@x.invalid", cc: "carol@x.invalid" },
    "an address in To and Cc appears once, in To",
  );
  assert.deepEqual(
    replyAllRecipients("Me <me@x.invalid>", "bob@x.invalid", "carol@x.invalid", "me@x.invalid"),
    { to: "bob@x.invalid", cc: "carol@x.invalid" },
    "a message the account sent is answered to its original recipients, as replyRecipient does",
  );
  assert.equal(replyAllRecipients("Me <me@x.invalid>", "me@x.invalid", "", "me@x.invalid"), null, "the account alone on the message: nothing to reply all to");
  assert.equal(replyAllRecipients("ann@x.invalid", "me@x.invalid", "", "me@x.invalid")!.to, "ann@x.invalid");
  assert.equal(replyAllRecipients("not an address", "bob@x.invalid", "", "me@x.invalid")!.to, "bob@x.invalid", "an unparseable sender is skipped, not kept");
});

test("the reader offers Reply all only when others are on the message, seeded and threaded like a reply (B10-06)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(code, /const replyAll = detail\.data && owner \? replyAllRecipients\(detail\.data\.from, detail\.data\.to, detail\.data\.cc \?\? "", owner\.email\) : null;/);
  assert.match(code, /\{replyAll && \([\s\S]{0,300}compose\("reply", true\)/);
  assert.match(code, /\.\.\.\(mode === "reply" && all && replyAll\?\.cc \? \{ cc: replyAll\.cc \} : \{\}\)/, "Cc is seeded on the same reply draft");
  assert.match(code, /threadId: mode === "reply" \? m\?\.threadId : undefined/, "thread identity stays the reply's");
  const model = readFileSync("app/components/inbox/model.ts", "utf8");
  assert.match(model, /cc\?: string;/);
});

test("a download in flight says so in its button; a failed Cloudflare download names the file (B6-03, B6-04)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(code, /t\("\{name\} could not be downloaded\.", \{ name: a\.filename \}\)/);
  assert.match(code, /<span role="status">\{t\("Downloading…"\)\}<\/span>/);
  assert.match(code, /setDownloading\(null\)/, "the in-flight state ends in finally, on success and failure alike");
});

test("the inbox warns about the Outlook client secret ending, with one action (B5-01)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(code, /queryKey: \["microsoft-setup"\]/, "the same setup answer Settings reads");
  assert.match(code, /secretExpiry\?\.state === "soon"/);
  assert.match(code, /Open the Outlook setup/);
  // It opens the Outlook setup at the secret fields (B5-02), not just the accounts list.
  assert.match(code, /to=\{outlookSecretSetupPath\(\)\}>\{t\("Open the Outlook setup"\)\}/);
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

test("an address made in the last 7 days is listed before its first message; an older or undated empty one stays folded (2026-10-08)", async () => {
  const { sidebarAccounts, isNewAccount, NEW_ACCOUNT_MS } = await import("../app/components/inbox/account-groups");
  const now = Date.parse("2026-10-08T12:00:00Z");
  const a = (email: string, over: Record<string, unknown> = {}) => ({ id: "cloudflare:" + email, provider: "cloudflare" as const, email, name: email, status: "connected", total: 0, unread: 0, ...over });
  const accounts = [
    a("j1@x.invalid", { createdAt: now - 60_000 }),
    a("edge@x.invalid", { createdAt: now - NEW_ACCOUNT_MS + 1 }),
    a("week@x.invalid", { createdAt: now - NEW_ACCOUNT_MS }),
    a("legacy@x.invalid"),
    a("ahead@x.invalid", { createdAt: now + 5_000 }),
    { ...a("me@gmail.invalid", { createdAt: now - 3_600_000 }), id: "gmail:g1", provider: "gmail" as const },
    a("muted@x.invalid", { createdAt: now - 60_000 }),
  ];
  const r = sidebarAccounts(accounts, { filter: "mail", hidden: new Set(["cloudflare:muted@x.invalid"]), now });
  assert.deepEqual(r.visible.map((x) => x.email), ["j1@x.invalid", "edge@x.invalid", "ahead@x.invalid", "me@gmail.invalid"],
    "just made, one millisecond inside the week, a clock a little ahead, a newly connected account");
  assert.deepEqual(r.withoutMail.map((x) => x.email), ["week@x.invalid", "legacy@x.invalid"],
    "exactly 7 days old folds; no creation time reads as old; a new address is never offered to Hide them…");
  assert.deepEqual(r.hidden.map((x) => x.email), ["muted@x.invalid"], "hiding a new address still hides it");
  assert.equal(isNewAccount(accounts[3], now), false);
  assert.equal(sidebarAccounts(accounts, { filter: "all", hidden: new Set(), now }).visible.length, accounts.length);
  // A week later the same address folds like any other without mail.
  assert.deepEqual(sidebarAccounts([accounts[0]], { filter: "mail", hidden: new Set(), now: now + NEW_ACCOUNT_MS }).withoutMail.map((x) => x.email), ["j1@x.invalid"]);
});
