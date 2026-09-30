import type { SendMailRequest } from '../../shared/mail/send';
import type { SendEmailParams } from '../email-sender';
import type { OutboxRow } from './outbox-store';
import { buildThreadingHeaders } from '../lib/email-helpers';
export interface PreparedMail {
  request: SendMailRequest;
}
export function transportParams(payload: PreparedMail): SendEmailParams {
  const { in_reply_to, references, thread_id: _threadId, auto_submitted, ...message } = payload.request;
  const headers: Record<string, string> = {
    ...(in_reply_to ? buildThreadingHeaders(in_reply_to, references || []) : {}),
    ...(auto_submitted ? { "Auto-Submitted": "auto-replied" } : {}),
  };
  return { ...message, ...(Object.keys(headers).length ? { headers } : {}) };
}
/** A provider receipt that is not an RFC Message-ID must not become a made-up header. */
export function receiptMessageId(receipt: string | null): string | null {
  if (!receipt) return null;
  const bare = receipt.trim().replace(/^<|>$/g, '');
  return /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? bare : null;
}
export function sentProjection(payload: PreparedMail, row: OutboxRow) {
  const request = payload.request;
  const address = (value: string | string[] | undefined) => value ? (Array.isArray(value) ? value.join(', ') : value) : '';
  const messageId = receiptMessageId(row.provider_message_id);
  const threading = request.in_reply_to ? buildThreadingHeaders(request.in_reply_to, request.references || []) : {};
  const headers = [
    { key: 'from', value: typeof request.from === 'string' ? request.from : `${request.from.name} <${request.from.email}>` },
    { key: 'to', value: address(request.to) },
    ...(request.cc ? [{ key: 'cc', value: address(request.cc) }] : []),
    { key: 'subject', value: request.subject },
    ...(messageId ? [{ key: 'message-id', value: `<${messageId}>` }] : []),
    ...Object.entries(threading).map(([key, value]) => ({ key: key.toLowerCase(), value })),
  ];
  return {
    id: row.id, subject: request.subject,
    sender: (typeof request.from === 'string' ? request.from : request.from.email).toLowerCase(),
    recipient: address(request.to).toLowerCase(), cc: address(request.cc).toLowerCase() || null,
    bcc: address(request.bcc).toLowerCase() || null, date: new Date(row.created_at).toISOString(),
    body: request.html || request.text || '', in_reply_to: request.in_reply_to || null,
    email_references: request.references?.length ? JSON.stringify(request.references) : null,
    thread_id: request.thread_id || request.in_reply_to || row.id, message_id: messageId,
    raw_headers: JSON.stringify(headers),
  };
}
