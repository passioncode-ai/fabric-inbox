import type { OutboxEntry } from './outbox';
import type { SendEmailParams } from '../../workers/email-sender';
export interface SendMailRequest extends Omit<SendEmailParams, 'headers'> {
  in_reply_to?: string;
  references?: string[];
  thread_id?: string;
  /** Sent by an agent: carries `Auto-Submitted: auto-replied` (RFC 3834) so other auto-responders do not answer it. */
  auto_submitted?: boolean;
}
export interface SendMailCommand {
  mailboxId: string;
  idempotencyKey?: string;
  kind?: 'send' | 'reply' | 'forward';
  originalEmailId?: string;
  request: SendMailRequest;
  /** MCP draft verification is performed once before persisting the transport payload. */
  verifyContent?: boolean;
  /**
   * S07 (B-272), R6-3: who sends it (a person in the app, or an agent: a key over the agent protocol, a reply agent) and
   * the draft it came from. Kept in the outbox payload, outside the identity hash, so the accepted reply's `project` step
   * leaves that draft to the send and records which outcome the reply gives the waiting agent drafts.
   */
  sentBy?: 'person' | 'agent';
  sourceDraft?: { id: string; answers: string | null; revision: number | null };
}
export type SendMailResult = OutboxEntry | {
  error: string;
  /** DRAFT_CONFLICT: a draft send named a revision the draft has moved past (MailboxDO.sendDraft). */
  code: 'INVALID_REQUEST' | 'IDEMPOTENCY_CONFLICT' | 'NOT_FOUND' | 'DRAFT_CONFLICT' | 'MOVED';
};
