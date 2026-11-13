/**
 * B-246 D-1 (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md): one grant model for agents and people. A grant
 * gives a holder (an agent key, by its immutable id, or a person) capabilities on mailboxes; a holder's reach is the
 * union of its grants. Today's levels are named bundles of capabilities, so every key and member reads here as exactly
 * what it could do before (R-1). Pure: nothing here reads storage or decides a request yet; W2a runs it beside the
 * current checks to log where the two would disagree, and the cut-over (W2c) waits for three days with none.
 */
import type { AgentKey, Level, Principal, SendMode } from "./keys";
import type { Member, MemberLevel } from "../lib/members";
import { normaliseAccountId, toolFitsScope } from "./scope";
import { TOOL_NEEDS } from "./tool-capabilities";
import { z } from "zod";
import { KEY_DAILY_SENDS } from "../../shared/mail/send-limits";

/** What a grant lets its holder do on its mailboxes. */
export const CAPABILITIES = ["read", "draft", "send", "organize", "delete", "create", "remove", "agents", "campaign"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Every mailbox of this server (one server is one tenant: R-2). */
export const ALL = "*";

export interface GrantLimits {
  /** "drafts": a send is kept as a draft for a person (a key's drafts-only mode). */
  sendMode: SendMode;
  /** Sends a day across the holder's grants; null: no cap (a person). */
  dailySendLimit: number | null;
  /** B-38: an irreversible act waits for the owner's approval. */
  ownerApproval: boolean;
}

export interface Grant {
  holder: { kind: "key"; id: string } | { kind: "person"; email: string };
  /** Normalised mailbox ids ("cloudflare:<address>", "gmail:<id>", "domain:<domain>") or ["*"]. */
  mailboxes: string[];
  can: Capability[];
  limits: GrantLimits;
  expiresAt: string | null;
  /** The grant this one was delegated from: its reach bounds this one at every use (R-4). */
  parent?: string;
}

const order = (caps: Iterable<Capability>): Capability[] => {
  const set = new Set(caps);
  return CAPABILITIES.filter((c) => set.has(c));
};

/** A key's level as capabilities (the bundles of D-1). A drafts-only key still holds `send`; its limits keep sends as drafts. */
export function capabilitiesOfLevel(level: Level): Capability[] {
  if (level === "read") return ["read"];
  if (level === "mail") return ["read", "draft", "send", "organize", "delete", "campaign"];
  return [...CAPABILITIES];
}

/** A member's level on one mailbox as capabilities (workers/lib/members.ts LEVELS). */
export function capabilitiesOfMemberLevel(level: MemberLevel): Capability[] {
  if (level === "read") return ["read"];
  if (level === "send") return ["read", "draft", "send", "organize"];
  return ["read", "draft", "send", "organize", "agents"];
}

/** Today's agent key as grants: one grant, its level's bundle on its accounts (null: every mailbox). */
export function grantsOfKey(key: Pick<AgentKey, "id" | "level" | "send" | "dailySendLimit" | "accounts" | "approval" | "expiresAt">): Grant[] {
  // An Admin key with a limit reaches nothing today (keys.ts normaliseKey); kept so.
  const mailboxes = key.accounts === null ? [ALL] : key.level === "admin" ? [] : [...key.accounts];
  if (!mailboxes.length) return [];
  return [{
    holder: { kind: "key", id: key.id },
    mailboxes,
    can: capabilitiesOfLevel(key.level),
    limits: { sendMode: key.level === "admin" ? "send" : key.send, dailySendLimit: key.dailySendLimit, ownerApproval: key.approval === "owner" },
    expiresAt: key.expiresAt,
  }];
}

/** Today's member as grants: one grant per level used among their mailboxes; an administrator holds everything. */
export function grantsOfMember(member: Pick<Member, "email" | "role" | "accounts" | "levels">): Grant[] {
  const holder = { kind: "person" as const, email: member.email.toLowerCase() };
  const limits: GrantLimits = { sendMode: "send", dailySendLimit: null, ownerApproval: false };
  if (member.role === "admin") return [{ holder, mailboxes: [ALL], can: [...CAPABILITIES], limits, expiresAt: null }];
  // B-246 W4 (D-3a): an architect's preset on every mailbox; read only where ROLE_GRANTS is on (workers/lib/members.ts standingOf).
  if (member.role === "architect") return [{ holder, mailboxes: [ALL], can: [...ROLE_PRESETS.architect.can], limits, expiresAt: null }];
  const byLevel = new Map<MemberLevel, string[]>();
  for (const account of member.accounts ?? []) {
    const level = member.levels?.[account] ?? "send";
    byLevel.set(level, [...(byLevel.get(level) ?? []), account]);
  }
  return [...byLevel].map(([level, mailboxes]) => ({ holder, mailboxes, can: capabilitiesOfMemberLevel(level), limits, expiresAt: null }));
}

/** A mailbox id as grants name it: lower-cased, its domain in punycode; null for anything else (R-2). */
export function canonicalMailbox(value: string): string | null {
  if (value === ALL) return ALL;
  const id = normaliseAccountId(value);
  if (!id) return null;
  if (!id.startsWith("cloudflare:") && !id.startsWith("domain:")) return id;
  const [prefix, rest] = [id.slice(0, id.indexOf(":") + 1), id.slice(id.indexOf(":") + 1)];
  const at = rest.lastIndexOf("@");
  const host = at >= 0 ? rest.slice(at + 1) : rest;
  let ascii: string;
  try { ascii = new URL(`https://${host}/`).hostname; } catch { return null; }
  return prefix + (at >= 0 ? rest.slice(0, at + 1) : "") + ascii;
}

/** Whether a grant's mailboxes cover one concrete mailbox ("cloudflare:<address>" or an account id). */
function covers(mailboxes: readonly string[], mailbox: string): boolean {
  if (mailboxes.includes(ALL) || mailboxes.includes(mailbox)) return true;
  if (!mailbox.startsWith("cloudflare:")) return false;
  const domain = mailbox.slice(mailbox.lastIndexOf("@") + 1);
  return mailboxes.includes(`domain:${domain}`);
}

const live = (g: Grant, now: Date) => g.expiresAt === null || Date.parse(g.expiresAt) > now.getTime();

/**
 * Whether a holder's grants let it do `capability` on `mailbox` (null: an act on the whole server, which only a grant
 * on "*" covers). The union of the live grants; a grant whose parent no longer covers it gives nothing (R-4).
 */
export function allows(grants: readonly Grant[], mailbox: string | null, capability: Capability, now = new Date(), parentOf?: (g: Grant) => Grant | null): boolean {
  return grants.some((g) => {
    if (!live(g, now) || !g.can.includes(capability)) return false;
    if (!(mailbox === null ? g.mailboxes.includes(ALL) : covers(g.mailboxes, mailbox))) return false;
    if (g.parent && parentOf) {
      const parent = parentOf(g);
      if (!parent || !allows([parent], mailbox, capability, now)) return false;
    }
    return true;
  });
}

/**
 * Whether `child` stays inside `parent` (R-2, R-4): every mailbox covered, no capability added, no later end, no
 * weaker limits. A delegation that is not a subset is refused, never narrowed silently (D-2).
 */
export function isSubset(child: Pick<Grant, "mailboxes" | "can" | "limits" | "expiresAt">, parent: Pick<Grant, "mailboxes" | "can" | "limits" | "expiresAt">): boolean {
  if (!child.mailboxes.every((m) => (m === ALL ? parent.mailboxes.includes(ALL) : covers(parent.mailboxes, m) || (m.startsWith("domain:") && parent.mailboxes.includes(m))))) return false;
  if (!child.can.every((c) => parent.can.includes(c))) return false;
  if (parent.expiresAt !== null && (child.expiresAt === null || Date.parse(child.expiresAt) > Date.parse(parent.expiresAt))) return false;
  if (parent.limits.sendMode === "drafts" && child.limits.sendMode !== "drafts") return false;
  if (parent.limits.dailySendLimit !== null && (child.limits.dailySendLimit === null || child.limits.dailySendLimit > parent.limits.dailySendLimit)) return false;
  if (parent.limits.ownerApproval && !child.limits.ownerApproval) return false;
  return true;
}

/** The capabilities a holder has on one mailbox, in the fixed order (what `list_my_access` will answer, W3). */
export function capabilitiesOn(grants: readonly Grant[], mailbox: string, now = new Date()): Capability[] {
  return order(grants.filter((g) => live(g, now) && covers(g.mailboxes, mailbox)).flatMap((g) => g.can));
}

// ---- W2b: the contracts (packet R-3, R-8) ----

/** A mailbox id a grant or a request may name: "*", a canonical address or account id, or a `domain:` entry. */
const MailboxId = z.string().max(320).transform((v, ctx) => {
  const id = canonicalMailbox(v);
  if (!id) { ctx.addIssue({ code: "custom", message: `not a mailbox: ${v.slice(0, 80)}` }); return z.NEVER; }
  return id;
});
const Capabilities = z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length).transform((c) => order(c));
const Instant = z.string().datetime({ offset: true });

/** grant/1: one grant as the store keeps it and `list_grants` answers it. */
export const GrantSchema = z.object({
  schema: z.literal("grant/1"),
  id: z.string().min(8).max(64),
  holder: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("key"), id: z.string().min(1).max(128) }),
    z.object({ kind: z.literal("person"), email: z.string().email().max(320).transform((e) => e.toLowerCase()) }),
  ]),
  mailboxes: z.array(MailboxId).min(1).max(200),
  can: Capabilities,
  limits: z.object({ sendMode: z.enum(["drafts", "send"]), dailySendLimit: z.number().int().min(0).max(KEY_DAILY_SENDS.max).nullable(), ownerApproval: z.boolean() }),
  expiresAt: Instant.nullable(),
  parent: z.string().min(8).max(64).optional(),
  grantedBy: z.string().min(1).max(320),
  grantedAt: Instant,
  why: z.string().min(1).max(500),
}).strict();
export type StoredGrant = z.infer<typeof GrantSchema>;

/** How long a request waits for a decision, and how many may wait for one holder (R-3). */
export const REQUEST_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_WAITING_PER_HOLDER = 10;

/** access-request/1: what an agent asked for and what became of it. */
export const AccessRequestSchema = z.object({
  schema: z.literal("access-request/1"),
  id: z.string().min(8).max(64),
  holder: z.object({ kind: z.literal("key"), id: z.string().min(1).max(128) }),
  mailboxes: z.array(MailboxId).min(1).max(200),
  can: Capabilities,
  why: z.string().min(1).max(500),
  until: Instant.nullable(),
  /** The project that asked on the Fabric board, as the board names it (the board path, D-4). */
  board: z.object({ project: z.string().min(1).max(192), message: z.string().min(8).max(128) }).optional(),
  requestedAt: Instant,
  expiresAt: Instant,
  state: z.enum(["waiting", "approved", "refused", "expired"]),
  decision: z.object({ by: z.string().min(1).max(320), at: Instant, note: z.string().max(500).optional(), grant: z.string().min(8).max(64).optional() }).optional(),
}).strict();
export type AccessRequest = z.infer<typeof AccessRequestSchema>;

/** The same request asked again: one holder, the same mailboxes and capabilities (R-3, no second row). */
export function requestKey(r: Pick<AccessRequest, "holder" | "mailboxes" | "can">): string {
  return `${r.holder.id}|${[...r.mailboxes].sort().join(",")}|${[...r.can].sort().join(",")}`;
}

/**
 * Whether a new request may wait: a repeat answers the waiting one, and a holder with MAX_WAITING_PER_HOLDER waiting
 * is refused. Expired requests count for nothing.
 */
export function admitRequest(existing: readonly AccessRequest[], asked: Pick<AccessRequest, "holder" | "mailboxes" | "can">, now = new Date()):
  { outcome: "new" } | { outcome: "repeat"; id: string } | { outcome: "too_many" } {
  const waiting = existing.filter((r) => r.state === "waiting" && r.holder.id === asked.holder.id && Date.parse(r.expiresAt) > now.getTime());
  const same = waiting.find((r) => requestKey(r) === requestKey(asked));
  if (same) return { outcome: "repeat", id: same.id };
  return waiting.length >= MAX_WAITING_PER_HOLDER ? { outcome: "too_many" } : { outcome: "new" };
}

/** A decision is taken once: only a waiting, unexpired request moves (the compare and set the store does, R-3). */
export function decide(r: AccessRequest, verdict: "approved" | "refused", by: string, now = new Date(), extra: { note?: string; grant?: string } = {}): AccessRequest | null {
  if (r.state !== "waiting" || Date.parse(r.expiresAt) <= now.getTime()) return null;
  return { ...r, state: verdict, decision: { by, at: now.toISOString(), ...(extra.note ? { note: extra.note } : {}), ...(extra.grant ? { grant: extra.grant } : {}) } };
}

/** The organization roles a server reads from its attestation (B-159), and their ready access (D-3, R-5). */
export const ORG_ROLES = ["owner", "admin", "architect", "employee"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
/**
 * A role's preset, before the owner edits it: `own` is the person's own address, `shared` the shared addresses the
 * owner lists. The owner and administrators hold everything; the architect per the operator's decision of 2026-11-06
 * (B-232), with its acts journaled and its reach ending with the role.
 */
export const ROLE_PRESETS: Readonly<Record<OrgRole, { mailboxes: "all" | "own+shared"; can: readonly Capability[]; standing: readonly ("grants")[] }>> = Object.freeze({
  owner: { mailboxes: "all", can: CAPABILITIES, standing: ["grants"] },
  admin: { mailboxes: "all", can: CAPABILITIES, standing: ["grants"] },
  architect: { mailboxes: "all", can: ["read", "organize", "create", "remove", "agents"], standing: ["grants"] },
  employee: { mailboxes: "own+shared", can: ["read", "draft", "send"], standing: [] },
});

// ---- W2c: the grants of a caller, and the decision they make for a tool (the shadow beside today's checks) ----

/**
 * B-246 W4b (packet D-3a, Delegation): the parent of a grant an architect gave one of their agent keys from their role.
 * Such a grant holds only while its grantor is still an architect (or became an administrator) and it stays inside the
 * architect's preset; it is read at every use, so leaving the list or losing the role takes it away at the next call.
 */
export const ARCHITECT_ROLE_PARENT = "role:architect";

/** Whether a stored grant still holds by its grantor; `roleOf` is the grantor's role on this server now, null when unknown. */
export function delegationHolds(g: Pick<StoredGrant, "parent" | "grantedBy" | "can">, roleOf: (email: string) => string | null): boolean {
  if (g.parent !== ARCHITECT_ROLE_PARENT) return true;
  const role = roleOf(g.grantedBy);
  if (role !== "architect" && role !== "admin") return false;
  return g.can.every((c) => ROLE_PRESETS.architect.can.includes(c));
}

/** A caller's grants from its key or sign-in today, plus the stored grants naming it (W2c) that still hold (W4b). */
export function grantsOfPrincipal(p: Principal, stored: readonly StoredGrant[] = [], holds: (g: StoredGrant) => boolean = () => true): Grant[] {
  const own: Grant[] = p.kind === "owner"
    ? [{ holder: { kind: "person", email: p.label.toLowerCase() }, mailboxes: [ALL], can: [...CAPABILITIES], limits: { sendMode: "send", dailySendLimit: null, ownerApproval: false }, expiresAt: null }]
    : grantsOfKey({ id: p.keyId, level: p.level, send: p.send, dailySendLimit: p.dailySendLimit, accounts: p.accounts ? [...p.accounts] : null, approval: p.approval, expiresAt: null });
  const holderId = p.kind === "owner" ? null : p.keyId;
  const extra = stored.filter((g) => g.holder.kind === "key" && g.holder.id === holderId && holds(g));
  return [...own, ...extra];
}

/**
 * B-246 W2c, the cut-over (`GRANTS_DECIDE=on`): the mailboxes on which a caller's grants give `need`; "all" when a grant on
 * "*" gives it. A send counts only under a grant whose send mode is send, so a drafts-only grant never sends.
 */
export function mailboxesFor(need: Capability, grants: readonly Grant[], now = new Date()): "all" | string[] {
  const usable = grants.filter((g) => live(g, now) && g.can.includes(need) && (need !== "send" || g.limits.sendMode === "send"));
  if (usable.some((g) => g.mailboxes.includes(ALL))) return "all";
  return [...new Set(usable.flatMap((g) => g.mailboxes))];
}

/**
 * B-246 W2c, the cut-over: whether the grants let a caller use a tool, and the mailboxes its call reaches (null: every
 * mailbox). The call's API is narrowed to exactly those, so a grant of `send` on one mailbox and `read` on another never
 * lets a send reach the second. A tool that acts on the whole server needs every capability on "*".
 */
export function grantScope(tool: { name: string; routes: readonly string[]; sends?: boolean; ownerSends?: boolean }, grants: readonly Grant[], now = new Date()):
  { allowed: boolean; accounts: readonly string[] | null; viaOwner?: boolean } {
  const need = TOOL_NEEDS[tool.name];
  const none = { allowed: false, accounts: [] as string[] };
  if (!need) return none;
  if (need === "self") return { allowed: true, accounts: [] };
  // A tool that sends mail (a campaign's launch, a test message) also needs a grant whose send mode is send there.
  const sendable = tool.sends ? sendableMailboxes(grants, now) : "all";
  if (need === "server") return CAPABILITIES.every((c) => mailboxesFor(c, grants, now) === "all") && sendable === "all" ? { allowed: true, accounts: null } : none;
  const want = mailboxesFor(need, grants, now);
  // W5a (packet R-6): a tool the owner may send for reaches every mailbox its need covers; where the grants give no send,
  // the owner's approval stands in for it (`viaOwner`), bound to what the call sends.
  if (tool.ownerSends) {
    const short = sendable !== "all" && (want === "all" || want.some((m) => !sendable.includes(m)));
    if (want === "all") return { allowed: true, accounts: null, viaOwner: short };
    return want.length && toolFitsScope(tool) ? { allowed: true, accounts: want, viaOwner: short } : none;
  }
  const reach = sendable === "all" ? want : want === "all" ? sendable : want.filter((m) => sendable.includes(m));
  if (reach === "all") return { allowed: true, accounts: null };
  return reach.length && toolFitsScope(tool) ? { allowed: true, accounts: reach } : none;
}

/** The mailboxes under a live grant whose send mode is send, whatever it grants there; "all" under one on "*". */
function sendableMailboxes(grants: readonly Grant[], now: Date): "all" | string[] {
  const usable = grants.filter((g) => live(g, now) && g.limits.sendMode === "send");
  if (usable.some((g) => g.mailboxes.includes(ALL))) return "all";
  return [...new Set(usable.flatMap((g) => g.mailboxes))];
}

/** Whether the grants let this caller use a tool: its need on its mailboxes, drafts kept, a limited caller kept to one mailbox's tools. */
export function grantsAllowTool(tool: { name: string; sends?: boolean; ownerSends?: boolean; routes: readonly string[] }, p: Principal, grants: readonly Grant[], now = new Date()): boolean {
  const need = TOOL_NEEDS[tool.name];
  if (!need) return false;
  // A limit that names nothing reaches nothing, except a requester key's own requests (B-246 W3).
  if (p.accounts && !p.accounts.length) return need === "self" && p.kind === "agent" && !!p.requestOnly;
  // A key asks for access and reads its own for itself, whatever it reaches.
  if (need === "self") return true;
  const mailbox = p.accounts ? p.accounts[0] : null;
  const reach = need === "server" ? CAPABILITIES.every((c) => allows(grants, null, c, now)) : allows(grants, mailbox, need, now);
  const drafts = !!tool.sends && !tool.ownerSends && p.kind === "agent" && p.send === "drafts" && p.level !== "admin";
  return reach && !drafts && (!p.accounts || toolFitsScope(tool));
}
