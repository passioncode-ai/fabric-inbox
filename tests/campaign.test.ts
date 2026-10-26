import { test } from "node:test";
import assert from "node:assert/strict";
import { CampaignInputSchema, campaignProblem, inWindow, normaliseRecipient, plan, render, suppressed, suppressionEntry } from "../shared/mail/campaign";

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
