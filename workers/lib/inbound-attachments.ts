/**
 * B-34: the files of an incoming message go to R2 a few at a time, and at most
 * INBOUND_MAX_ATTACHMENTS of them: every R2 write is a subrequest of the one delivery, and a message
 * made of hundreds of tiny parts must not use up the invocation's allowance or its time. Files past
 * the cap are not stored; the delivery says how many in its log and in what it returns.
 */
import type { StoredAttachment } from "./attachments";

export const INBOUND_MAX_ATTACHMENTS = 100;
export const INBOUND_WRITES_AT_ONCE = 6;

export interface InboundPart { filename?: string | null; mimeType: string; content: ArrayBuffer | Uint8Array | string; contentId?: string; disposition?: string | null }

export async function storeInboundAttachments(
  bucket: Pick<R2Bucket, "put">,
  messageId: string,
  parts: readonly InboundPart[],
  name: (filename: string | null | undefined) => string,
): Promise<{ stored: StoredAttachment[]; dropped: number }> {
  const kept = parts.slice(0, INBOUND_MAX_ATTACHMENTS);
  const stored: StoredAttachment[] = kept.map((att, index) => {
    const content = att.content;
    return { id: `${messageId}-${index}`, email_id: messageId, filename: name(att.filename), mimetype: att.mimeType,
      size: typeof content === "string" ? content.length : content.byteLength,
      content_id: att.contentId || null, disposition: att.disposition || "attachment" };
  });
  for (let i = 0; i < kept.length; i += INBOUND_WRITES_AT_ONCE)
    await Promise.all(kept.slice(i, i + INBOUND_WRITES_AT_ONCE).map((att, j) => {
      const row = stored[i + j]!;
      return bucket.put(`attachments/${messageId}/${row.id}/${row.filename}`, att.content);
    }));
  return { stored, dropped: parts.length - kept.length };
}
