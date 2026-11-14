/**
 * The one rule for "which message of the conversation does this reply answer" (S07, KIMI-49): its In-Reply-To when that
 * names a message of the conversation, else the last References entry that does. The reader's thread (S05, which cell a
 * reply answers) and the server (S07, which agent drafts a sent reply retires, at acceptance and at Sent sync) both use
 * this function, so they never disagree. No subject is ever compared.
 */

/** A Message-ID without its angle brackets, lower case; "" for nothing. */
export const bareMessageId = (id: string | null | undefined): string => (id ?? "").trim().replace(/^<|>$/g, "").toLowerCase();

/**
 * The ids a References value lists, oldest first. It is a header line ("<a> <b>") or, as this server stores a sent
 * message's, a JSON array of ids.
 */
export function referenceIds(value: string | readonly string[] | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(bareMessageId).filter(Boolean);
  const text = String(value).trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed.map((v) => bareMessageId(String(v))).filter(Boolean);
    } catch { /* a header line after all */ }
  }
  return text.split(/[\s,]+/).map(bareMessageId).filter(Boolean);
}

/** What a reply names: its In-Reply-To and its References. */
export interface ReplyHeaders {
  inReplyTo?: string | null;
  references?: string | readonly string[] | null;
}

/**
 * The id the reply answers among `known` (bare ids, see `bareMessageId`): In-Reply-To when known, else the last
 * References entry that is known; null when it names none. `named` says whether it names anything at all, so a caller
 * can tell "answers a message not in this conversation" from "answers nothing".
 */
export function replyTarget(reply: ReplyHeaders, known: (bareId: string) => boolean): { target: string | null; named: boolean } {
  const inReplyTo = bareMessageId(reply.inReplyTo);
  const refs = referenceIds(reply.references);
  const named = !!inReplyTo || refs.length > 0;
  if (inReplyTo && known(inReplyTo)) return { target: inReplyTo, named };
  for (let i = refs.length - 1; i >= 0; i--) if (known(refs[i]!)) return { target: refs[i]!, named };
  return { target: null, named };
}
