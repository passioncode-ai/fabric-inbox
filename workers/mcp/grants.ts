/**
 * B-246 D-1 (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md): one grant model for agents and people. A grant
 * gives a holder (an agent key, by its immutable id, or a person) capabilities on mailboxes; a holder's reach is the
 * union of its grants. Today's levels are named bundles of capabilities, so every key and member reads here as exactly
 * what it could do before (R-1). Pure: nothing here reads storage or decides a request yet; W2a runs it beside the
 * current checks to log where the two would disagree, and the cut-over (W2c) waits for three days with none.
 */
import type { AgentKey, Level, SendMode } from "./keys";
import type { Member, MemberLevel } from "../lib/members";
import { normaliseAccountId } from "./scope";

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
