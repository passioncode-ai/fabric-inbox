import type { IncomingMailEvent } from '../../shared/mail/incoming';
import type { OutboxSql } from './outbox-store';
export const INCOMING_SCHEMA = `
CREATE TABLE incoming_receipts (
  delivery_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  automation_status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE incoming_event_payload (
  delivery_id TEXT NOT NULL REFERENCES incoming_receipts(delivery_id),
  part INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY(delivery_id, part)
);`;
export const MAX_INCOMING_ATTEMPTS = 10;
export class IncomingJournal {
  constructor(private sql: OutboxSql) {}
  has(id: string) { return [...this.sql.exec('SELECT 1 FROM incoming_receipts WHERE delivery_id = ?', id)].length > 0; }
  /** Caller wraps this together with Inbox insertion in one transaction. */
  record(mailboxId: string, event: IncomingMailEvent) {
    this.sql.exec('INSERT INTO incoming_receipts(delivery_id, mailbox_id, received_at) VALUES (?, ?, ?)', event.id, mailboxId, Date.now());
    const serialized = JSON.stringify(event);
    for (let offset = 0, part = 0; offset < serialized.length; offset += 32768, part++) {
      this.sql.exec('INSERT INTO incoming_event_payload(delivery_id, part, content) VALUES (?, ?, ?)', event.id, part, serialized.slice(offset, offset + 32768));
    }
  }
  /** Events whose turn has come, oldest turn first; one that keeps failing waits its backoff. */
  pending(now = Date.now()): { delivery_id: string; mailbox_id: string }[] {
    return [...this.sql.exec("SELECT delivery_id, mailbox_id FROM incoming_receipts WHERE automation_status = 'pending' AND next_at <= ? ORDER BY next_at, received_at LIMIT 25", now)];
  }
  /** Any event still owed to a consumer, due or not (the alarm is kept for it). */
  waiting(): number {
    return Number([...this.sql.exec("SELECT COUNT(*) AS n FROM incoming_receipts WHERE automation_status = 'pending'")][0]?.n ?? 0);
  }
  nextDue(): number | null {
    const t = [...this.sql.exec("SELECT MIN(next_at) AS t FROM incoming_receipts WHERE automation_status = 'pending'")][0]?.t;
    return t === null || t === undefined ? null : Number(t);
  }
  /**
   * A consumer refused it: wait 30 s, doubling to at most an hour; after `MAX_INCOMING_ATTEMPTS`
   * it is set aside as `dead` with its error, shown to the operator and retried only on request.
   */
  failed(id: string, error: string, now = Date.now()) {
    const row = [...this.sql.exec('SELECT attempts FROM incoming_receipts WHERE delivery_id = ?', id)][0];
    const attempts = Number(row?.attempts ?? 1);
    if (attempts >= MAX_INCOMING_ATTEMPTS)
      this.sql.exec("UPDATE incoming_receipts SET automation_status = 'dead', last_error = ? WHERE delivery_id = ?", error.slice(0, 300), id);
    else
      this.sql.exec('UPDATE incoming_receipts SET next_at = ?, last_error = ? WHERE delivery_id = ?',
        now + Math.min(30_000 * 2 ** (attempts - 1), 3_600_000), error.slice(0, 300), id);
    return attempts >= MAX_INCOMING_ATTEMPTS;
  }
  /** What the operator needs to know: events set aside, events still being retried, the last error. */
  problems(): { dead: number; retrying: number; lastError: string | null } {
    const n = (q: string) => Number([...this.sql.exec(q)][0]?.n ?? 0);
    const last = [...this.sql.exec("SELECT last_error FROM incoming_receipts WHERE last_error IS NOT NULL AND automation_status != 'accepted' ORDER BY received_at DESC LIMIT 1")][0];
    return {
      dead: n("SELECT COUNT(*) AS n FROM incoming_receipts WHERE automation_status = 'dead'"),
      retrying: n("SELECT COUNT(*) AS n FROM incoming_receipts WHERE automation_status = 'pending' AND attempts > 0"),
      lastError: last ? String(last.last_error) : null,
    };
  }
  /** Retry on request: every set-aside event is due again. */
  revive(): number {
    const n = Number([...this.sql.exec("SELECT COUNT(*) AS n FROM incoming_receipts WHERE automation_status = 'dead'")][0]?.n ?? 0);
    this.sql.exec("UPDATE incoming_receipts SET automation_status = 'pending', attempts = 0, next_at = 0 WHERE automation_status = 'dead'");
    return n;
  }
  event(id: string): IncomingMailEvent {
    return JSON.parse([...this.sql.exec('SELECT content FROM incoming_event_payload WHERE delivery_id = ? ORDER BY part', id)].map(r => r.content).join(''));
  }
  attempted(id: string) { this.sql.exec('UPDATE incoming_receipts SET attempts = attempts + 1 WHERE delivery_id = ?', id); }
  /** Caller commits acknowledgement and payload removal atomically. */
  accepted(id: string) {
    this.sql.exec("UPDATE incoming_receipts SET automation_status = 'accepted', last_error = NULL WHERE delivery_id = ?", id);
    this.sql.exec('DELETE FROM incoming_event_payload WHERE delivery_id = ?', id);
  }
}
