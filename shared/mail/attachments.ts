/** Shared wire contract: canonical RFC 4648 base64, with limits on decoded bytes. */
export interface MailAttachment {
  content: string;
  filename: string;
  type: string;
  disposition: 'attachment' | 'inline';
  /** Bare Content-ID, without angle brackets. */
  contentId?: string;
}
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_SEND_REQUEST_BYTES = 16 * 1024 * 1024;
export class AttachmentValidationError extends Error {
  constructor(public code: 'invalid_attachment' | 'message_too_large', public status: 400 | 413) {
    super(code);
    this.name = 'AttachmentValidationError';
  }
}
const invalid = (): never => { throw new AttachmentValidationError('invalid_attachment', 400); };
const tooLarge = (): never => { throw new AttachmentValidationError('message_too_large', 413); };
const encoder = new TextEncoder();
const controls = /[\x00-\x1f\x7f-\x9f]/;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function validateAttachments(value: unknown): MailAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid();
  if (value.length > MAX_ATTACHMENTS) return tooLarge();
  let total = 0;
  return value.map((item): MailAttachment => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
    const { content, filename, type, disposition, contentId } = item;
    if (typeof content !== 'string') return invalid();
    // Reject oversized input before scanning/decoding it. No large temporary byte array.
    if (content.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) return tooLarge();
    if (content.length % 4) return invalid();
    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
    const data = padding ? content.slice(0, -padding) : content;
    if (/[^A-Za-z0-9+/]/.test(data) || (padding && !data.length)) return invalid();
    // Padding bits must be zero: reject alternate encodings such as Zh== for Zg==.
    if (padding && (alphabet.indexOf(data.at(-1)!) & (padding === 2 ? 15 : 3))) return invalid();
    total += content.length / 4 * 3 - padding;
    if (total > MAX_ATTACHMENT_BYTES) return tooLarge();
    if (typeof filename !== 'string' || !filename.trim() || filename === '.' || filename === '..' ||
        controls.test(filename) || /[/\\]/.test(filename) || encoder.encode(filename).length > 255 ||
        new TextDecoder().decode(encoder.encode(filename)) !== filename) return invalid();
    if (typeof type !== 'string' || type.length > 127 ||
        !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(type)) return invalid();
    if (disposition !== 'attachment' && disposition !== 'inline') return invalid();
    if (contentId !== undefined && (typeof contentId !== 'string' ||
        !/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~@]{1,200}$/.test(contentId))) return invalid();
    return { content, filename, type: type.toLowerCase(), disposition, ...(contentId !== undefined ? { contentId } : {}) };
  });
}

/**
 * A stored attachment's name: path and control characters replaced, and cut to 200 UTF-8 bytes
 * keeping its extension. It is part of an R2 key, which may not exceed 1024 bytes — an inbound
 * name of 600 "é" made the message impossible to store (2026-10-01 review).
 */
export function storedAttachmentName(name: string | null | undefined, maxBytes = 200): string {
  const clean = (name || 'untitled').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim() || 'untitled';
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  if (bytes(clean) <= maxBytes) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
  let stem = [...clean.slice(0, clean.length - ext.length)];
  while (stem.length && bytes(stem.join('') + ext) > maxBytes) stem.pop();
  return (stem.join('') || 'untitled') + ext;
}
