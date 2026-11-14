// S02 (B-268): the open message's header facts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addressOf, compactRecipients, headerFacts, splitAddresses, relativeDate } from "../app/components/inbox/message-header";

describe("S02: who wrote a message and to whom", () => {
  it("splits an address list on commas between addresses, not inside a quoted name", () => {
    assert.deepEqual(splitAddresses('"Smith, Ann" <ann@acme.example>, bob@acme.example; Cy <cy@acme.example>'), [
      '"Smith, Ann" <ann@acme.example>',
      "bob@acme.example",
      "Cy <cy@acme.example>",
    ]);
    assert.deepEqual(splitAddresses(undefined), []);
    assert.equal(addressOf("Ann <ANN@Acme.Example>"), "ann@acme.example");
    assert.equal(addressOf("not an address"), "");
  });

  it("marks our own address among the recipients as you", () => {
    const f = headerFacts({ from: "ann@acme.example", to: "Me <me@owner.example>, bob@acme.example", cc: "cy@acme.example", own: "me@owner.example" });
    assert.deepEqual(f.to.map((r) => r.you), [true, false]);
    assert.deepEqual(f.cc.map((r) => r.you), [false]);
    assert.equal(f.notAddressed, false);
  });

  it("shows Bcc only on mail we sent", () => {
    assert.equal(headerFacts({ from: "me@owner.example", to: "ann@acme.example", bcc: "boss@owner.example", own: "me@owner.example", sent: true }).bcc.length, 1);
    assert.equal(headerFacts({ from: "ann@acme.example", to: "me@owner.example", bcc: "boss@owner.example", own: "me@owner.example" }).bcc.length, 0);
  });

  it("says our address is not in To or Cc only for received mail, no list, no catch-all", () => {
    const base = { from: "ann@acme.example", to: "team@acme.example", own: "me@owner.example" };
    assert.equal(headerFacts(base).notAddressed, true);
    assert.equal(headerFacts({ ...base, listId: "<news.acme.example>" }).notAddressed, false);
    assert.equal(headerFacts({ ...base, catchAll: true }).notAddressed, false);
    assert.equal(headerFacts({ ...base, sent: true }).notAddressed, false);
    assert.equal(headerFacts({ ...base, own: "" }).notAddressed, false);
  });

  it("shows Reply-To only when it differs from From", () => {
    assert.equal(headerFacts({ from: "Ann <ann@acme.example>", to: "x@owner.example", replyTo: "ann@acme.example" }).replyTo, null);
    assert.equal(headerFacts({ from: "Ann <ann@acme.example>", to: "x@owner.example", replyTo: "Desk <desk@other.example>" }).replyTo, "Desk <desk@other.example>");
    assert.equal(headerFacts({ from: "ann@acme.example", to: "x@owner.example", replyTo: "" }).replyTo, null);
  });

  it("gives the compact line its first recipient and how many more", () => {
    const f = headerFacts({ from: "a@acme.example", to: "b@acme.example, c@acme.example", cc: "d@acme.example" });
    assert.deepEqual(compactRecipients(f), { first: f.to[0], more: 2 });
    assert.deepEqual(compactRecipients(headerFacts({ from: "a@acme.example", to: "" })), { first: null, more: 0 });
  });
});

describe("A-8: Received at is never on mail we sent", () => {
  it("received mail not naming our address says where it arrived; sent mail with Bcc does not", () => {
    const received = headerFacts({ from: "ann@acme.example", to: "list@acme.example", own: "hello@owner.example" });
    assert.equal(received.receivedAt, true);
    const sent = headerFacts({ from: "hello@owner.example", to: "ann@acme.example", bcc: "bob@acme.example", own: "hello@owner.example", sent: true });
    assert.equal(sent.receivedAt, false, "From already names our address");
    assert.equal(sent.bcc.length, 1);
    assert.equal(headerFacts({ from: "ann@acme.example", to: "hello@owner.example", own: "hello@owner.example" }).receivedAt, false);
  });
});

describe("A-22: the date's relative time on pointing", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  it("hours, days and minutes in the reader's language", () => {
    assert.equal(relativeDate(new Date(now - 3 * 3600_000), now, "en-US"), "3 hours ago");
    assert.equal(relativeDate(new Date(now - 86_400_000), now, "en-US"), "yesterday");
    assert.equal(relativeDate(new Date(now - 5 * 60_000), now, "en-US"), "5 minutes ago");
    assert.equal(relativeDate(new Date(now - 3 * 3600_000), now, "ru-RU"), "3 часа назад");
    assert.equal(relativeDate(new Date(now + 60_000), now, "en-US"), "now", "a date ahead of the clock reads as now");
  });
});
