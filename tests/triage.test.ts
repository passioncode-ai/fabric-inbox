import { test } from "node:test";
import assert from "node:assert/strict";
import { triage, signalsFromHeaders, type TriageInput } from "../shared/mail/triage";

const msg = (over: Partial<TriageInput>): TriageInput => ({ sender: "Ann Lee <ann@customer.invalid>", subject: "Hello", read: false, starred: false, ...over });
const place = (over: Partial<TriageInput>) => { const t = triage(msg(over)); return `${t.group}/${t.importance}`; };

test("an unread message from a person is important; once read it is normal (REQ-T1)", () => {
  assert.equal(place({}), "people/important");
  assert.equal(place({ read: true }), "people/normal");
  assert.deepEqual(triage(msg({})).reasons, ["Written by a person", "Unread"]);
});

test("mailing lists, promotions, social and automated senders are low and grouped", () => {
  assert.equal(place({ signals: { listUnsubscribe: true } }), "newsletters/low");
  assert.equal(place({ signals: { precedence: "bulk" } }), "newsletters/low");
  assert.equal(place({ labels: ["CATEGORY_PROMOTIONS"] }), "newsletters/low");
  assert.equal(place({ sender: "LinkedIn <messages-noreply@linkedin.com>" }), "social/low");
  assert.equal(place({ labels: ["CATEGORY_SOCIAL"] }), "social/low");
  assert.equal(place({ sender: "noreply@shop.invalid", subject: "We shipped" }), "notifications/low");
  assert.equal(place({ labels: ["CATEGORY_UPDATES"] }), "notifications/low");
  assert.equal(place({ signals: { autoSubmitted: "auto-generated" } }), "notifications/low");
});

test("messages that need action are raised out of their automated group", () => {
  assert.equal(place({ sender: "no-reply@accounts.google.test", subject: "Security alert: new sign-in on Mac" }), "security/important");
  assert.equal(place({ sender: "App Store Connect <no-reply@email.apple.com>", subject: "App Store Connect: Your submission was rejected" }), "stores/important");
  assert.equal(place({ sender: "TestFlight <no-reply@email.apple.com>", subject: "TestFlight: build 42 is ready to test" }), "stores/normal");
  assert.equal(place({ sender: "Stripe <noreply@stripe.com>", subject: "Payment failed for Fabric Pro" }), "billing/important");
  assert.equal(place({ sender: "Stripe <no-reply@stripe.com>", subject: "Your receipt from Fabric" }), "billing/low");
  assert.equal(place({ sender: "GitHub <noreply@github.com>", subject: "[passioncode-ai/fabric-inbox] Run failed: CI - main" }), "dev/important");
  assert.equal(place({ sender: "GitHub <noreply@github.com>", subject: "[passioncode-ai/fabric-inbox] New comment on PR #3" }), "dev/low");
  assert.equal(place({ sender: "Sentry <noreply@md.getsentry.com>", subject: "Critical: error rate exceeded" }), "alerts/important");
  assert.equal(place({ sender: "noreply@sentry.io", subject: "Weekly report", read: true }), "alerts/normal");
});

test("a star and Gmail's IMPORTANT label raise a message; a read security mail is not re-raised", () => {
  assert.equal(place({ signals: { listId: true }, starred: true }), "newsletters/important");
  assert.equal(place({ read: true, labels: ["IMPORTANT"] }), "people/important");
  assert.equal(place({ labels: ["IMPORTANT", "CATEGORY_PROMOTIONS"] }), "newsletters/low", "IMPORTANT does not rescue a promotion");
  assert.equal(place({ sender: "no-reply@x.invalid", subject: "Your verification code is 1234", read: true }), "security/normal");
});

test("the same message always lands in the same place", () => {
  const input = msg({ sender: "Stripe <noreply@stripe.com>", subject: "Invoice 42" });
  assert.deepEqual(triage(input), triage(structuredClone(input)));
});

test("header signals are compact and never carry values beyond what triage needs", () => {
  assert.deepEqual(signalsFromHeaders([
    { key: "List-Id", value: "<news.x.invalid>" },
    { key: "list-unsubscribe", value: "<mailto:secret-token@x.invalid>" },
    { key: "Precedence", value: " Bulk " },
    { key: "Auto-Submitted", value: "auto-generated" },
    { key: "Subject", value: "private" },
  ]), { listId: true, listUnsubscribe: true, precedence: "bulk", autoSubmitted: "auto-generated" });
  assert.deepEqual(signalsFromHeaders([]), {});
});

test("Gmail messages keep list signals for triage when cached", async () => {
  const { normalizeMessage } = await import("../workers/providers/gmail-client");
  const message = normalizeMessage("acct", { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    payload: { headers: [{ name: "From", value: "news@x.invalid" }, { name: "List-Unsubscribe", value: "<mailto:u@x.invalid>" }, { name: "Subject", value: "Digest" }] } });
  assert.deepEqual(message.signals, { listUnsubscribe: true });
  const placed = triage({ sender: message.from, subject: message.subject, read: message.read, starred: false, labels: message.labels, signals: message.signals });
  assert.equal(`${placed.group}/${placed.importance}`, "newsletters/low");
});


test("people who write from role addresses are people; true no-reply forms are automated (audit F3)", () => {
  assert.equal(place({ sender: "Anna <hello@partner-studio.invalid>", subject: "Re: our call tomorrow" }), "people/important");
  assert.equal(place({ sender: "Ivan <team@acme.invalid>", subject: "Proposal attached" }), "people/important");
  assert.equal(place({ sender: "info@lawfirm.invalid", subject: "Договор на подпись" }), "people/important");
  assert.equal(place({ sender: "support@smallsaas.invalid", subject: "Re: your refund question" }), "people/important");
  assert.equal(place({ sender: "support@bigsaas.invalid", subject: "Weekly digest", signals: { listUnsubscribe: true } }), "newsletters/low", "with a list header a role address is bulk");
  assert.equal(place({ sender: "no_reply@somebank.invalid", subject: "Statement ready" }), "notifications/low");
  assert.equal(place({ sender: "info-noreply@x.invalid", subject: "Hi" }), "notifications/low");
});

test("bounces are alerts that need you; calendar mail is a notification (audit F10, F11)", () => {
  assert.equal(place({ sender: "mailer-daemon@googlemail.invalid", subject: "Delivery Status Notification (Failure)" }), "alerts/important");
  assert.equal(place({ sender: "postmaster@outlook.invalid", subject: "Undeliverable: Invoice" }), "alerts/important");
  assert.equal(place({ sender: "Bob <bob@x.invalid>", subject: "Accepted: Weekly sync @ Mon 10:00" }), "notifications/low");
  // Google Calendar's sender, built from local part and domain as the rule in shared/mail/triage.ts holds it.
  const calendar = ["calendar-notification", "google.com"].join("@");
  assert.equal(place({ sender: calendar, subject: "Updated invitation: Demo" }), "notifications/normal");
  assert.equal(place({ sender: `Google Calendar <${calendar}>`, subject: "Demo on Friday" }), "notifications/normal", "the sender alone is enough");
  assert.notEqual(place({ sender: "calendar-notification@example.com", subject: "Demo on Friday" }), "notifications/normal", "the same local part elsewhere is not Calendar");
  assert.equal(place({ sender: "googleplay-noreply@google.com", subject: "Google Play Console: action required, policy issue" }), "stores/important");
});

test("Russian mail is sorted too, and a Russian word is matched whole (audit F12)", () => {
  assert.equal(place({ sender: "noreply@bank.invalid", subject: "Платёж не прошёл" }), "billing/important");
  assert.equal(place({ sender: "noreply@x.invalid", subject: "Ваш код для входа: 1234" }), "security/important");
  assert.equal(place({ sender: "noreply@shop.invalid", subject: "Расчёт стоимости доставки" }), "notifications/low", "«счёт» inside «расчёт» is not a bill");
  assert.equal(place({ sender: "noreply@shop.invalid", subject: "Ваш счёт за сентябрь" }), "billing/low");
  assert.equal(place({ sender: "monitor@status.invalid", subject: "Сбой сервиса: API недоступен", signals: { autoSubmitted: "auto-generated" } }), "alerts/important", "a Russian outage from a monitor is an alert");
});

test("mail from our own domains is ours, not a person's unread mail, even through a group (audit F13)", () => {
  assert.equal(place({ sender: "routing-test@owner.invalid", subject: "routing test", ownDomains: ["owner.invalid"] }), "internal/normal");
  assert.equal(place({ sender: "ivan@mydomain.invalid", signals: { listId: true }, ownDomains: ["mydomain.invalid"] }), "internal/normal");
  assert.equal(place({ sender: "a@mail.mydomain.invalid", ownDomains: ["mydomain.invalid"], starred: true }), "internal/important", "a star still raises it");
  assert.equal(place({ sender: "mailer-daemon@mydomain.invalid", subject: "Undeliverable", ownDomains: ["mydomain.invalid"] }), "alerts/important", "our own bounce is still a bounce");
});
