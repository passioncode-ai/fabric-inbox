/**
 * The part of an address before @ (SCN-061, SCN-064): one check for the Add address dialog, the
 * server's routes and the agent protocol, so the three can never disagree about what is allowed.
 * Every refusal says what to type instead. Plain module: the tests, the Worker and the app load it.
 */

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
  postmaster: "Other mail servers write to postmaster@ about delivery problems; a domain that receives mail is expected to have it (RFC 5321).",
  abuse: "Reports of spam or abuse sent from your domain arrive at abuse@ (RFC 2142).",
  hostmaster: "Problems with the domain's DNS are reported to hostmaster@ (RFC 2142).",
  webmaster: "Problems with your website are reported to webmaster@ (RFC 2142).",
  security: "Security researchers write to security@ to report a vulnerability.",
  "mailer-daemon": "Bounce messages are sent in mailer-daemon's name; what arrives here is usually automatic.",
  noreply: "People do answer no-reply addresses: their replies will arrive here.",
  "no-reply": "People do answer no-reply addresses: their replies will arrive here.",
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

const quoteList = (chars: string[]) => chars.map((c) => `“${c}”`).join(chars.length === 2 ? " and " : ", ");

export function checkLocalPart(raw: string): LocalPartCheck {
  const value = raw.trim().toLowerCase();
  const fail = (problem: string): LocalPartCheck => ({ value, valid: false, problem, note: null });
  if (!value) return fail("Type the part before @, such as support.");
  if (value.includes("@")) return fail("Type only the part before @: the domain is chosen beside it.");
  if (/\s/.test(value)) return fail("Spaces are not allowed: use a dot or a dash instead (first.last).");
  const bad = [...new Set([...value].filter((c) => !ALLOWED.test(c)))];
  if (bad.length) {
    const shown = bad.slice(0, 3);
    return fail(`${quoteList(shown)} ${shown.length === 1 ? "is" : "are"} not allowed: use letters a–z, digits, dots, dashes, underscores or plus.`);
  }
  if (value.length > LOCAL_PART_MAX) return fail(`Too long: ${value.length} characters; at most ${LOCAL_PART_MAX}.`);
  if (!/^[a-z0-9]/.test(value) || !/[a-z0-9]$/.test(value)) return fail("It must start and end with a letter or digit.");
  if (value.includes("..")) return fail("Two dots in a row are not allowed.");
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
 * address on the chosen domain counts as its name; one on another domain and a repeat are set aside
 * with the reason. Only names that can be created count toward the 50; invalid ones are listed with
 * why (up to 50 of them too), and whatever is past either limit is said once, with how many.
 */
export function parseLocalParts(text: string, domain: string): ParsedNames {
  const entries: ParsedNames["entries"] = [];
  const skipped: ParsedNames["skipped"] = [];
  const seen = new Set<string>();
  const wanted = domain.trim().toLowerCase();
  let valid = 0;
  let over = 0;
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    let name = token;
    const at = token.lastIndexOf("@");
    if (at > 0) {
      const other = token.slice(at + 1).toLowerCase();
      if (other !== wanted) { skipped.push({ input: token, reason: `${token} is on ${other}, not ${wanted}.` }); continue; }
      name = token.slice(0, at);
    }
    const check = checkLocalPart(name);
    if (seen.has(check.value)) { skipped.push({ input: token, reason: `${check.value} is listed already.` }); continue; }
    if (check.valid ? valid >= BATCH_MAX : entries.length - valid >= BATCH_MAX) { over++; continue; }
    seen.add(check.value);
    entries.push({ input: token, check });
    if (check.valid) valid++;
  }
  if (over) skipped.push({ input: "…", reason: `${over} more ${over === 1 ? "name was" : "names were"} left out: at most ${BATCH_MAX} at once.` });
  return { entries, skipped };
}
