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

// ---- W2a part 2: every tool's need, and the same decision as today's levels for every key shape ----
import { TOOLS } from "../workers/mcp/tools";
import { TOOL_NEEDS } from "../workers/mcp/tool-capabilities";
import { CAPABILITIES } from "../workers/mcp/grants";
import { levelAllows } from "../workers/mcp/keys";
import { toolFitsScope } from "../workers/mcp/scope";

test("every tool is named once in TOOL_NEEDS, and nothing else is", () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names.filter((n) => !(n in TOOL_NEEDS)), [], "tools with no need: decide what each needs from a grant");
  assert.deepEqual(Object.keys(TOOL_NEEDS).filter((n) => !names.includes(n)), [], "needs for tools that do not exist");
});

test("for every tool and every key shape of today, the grants decide exactly as the levels do (R-1)", () => {
  const shapes = (["read", "mail", "admin"] as const).flatMap((level) => (["drafts", "send"] as const).flatMap((send) =>
    [null, [A]].map((accounts) => key({ level, send, accounts }))));
  const differ: string[] = [];
  for (const tool of TOOLS) {
    const need = TOOL_NEEDS[tool.name];
    for (const k of shapes) {
      const drafts = k.send === "drafts" && k.level !== "admin";
      // keys.ts normaliseKey: an Admin key with a limit reaches nothing.
      const old = !(k.level === "admin" && k.accounts !== null) && levelAllows(k.level, tool.level) && !(tool.sends && drafts) && (k.accounts === null || toolFitsScope(tool));
      const grants = grantsOfKey(k);
      const mailbox = k.accounts === null ? null : A;
      const reach = need === "server" ? CAPABILITIES.every((c) => allows(grants, null, c)) : allows(grants, mailbox, need);
      const sendsKept = !(tool.sends && grants.some((g) => g.limits.sendMode === "drafts"));
      const now = reach && sendsKept && (k.accounts === null || toolFitsScope(tool));
      if (old !== now) differ.push(`${tool.name} ${k.level}/${k.send}/${k.accounts ? "limited" : "all"}: old ${old}, grants ${now}`);
    }
  }
  assert.deepEqual(differ, []);
});

// ---- W2b: the contracts ----
import { AccessRequestSchema, GrantSchema, ORG_ROLES, ROLE_PRESETS, admitRequest, decide, requestKey, MAX_WAITING_PER_HOLDER, type AccessRequest } from "../workers/mcp/grants";
import { mailCapabilities } from "../workers/routes/fabric-service";

const request = (over: Partial<AccessRequest> = {}): AccessRequest => AccessRequestSchema.parse({
  schema: "access-request/1", id: "req-00000001", holder: { kind: "key", id: "k1" }, mailboxes: ["sales@acme.example"], can: ["send", "read"],
  why: "outreach", until: null, requestedAt: "2026-11-12T00:00:00Z", expiresAt: "2026-11-19T00:00:00Z", state: "waiting", ...over });

test("grant/1 and access-request/1 take canonical mailboxes and ordered capabilities, and refuse anything else", () => {
  const r = request();
  assert.deepEqual(r.mailboxes, ["cloudflare:sales@acme.example"]);
  assert.deepEqual(r.can, ["read", "send"]);
  assert.throws(() => request({ mailboxes: ["not a mailbox"] }), /not a mailbox/);
  assert.throws(() => request({ can: ["fly" as never] }));
  assert.throws(() => AccessRequestSchema.parse({ ...r, extra: 1 }), "a strict contract");
  const g = GrantSchema.parse({ schema: "grant/1", id: "grant-0001", holder: { kind: "person", email: "Ann@Acme.example" }, mailboxes: ["*"], can: ["read"],
    limits: { sendMode: "send", dailySendLimit: null, ownerApproval: false }, expiresAt: null, grantedBy: "owner@acme.example", grantedAt: "2026-11-12T00:00:00Z", why: "role" });
  assert.equal(g.holder.kind === "person" && g.holder.email, "ann@acme.example");
  assert.throws(() => GrantSchema.parse({ ...g, can: [] }), "a grant gives something");
});

test("a repeated request answers the waiting one, at most ten wait per holder, an expired one counts for nothing (R-3)", () => {
  const now = new Date("2026-11-13T00:00:00Z");
  const first = request();
  assert.deepEqual(admitRequest([first], { holder: first.holder, mailboxes: [...first.mailboxes].reverse(), can: ["send", "read"] }, now), { outcome: "repeat", id: first.id });
  const many = Array.from({ length: MAX_WAITING_PER_HOLDER }, (_, i) => request({ id: `req-${String(i).padStart(8, "0")}`, mailboxes: [`a${i}@acme.example`] }));
  assert.deepEqual(admitRequest(many, { holder: first.holder, mailboxes: ["cloudflare:new@acme.example"], can: ["read"] }, now), { outcome: "too_many" });
  assert.deepEqual(admitRequest(many, { holder: { kind: "key", id: "other" }, mailboxes: ["cloudflare:new@acme.example"], can: ["read"] }, now), { outcome: "new" });
  assert.deepEqual(admitRequest([first], { holder: first.holder, mailboxes: first.mailboxes, can: first.can }, new Date("2026-11-20T00:00:00Z")), { outcome: "new" });
  assert.equal(requestKey(first), "k1|cloudflare:sales@acme.example|read,send");
});

test("a decision is taken once and never on an expired request", () => {
  const now = new Date("2026-11-13T00:00:00Z");
  const approved = decide(request(), "approved", "owner@acme.example", now, { grant: "grant-0001" });
  assert.equal(approved?.state, "approved");
  assert.equal(approved?.decision?.grant, "grant-0001");
  assert.equal(decide(approved!, "refused", "admin@acme.example", now), null, "already decided");
  assert.equal(decide(request(), "approved", "owner@acme.example", new Date("2026-11-20T00:00:00Z")), null, "expired");
});

test("every role has a preset; the employee reaches its own and shared addresses only, never the whole server", () => {
  assert.deepEqual(Object.keys(ROLE_PRESETS).sort(), [...ORG_ROLES].sort());
  assert.equal(ROLE_PRESETS.employee.mailboxes, "own+shared");
  assert.deepEqual(ROLE_PRESETS.employee.standing, []);
  assert.ok(!ROLE_PRESETS.architect.can.includes("send"), "the architect sets mail up; sending stays with the mailbox's people");
});

test("the service declares a capability only once its tools exist (D-5)", () => {
  assert.deepEqual(mailCapabilities(TOOLS), ["mail.read", "mail.send"]);
  assert.deepEqual(mailCapabilities([...TOOLS, { name: "request_access" }]), ["mail.read", "mail.send", "mail.access"]);
});
