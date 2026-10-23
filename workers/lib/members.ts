/**
 * Who may sign in to a shared server and what they reach (B-149). Cloudflare Access decides who
 * passes; this list decides the role. Empty or absent, every person Access lets in is an
 * administrator, as before: a one-person server changes nothing. Once it names anyone, a listed
 * administrator has every right, a member reaches only their own mailboxes, and anyone else Access
 * lets in is refused. One R2 object, written on the etag read, like the agent keys.
 */
import { normaliseAccounts } from "../mcp/scope";
import { bodyForUpdate } from "./r2-json";
import { msg } from "../../shared/i18n";

export class MembersError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export const MEMBERS_KEY = "config/members.json";
export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];
export const MAX_MEMBERS = 500;

export interface Member {
  email: string;
  role: Role;
  /** A member's mailboxes ("cloudflare:<address>", "gmail:<id>", …); null for an administrator. */
  accounts: string[] | null;
  addedAt: string;
}

/** What a signed-in person is on this server. */
export type Standing =
  | { role: "admin"; email: string; listed: boolean }
  | { role: "member"; email: string; accounts: readonly string[] }
  | { role: "none"; email: string };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
export const normaliseEmail = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return EMAIL.test(v) ? v : null;
};

function normaliseMember(raw: unknown): Member | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const email = normaliseEmail(m.email);
  if (!email) return null;
  // An unknown role is the safest one; a member with a damaged list reaches nothing.
  const role: Role = m.role === "admin" ? "admin" : "member";
  return { email, role, accounts: role === "admin" ? null : (normaliseAccounts(m.accounts) ?? []).filter((a) => !a.startsWith("domain:")),
    addedAt: typeof m.addedAt === "string" ? m.addedAt : new Date(0).toISOString() };
}

/** A damaged file reads as an empty list only when nothing in it is readable; duplicates keep the first. */
export function normaliseMembers(raw: unknown): Member[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { members?: unknown }).members) ? (raw as { members: unknown[] }).members : [];
  const seen = new Set<string>();
  return list.map(normaliseMember).filter((m): m is Member => !!m && !seen.has(m.email) && !!seen.add(m.email));
}

/**
 * The list. A file that is there but cannot be read fails closed: an empty list would make every
 * person an administrator. The fix is to save the list again, or delete the object to start over.
 */
export async function readMembers(bucket: R2Bucket): Promise<Member[]> {
  const object = await bucket.get(MEMBERS_KEY);
  if (!object) return [];
  const raw = await object.json().catch(() => null);
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { members?: unknown }).members))
    throw new MembersError(msg("The list of people ({key}) cannot be read, so nobody is let in. Delete it in R2 to start over.", { key: MEMBERS_KEY }), 503);
  return normaliseMembers(raw);
}

/** The standing of a signed-in email against the list. */
export function standingOf(members: readonly Member[], email: string): Standing {
  const who = email.trim().toLowerCase();
  if (!members.length) return { role: "admin", email: who, listed: false };
  const m = members.find((x) => x.email === who);
  if (!m) return { role: "none", email: who };
  return m.role === "admin" ? { role: "admin", email: who, listed: true } : { role: "member", email: who, accounts: m.accounts ?? [] };
}

/**
 * Changes the list. The result must keep an administrator, so nobody locks the server; the first
 * change a person makes lists them as its administrator.
 */
export async function updateMembers(bucket: R2Bucket, change: (members: Member[]) => Member[], by: string | null): Promise<Member[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(MEMBERS_KEY);
    const current = object ? normaliseMembers(await bodyForUpdate(object)) : [];
    let next = change(current);
    const editor = by ? normaliseEmail(by) : null;
    if (!current.length && next.length && editor && !next.some((m) => m.email === editor))
      next = [{ email: editor, role: "admin", accounts: null, addedAt: new Date().toISOString() }, ...next];
    // An emptied list would make every person Access lets in an administrator again.
    if (current.length && !next.length)
      throw new MembersError(msg("The last administrator stays on the list: with nobody on it, everyone who can sign in would manage this server."), 409);
    if (next.length && !next.some((m) => m.role === "admin"))
      throw new MembersError(msg("The list must keep at least one administrator, or nobody could manage this server."), 409);
    if (next.length > MAX_MEMBERS) throw new MembersError(msg("At most {max} people.", { max: MAX_MEMBERS }), 400);
    const written = await bucket.put(MEMBERS_KEY, JSON.stringify({ members: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new MembersError(msg("The list changed several times at once; try again."), 409);
}

let cache: { at: number; members: Member[] } | null = null;
/** The list, read from R2 at most every 10 seconds per isolate (a removed person is out within that). */
export async function membersCached(bucket: R2Bucket, now = Date.now()): Promise<Member[]> {
  if (cache && now - cache.at < 10_000) return cache.members;
  const members = await readMembers(bucket);
  cache = { at: now, members };
  return members;
}
export const forgetMembers = () => { cache = null; };
