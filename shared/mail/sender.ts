/**
 * The sender a person reads. A Cloudflare mailbox keeps the sender's address in `sender` (rules,
 * spam lists and replies match on it) and, since 2026-10-08, the name the message gave in
 * `sender_name`. Rows stored before that still carry the From header in `raw_headers`, so the
 * name is read from there. The answer is "Name <address>", the form Gmail rows already use, or
 * the bare address when the message named nobody (or named a different address).
 */

const MAX_NAME = 120;

/** A display name safe to show and to put back into a header: no controls, brackets or quotes. */
export function cleanSenderName(name: string | null | undefined): string | null {
  const clean = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f<>"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return clean || null;
}

/** RFC 2047 encoded words in UTF-8 (=?UTF-8?B?…?= and =?UTF-8?Q?…?=); anything else is left as it is. */
function decodeWords(value: string): string {
  return value.replace(/=\?utf-8\?([bq])\?([^?]*)\?=\s*/gi, (whole, kind: string, text: string) => {
    try {
      const bytes = kind.toLowerCase() === "b"
        ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
        : Uint8Array.from(
          text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
          (c) => c.charCodeAt(0),
        );
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/** The name in a stored From header, when that header names this address. */
export function nameFromHeaders(address: string, rawHeaders: string | null | undefined): string | null {
  if (!rawHeaders) return null;
  let headers: unknown;
  try { headers = JSON.parse(rawHeaders); } catch { return null; }
  if (!Array.isArray(headers)) return null;
  const from = headers.find((h) => h && typeof h.key === "string" && h.key.toLowerCase() === "from");
  const value = typeof from?.value === "string" ? from.value : "";
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  if (!match || match[2].trim().toLowerCase() !== address.trim().toLowerCase()) return null;
  return cleanSenderName(decodeWords(match[1]).replace(/^"(.*)"$/, "$1"));
}

export function displaySender(address: string | null | undefined, name?: string | null, rawHeaders?: string | null): string {
  const email = String(address ?? "").trim();
  if (!email) return "";
  const shown = cleanSenderName(name) ?? nameFromHeaders(email, rawHeaders);
  if (!shown || shown.toLowerCase() === email.toLowerCase()) return email;
  return /[(),.:;@[\]]/.test(shown) ? `"${shown}" <${email}>` : `${shown} <${email}>`;
}
