// S02 (B-268): the open message's header facts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addressOf, compactRecipients, headerFacts, splitAddresses } from "../app/components/inbox/message-header";

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
