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
}
export type SendMailResult = OutboxEntry | {
  error: string;
  code: 'INVALID_REQUEST' | 'IDEMPOTENCY_CONFLICT' | 'NOT_FOUND';
};
