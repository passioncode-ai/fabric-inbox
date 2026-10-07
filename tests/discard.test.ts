import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISCARD_RULE_LIMIT, EMPTY_DISCARD_STORE, autoReason, discardFacts, discardSafety, forgetDiscard, learnDiscard, listIdOf, matchDiscard,
  normaliseDiscardStore, recordApplied, ruleFor, ruleIdOf, ruleSubject, isPersonalDomain, type DiscardStore,
} from "../shared/mail/discard";

// The learning behind Discarded (operator, 2026-10-06): each discard records why, keyed on the
// strongest stable signal (List-Id, else the sender's address); mail matching a rule goes to
// Discarded on arrival unless the person wrote to the sender, took part in the thread, or allowed them.
const news = [{ key: "List-Id", value: "Weekly Digest <weekly.digest.example.org>" }, { key: "List-Unsubscribe", value: "<https://example.org/u>" }];

test("the List-Id is read as its id, lower-cased, with the list's own name", () => {
  assert.deepEqual(listIdOf("Weekly Digest <Weekly.Digest.Example.org>"), { id: "weekly.digest.example.org", name: "Weekly Digest" });
  assert.deepEqual(listIdOf("<news.example.org>"), { id: "news.example.org" });
  assert.deepEqual(listIdOf("plain.list.example.org"), { id: "plain.list.example.org" });
  assert.equal(listIdOf(""), null);
  assert.equal(listIdOf("not a list id"), null, "a value with spaces and no brackets is no id");
  assert.equal(listIdOf("<" + "x".repeat(300) + ">"), null, "an absurd value is refused");
});

test("the facts of a message: a newsletter by its List-Id or List-Unsubscribe, its domain only for bulk senders", () => {
  const f = discardFacts({ sender: "Digest <digest@mail.example.org>", headers: news, category: "Newsletters" });
  assert.equal(f.sender, "digest@mail.example.org");
  assert.deepEqual(f.list, { id: "weekly.digest.example.org", name: "Weekly Digest" });
  assert.equal(f.newsletter, true);
  assert.equal(f.domain, "mail.example.org", "a bulk sender's domain is part of why");
  assert.equal(f.category, "Newsletters");
  const person = discardFacts({ sender: "ann@gmail.com", headers: [] });
  assert.equal(person.newsletter, false);
  assert.equal(person.domain, undefined, "never a person's domain");
  const bulkOnGmail = discardFacts({ sender: "promo@gmail.com", headers: [{ key: "List-Unsubscribe", value: "<mailto:x@gmail.com>" }] });
  assert.equal(bulkOnGmail.domain, undefined, "a shared personal domain is never recorded, even for bulk mail");
  const noreply = discardFacts({ sender: "no-reply@shop.example.com", headers: [] });
  assert.equal(noreply.domain, "shop.example.com", "a no-reply sender is bulk");
  assert.equal(discardFacts({ sender: "x@y.example", headers: [{ key: "Precedence", value: "bulk" }] }).domain, "y.example");
});

test("personal mail domains are known, and their subdomains are not", () => {
  for (const d of ["gmail.com", "googlemail.com", "icloud.com", "me.com", "outlook.com", "hotmail.com", "yahoo.com", "proton.me", "yandex.ru", "mail.ru", "gmx.de"]) assert.ok(isPersonalDomain(d), d);
  assert.ok(!isPersonalDomain("news.example.org"));
  assert.ok(!isPersonalDomain("mail.google.com"), "a provider's own service domain is not a person's address");
});

test("the rule is keyed on the List-Id when there is one, else on the sender", () => {
  assert.deepEqual(ruleFor(discardFacts({ sender: "digest@mail.example.org", headers: news })), { kind: "list", value: "weekly.digest.example.org", label: "Weekly Digest" });
  assert.deepEqual(ruleFor(discardFacts({ sender: "Bob <bob@shop.example>", headers: [] })), { kind: "sender", value: "bob@shop.example", label: "bob@shop.example" });
  assert.equal(ruleFor(discardFacts({ sender: "", headers: [] })), null, "no sender and no list: nothing to learn");
});

test("the first discard learns a rule at once; the next ones count on it", () => {
  const facts = discardFacts({ sender: "digest@mail.example.org", headers: news, category: "Newsletters" });
  const first = learnDiscard(EMPTY_DISCARD_STORE, facts, 1000);
  assert.equal(first.created, true);
  assert.equal(first.store.rules.length, 1);
  const rule = first.rule!;
  assert.equal(rule.kind, "list");
  assert.equal(rule.discards, 1);
  assert.equal(rule.applied, 0);
  assert.equal(rule.why.category, "Newsletters");
  assert.equal(rule.why.newsletter, true);
  assert.match(rule.id, /^l-[0-9a-f]{8}$/);
  const again = learnDiscard(first.store, discardFacts({ sender: "other@mail.example.org", headers: news }), 2000);
  assert.equal(again.created, false);
  assert.equal(again.rule!.id, rule.id, "the same list is the same rule whoever sent it");
  assert.equal(again.rule!.discards, 2);
  assert.equal(again.rule!.lastDiscardAt, 2000);
  assert.equal(EMPTY_DISCARD_STORE.rules.length, 0, "the store is never changed in place");
});

test("learning is refused for mail from a person written to, from the workspace's own domains, or allowed", () => {
  const known = learnDiscard(EMPTY_DISCARD_STORE, discardFacts({ sender: "ann@example.org", headers: [] }), 1, { known: true });
  assert.equal(known.rule, undefined);
  assert.equal(known.skipped, "You have written to this sender, so their mail is never discarded on its own");
  const own = learnDiscard(EMPTY_DISCARD_STORE, discardFacts({ sender: "me@ours.example", headers: [] }), 1, { ownDomains: ["ours.example"] });
  assert.match(own.skipped!, /your own domain/);
  const allowed = learnDiscard({ ...EMPTY_DISCARD_STORE, allowed: ["example.org"] }, discardFacts({ sender: "x@sub.example.org", headers: [] }), 1);
  assert.match(allowed.skipped!, /Always allow/);
  const list = learnDiscard(EMPTY_DISCARD_STORE, discardFacts({ sender: "ann@example.org", headers: news }), 1, { known: true });
  assert.ok(list.rule, "a mailing list is learned even from a sender you wrote to: the list is not the person");
});

test("mail on arrival matches a rule by its List-Id first, then by its sender; allowed senders and domains never match", () => {
  let store: DiscardStore = learnDiscard(EMPTY_DISCARD_STORE, discardFacts({ sender: "digest@mail.example.org", headers: news }), 1).store;
  store = learnDiscard(store, discardFacts({ sender: "bob@shop.example", headers: [] }), 2).store;
  assert.equal(matchDiscard(store, discardFacts({ sender: "new@elsewhere.example", headers: news }))?.kind, "list");
  assert.equal(matchDiscard(store, discardFacts({ sender: "BOB@shop.example", headers: [] }))?.kind, "sender");
  assert.equal(matchDiscard(store, discardFacts({ sender: "carol@shop.example", headers: [] })), null, "a sender rule is that address only");
  assert.equal(matchDiscard({ ...store, allowed: ["bob@shop.example"] }, discardFacts({ sender: "bob@shop.example", headers: [] })), null);
  assert.equal(matchDiscard({ ...store, allowed: ["mail.example.org"] }, discardFacts({ sender: "digest@mail.example.org", headers: news })), null);
  assert.equal(matchDiscard(store, discardFacts({ sender: "bob@shop.example", headers: [] }), { allowedSenders: ["bob@shop.example"], allowedDomains: [] }), null,
    "a Never spam entry is an Always allow too");
});

test("safety on arrival: a sender written to, a thread taken part in, the workspace's own domains", () => {
  assert.equal(discardSafety({ sender: "a@x.example", known: false, inThread: false, ownDomains: [] }), null);
  assert.match(discardSafety({ sender: "a@x.example", known: true, inThread: false, ownDomains: [] })!, /written to/);
  assert.match(discardSafety({ sender: "a@x.example", known: false, inThread: true, ownDomains: [] })!, /conversation/);
  assert.match(discardSafety({ sender: "a@sub.ours.example", known: false, inThread: false, ownDomains: ["ours.example"] })!, /own domain/);
});

test("the reason shown on mail discarded automatically counts the discards; applying it is recorded", () => {
  let store = learnDiscard(EMPTY_DISCARD_STORE, discardFacts({ sender: "digest@mail.example.org", headers: news }), 1).store;
  const rule = store.rules[0]!;
  assert.equal(autoReason(rule), "Discarded automatically: you discarded 1 message from this newsletter (Weekly Digest)");
  store = learnDiscard(store, discardFacts({ sender: "digest@mail.example.org", headers: news }), 2).store;
  store = learnDiscard(store, discardFacts({ sender: "digest@mail.example.org", headers: news }), 3).store;
  assert.equal(autoReason(store.rules[0]!), "Discarded automatically: you discarded 3 messages from this newsletter (Weekly Digest)");
  const sender = learnDiscard(EMPTY_DISCARD_STORE, discardFacts({ sender: "bob@shop.example", headers: [] }), 1).rule!;
  assert.equal(autoReason(sender), "Discarded automatically: you discarded 1 message from bob@shop.example");
  assert.equal(ruleSubject(sender), "bob@shop.example");
  assert.equal(ruleSubject(store.rules[0]!), "Weekly Digest");
  const applied = recordApplied(store, store.rules[0]!.id, 99);
  assert.equal(applied.rules[0]!.applied, 1);
  assert.equal(applied.rules[0]!.lastAppliedAt, 99);
  assert.equal(recordApplied(store, "s-00000000", 99), store, "an unknown rule changes nothing");
});

test("Undo forgets a discard: the count goes down and a rule it created goes", () => {
  const facts = discardFacts({ sender: "bob@shop.example", headers: [] });
  const one = learnDiscard(EMPTY_DISCARD_STORE, facts, 1).store;
  assert.equal(forgetDiscard(one, ruleIdOf(facts)!).rules.length, 0, "the discard that made the rule took it back");
  const two = learnDiscard(one, facts, 2).store;
  const back = forgetDiscard(two, ruleIdOf(facts)!);
  assert.equal(back.rules.length, 1);
  assert.equal(back.rules[0]!.discards, 1);
  assert.equal(forgetDiscard(EMPTY_DISCARD_STORE, ruleIdOf(facts)!), EMPTY_DISCARD_STORE);
});

test("a stored file is cleaned: unknown shapes dropped, bounded, the most recently used rules kept", () => {
  assert.deepEqual(normaliseDiscardStore(null), EMPTY_DISCARD_STORE);
  assert.deepEqual(normaliseDiscardStore({ rules: "x", allowed: [5, "Bob@Shop.example", "shop.example", "not an entry"] }).allowed, ["bob@shop.example", "shop.example"]);
  const rules = Array.from({ length: DISCARD_RULE_LIMIT + 5 }, (_, i) => ({ id: `s-${i.toString(16).padStart(8, "0")}`, kind: "sender", value: `u${i}@x.example`, label: `u${i}@x.example`,
    why: { sender: `u${i}@x.example`, newsletter: false }, discards: 1, applied: 0, createdAt: i, lastDiscardAt: i }));
  const kept = normaliseDiscardStore({ rules: [...rules, { id: "bad", kind: "domain", value: "x" }] });
  assert.equal(kept.rules.length, DISCARD_RULE_LIMIT);
  assert.ok(kept.rules.every((r) => r.lastDiscardAt >= 5), "the oldest rules go first");
});
