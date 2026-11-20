/**
 * B-309: secrets taken out of mail text before it leaves the server for Memory or reaches a model. Mail carries sign-in
 * codes, reset links, API keys, passwords a person sent themselves and card numbers; none of it belongs in a knowledge
 * graph or a model's prompt. Pure and deterministic: each find is replaced by a fixed marker naming its kind, so a
 * citation Memory checks against the text it was given still matches, and the counts (never the values) are logged.
 *
 * What is found:
 * - key: a provider key or token by its known shape (OpenAI-style `sk-…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox…`,
 *   AWS `AKIA…`, Google `AIza…`, Stripe `sk_live_…`/`rk_live_…`, a JSON Web Token, a `Bearer …` header value);
 * - password: the value after "password", "passcode", "pwd", "пароль" and a colon or equals sign;
 * - code: a one-time code of 4 to 8 digits after "code", "OTP", "PIN", "код";
 * - link: a URL whose query names a token, a key, a code, a signature or a password;
 * - card: 13 to 19 digits (spaces or hyphens allowed between) that pass the Luhn check.
 */

export type RedactKind = "key" | "password" | "code" | "link" | "card";
export interface Redacted { text: string; count: number; kinds: Partial<Record<RedactKind, number>> }

export const REDACTED = (kind: RedactKind) => `[redacted ${kind}]`;

const KEY_SHAPES: RegExp[] = [
  /\b(?:sk|pk|rk)-(?:proj-|or-v1-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
];
const PASSWORD = /(?<![\p{L}\p{N}_])(password|passcode|passwd|pwd|пароль)(\s*[:=]\s*|\s+is\s+)(\S{3,128})/giu;
const CODE = /(?<![\p{L}\p{N}_])(code|otp|pin|код)(\s*(?:is|:|=|\u2014|-)?\s*)(\d{4,8})(?!\d)/giu;
const SECRET_LINK = /\bhttps?:\/\/[^\s<>"')]+[?&#](?:[^\s<>"')]*&)?(?:token|access_token|key|api_key|apikey|code|sig|signature|password|secret|auth)=[^\s<>"')]+/gi;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The text with every secret it shows replaced, and how many of each kind were. */
export function redactSecrets(input: string): Redacted {
  const kinds: Partial<Record<RedactKind, number>> = {};
  const hit = (kind: RedactKind) => { kinds[kind] = (kinds[kind] ?? 0) + 1; };
  let text = String(input ?? "");
  // Links first: a token inside a URL is one find, not a key and a link.
  text = text.replace(SECRET_LINK, () => { hit("link"); return REDACTED("link"); });
  for (const shape of KEY_SHAPES) {
    text = text.replace(shape, (_m, bearer?: string) => { hit("key"); return typeof bearer === "string" && /^bearer$/i.test(bearer) ? `${bearer} ${REDACTED("key")}` : REDACTED("key"); });
  }
  text = text.replace(PASSWORD, (_m, word: string, sep: string) => { hit("password"); return `${word}${sep}${REDACTED("password")}`; });
  text = text.replace(CODE, (_m, word: string, sep: string) => { hit("code"); return `${word}${sep}${REDACTED("code")}`; });
  text = text.replace(CARD, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    hit("card");
    return REDACTED("card");
  });
  const count = Object.values(kinds).reduce((a, b) => a + (b ?? 0), 0);
  return { text, count, kinds };
}
