// Local synthetic visual fixture. Never connects to a mail provider or sends mail.
import http from "node:http";
const accounts = [
  {
    id: "cloudflare:hello@example.com",
    provider: "cloudflare",
    email: "hello@example.com",
    name: "Studio",
    status: "connected",
  },
  {
    id: "gmail:personal-fixture",
    provider: "gmail",
    email: "alex@example.com",
    name: "Personal",
    status: "connected",
  },
  {
    id: "cloudflare:work@example.org",
    provider: "cloudflare",
    email: "work@example.org",
    name: "Fabric",
    status: "connected",
  },
];
// PREVIEW_MANY=1: an owner with many domains, long names and a few addresses each (the sidebar with 30 domains).
if (process.env.PREVIEW_MANY === "1") {
  const names = ["acme.example", "bulk-messages-and-notifications.example", "data-checks-analytics.example", "fabric-project.example",
    "support-desk-for-a-long-product-name.example", "prompt-arena.example", "acme-very-long-product-name-for-testing.example", "studio.example",
    "billing-and-invoices.example", "northwind.example", "contoso-support.example", "fabrikam.example", "tailspin-toys.example", "wingtip.example",
    "adventure-works.example", "litware.example", "proseware.example", "lucerne-publishing.example", "margies-travel.example",
    "coho-vineyard.example", "fourth-coffee.example", "graphic-design-institute.example", "humongous-insurance.example", "relecloud.example",
    "southridge-video.example", "trey-research.example", "woodgrove-bank.example", "alpine-ski-house.example", "blue-yonder-airlines.example",
    "city-power-and-light.example", "consolidated-messenger.example", "datum-corporation.example"];
  for (const [i, d] of names.entries()) for (const local of i % 3 ? ["hello", "support"] : ["hello", "support", "billing", "no-reply-notifications"])
    accounts.push({ id: `cloudflare:${local}@${d}`, provider: "cloudflare", email: `${local}@${d}`, name: "", status: "connected", unread: (i * 7 + local.length) % 5 === 0 ? (i % 9) + 1 : 0, total: local === "no-reply-notifications" ? 0 : 3 });
}
const rows = [
  [
    "Maya Chen",
    "A few thoughts on the new direction",
    "The quieter layout is working. I left a few notes on the account switcher.",
    0,
  ],
  [
    "Linear",
    "Your team’s weekly update",
    "Here’s what moved forward this week. Three projects, one shared view.",
    2,
  ],
  [
    "Jordan Lee",
    "Thursday works for me",
    "Let’s keep the morning free and catch up after lunch.",
    1,
  ],
  [
    "Figma",
    "A comment on Inbox / Workbench",
    "Maya mentioned you in a comment: the sender identity should stay visible.",
    0,
  ],
  [
    "Sam Rivera",
    "Invoice for September",
    "The invoice is attached. Thanks again for the thoughtful collaboration.",
    2,
  ],
  [
    "Newsletter <news@example.net>",
    "Small tools, thoughtful work",
    "A few things worth reading over the weekend.",
    1,
  ],
  [
    "GitHub <noreply@github.com>",
    "[passioncode-ai/fabric-inbox] Run failed: CI - main",
    "The workflow run failed on main at the test step.",
    2,
  ],
  [
    "Stripe <noreply@stripe.com>",
    "Payment failed for Fabric Pro",
    "We could not charge the card ending 4242. Update your payment method.",
    0,
  ],
  [
    "App Store Connect <no-reply@email.apple.com>",
    "App Store Connect: Your submission was rejected",
    "Guideline 2.1 — information needed. Reply in App Store Connect.",
    2,
  ],
  [
    "Google <no-reply@accounts.google.com>",
    "Security alert: new sign-in on Mac",
    "A new sign-in to your account was detected.",
    1,
  ],
  [
    "Product Hunt <noreply@producthunt.com>",
    "Top products this week",
    "Seven launches the community loved.",
    1,
  ],
  [
    "Stripe <no-reply@stripe.com>",
    "Your receipt from Cloudflare",
    "Receipt #2291 for your Workers Paid plan.",
    0,
  ],
];
let messages = rows.map(([sender, subject, snippet, a], i) => ({
  id: JSON.stringify([accounts[a].id, "message-" + i]),
  accountId: accounts[a].id,
  provider: accounts[a].provider,
  providerMessageId: "message-" + i,
  subject,
  sender: sender.includes("<") ? sender : sender + " <sender" + i + "@example.com>",
  recipient: accounts[a].email,
  date: new Date(Date.now() - i * 3600000).toISOString(),
  read: i > 1 && i < 6,
  starred: i === 0,
  snippet,
  folder: "inbox",
  threadId: "thread-" + i,
}));
// S02 (B-268): a message with Cc and a long To list, one whose Reply-To differs, one sent to a list we are not named on.
Object.assign(messages[2], { cc: "Sam Park <sam@example.net>, Kim Ito <kim@example.net>", recipient: "hello@example.com, Ana <ana@example.net>, Bo <bo@example.net>, Cy <cy@example.net>, Di <di@example.net>" });
Object.assign(messages[4], { raw_headers: JSON.stringify([{ key: "reply-to", value: "Billing desk <billing@other.example>" }, { key: "list-id", value: "" }].slice(0, 1)) });
Object.assign(messages[5], { recipient: "readers@example.net", raw_headers: JSON.stringify([{ key: "from", value: "Newsletter <news@example.net>" }]) });
// B-138: a conversation the reply agent answered, then a newer message nobody answered; and marks.
const STATES = { "message-0": "new_after_agent", "message-3": "agent_replied", "message-7": "error" };
for (const m of messages) if (STATES[m.providerMessageId]) m.agentState = STATES[m.providerMessageId];
messages[0].threadCount = 4;
const OPEN_STATES = ["unanswered", "new_after_agent", "error", "needs_data", "agent_draft"];
const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
const conversation = [
  { id: "c1", folder_id: "inbox", sender: "maya@example.com", sender_name: "Maya Chen", recipient: "hello@example.com", date: at(30), subject: "A few thoughts on the new direction", thread_id: "thread-0", read: 1,
    body: "<p>Hi! How do I move my workspace to the new plan?</p><p>Maya</p>", agent_run: { id: "agent-" + "a".repeat(32), status: "sent", agentId: "support" } },
  { id: "c2", folder_id: "sent", sender: "hello@example.com", recipient: "maya@example.com", date: at(29), subject: "Re: A few thoughts on the new direction", thread_id: "thread-0", read: 1, sent_by: "agent",
    body: "<p>Hello Maya,</p><p>Open Settings, then Plan, and choose the new plan. Your workspace moves with everything in it.</p><p>Studio support</p>" },
  { id: "c3", folder_id: "inbox", sender: "maya@example.com", sender_name: "Maya Chen", recipient: "hello@example.com", date: at(5), subject: "Re: A few thoughts on the new direction", thread_id: "thread-0", read: 1,
    body: "<p>Thanks. I did that, but the old invoices are gone. Where are they now?</p>" },
  { id: "message-0", folder_id: "inbox", sender: "maya@example.com", sender_name: "Maya Chen", recipient: "hello@example.com", date: messages[0].date, subject: messages[0].subject, thread_id: "thread-0", read: 0,
    body: "<p>The quieter layout is working. I left a few notes on the account switcher.</p><p>Synthetic preview message, not real mail.</p>" },
];
// S05 (B-221): reply headers, a quoted history, and a reply to an earlier message (nested).
Object.assign(conversation[0], { message_id: "<c1@example.com>", cc: "Kim Ito <kim@example.net>" });
Object.assign(conversation[1], { message_id: "<c2@example.com>", in_reply_to: "<c1@example.com>" });
Object.assign(conversation[2], { message_id: "<c3@example.com>", in_reply_to: "<c2@example.com>",
  body: conversation[2].body + '<div class="gmail_quote"><div class="gmail_attr">On Thu, Maya Chen wrote:</div><blockquote>Open Settings, then Plan, and choose the new plan.</blockquote></div>' });
Object.assign(conversation[3], { message_id: "<m0@example.com>", in_reply_to: "<c1@example.com>" });
// ── W4 audit of the mail window (S03, S04, S06, S07, S09, S10, S11): safety records, agent drafts, files, sent mail. ──
// Synthetic only. Every write below changes this process's memory and nothing else.
const NOW = Date.now();
const fixture = { draftPut: "ok" };
const KiB = 1024, MiB = 1024 * 1024;
const checkOf = (over = {}) => ({ version: 1, checkedAt: NOW - 3600000, feedVersion: 7, scope: "received", signals: [], notRun: [], links: [], files: [], contentHash: "fixture", ...over });
const recordOf = (check, state = "clear", findings = {}, top = {}) => ({ state, checkedAt: NOW - 3600000, findings: { ...findings, ...(check ? { check } : {}) }, ...top });
const keyOf = (accountIndex, id) => `${accounts[accountIndex].id.toLowerCase()}|${id}`;
// HTML bodies with links, by message id (S04): a phishing link, a lookalike, a link whose text names another domain, a clean one.
const BODIES = {
  "message-7": '<p>We could not charge your card. <a href="https://stripe-billing.example/update">Update your payment method</a> today.</p><p>Or sign in at <a href="https://strlpe.example/login">strlpe.example</a>.</p><p>Questions: <a href="mailto:help@stripe-billing.example">help@stripe-billing.example</a>. Read our <a href="https://docs.example.com/billing">billing guide</a>.</p><p>Synthetic preview message, not real mail.</p>',
  "message-8": '<p>Your submission needs one more answer. Open <a href="https://tracker.example/r/1">https://appstoreconnect.example/app/1</a> to reply.</p><p>Synthetic preview message, not real mail.</p>',
  "message-9": '<p>A new sign-in to your account was detected. If this was you, nothing is needed. <a href="https://accounts.example.com/security">Review your devices</a>.</p><p>Synthetic preview message, not real mail.</p>',
  "message-3": '<p>Maya mentioned you in a comment. <a href="https://design.example.com/file/1">Open the file</a>.</p><p>Synthetic preview message, not real mail.</p>',
  "message-4": '<p>The invoice is attached, with the statement and the photos from the site visit. <a href="https://acme.example/pay">Pay online</a>.</p><p>Sam</p><p>Synthetic preview message, not real mail.</p>',
};
// S09: message-4 carries five files of real sizes; one red, two amber, two green (S03's file colours).
const FILES = [
  { id: "att-1", filename: "invoice.pdf", mimetype: "application/pdf", size: 30 * KiB, entry: { checked: true, kind: "pe", codes: ["program", "disguised"], colour: "red" } },
  { id: "att-2", filename: "statement.html", mimetype: "text/html", size: 2 * KiB, entry: { checked: true, kind: "html", codes: ["webPage"], colour: "amber" } },
  { id: "att-3", filename: "site-photos.zip", mimetype: "application/zip", size: Math.round(4.5 * MiB), entry: { checked: true, kind: "zip", codes: ["archive"], colour: "amber" } },
  { id: "att-4", filename: "quarterly-report-with-a-long-file-name.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: Math.round(1.2 * MiB), entry: { checked: true, kind: "ooxml", codes: [], colour: "green" } },
  { id: "att-5", filename: "notes.txt", mimetype: "text/plain", size: 1 * KiB, entry: { checked: true, kind: "text", codes: [], colour: "green" } },
];
const DETAIL = { "message-4": { attachments: FILES.map(({ entry, ...a }) => a) } };
const fileEntries = FILES.map((f) => ({ id: f.id, filename: f.filename, size: f.size, ...f.entry }));
const fact = (label, value) => ({ label, value });
const SAFETY = {
  [keyOf(0, "message-0")]: recordOf(checkOf()),
  [keyOf(2, "message-1")]: recordOf(checkOf({ notRun: [{ check: "senderAuth", why: "inboxSkipNotReceiver" }] })),
  [keyOf(1, "message-2")]: recordOf(checkOf({ signals: [{ check: "replyPath", severity: "major", code: "mailSenderReplyElsewhere", facts: [fact("mailFactReplyDomain", "other.example")] }] })),
  [keyOf(2, "message-4")]: recordOf(checkOf({ files: fileEntries, links: [{ url: "https://acme.example/pay", host: "acme.example" }],
    signals: [{ check: "attachments", severity: "critical", code: "inboxFileDisguised", facts: [fact("inboxFactFile", "invoice.pdf")] },
      { check: "attachments", severity: "major", code: "inboxFileRisky", facts: [fact("inboxFactFile", "statement.html")] }] })),
  [keyOf(1, "message-5")]: recordOf(checkOf({ notRun: [{ check: "senderAuth", why: "inboxSkipNotReceiver" }] })),
  [keyOf(0, "message-7")]: recordOf(checkOf({
    links: [{ url: "https://stripe-billing.example/update", host: "stripe-billing.example", why: "phishing" }, { url: "https://strlpe.example/login", host: "strlpe.example", why: "lookalike", resembles: "stripe.com" }, { url: "https://docs.example.com/billing", host: "docs.example.com" }],
    signals: [{ check: "links", severity: "critical", code: "inboxLinkPhishing", facts: [fact("mailFactAddress", "stripe-billing.example")] },
      { check: "links", severity: "critical", code: "inboxLinkLookalike", facts: [fact("mailFactAddress", "strlpe.example"), fact("mailFactResembles", "stripe.com")] },
      { check: "senderIdentity", severity: "critical", code: "mailSenderBrandMismatch", facts: [fact("mailFactDisplayName", "Stripe"), fact("mailFactAddress", "billing-notice.example")] }],
    review: { version: 1, ran: true, codes: ["looks_like_phishing", "urgent_payment"], quotes: ["We could not charge your card."], contentHash: "fixture", at: NOW - 3600000 } }), "clear", { phishing: [{ host: "stripe-billing.example" }] }),
  [keyOf(2, "message-8")]: recordOf(checkOf({ links: [{ url: "https://tracker.example/r/1", host: "tracker.example", why: "textMismatch", shown: "appstoreconnect.example" }],
    signals: [{ check: "links", severity: "major", code: "inboxLinkTextMismatch", facts: [fact("inboxFactShown", "appstoreconnect.example"), fact("mailFactAddress", "tracker.example")] }] })),
  [keyOf(1, "message-9")]: recordOf(checkOf({ links: [{ url: "https://accounts.example.com/security", host: "accounts.example.com" }] })),
  [keyOf(1, "message-10")]: recordOf(checkOf({ links: [{ url: "https://launch-deals.example/claim", host: "launch-deals.example", why: "phishing" }],
    signals: [{ check: "links", severity: "critical", code: "inboxLinkPhishing", facts: [fact("mailFactAddress", "launch-deals.example")] }] }), "held", { phishing: [{ host: "launch-deals.example" }] }, { reason: "phishing", review: null }),
  [keyOf(0, "message-11")]: recordOf(checkOf({ signals: [{ check: "hidden", severity: "major", code: "inboxModelFlagged" }], review: { version: 1, ran: false, why: "budget", codes: [], quotes: [], contentHash: "fixture", at: NOW - 3600000 } }), "released", { model: true }, { decidedBy: "review", decidedAt: NOW - 1800000 }),
  // S05 events: a reply in thread-0 the safety review released.
  [keyOf(0, "c3")]: recordOf(checkOf({ signals: [{ check: "hidden", severity: "major", code: "inboxModelFlagged" }] }), "released", { model: true }, { decidedBy: "review", decidedAt: NOW - 4 * 3600000 }),
};
// message-3 has no record and its open-time check answers none ("Not checked"); message-6 is checked on open.
const OPEN_CHECK = { [keyOf(2, "message-6")]: recordOf(checkOf({ links: [] }), "clear", {}, { decidedBy: "open" }) };
for (const m of messages) {
  const r = SAFETY[`${m.accountId.toLowerCase()}|${m.providerMessageId}`];
  if (r?.findings.check) m.safety = { colour: "fixture", checkedAt: r.findings.check.checkedAt };
}
const product = messages.find((m) => m.providerMessageId === "message-10");
product.held = { reason: "phishing", verdict: null, links: ["launch-deals.example"] };
// S02: a message we sent with a Bcc (Sent folder).
messages.push({ id: JSON.stringify([accounts[0].id, "sent-1"]), accountId: accounts[0].id, provider: "cloudflare", providerMessageId: "sent-1",
  subject: "The plan for next week", sender: "Studio <hello@example.com>", recipient: "Maya Chen <maya@example.com>", cc: "Kim Ito <kim@example.net>",
  bcc: "records@owner.example, Ana Ruiz <ana@acme.example>", folder_id: "sent", date: at(3), read: true, starred: false,
  snippet: "Here is the plan we agreed on.", folder: "sent", threadId: "thread-sent-1" });
// S06, S07: two threads with reply agents' drafts on hello@example.com.
const draftA = "agent-" + "b".repeat(32) + "-draft", draftB = "agent-" + "c".repeat(32) + "-draft", draftE = "agent-" + "e".repeat(32) + "-draft";
const runA = { id: "agent-" + "b".repeat(32), status: "drafted", agentId: "support", agentVersion: 3, draftId: draftA, grounded: true, sources: [{ ref: "billing/refunds#2", title: "Refunds policy" }] };
const runB = { id: "agent-" + "c".repeat(32), status: "drafted", agentId: "support", agentVersion: 3, draftId: draftB, grounded: false, sources: [] };
const drafts = {
  [draftA]: { id: draftA, revision: 1, to: "ana@acme.example", cc: null, bcc: null, subject: "Re: Where is my refund?", body: "<p>Hello Ana,</p><p>Your refund was sent on Monday. It reaches your card in 5 to 10 working days.</p><p>Studio support</p>", inReplyTo: "d1", threadId: "thread-agent" },
  [draftB]: { id: draftB, revision: 1, to: "ana@acme.example", cc: null, bcc: null, subject: "Re: Where is my refund?", body: "<p>Hello Ana,</p><p>Yes, you can change the card in Settings, then Billing.</p><p>Studio support</p>", inReplyTo: "d2", threadId: "thread-agent" },
};
const agentThread = [
  { id: "d1", folder_id: "inbox", sender: "ana@acme.example", sender_name: "Ana Ruiz", recipient: "hello@example.com", date: at(8), subject: "Where is my refund?", thread_id: "thread-agent", read: 1, message_id: "<d1@acme.example>",
    body: "<p>Hello, I returned the order two weeks ago. Where is my refund?</p><p>Ana</p>", agent_run: runA },
  { id: draftA, folder_id: "draft", sender: "hello@example.com", recipient: "ana@acme.example", date: at(7.9), subject: "Re: Where is my refund?", thread_id: "thread-agent", read: 1, in_reply_to: "d1", body: drafts[draftA].body, agent_run: runA },
  { id: "d2", folder_id: "inbox", sender: "ana@acme.example", sender_name: "Ana Ruiz", recipient: "hello@example.com", date: at(2), subject: "Re: Where is my refund?", thread_id: "thread-agent", read: 0, message_id: "<d2@acme.example>", in_reply_to: "<d1@acme.example>",
    body: "<p>Also, can I change the card the refund goes to?</p><p>Ana</p>", agent_run: runB },
  { id: draftB, folder_id: "draft", sender: "hello@example.com", recipient: "ana@acme.example", date: at(1.9), subject: "Re: Where is my refund?", thread_id: "thread-agent", read: 1, in_reply_to: "d2", body: drafts[draftB].body, agent_run: runB },
];
const runE1 = { id: "agent-" + "d".repeat(32), status: "drafted", agentId: "support", agentVersion: 2, draftId: "agent-" + "d".repeat(32) + "-draft", outcome: { kind: "answered_by_person", at: at(20) }, draftKept: true };
const runE3 = { id: "agent-" + "e".repeat(32), status: "drafted", agentId: "support", agentVersion: 2, draftId: draftE, outcome: { kind: "answered_by_person", at: at(10), edited: true } };
const editedThread = [
  { id: "e1", folder_id: "inbox", sender: "lee@acme.example", sender_name: "Lee Park", recipient: "hello@example.com", date: at(26), subject: "Delivery to another address", thread_id: "thread-edited", read: 1, message_id: "<e1@acme.example>", body: "<p>Can you deliver to my office instead?</p>", agent_run: runE1 },
  { id: "e2", folder_id: "sent", sender: "hello@example.com", recipient: "lee@acme.example", date: at(20), subject: "Re: Delivery to another address", thread_id: "thread-edited", read: 1, message_id: "<e2@example.com>", in_reply_to: "<e1@acme.example>", sent_by: "person", body: "<p>Yes, send me the address and I will change it.</p>" },
  { id: "e3", folder_id: "inbox", sender: "lee@acme.example", sender_name: "Lee Park", recipient: "hello@example.com", date: at(12), subject: "Re: Delivery to another address", thread_id: "thread-edited", read: 1, message_id: "<e3@acme.example>", in_reply_to: "<e2@example.com>", body: "<p>It is 1 Main Street, Springfield.</p>", agent_run: runE3 },
  { id: draftE, folder_id: "draft", sender: "hello@example.com", recipient: "lee@acme.example", date: at(11.9), subject: "Re: Delivery to another address", thread_id: "thread-edited", read: 1, in_reply_to: "e3", body: "<p>Thanks Lee, changed (edited by a person).</p>", agent_run: runE3 },
  { id: "e4", folder_id: "sent", sender: "hello@example.com", recipient: "lee@acme.example", date: at(10), subject: "Re: Delivery to another address", thread_id: "thread-edited", read: 1, message_id: "<e4@example.com>", in_reply_to: "<e3@acme.example>", sent_by: "person", body: "<p>Done, it goes to your office.</p>" },
];
const threads = { "thread-agent": agentThread, "thread-edited": editedThread };
const rowOf = (e) => ({ id: JSON.stringify([accounts[0].id, e.id]), accountId: accounts[0].id, provider: "cloudflare", providerMessageId: e.id, subject: e.subject,
  sender: `${e.sender_name ?? ""} <${e.sender}>`.trim(), recipient: e.recipient, date: e.date, read: !!e.read, starred: false, snippet: e.body.replace(/<[^>]+>/g, " ").trim().slice(0, 120),
  folder: "inbox", threadId: e.thread_id, threadCount: threads[e.thread_id].length, ...(e.agent_run ? { agentRun: e.agent_run } : {}) });
messages.unshift(rowOf(agentThread[2]));
messages.push(rowOf(editedThread[2]));
const runDetails = (run) => ({ ...run, reason: "draft_mode", toolCalls: [{ name: "search_knowledge", ok: true }, { name: "read_thread", ok: true }], model: "fixture-model", checkedBy: "fixture-checker", draftTextComplete: !!run.draftKept });
const allRuns = [runA, runB, runE1, runE3];
/** A card's send: the draft becomes the sent reply; an earlier untouched sibling of the same thread retires (S07). */
function sendDraft(id) {
  const list = threads["thread-agent"];
  const at0 = list.findIndex((e) => e.id === id);
  if (at0 < 0) return false;
  const e = list[at0];
  const run = e.agent_run;
  Object.assign(e, { folder_id: "sent", sent_by: "person", message_id: `<${id}@example.com>`, in_reply_to: `<${e.in_reply_to}@acme.example>`, date: new Date().toISOString() });
  run.outcome = { kind: "approved_by_person", at: new Date().toISOString(), sentMessageId: id };
  for (const other of [runA, runB]) if (other !== run && !other.outcome) {
    other.outcome = { kind: "answered_by_person", at: new Date().toISOString() };
    other.draftKept = true;
    const i = list.findIndex((x) => x.id === other.draftId);
    if (i >= 0) list.splice(i, 1);
  }
  for (const m of messages) if (m.agentRun && (m.agentRun === run || m.agentRun.id === run.id)) m.agentRun = run;
  return true;
}
const DOMAINS = { connected: true, account: "Acme", accounts: [{ id: "acct-1", name: "Acme", server: true, via: "server", shown: true, choice: "shown", domains: 2, served: 2 }], problems: [], permissions: [], accountPermissions: [], tokenUrl: "https://dash.cloudflare.example/profile/api-tokens",
  domains: [{ name: "example.com", zoneId: "zone-1", status: "active", routing: "enabled", addresses: 2 }, { name: "example.org", zoneId: "zone-2", status: "active", routing: "enabled", addresses: 1 }] };
const ADDRESSES = { domains: [{ domain: "example.com", unknownAddressPolicy: "reject", catchAll: null }, { domain: "example.org", unknownAddressPolicy: "reject", catchAll: null }],
  routingConfigured: true, addresses: [{ email: "hello@example.com", name: "Studio" }, { email: "work@example.org", name: "Fabric" }], unknownRecipients: [], incomingFailures: [] };
const ACCOUNT_LIST = { configuration: "ready", accounts: [{ id: "personal-fixture", email: "alex@example.com", status: "connected", provider: "gmail", providerName: "Gmail", lastSyncAt: NOW - 600000 }], providers: [{ id: "gmail", status: "ready" }] };
async function bodyOf(req) { let raw = ""; for await (const chunk of req) raw += chunk; try { return JSON.parse(raw || "{}"); } catch { return {}; } }
/** The mail window's audit routes. Returns true when it answered. */
async function auditRoute(req, res, url) {
  const json = (v, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(v)); return true; };
  const path = decodeURIComponent(url.pathname);
  if (path === "/api/__fixture/set") { for (const [k, v] of url.searchParams) fixture[k] = v; return json(fixture); }
  if (path === "/api/safety/lookup" && req.method === "POST") {
    const { keys = [] } = await bodyOf(req);
    const records = {};
    for (const k of keys) { const id = `${String(k.accountId).toLowerCase()}|${k.messageId}`; if (SAFETY[id]) records[id] = SAFETY[id]; }
    return json({ records, feedVersion: 7 });
  }
  if (path === "/api/safety/check" && req.method === "POST") {
    const b = await bodyOf(req);
    const id = `${String(b.accountId).toLowerCase()}|${b.messageId}`;
    if (OPEN_CHECK[id]) SAFETY[id] = OPEN_CHECK[id];
    return json({ record: SAFETY[id] ?? null, feedVersion: 7 });
  }
  if (path === "/api/safety/decide" && req.method === "POST") return json({ state: "released" });
  if (/^\/api\/v1\/mailboxes\/[^/]+\/threads\/[^/]+\/read$/.test(path) && req.method === "POST") { await bodyOf(req); return json({ ok: true }); }
  for (const [tid, list] of Object.entries(threads))
    if (path === `/api/v1/mailboxes/hello@example.com/threads/${tid}`) return json(list);
  let m = /^\/api\/v1\/mailboxes\/hello@example\.com\/drafts\/([^/]+)(\/send)?$/.exec(path);
  if (m) {
    const d = drafts[m[1]];
    if (!d) return json({ error: "Not found", code: "draft_not_found" }, 404);
    if (m[2] && req.method === "POST") { await bodyOf(req); return sendDraft(m[1]) ? json({ id: m[1], status: "sent" }) : json({ code: "draft_gone" }, 409); }
    if (req.method === "PUT") {
      const b = await bodyOf(req);
      if (fixture.draftPut === "gone") return json({ error: "This draft was removed because a reply was sent.", code: "draft_gone" }, 409);
      if (fixture.draftPut === "conflict") { d.revision += 1; d.body = "<p>Hello Ana, (a newer text saved on another device)</p>"; return json({ error: "A newer version of this draft was saved elsewhere.", code: "draft_conflict" }, 409); }
      if (fixture.draftPut === "failed") return json({ error: "The server could not save it." }, 500);
      if (b.expected_revision !== d.revision) return json({ code: "draft_conflict" }, 409);
      d.revision += 1; d.body = b.body;
      const row = threads["thread-agent"].find((e) => e.id === m[1]); if (row) row.body = b.body;
      return json({ id: d.id, revision: d.revision });
    }
    return json(d);
  }
  m = /^\/api\/agent-runs\/([^/]+)(\/(discard-draft|redraft|tuning|again))?$/.exec(path);
  if (m) {
    const run = allRuns.find((r) => r.id === m[1]);
    if (!run) return json({ error: "Not found" }, 404);
    if (m[3] === "tuning") return json({ agent: { instructions: "Answer customers of Studio from the knowledge only.", replyPolicy: "draft" }, knowledge: [{ title: "Refunds policy", text: "Refunds are sent within 2 days and reach the card in 5 to 10 working days." }] });
    if (m[3] === "discard-draft" && req.method === "POST") {
      run.outcome = { kind: "superseded", at: new Date().toISOString() }; run.draftKept = true;
      for (const list of Object.values(threads)) { const i = list.findIndex((x) => x.id === run.draftId); if (i >= 0) list.splice(i, 1); }
      return json({ ok: true });
    }
    if (m[3] === "redraft" && req.method === "POST") { await bodyOf(req); run.personDraftId = "person-" + run.id; return json({ id: run.personDraftId }); }
    if (!m[3]) return json(runDetails(run));
  }
  // S02: a Gmail message's stored headers; the newsletter carries a List-Id (no "not in To or Cc" line).
  m = /^\/api\/accounts\/[^/]+\/messages\/([^/]+)\/headers$/.exec(path);
  if (m) return json({ headers: [{ key: "From", value: "fixture" }, ...(m[1] === "message-5" ? [{ key: "List-Id", value: "Weekend reading <news.example.net>" }] : [])] });
  if (/^\/api\/agents\/[^/]+$/.test(path)) return json({ id: "support", name: "Support desk", version: 3 });
  // Files of message-4 (S09): real bytes of each declared size.
  m = /^\/api\/v1\/mailboxes\/work@example\.org\/emails\/message-4\/attachments\/([^/]+)$/.exec(path);
  if (m) { const f = FILES.find((x) => x.id === m[1]); if (!f) return json({ error: "Not found" }, 404); res.writeHead(200, { "Content-Type": f.mimetype, "Content-Length": f.size }); res.end(Buffer.alloc(f.size, 65)); return true; }
  // S10: a test run and saving a rule.
  if (/^\/api\/automation\/[^/]+\/dry-run$/.test(path) && req.method === "POST") {
    const b = await bodyOf(req);
    const matched = String(b.emailId) === "message-4";
    return json({ matched, analysis: { matches: matched, summary: matched ? "The subject contains invoice." : "The subject does not contain invoice.", draft: "" }, action: b.rule?.action ?? { type: "archive" }, executed: false });
  }
  if (/^\/api\/automation\/[^/]+\/rules$/.test(path) && req.method === "PUT") { const b = await bodyOf(req); return json({ ...b, id: b.id ?? "r-new", version: (b.version ?? 0) + 1 }); }
  if (/^\/api\/automation\/[^/]+\/runs\/[^/]+\/(approve|dismiss|check)$/.test(path) && req.method === "POST") return json({ ok: true });
  // S11: this server's settings lists.
  if (path === "/api/accounts") return json(ACCOUNT_LIST);
  if (path === "/api/project-addresses") return json(ADDRESSES);
  if (path === "/api/domains") return json(DOMAINS);
  if (path === "/api/agents") return json({ agents: [{ id: "support", name: "Support desk", version: 3, enabled: true }] });
  return false;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    const proxy = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(process.env.PREVIEW_TARGET_PORT || 5174),
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: "127.0.0.1:" + (process.env.PREVIEW_TARGET_PORT || 5174),
        },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    proxy.on("error", () => {
      res.writeHead(502);
      res.end("Start npm run dev -- --port 5174 first");
    });
    req.pipe(proxy);
    return;
  }
  if (await auditRoute(req, res, url)) return;
  res.setHeader("Content-Type", "application/json");
  const json = (v) => res.end(JSON.stringify(v));
  // Opt-in state changes stay in this process and never call a real provider.
  if (process.env.PREVIEW_ACTIONS === "1" && req.method !== "GET") {
    const parts = url.pathname.split("/").map(decodeURIComponent);
    const gmail = parts[2] === "accounts";
    const accountId = gmail ? "gmail:" + parts[3] : "cloudflare:" + parts[4];
    const messageId = gmail ? parts[5] : parts[6];
    const action = gmail ? parts[6] : parts[7];
    const message = messages.find(m => m.accountId === accountId && m.providerMessageId === messageId);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (message && body && ((gmail && ["starred", "trashed", "read", "archive"].includes(action)) || (!gmail && (!action || action === "move")))) {
      if (typeof body.starred === "boolean") message.starred = body.starred;
      if (typeof body.read === "boolean") message.read = body.read;
      if (typeof body.trashed === "boolean") message.folder = body.trashed ? "trash" : "inbox";
      if (action === "archive") message.folder = "archive";
      if (action === "move" && ["inbox", "archive", "trash"].includes(body.folderId)) message.folder = body.folderId;
      json({ ...message, labels: [...(message.starred ? ["STARRED"] : []), ...(message.folder === "inbox" ? ["INBOX"] : [])], fixture: true });
      return;
    }
  }
  if (req.method !== "GET") {
    res.statusCode = 400;
    json({
      error:
        "Synthetic preview only. No mail was sent. Connect your own server for actions.",
      fixture: true,
    });
    return;
  }
  // S10 (B-275): one address's rules, runs and outbox for the rules screen.
  if (url.pathname.startsWith("/api/automation/") && url.pathname.endsWith("/rules")) {
    json(process.env.PREVIEW_NO_RULES === "1" ? [] : [
      { id: "r1", version: 3, name: "Invoices", enabled: true, mode: "approval", conditions: { from: "billing@acme.example", subject: "invoice" },
        action: { type: "forward", to: "accounts@owner.example" }, dailyLimit: 20 },
      { id: "r2", version: 1, name: "Newsletters", enabled: false, mode: "automatic", conditions: { ai: "a newsletter or a product digest" },
        action: { type: "archive" }, dailyLimit: 50 },
    ]);
    return;
  }
  if (url.pathname.startsWith("/api/automation/") && url.pathname.endsWith("/runs")) {
    const rule = { id: "r1", version: 3, name: "Invoices", enabled: true, mode: "approval", conditions: { from: "billing@acme.example", subject: "invoice" }, action: { type: "forward", to: "accounts@owner.example" }, dailyLimit: 20 };
    json([
      { id: "run1", key: "k1", account: "hello@example.com", emailId: "message-4", subject: "Invoice for September", rule, status: "waiting_approval", createdAt: at(1), updatedAt: at(1), attempts: 1, actions: [] },
      { id: "run2", key: "k2", account: "hello@example.com", emailId: "message-9", subject: "Invoice for August", rule, status: "succeeded", createdAt: at(30), updatedAt: at(30), attempts: 1, actions: [] },
      // S05 events: the rule forwarded a message of thread-0.
      { id: "run3", key: "k3", account: "hello@example.com", emailId: "c3", subject: "Re: A few thoughts on the new direction", rule, status: "succeeded", createdAt: at(4.5), updatedAt: at(4.5), attempts: 1, actions: [] },
    ]);
    return;
  }
  if (url.pathname.endsWith("/outbox")) {
    json([]);
    return;
  }
  if (url.pathname === "/api/agent-status") {
    json({ enabled: false, domains: { "example.com": true }, addresses: {} });
    return;
  }
  if (decodeURIComponent(url.pathname) === "/api/v1/mailboxes/hello@example.com/threads/thread-0") {
    json(conversation);
    return;
  }
  if (url.pathname === "/api/inbox") {
    const reply = url.searchParams.get("reply");
    if (reply) {
      const wanted = reply === "open" ? OPEN_STATES : [reply];
      const replyCounts = {};
      for (const m of messages) if (m.agentState) replyCounts[m.agentState] = (replyCounts[m.agentState] ?? 0) + 1;
      json({ accounts, messages: messages.filter((m) => wanted.includes(m.agentState)), issues: [], hasMore: false, replyCounts });
      return;
    }
    let filtered = messages.filter(
      (m) =>
        (!url.searchParams.get("account") ||
          m.accountId === url.searchParams.get("account")) &&
        (url.searchParams.get("folder") === "starred"
          ? m.starred
          : m.folder === (url.searchParams.get("folder") || "inbox")) &&
        (url.searchParams.get("unread") !== "1" || !m.read) &&
        (m.subject + " " + m.snippet + " " + m.sender)
          .toLowerCase()
          .includes((url.searchParams.get("query") || "").toLowerCase()),
    );
    json({ accounts, messages: filtered, issues: [], hasMore: false });
    return;
  }
  const id = url.pathname.split("/").at(-1);
  // A message of the audit threads opened from its cell.
  const inThread = Object.values(threads).flat().find((e) => e.id === id);
  if (inThread && !messages.some((x) => x.providerMessageId === id)) { json({ ...inThread, attachments: [] }); return; }
  const m = messages.find((m) => m.providerMessageId === id);
  if (m) {
    const text = `Hi Alex,\n\n${m.snippet}\n\nThe three-column view makes it much easier to see what needs attention. I can scan all my accounts, then narrow the same list without losing my place.\n\nA few details to keep in mind:\n• Keep the account visible on every message.\n• Let the content have room to breathe.\n• Make the next action easy to find.\n\nLet me know what you think.\n\n${m.sender.split(" <")[0]}\n\nSynthetic preview message — not real mail.`;
    json(
      m.provider === "gmail"
        ? {
            ...m,
            from: m.sender,
            to: m.recipient,
            text,
            ...(process.env.PREVIEW_HTML === "1" ? {
              text: "",
              html: '<p>Synthetic HTML message for privacy checks. <a href="https://example.com/phish" target="_top">A link that asks for the top window</a></p><img src="https://example.com/fabric-inbox-synthetic-image.png" alt="Synthetic external image">',
            } : {}),
            labels: ["INBOX"],
            attachments: [],
            ...(BODIES[m.providerMessageId] ? { html: BODIES[m.providerMessageId], text: "" } : {}),
          }
        : {
            ...m,
            body: BODIES[m.providerMessageId] ?? "<p>" + text.replaceAll("\n", "</p><p>") + "</p>",
            attachments: [],
            ...DETAIL[m.providerMessageId],
          },
    );
    return;
  }
  res.writeHead(404);
  json({ error: "fixture_route_not_found" });
});
server.listen(Number(process.env.FIXTURE_PORT || 5175), "127.0.0.1", () =>
  console.log(
    "Synthetic UI fixture on port " +
      (process.env.FIXTURE_PORT || 5175) +
      " (no real mail)",
  ),
);
