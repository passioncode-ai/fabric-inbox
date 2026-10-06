/**
 * The part of an address before @ (SCN-061, SCN-064): one check for the Add address dialog, the
 * server's routes and the agent protocol, so the three can never disagree about what is allowed.
 * Every refusal says what to type instead. Plain module: the tests, the Worker and the app load it.
 */
import { msg } from "./i18n";

/** RFC 5321 limits the part before @ to 64 characters. */
export const LOCAL_PART_MAX = 64;
/** How many addresses one request may create (Add address → Several, create_addresses). */
export const BATCH_MAX = 50;

/**
 * What the server stores: lower case; letters, digits, dot, dash, underscore and plus; a letter or
 * digit at each end; never two dots in a row; at most 64 characters.
 */
export const LOCAL_PART_RE = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

const ALLOWED = /[a-z0-9._+-]/;

/** Role names other mail servers and people write to on any domain (RFC 2142, RFC 5321). */
const ROLE_NOTES: Record<string, string> = {
  postmaster: msg("Other mail servers write to postmaster@ about delivery problems; a domain that receives mail is expected to have it (RFC 5321)."),
  abuse: msg("Reports of spam or abuse sent from your domain arrive at abuse@ (RFC 2142)."),
  hostmaster: msg("Problems with the domain's DNS are reported to hostmaster@ (RFC 2142)."),
  webmaster: msg("Problems with your website are reported to webmaster@ (RFC 2142)."),
  security: msg("Security researchers write to security@ to report a vulnerability."),
  "mailer-daemon": msg("Bounce messages are sent in mailer-daemon's name; what arrives here is usually automatic."),
  noreply: msg("People do answer no-reply addresses: their replies will arrive here."),
  "no-reply": msg("People do answer no-reply addresses: their replies will arrive here."),
};

export interface LocalPartCheck {
  /** Trimmed and lower case: what would be created. */
  value: string;
  valid: boolean;
  /** Why it cannot be created, in words; null when it can. */
  problem: string | null;
  /** Worth knowing but not a refusal (a role name). */
  note: string | null;
}

export const roleNote = (localPart: string): string | null => ROLE_NOTES[localPart.trim().toLowerCase()] ?? null;

const quoted = (c: string) => `“${c}”`;
/** The characters that may not be used, said in one sentence per count so it translates whole (L10N-04). */
const notAllowed = (chars: string[]) =>
  chars.length === 1 ? msg("{char} is not allowed: use letters a–z, digits, dots, dashes, underscores or plus.", { char: quoted(chars[0]!) })
    : chars.length === 2 ? msg("{a} and {b} are not allowed: use letters a–z, digits, dots, dashes, underscores or plus.", { a: quoted(chars[0]!), b: quoted(chars[1]!) })
      : msg("{chars} are not allowed: use letters a–z, digits, dots, dashes, underscores or plus.", { chars: chars.map(quoted).join(", ") });

export function checkLocalPart(raw: string): LocalPartCheck {
  const value = raw.trim().toLowerCase();
  const fail = (problem: string): LocalPartCheck => ({ value, valid: false, problem, note: null });
  if (!value) return fail(msg("Type the part before @, such as support."));
  if (value.includes("@")) return fail(msg("Type only the part before @: the domain is chosen beside it."));
  if (/\s/.test(value)) return fail(msg("Spaces are not allowed: use a dot or a dash instead (first.last)."));
  const bad = [...new Set([...value].filter((c) => !ALLOWED.test(c)))];
  if (bad.length) {
    return fail(notAllowed(bad.slice(0, 3)));
  }
  if (value.length > LOCAL_PART_MAX) return fail(msg("Too long: {length} characters; at most {max}.", { length: value.length, max: LOCAL_PART_MAX }));
  if (!/^[a-z0-9]/.test(value) || !/[a-z0-9]$/.test(value)) return fail(msg("It must start and end with a letter or digit."));
  if (value.includes("..")) return fail(msg("Two dots in a row are not allowed."));
  return { value, valid: true, problem: null, note: roleNote(value) };
}

/** "alex.morgan" → "Alex Morgan": the name mail from the address is sent with, until the person types one. */
export function suggestDisplayName(localPart: string): string {
  return localPart.trim().toLowerCase().split(/[._+-]+/).filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

export interface ParsedNames {
  /** Each distinct name in the order typed, with its check. */
  entries: { input: string; check: LocalPartCheck }[];
  /** What was typed but set aside, with why. */
  skipped: { input: string; reason: string }[];
}

/**
 * Several names typed at once: one per line, or separated by commas, semicolons or spaces. A full
 * address on the chosen domain counts as its name; one on another domain, a repeat and anything past
 * the 50th are set aside with the reason.
 */
export function parseLocalParts(text: string, domain: string): ParsedNames {
  const entries: ParsedNames["entries"] = [];
  const skipped: ParsedNames["skipped"] = [];
  const seen = new Set<string>();
  const wanted = domain.trim().toLowerCase();
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    let name = token;
    const at = token.lastIndexOf("@");
    if (at > 0) {
      const other = token.slice(at + 1).toLowerCase();
      if (other !== wanted) { skipped.push({ input: token, reason: msg("{address} is on {domain}, not {wanted}.", { address: token, domain: other, wanted }) }); continue; }
      name = token.slice(0, at);
    }
    const check = checkLocalPart(name);
    if (seen.has(check.value)) { skipped.push({ input: token, reason: msg("{name} is listed already.", { name: check.value }) }); continue; }
    if (entries.length >= BATCH_MAX) { skipped.push({ input: token, reason: msg("At most {max} addresses at once.", { max: BATCH_MAX }) }); continue; }
    seen.add(check.value);
    entries.push({ input: token, check });
  }
  return { entries, skipped };
}
