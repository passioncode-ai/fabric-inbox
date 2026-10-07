import type { Context } from 'hono';
import type { MailboxContext } from '../lib/mailbox';
import type { SendMailCommand } from '../../shared/mail/send';
import { msg } from "../../shared/i18n";

/** All browser sends share the same mailbox-owned durable effect boundary. */
export async function handleSendEmail(c: Context<MailboxContext>, kind: 'send' | 'reply' | 'forward' = 'send') {
  const raw = await c.req.json();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: msg('Invalid send request'), code: 'INVALID_REQUEST' }, 400);
  const result = await c.var.mailboxStub.sendMail({
    mailboxId: c.req.param('mailboxId')!,
    idempotencyKey: c.req.header('Idempotency-Key') ?? raw.idempotencyKey,
    kind,
    originalEmailId: kind === 'send' ? undefined : c.req.param('id'),
    request: raw as SendMailCommand['request'],
  });
  if ('error' in result) {
    const status = result.code === 'IDEMPOTENCY_CONFLICT' ? 409 : result.code === 'NOT_FOUND' ? 404 : 400;
    return c.json(result, status);
  }
  if (result.status === 'unknown') return c.json({ ...result, error: msg('Send outcome is unknown; do not resend automatically') }, 409);
  if (result.status === 'failed') return c.json({ ...result, error: msg('Email was not accepted by the transport') }, result.errorCode === 'RATE_LIMIT' ? 429 : 502);
  return c.json(result, result.status === 'accepted' ? 200 : 202);
}
export const handleReplyEmail = (c: Context<MailboxContext>) => handleSendEmail(c, 'reply');
export const handleForwardEmail = (c: Context<MailboxContext>) => handleSendEmail(c, 'forward');
