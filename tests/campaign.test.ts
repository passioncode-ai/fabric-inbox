import { test } from "node:test";
import assert from "node:assert/strict";
import { CampaignInputSchema, campaignProblem, companyOf, FREE_MAIL, composeStep, inboundKind, inWindow, nextInWindow, normaliseRecipient, plan, rampedCap, render, suppressed, suppressionEntry } from "../shared/mail/campaign";

// B-181 (SCN-089): a campaign as it is prepared.
const base = (over: Record<string, unknown> = {}) => CampaignInputSchema.parse({ name: "Q4 partners", sender: "gmail:a1", steps: [{ body: "Hi {{first_name|there}}" }], ...over });

test("human-paced defaults, and a Cloudflare sender or a backwards window is refused with why", () => {
  const c = base();
  assert.deepEqual([c.dailyCap, c.gapMinutes, c.window.days, c.window.start, c.window.end, c.stopOnReply, c.companyStop], [30, [5, 10], [1, 2, 3, 4, 5], "09:00", "17:00", true, true]);
  assert.equal(campaignProblem(c), null);
  assert.match(campaignProblem(base({ sender: "cloudflare:me@owner.example" }))!, /transactional mail only/);
  assert.match(campaignProblem(base({ window: { start: "17:00", end: "09:00" } }))!, /must end after it starts/);
  assert.match(campaignProblem(base({ timezone: "Mars/Olympus" }))!, /not a time zone/);
  assert.equal(CampaignInputSchema.safeParse({ name: "x", sender: "gmail:a1", steps: [{ body: "a" }], dailyCap: 51 }).success, false, "never over 50 a day");
});

test("fields fill the template, a fallback covers a missing one, and what is still missing is named", () => {
  assert.deepEqual(render("Hi {{first_name|there}}, about {{Company}}.", { first_name: "Ann", company: "Acme" }), { text: "Hi Ann, about Acme.", missing: [] });
  assert.deepEqual(render("Hi {{first_name|there}}, about {{company}}.", {}), { text: "Hi there, about .", missing: ["company"] });
});

test("recipients are normalised and the suppression list holds addresses and whole domains", () => {
  assert.deepEqual(normaliseRecipient({ email: " Ann@Acme.Example ", fields: { First_Name: "Ann", "bad key": 1 } as never }), { email: "ann@acme.example", fields: { first_name: "Ann", email: "ann@acme.example" } });
  assert.equal(normaliseRecipient({ email: "not an address" }), null);
  const list = new Set([suppressionEntry("@acme.example")!, suppressionEntry("bob@other.example")!]);
  assert.equal(suppressed("x@mail.acme.example", list), true, "a subdomain of a listed domain");
  assert.equal(suppressed("bob@other.example", list), true);
  assert.equal(suppressed("ann@other.example", list), false);
  assert.equal(suppressionEntry("nonsense"), null);
});

test("a dry run sends only inside the window, at most the daily cap a rolling day, with the gaps", () => {
  const c = base({ timezone: "UTC", dailyCap: 3 });
  const monday9 = Date.parse("2026-10-26T09:00:00Z");
  const times = plan(c, 5, Date.parse("2026-10-25T12:00:00Z"), () => 0);
  assert.equal(times.length, 5);
  assert.equal(times[0], monday9, "Sunday is not a window day; Monday 09:00 is the first send");
  assert.deepEqual(times.slice(1, 3).map((t) => t - times[0]!), [5 * 60_000, 10 * 60_000], "5 minutes apart");
  assert.ok(times[3]! - times[0]! >= 86_400_000, "the fourth waits a rolling day");
  assert.ok(times.every((t) => inWindow(c, t)));
});

// B-181 step 2 (SCN-090): the rules the sending loop follows.
test("the ramp holds an account to 10 on its first day, 5 more each day, never over the campaign's cap", () => {
  const first = Date.UTC(2026, 10, 2, 9);
  assert.equal(rampedCap(30, 0, first), 10, "before any send");
  assert.equal(rampedCap(30, first, first + 3_600_000), 10);
  assert.equal(rampedCap(30, first, first + 86_400_000), 15);
  assert.equal(rampedCap(30, first, first + 10 * 86_400_000), 30);
  assert.equal(rampedCap(8, first, first), 8);
  const c = base({ dailyCap: 30, gapMinutes: [5, 5] });
  const times = plan(c, 12, Date.UTC(2026, 10, 2, 9), () => 0); // Monday 09:00 UTC
  assert.equal(times.filter((t) => t < Date.UTC(2026, 10, 2, 17)).length, 10, "the dry run keeps the ramp too");
});

test("the next moment inside the window, and each step as the recipient gets it", () => {
  const c = base();
  assert.equal(nextInWindow(c, Date.UTC(2026, 10, 7, 12)), Date.UTC(2026, 10, 9, 9), "Saturday noon waits for Monday 09:00");
  const two = base({ steps: [{ subject: "About {{company|your team}}", body: "Hi {{first_name|there}}" }, { body: "Any thoughts?" }], postalAddress: "1 Main St, Springfield" });
  const first = composeStep(two, 0, { first_name: "Ann" }, "");
  assert.equal(first.subject, "About your team");
  assert.match(first.text, /^Hi Ann\n\nIf you would rather not hear from me again, reply "unsubscribe"/);
  assert.match(first.text, /1 Main St, Springfield$/);
  assert.equal(composeStep(two, 1, {}, "About your team").subject, "Re: About your team", "a follow-up answers the first message");
  assert.equal(composeStep(two, 1, {}, "Re: x").subject, "Re: x");
});

test("an arriving message is a bounce, an automatic reply, a request to stop, or a reply; a company is a domain that is not free mail", () => {
  assert.equal(inboundKind({ sender: "Mail Delivery Subsystem <mailer-daemon@mail.example>", subject: "Delivery Status Notification (Failure)", body: "" }), "bounce");
  assert.equal(inboundKind({ sender: "postmaster@acme.example", subject: "Undeliverable: Hi", body: "" }), "bounce");
  assert.equal(inboundKind({ sender: "ann@acme.example", subject: "Automatic reply: About your team", body: "I am away" }), "auto");
  assert.equal(inboundKind({ sender: "ann@acme.example", subject: "Re: About", body: "Please unsubscribe me.\n\nOn Mon, me wrote:\n> hi" }), "unsubscribe");
  assert.equal(inboundKind({ sender: "ann@acme.example", subject: "Re: About", body: "Отпишите меня, пожалуйста" }), "unsubscribe");
  assert.equal(inboundKind({ sender: "ann@acme.example", subject: "Re: About", body: "Sounds good, call me.\n\nOn Mon, me wrote:\n> reply unsubscribe to stop" }), "reply",
    "the stop line quoted from our own message is not a request to stop");
  assert.equal(companyOf("ann@acme.example"), "acme.example");
  assert.equal(companyOf(`ann@${[...FREE_MAIL][0]}`), null, "free mail is nobody's company");
});
