/**
 * The untrusted-fence pattern (the agents database's `untrusted-fence`; S06, B-271): text other people wrote (an incoming
 * message, a subject, a source title, an agent's draft) reaches a model only inside a fenced block that the model is told
 * is data. The fence carries a fresh random token for every block, so text inside it cannot close it; one preamble line
 * says what the block is; every field is stripped of characters a person does not see and capped in length; a line that
 * imitates any fence is neutralised. The reply agent passes untrusted text as JSON fields (workers/agents/runner.ts);
 * this is the one helper for prose prompts, and the only fence implementation in the repository.
 */

/**
 * Characters a person does not see but a model reads: format characters (zero-width spaces and joiners, bidirectional
 * controls, the byte order mark, tag characters), control characters other than a line break or a tab, and the
 * variation selectors, removed before anything is fenced.
 */
const HIDDEN = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

export function stripHidden(text: string): string {
  return text.replace(HIDDEN, "").replace(/\r\n?/g, "\n");
}

/** The fence's marker; a field that contains it (with any token) has it changed, so no line imitates a fence. */
export const FENCE_MARK = "UNTRUSTED-DATA-";

/** One field of the block: its label (our words) and its value (theirs), at most `max` characters. */
export interface FencedField {
  label: string;
  value: string;
  max: number;
}

const randomToken = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** A field's value made safe to fence: hidden characters gone, fence lookalikes changed, capped. */
export function fenceValue(value: string, max: number): string {
  const clean = stripHidden(value).split(FENCE_MARK).join("UNTRUSTED_DATA_");
  return clean.length > max ? clean.slice(0, max) + " [cut]" : clean;
}

/**
 * The fenced block: a preamble line, then the fence, the fields, the fence again. `token` is for tests; every real call
 * takes a fresh random one.
 */
export function fenceUntrusted(fields: readonly FencedField[], preamble: string, token: string = randomToken()): string {
  const fence = `${FENCE_MARK}${token}`;
  const body = fields.map((f) => `${f.label}: ${fenceValue(f.value, f.max)}`).join("\n");
  return `${preamble}\n${fence}\n${body}\n${fence}`;
}
