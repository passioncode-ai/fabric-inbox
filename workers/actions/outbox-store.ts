import type { OutboxEntry, OutboxStatus } from '../../shared/mail/outbox';

export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER,
  provider_message_id TEXT,
  projection_status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  UNIQUE(mailbox_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_mailbox_time ON outbox(mailbox_id, created_at DESC);
CREATE TABLE IF NOT EXISTS outbox_payload (
  action_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY(action_id, part)
);`;
export interface OutboxRow {
  id: string; mailbox_id: string; idempotency_key: string; payload_hash: string;
  status: OutboxStatus; created_at: number; updated_at: number; attempts: number;
  provider_message_id: string | null; projection_status: 'pending' | 'complete'; error_code: string | null;
  /** The provider's own words for a refusal, cut to 300 characters (migration 20); null otherwise. */
  error_detail?: string | null;
}
export interface OutboxSql { exec(query: string, ...args: (string | number | null)[]): Iterable<any> }
export class IdempotencyConflict extends Error {
  constructor() { super('Idempotency key already belongs to a different request'); this.name = 'IdempotencyConflict'; }
}
export function journal(row: OutboxRow): OutboxEntry {
  return { id: row.id, mailboxId: row.mailbox_id, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at, attempts: row.attempts, providerMessageId: row.provider_message_id,
    deliveryStatus: 'unconfirmed', projectionStatus: row.projection_status, errorCode: row.error_code,
    errorDetail: row.error_detail ?? null };
}
export class SqlOutboxStore {
  constructor(private sql: OutboxSql, private atomic: <T>(fn: () => T) => T) {}
  get(id: string): OutboxRow | undefined {
    return [...this.sql.exec('SELECT * FROM outbox WHERE id = ?', id)][0];
  }
  find(mailbox: string, key: string, hash: string): OutboxRow | undefined {
    const row = [...this.sql.exec('SELECT * FROM outbox WHERE mailbox_id = ? AND idempotency_key = ?', mailbox, key)][0] as OutboxRow | undefined;
    if (row && row.payload_hash !== hash) throw new IdempotencyConflict();
    return row;
  }
  reserve(mailbox: string, key: string, hash: string, payload: unknown): OutboxRow {
    return this.atomic(() => {
      const existing = [...this.sql.exec('SELECT * FROM outbox WHERE mailbox_id = ? AND idempotency_key = ?', mailbox, key)][0] as OutboxRow | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) throw new IdempotencyConflict();
        return existing;
      }
      const id = crypto.randomUUID(), now = Date.now();
      this.sql.exec("INSERT INTO outbox(id, mailbox_id, idempotency_key, payload_hash, status, created_at, updated_at) VALUES(?, ?, ?, ?, 'pending', ?, ?)", id, mailbox, key, hash, now, now);
      // DO SQLite has a 2 MB per-row limit. Chunk bodies/attachments within the same transaction.
      const serialized = JSON.stringify(payload);
      for (let offset = 0, part = 0; offset < serialized.length; offset += 32768, part++) {
        this.sql.exec('INSERT INTO outbox_payload(action_id, part, content) VALUES (?, ?, ?)', id, part, serialized.slice(offset, offset + 32768));
      }
      return this.get(id)!;
    });
  }
  payload(id: string): any {
    const parts = [...this.sql.exec('SELECT content FROM outbox_payload WHERE action_id = ? ORDER BY part', id)];
    return JSON.parse(parts.map(p => p.content).join(''));
  }
  claim(id: string): boolean {
    return this.atomic(() => {
      const row = this.get(id);
      if (!row || row.status !== 'pending') return false;
      const now = Date.now();
      const count = (since: number) => Number([...this.sql.exec('SELECT COUNT(*) AS n FROM outbox WHERE mailbox_id = ? AND attempts > 0 AND attempted_at >= ?', row.mailbox_id, since)][0].n);
      if (count(now - 3600000) >= 20 || count(now - 86400000) >= 100) {
        this.finish(id, 'failed', null, 'RATE_LIMIT');
        return false;
      }
      return [...this.sql.exec("UPDATE outbox SET status = 'sending', attempts = attempts + 1, attempted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING id", now, now, id)].length === 1;
    });
  }
  finish(id: string, state: 'accepted' | 'failed' | 'unknown', receipt: string | null, code: string | null, detail: string | null = null) {
    this.sql.exec('UPDATE outbox SET status = ?, provider_message_id = ?, error_code = ?, error_detail = ?, updated_at = ? WHERE id = ? AND status IN (\'pending\', \'sending\')', state, receipt, code, detail, Date.now(), id);
  }
  projected(id: string) {
    this.atomic(() => {
      this.sql.exec("UPDATE outbox SET projection_status = 'complete', error_code = NULL, updated_at = ? WHERE id = ? AND status = 'accepted'", Date.now(), id);
      this.sql.exec('DELETE FROM outbox_payload WHERE action_id = ?', id);
    });
  }
  projectionFailed(id: string) {
    this.sql.exec("UPDATE outbox SET error_code = 'PROJECTION_PENDING', updated_at = ? WHERE id = ? AND status = 'accepted'", Date.now(), id);
  }
  recoverInterrupted() {
    this.sql.exec("UPDATE outbox SET status = 'unknown', error_code = 'INTERRUPTED_SEND', updated_at = ? WHERE status = 'sending'", Date.now());
  }
  recoverable(): OutboxRow[] {
    return [...this.sql.exec("SELECT * FROM outbox WHERE status = 'pending' OR (status = 'accepted' AND projection_status = 'pending') ORDER BY created_at LIMIT 25")];
  }
  list(mailbox: string, limit = 50, offset = 0): OutboxEntry[] {
    return [...this.sql.exec('SELECT * FROM outbox WHERE mailbox_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?', mailbox, Math.max(1, Math.min(100, limit)), Math.max(0, offset))].map(journal);
  }
}
