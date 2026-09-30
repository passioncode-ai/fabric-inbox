/** Trusted image URLs come from attachment metadata, never from the email HTML. */
export interface InlineAttachments {
  mailboxId: string;
  emailId: string;
  attachmentIds: string[];
}
const segment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function attachmentPath(mailboxId: string, emailId: string, attachmentId: string) {
  return `/api/v1/mailboxes/${segment(mailboxId)}/emails/${segment(emailId)}/attachments/${segment(attachmentId)}`;
}
export function mailImagePolicy(remote: boolean, origin: string, inline?: InlineAttachments) {
  const url = new URL(origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid application origin');
  const images = ['data:', 'cid:'];
  if (inline) images.push(...inline.attachmentIds.map(id => origin + attachmentPath(inline.mailboxId, inline.emailId, id)));
  if (remote) images.push('https:');
  return `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src ${images.join(' ')}; script-src 'unsafe-inline';`;
}
export interface InlineAttachmentRef {
  id: string;
  content_id?: string | null;
  disposition?: string | null;
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Rewrite `cid:` references in email HTML to the attachment route of the inline part.
 * A reference ends where the URL ends (quote, whitespace, `)`, `<`, `>`, `\` or end of
 * text), so the part `img1` never rewrites `cid:img10`. The URL is inserted literally:
 * `$` patterns in an attachment ID are not replacement syntax.
 */
export function rewriteInlineImages(
  body: string,
  mailboxId: string,
  emailId: string,
  attachments?: InlineAttachmentRef[],
): string {
  if (!body || !attachments?.length) return body;
  let result = body;
  for (const att of attachments) {
    if (att.disposition !== 'inline' || !att.content_id) continue;
    const cid = att.content_id.trim().replace(/^<(.*)>$/, '$1');
    if (!cid) continue;
    const url = attachmentPath(mailboxId, emailId, att.id);
    const reference = new RegExp(`cid:${escapeRegExp(cid)}(?![^\\s"'<>()\\\\])`, 'gi');
    result = result.replace(reference, () => url);
  }
  return result;
}
