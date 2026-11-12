// B-246 D-1 (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md): grants for agents and people, today's levels as bundles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allows, canonicalMailbox, capabilitiesOn, grantsOfKey, grantsOfMember, isSubset, type Grant } from "../workers/mcp/grants";

const key = (over: Record<string, unknown> = {}) => ({ id: "k1", level: "mail" as const, send: "send" as const, dailySendLimit: 50, accounts: null as string[] | null, expiresAt: null as string | null, ...over });
const A = "cloudflare:sales@acme.example";
const B = "cloudflare:support@acme.example";
const OTHER = "cloudflare:x@other.example";

test("a Read key reads its mailboxes and changes nothing; a Mail key does what it did; an Admin key acts on the server", () => {
  const read = grantsOfKey(key({ level: "read", accounts: [A] }));
  assert.equal(allows(read, A, "read"), true);
  for (const c of ["draft", "send", "organize", "delete", "create"] as const) assert.equal(allows(read, A, c), false, c);
  assert.equal(allows(read, B, "read"), false, "only its mailbox");
  const mail = grantsOfKey(key());
  for (const c of ["read", "draft", "send", "organize", "delete", "campaign"] as const) assert.equal(allows(mail, B, c), true, c);
  for (const c of ["create", "remove", "agents"] as const) assert.equal(allows(mail, B, c), false, c);
  assert.equal(allows(mail, null, "read"), true, "a key with no limit reaches the whole server");
  const admin = grantsOfKey(key({ level: "admin" }));
  assert.equal(allows(admin, null, "create"), true);
  assert.equal(grantsOfKey(key({ level: "admin", accounts: [A] })).length, 0, "a limited Admin key reaches nothing, as today");
});

test("the old controls travel with the grant: drafts-only, the daily cap, the owner's approval, the end (R-1)", () => {
  const [g] = grantsOfKey(key({ send: "drafts", dailySendLimit: 7, approval: "owner", expiresAt: "2027-01-01T00:00:00Z" }));
  assert.deepEqual(g.limits, { sendMode: "drafts", dailySendLimit: 7, ownerApproval: true });
  assert.equal(g.expiresAt, "2027-01-01T00:00:00Z");
  assert.equal(allows([g], A, "read", new Date("2027-02-01T00:00:00Z")), false, "an ended grant gives nothing");
  assert.equal(grantsOfKey(key({ level: "admin", send: "drafts" }))[0].limits.sendMode, "send", "an Admin key always sends, as today");
});

test("a member's levels become a grant per level; an administrator holds everything", () => {
  const member = grantsOfMember({ email: "Ann@acme.example", role: "member", accounts: [A, B], levels: { [A]: "read" } });
  assert.equal(allows(member, A, "read"), true);
  assert.equal(allows(member, A, "send"), false, "read on A");
  assert.equal(allows(member, B, "send"), true, "send is the default level");
  assert.equal(allows(member, B, "agents"), false);
  assert.deepEqual(capabilitiesOn(grantsOfMember({ email: "a@acme.example", role: "member", accounts: [A], levels: { [A]: "agents" } }), A), ["read", "draft", "send", "organize", "agents"]);
  assert.equal(allows(grantsOfMember({ email: "boss@acme.example", role: "admin", accounts: null }), null, "remove"), true);
  assert.equal(member[0].holder.kind === "person" && member[0].holder.email, "ann@acme.example");
});

test("a domain covers its addresses and no other; * covers the server; an act on the server needs *", () => {
  const g: Grant[] = [{ holder: { kind: "key", id: "k" }, mailboxes: ["domain:acme.example"], can: ["read"], limits: { sendMode: "send", dailySendLimit: 1, ownerApproval: false }, expiresAt: null }];
  assert.equal(allows(g, A, "read"), true);
  assert.equal(allows(g, OTHER, "read"), false);
  assert.equal(allows(g, "cloudflare:x@sub.acme.example", "read"), false, "not its subdomains");
  assert.equal(allows(g, null, "read"), false);
});

test("several grants add up; a grant whose parent no longer covers it gives nothing (R-4)", () => {
  const limits = { sendMode: "send" as const, dailySendLimit: 10, ownerApproval: false };
  const parent: Grant = { holder: { kind: "person", email: "arch@acme.example" }, mailboxes: [A], can: ["read", "send"], limits, expiresAt: null };
  const child: Grant = { holder: { kind: "key", id: "k" }, mailboxes: [A], can: ["send"], limits, expiresAt: null, parent: "p" };
  const other: Grant = { holder: { kind: "key", id: "k" }, mailboxes: [B], can: ["read"], limits, expiresAt: null };
  assert.equal(allows([child, other], A, "send", new Date(), () => parent), true);
  assert.equal(allows([child, other], B, "read", new Date(), () => parent), true);
  assert.equal(allows([child], A, "send", new Date(), () => ({ ...parent, can: ["read"] })), false, "the parent lost send");
  assert.equal(allows([child], A, "send", new Date(), () => null), false, "the parent was revoked");
});

test("a delegation is a subset in mailboxes, capabilities, end and limits, or it is refused", () => {
  const limits = { sendMode: "send" as const, dailySendLimit: 20, ownerApproval: false };
  const parent = { mailboxes: ["domain:acme.example"], can: ["read", "draft", "send"] as Grant["can"], limits, expiresAt: "2027-01-01T00:00:00Z" };
  assert.equal(isSubset({ mailboxes: [A], can: ["read"], limits, expiresAt: "2026-12-01T00:00:00Z" }, parent), true);
  assert.equal(isSubset({ mailboxes: [OTHER], can: ["read"], limits, expiresAt: "2026-12-01T00:00:00Z" }, parent), false, "another domain");
  assert.equal(isSubset({ mailboxes: ["*"], can: ["read"], limits, expiresAt: "2026-12-01T00:00:00Z" }, parent), false, "the whole server");
  assert.equal(isSubset({ mailboxes: [A], can: ["delete"], limits, expiresAt: "2026-12-01T00:00:00Z" }, parent), false, "a capability added");
  assert.equal(isSubset({ mailboxes: [A], can: ["read"], limits, expiresAt: null }, parent), false, "no end under a parent that ends");
  assert.equal(isSubset({ mailboxes: [A], can: ["read"], limits: { ...limits, dailySendLimit: 21 }, expiresAt: "2026-12-01T00:00:00Z" }, parent), false, "a higher cap");
  assert.equal(isSubset({ mailboxes: [A], can: ["send"], limits, expiresAt: "2026-12-01T00:00:00Z" }, { ...parent, limits: { ...limits, sendMode: "drafts" } }), false, "send under drafts-only");
});

test("mailbox ids are canonical: lower case, the domain in punycode, nothing else accepted", () => {
  assert.equal(canonicalMailbox("Sales@ACME.example"), "cloudflare:sales@acme.example");
  assert.equal(canonicalMailbox("info@пример.example"), "cloudflare:info@xn--e1afmkfd.example");
  assert.equal(canonicalMailbox("domain:Пример.example"), null, "a domain id takes ASCII as today; its punycode form is what to send");
  assert.equal(canonicalMailbox("domain:xn--e1afmkfd.example"), "domain:xn--e1afmkfd.example");
  assert.equal(canonicalMailbox("*"), "*");
  assert.equal(canonicalMailbox("not an address"), null);
});
