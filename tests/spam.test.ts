import { test } from "node:test";
import assert from "node:assert/strict";
import { authResults, spamCheck, normaliseLists, listEntry, type SpamLists } from "../shared/mail/spam";

// SP-1: the verdict a Cloudflare message gets on arrival, from the operator's lists and the
// authenticity results Cloudflare's MX wrote. Header values are the shapes seen on live mail.
const cf = (value: string) => ({ key: "authentication-results", value: `mx.cloudflare.net; ${value}` });
const pass = cf("dkim=pass header.d=mg-d0.letters.invalid header.s=mailo; dmarc=pass header.from=letters.invalid policy.dmarc=reject; spf=none");
const empty: SpamLists = { blockedSenders: [], blockedDomains: [], allowedSenders: [], allowedDomains: [] };
const base = { sender: "news@letters.invalid", ownDomains: ["ours.invalid", "product.invalid"], lists: empty, known: false };

test("only the topmost result written by Cloudflare's MX counts; a forged one lower down is ignored", () => {
  const forged = { key: "authentication-results", value: "mx.cloudflare.net; dmarc=pass header.from=bank.invalid" };
  const real = cf("dkim=fail header.d=bank.invalid; dmarc=fail header.from=bank.invalid policy.dmarc=reject; spf=fail");
  assert.deepEqual(authResults([real, forged]), { dkim: ["fail"], dkimDomains: [], dmarc: "fail", dmarcPolicy: "reject", spf: "fail", fromDomain: "bank.invalid" });
  assert.equal(authResults([{ key: "authentication-results", value: "evil.invalid; dmarc=pass" }]), null, "another server's result is not ours to trust");
  assert.equal(authResults([]), null);
  assert.deepEqual(authResults([pass])?.dkimDomains, ["mg-d0.letters.invalid"]);
});

test("a message that passed the checks from a stranger is screened by the model; one we wrote to is clean", () => {
  assert.deepEqual(spamCheck({ ...base, headers: [pass] }), { verdict: "screen", reason: "" });
  assert.deepEqual(spamCheck({ ...base, headers: [pass], known: true }), { verdict: "clean", reason: "You have written to this sender" });
});

test("DMARC failure where the domain asks to reject or quarantine is spam; with p=none it is only screened", () => {
  const reject = cf("dkim=none; dmarc=fail header.from=payments.invalid policy.dmarc=reject; spf=softfail");
  const r = spamCheck({ ...base, sender: "service@payments.invalid", headers: [reject] });
  assert.equal(r.verdict, "spam");
  assert.match(r.reason, /DMARC for payments\.invalid/);
  const quarantine = cf("dmarc=fail header.from=shop.invalid policy.dmarc=quarantine");
  assert.equal(spamCheck({ ...base, sender: "a@shop.invalid", headers: [quarantine] }).verdict, "spam");
  const none = cf("dmarc=fail header.from=small.invalid policy.dmarc=none; spf=pass");
  assert.equal(spamCheck({ ...base, sender: "a@small.invalid", headers: [none] }).verdict, "screen");
});

test("SPF failure with no valid signature is spam; with a valid signature it is not decided by SPF", () => {
  assert.equal(spamCheck({ ...base, sender: "a@x.invalid", headers: [cf("dkim=none; spf=fail smtp.mailfrom=x.invalid; dmarc=none")] }).verdict, "spam");
  assert.equal(spamCheck({ ...base, sender: "a@x.invalid", headers: [cf("dkim=pass header.d=x.invalid; spf=fail; dmarc=none")] }).verdict, "screen");
});

test("mail claiming one of our domains is ours only when it proves it; otherwise it is a forgery", () => {
  const own = cf("dkim=pass header.d=ours.invalid header.s=cf-bounce; dmarc=pass header.from=ours.invalid policy.dmarc=reject; spf=none");
  assert.deepEqual(spamCheck({ ...base, sender: "routing-test@ours.invalid", headers: [own] }), { verdict: "clean", reason: "From one of your own domains" });
  const forged = cf("dkim=none; dmarc=none header.from=ours.invalid; spf=none");
  const r = spamCheck({ ...base, sender: "ceo@ours.invalid", headers: [forged] });
  assert.equal(r.verdict, "spam");
  assert.match(r.reason, /ours\.invalid/);
  assert.equal(spamCheck({ ...base, sender: "a@news.product.invalid", headers: [forged] }).verdict, "spam", "a subdomain of ours is ours too");
  assert.equal(spamCheck({ ...base, sender: "a@ours.invalid", headers: [] }).verdict, "clean", "with no result from Cloudflare (a local or relayed copy) nothing is claimed");
});

test("a forgery is decided first; then the operator's lists: allowed beats the weaker checks, blocked beats a pass", () => {
  const lists: SpamLists = { blockedSenders: ["deals@shop.invalid"], blockedDomains: ["spammy.invalid"], allowedSenders: [], allowedDomains: ["payments.invalid"] };
  assert.equal(spamCheck({ ...base, lists, sender: "deals@shop.invalid", headers: [pass] }).reason, "You marked this sender as spam");
  assert.equal(spamCheck({ ...base, lists, sender: "x@mail.spammy.invalid", headers: [pass] }).reason, "You marked spammy.invalid as spam");
  const reject = cf("dmarc=fail header.from=payments.invalid policy.dmarc=reject");
  // Allowing payments.invalid allows its mail, not mail its own DMARC says is not from it.
  assert.equal(spamCheck({ ...base, lists, sender: "service@payments.invalid", headers: [reject] }).verdict, "spam");
  assert.match(spamCheck({ ...base, lists, sender: "service@payments.invalid", headers: [reject] }).reason, /Failed DMARC for payments\.invalid/);
  // A broken SPF record with no signature is weaker: the operator's allow wins there.
  const spfFail = cf("spf=fail smtp.mailfrom=payments.invalid; dmarc=none header.from=payments.invalid");
  assert.deepEqual(spamCheck({ ...base, lists, sender: "service@payments.invalid", headers: [spfFail] }), { verdict: "clean", reason: "You marked payments.invalid as not spam" });
  assert.equal(spamCheck({ ...base, lists: { ...lists, allowedSenders: ["deals@shop.invalid"] }, sender: "deals@shop.invalid", headers: [pass] }).verdict, "clean",
    "an allowed sender wins over a blocked one");
});

test("lists are normalised, deduplicated and bounded; an entry is an address or a domain", () => {
  const lists = normaliseLists({ blockedSenders: [" A@B.invalid ", "a@b.invalid", "nope"], blockedDomains: ["@Spam.Test", "spam.test", "x"], allowedSenders: [], allowedDomains: ["ok.test"] });
  assert.deepEqual(lists, { blockedSenders: ["a@b.invalid"], blockedDomains: ["spam.test"], allowedSenders: [], allowedDomains: ["ok.test"] });
  assert.deepEqual(normaliseLists(null), empty);
  assert.equal(normaliseLists({ blockedSenders: Array.from({ length: 3000 }, (_, i) => `u${i}@x.invalid`) }).blockedSenders.length, 2000);
  assert.deepEqual(listEntry("Ann <ANN@Shop.invalid>", "sender"), "ann@shop.invalid");
  assert.deepEqual(listEntry("ann@mail.shop.invalid", "domain"), "mail.shop.invalid");
  assert.equal(listEntry("not an address", "sender"), null);
});

test("EMAIL_ADDRESSES is read in every shape a deployment gives it", async () => {
  const { allowedAddresses } = await import("../workers/lib/mailbox-store");
  assert.deepEqual(allowedAddresses({ EMAIL_ADDRESSES: ["A@x.invalid"] }), ["a@x.invalid"]);
  assert.deepEqual(allowedAddresses({ EMAIL_ADDRESSES: '["a@x.invalid","b@x.invalid"]' as never }), ["a@x.invalid", "b@x.invalid"]);
  assert.deepEqual(allowedAddresses({ EMAIL_ADDRESSES: "a@x.invalid, B@x.invalid" as never }), ["a@x.invalid", "b@x.invalid"]);
  assert.deepEqual(allowedAddresses({ EMAIL_ADDRESSES: "[broken" as never }), [], "an unreadable value restricts nothing");
  assert.deepEqual(allowedAddresses({}), []);
});

test("too little text to judge: a signature or a word is left alone, a short offer or any link is not", async () => {
  const { tooLittleToJudge } = await import("../shared/mail/spam");
  assert.equal(tooLittleToJudge("Wysłane z iPhone'a"), true);
  assert.equal(tooLittleToJudge("\n\nSent from my iPhone\n"), true);
  assert.equal(tooLittleToJudge("ok, thanks"), true);
  assert.equal(tooLittleToJudge("We offer SEO services at a great price."), false);
  assert.equal(tooLittleToJudge("see www.x.invalid"), false);
});
