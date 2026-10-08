import type { OutboxEntry } from '../../shared/mail/outbox';
import { SqlOutboxStore, journal, type OutboxRow } from './outbox-store';
export { IdempotencyConflict } from './outbox-store';

// Only explicit pre-acceptance rejection codes are safe failures. Delivery errors can
// cover partial multi-recipient acceptance, so those remain unknown.
const REJECTIONS = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY',
  // Cloudflare's Email Sending REST API refused the request with a 4xx: nothing was accepted
  // (workers/email-sender.ts, mail from a domain in another account).
  'E_REST_REFUSED',
]);
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export async function payloadHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
interface Effects {
  transport(payload: any, row: OutboxRow): Promise<{ messageId: string }>;
  project(payload: any, row: OutboxRow): Promise<void>;
  beforeEffect(): Promise<void>;
}
export class OutboxCoordinator {
  private active = new Map<string, Promise<OutboxEntry>>();
  constructor(private store: SqlOutboxStore, private effects: Effects) {}
  async submit(mailbox: string, key: string, payload: unknown, identity: unknown = payload): Promise<OutboxEntry> {
    if (typeof key !== 'string' || !key || key.length > 200 || /[\r\n]/.test(key)) throw new Error('Invalid idempotency key');
    const row = this.store.reserve(mailbox, key, await payloadHash(identity), payload);
    return this.process(row.id);
  }
  async process(id: string): Promise<OutboxEntry> {
    const running = this.active.get(id);
    if (running) return running;
    const result = this.run(id);
    this.active.set(id, result);
    try { return await result; } finally { this.active.delete(id); }
  }
  private async run(id: string): Promise<OutboxEntry> {
    let row = this.store.get(id);
    if (!row) throw new Error('Outbox action not found');
    if (this.store.claim(id)) {
      row = this.store.get(id)!;
      // A storage failure before the external effect is known safe. No attempt is
      // automatically retried; caller sees a failed durable action.
      try { await this.effects.beforeEffect(); }
      catch { this.store.finish(id, 'failed', null, 'PERSISTENCE_FAILED'); return journal(this.store.get(id)!); }
      let receipt: { messageId: string };
      try {
        receipt = await this.effects.transport(this.store.payload(id), row);
        if (typeof receipt?.messageId !== 'string' || !receipt.messageId.trim()) throw new Error('Missing receipt');
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const rejected = typeof code === 'string' && REJECTIONS.has(code);
        this.store.finish(id, rejected ? 'failed' : 'unknown', null, rejected ? code : 'TRANSPORT_OUTCOME_UNKNOWN',
          rejected ? refusalDetail((error as Error)?.message) : null);
        return journal(this.store.get(id)!);
      }
      // Commit acceptance before projection. If this write fails the persisted
      // sending row is recovered as unknown, never sent a second time.
      try { this.store.finish(id, 'accepted', receipt.messageId, null); }
      catch {
        // The provider has accepted, but its receipt could not be committed.
        // Never reinterpret this as rejection or permit a fresh transport attempt.
        this.store.finish(id, 'unknown', null, 'RECEIPT_PERSISTENCE_FAILED');
        return journal(this.store.get(id)!);
      }
    }
    row = this.store.get(id)!;
    if (row.status === 'accepted' && row.projection_status !== 'complete') {
      try {
        await this.effects.project(this.store.payload(id), row);
        this.store.projected(id);
      } catch { this.store.projectionFailed(id); }
    }
    return journal(this.store.get(id)!);
  }
}

/**
 * A refusal in the provider's own words, kept with the failed action so a person sees why (live
 * 2026-10-08: an address showed only E_REST_REFUSED and a wrong guess). Only a coded, definite
 * refusal keeps it; cut to 300 characters, credentials and mail addresses masked, so the journal
 * still never carries a secret or a recipient.
 */
export function refusalDetail(message: unknown): string | null {
  if (typeof message !== "string" || !message.trim()) return null;
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [hidden]")
    .replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[A-Za-z]{2,}/g, "[address]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[hidden]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
