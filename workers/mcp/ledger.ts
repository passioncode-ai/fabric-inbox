/**
 * The agent protocol's ledger (AP-3, AP-4, AP-6), one per workspace (`getByName("workspace")`).
 *
 * It keeps what must be exact under concurrent calls, so it lives in one Durable Object:
 * one-time confirmation codes for irreversible actions, the daily send count per key, and the
 * journal of every change an agent made. Its class keeps upstream's name `EmailMCP` — the class
 * is bound and migrated (`v3`), and removing it would be a destructive storage step.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { migrateSchema, statements } from "../lib/do-schema";

export const CONFIRM_TTL_MS = 5 * 60_000;
/** B-38: an action waiting for the owner's approval waits a day, not five minutes: a person answers it. */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
export const JOURNAL_KEPT = 5000;
const MAX_OPEN_CODES = 200;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const LEDGER_STEPS = [
  statements("1_initial", [
    `CREATE TABLE IF NOT EXISTS mcp_confirmations (code TEXT PRIMARY KEY, caller TEXT NOT NULL, tool TEXT NOT NULL,
       args_hash TEXT NOT NULL, summary TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS mcp_send_counts (day TEXT NOT NULL, caller TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, caller))`,
    `CREATE TABLE IF NOT EXISTS mcp_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, caller TEXT NOT NULL,
       caller_label TEXT NOT NULL, tool TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS mcp_journal_by_time ON mcp_journal(at DESC)`,
  ]),
  // One key change at a time: making and revoking read and write Cloudflare's policy in several calls.
  statements("2_locks", [`CREATE TABLE IF NOT EXISTS mcp_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL)`]),
  // B-38: a code issued to a key whose irreversible actions the owner approves works only once approved.
  statements("3_owner_approval", [
    `ALTER TABLE mcp_confirmations ADD COLUMN needs_owner INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE mcp_confirmations ADD COLUMN approved_at INTEGER`,
    `ALTER TABLE mcp_confirmations ADD COLUMN caller_label TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE mcp_confirmations ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
  ]),
];

/** B-38: one action an agent asked for that waits for the owner, as Agent access lists it. */
export interface PendingApproval { code: string; caller: string; callerLabel: string; tool: string; summary: string; createdAt: number; expiresAt: number; approved: boolean }

export type JournalOutcome = "done" | "failed" | "refused" | "confirmation_asked";
export interface JournalEntry { id: number; at: number; caller: string; callerLabel: string; tool: string; target: string; outcome: JournalOutcome; detail: string }

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export class EmailMCP extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrateSchema(ctx.storage, LEDGER_STEPS, "EmailMCP");
  }

  /** Takes a named lease unless another holder has one that has not expired. */
  acquireLock(name: string, holder: string, ttlMs: number, now = Date.now()): boolean {
    const row = [...this.sql.exec("SELECT holder, expires_at FROM mcp_locks WHERE name = ?", name)][0];
    if (row && row.holder !== holder && Number(row.expires_at) > now) return false;
    this.sql.exec("INSERT INTO mcp_locks (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at", name, holder, now + ttlMs);
    return true;
  }

  releaseLock(name: string, holder: string): void {
    this.sql.exec("DELETE FROM mcp_locks WHERE name = ? AND holder = ?", name, holder);
  }

  /** Upstream's McpAgent set alarms on this class; one still pending finds nothing to do. */
  async alarm(): Promise<void> {}

  /**
   * A code for one irreversible call: the same caller, tool and arguments, within five minutes; with
   * `owner` (B-38) it works only after the owner approved it, within a day.
   */
  issueConfirmation(input: { caller: string; tool: string; argsHash: string; summary: string; owner?: boolean; callerLabel?: string }, now = Date.now()): { code: string; expiresAt: number } {
    this.sql.exec("DELETE FROM mcp_confirmations WHERE expires_at <= ?", now);
    const open = Number([...this.sql.exec("SELECT COUNT(*) AS n FROM mcp_confirmations WHERE caller = ?", input.caller)][0]?.n ?? 0);
    if (open >= MAX_OPEN_CODES) throw new Error("Too many actions are waiting for confirmation; confirm or let them expire first");
    const code = newCode();
    const expiresAt = now + (input.owner ? APPROVAL_TTL_MS : CONFIRM_TTL_MS);
    this.sql.exec("INSERT INTO mcp_confirmations (code, caller, tool, args_hash, summary, expires_at, needs_owner, caller_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      code, input.caller, input.tool, input.argsHash, input.summary, expiresAt, input.owner ? 1 : 0, (input.callerLabel ?? "").slice(0, 200), now);
    return { code, expiresAt };
  }

  /** B-38: actions waiting for the owner, and approved ones not yet used, newest first. */
  pendingApprovals(now = Date.now()): PendingApproval[] {
    this.sql.exec("DELETE FROM mcp_confirmations WHERE expires_at <= ?", now);
    return [...this.sql.exec("SELECT code, caller, caller_label, tool, summary, created_at, expires_at, approved_at FROM mcp_confirmations WHERE needs_owner = 1 ORDER BY created_at DESC LIMIT 200")]
      .map((r) => ({ code: String(r.code), caller: String(r.caller), callerLabel: String(r.caller_label), tool: String(r.tool), summary: String(r.summary),
        createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), approved: r.approved_at !== null }));
  }

  /** B-38: a key switched to the owner's approval loses the codes it was given before, so none of them works on its own. */
  dropSelfConfirmations(caller: string): number {
    return [...this.sql.exec("DELETE FROM mcp_confirmations WHERE caller = ? AND needs_owner = 0 RETURNING 1", caller)].length;
  }

  /** B-38: the owner's answer. Approve lets the code work once; deny deletes it. False when there is no such waiting action. */
  decideApproval(code: string, approve: boolean, now = Date.now()): boolean {
    const id = code.trim().toUpperCase();
    const row = [...this.sql.exec("SELECT expires_at FROM mcp_confirmations WHERE code = ? AND needs_owner = 1", id)][0];
    if (!row || Number(row.expires_at) <= now) return false;
    if (approve) this.sql.exec("UPDATE mcp_confirmations SET approved_at = ? WHERE code = ?", now, id);
    else this.sql.exec("DELETE FROM mcp_confirmations WHERE code = ?", id);
    return true;
  }

  /**
   * Spends a code once. Wrong caller, tool, arguments or an expired code: nothing is spent. A code the
   * owner has not approved yet (B-38) answers "waiting" and stays.
   */
  consumeConfirmation(input: { code: string; caller: string; tool: string; argsHash: string }, now = Date.now()): boolean | "waiting" {
    const row = [...this.sql.exec("SELECT caller, tool, args_hash, expires_at, needs_owner, approved_at FROM mcp_confirmations WHERE code = ?", input.code.trim().toUpperCase())][0];
    if (!row || row.caller !== input.caller || row.tool !== input.tool || row.args_hash !== input.argsHash || Number(row.expires_at) <= now) return false;
    if (Number(row.needs_owner) === 1 && row.approved_at === null) return "waiting";
    this.sql.exec("DELETE FROM mcp_confirmations WHERE code = ?", input.code.trim().toUpperCase());
    return true;
  }

  /** Takes one send from today's allowance; `limit` null means no daily limit (the owner). */
  reserveSend(caller: string, limit: number | null, now = Date.now()): { ok: boolean; used: number; limit: number | null } {
    const today = day(now);
    const used = Number([...this.sql.exec("SELECT count FROM mcp_send_counts WHERE day = ? AND caller = ?", today, caller)][0]?.count ?? 0);
    if (limit !== null && used >= limit) return { ok: false, used, limit };
    this.sql.exec("INSERT INTO mcp_send_counts (day, caller, count) VALUES (?, ?, 1) ON CONFLICT(day, caller) DO UPDATE SET count = count + 1", today, caller);
    this.sql.exec("DELETE FROM mcp_send_counts WHERE day < ?", day(now - 3 * 86_400_000));
    return { ok: true, used: used + 1, limit };
  }

  /** Gives back a send that never left (the route refused it). */
  refundSend(caller: string, now = Date.now()): void {
    this.sql.exec("UPDATE mcp_send_counts SET count = MAX(0, count - 1) WHERE day = ? AND caller = ?", day(now), caller);
  }

  record(entry: Omit<JournalEntry, "id">): void {
    this.sql.exec("INSERT INTO mcp_journal (at, caller, caller_label, tool, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.at, entry.caller, entry.callerLabel.slice(0, 200), entry.tool, entry.target.slice(0, 300), entry.outcome, entry.detail.slice(0, 500));
    this.sql.exec("DELETE FROM mcp_journal WHERE id <= (SELECT id FROM mcp_journal ORDER BY id DESC LIMIT 1 OFFSET ?)", JOURNAL_KEPT);
  }

  /**
   * Newest first. Paged by `cursor`, the id of the last entry seen: entries sharing a millisecond are
   * neither skipped nor repeated (B-50). `before` (a timestamp) is the older cursor, still accepted.
   */
  journal(options: { before?: number; cursor?: number; limit?: number; caller?: string } = {}): JournalEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = [...this.sql.exec(
      `SELECT id, at, caller, caller_label, tool, target, outcome, detail FROM mcp_journal
        WHERE id < ? AND at < ? ${options.caller ? "AND caller = ?" : ""} ORDER BY id DESC LIMIT ?`,
      ...[options.cursor ?? Number.MAX_SAFE_INTEGER, options.before ?? Number.MAX_SAFE_INTEGER, ...(options.caller ? [options.caller] : []), limit])];
    return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), caller: String(r.caller), callerLabel: String(r.caller_label), tool: String(r.tool),
      target: String(r.target), outcome: r.outcome as JournalOutcome, detail: String(r.detail) }));
  }
}
