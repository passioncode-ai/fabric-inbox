import { EMPTY_DISCARD_STORE, normaliseDiscardStore, type DiscardFacts, type DiscardStore } from "../../shared/mail/discard";

/**
 * The workspace's discard rules and its Always allow list (shared/mail/discard.ts): one R2 object,
 * read on every arrival a rule may apply to and written when the person discards or changes a rule.
 * Writes are conditional on the version read (as the spam lists are), so two discards at once both
 * land.
 */
export const DISCARD_KEY = "config/discard.json";

export async function readDiscardStore(bucket: R2Bucket): Promise<DiscardStore> {
  const object = await bucket.get(DISCARD_KEY);
  if (!object) return { ...EMPTY_DISCARD_STORE, rules: [], allowed: [] };
  return normaliseDiscardStore(await object.json().catch(() => null));
}

export class DiscardStoreConflict extends Error {}

/** Applies `change` to the stored rules; retries when another write came first. */
export async function updateDiscardStore(bucket: R2Bucket, change: (store: DiscardStore) => DiscardStore): Promise<DiscardStore> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(DISCARD_KEY);
    const current = object ? normaliseDiscardStore(await object.json().catch(() => null)) : { rules: [], allowed: [] };
    const next = normaliseDiscardStore(change(current));
    const written = await bucket.put(DISCARD_KEY, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      // A first write succeeds only while nothing is there (RFC 7232 If-None-Match: *).
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new DiscardStoreConflict("The discard rules changed several times at once; try again");
}

const EXPLAIN_PROMPT = `You explain in one short sentence (at most 20 words) why a person might throw away an email like this one, judging only from its sender, list and subject. Answer with the sentence alone, no quotes. If you cannot tell, answer: unknown.`;

/**
 * A model's one-line reason for a discard, when the server has Workers AI: optional, bounded to 8
 * seconds and 200 characters, and null on any failure (the rule stands without it). The text is the
 * model's guess, shown as such; the sender's own words are passed as data in the user turn.
 */
export async function explainDiscard(ai: Ai | undefined, facts: DiscardFacts, subject: string): Promise<string | null> {
  if (!ai) return null;
  const input = JSON.stringify({ sender: facts.sender, list: facts.list?.name ?? facts.list?.id ?? null, newsletter: facts.newsletter, category: facts.category ?? null, subject: subject.slice(0, 200) });
  try {
    const answer = await Promise.race([
      ai.run(
        // @ts-expect-error — model string not in generated union
        "@cf/meta/llama-3.1-8b-instruct-fast",
        { messages: [{ role: "system", content: EXPLAIN_PROMPT }, { role: "user", content: input }], max_tokens: 60, temperature: 0 },
      ) as Promise<{ response?: string }>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);
    const text = (answer?.response ?? "").replace(/\s+/g, " ").replace(/^["'«]|["'»]$/g, "").trim();
    if (!text || /^unknown\.?$/i.test(text)) return null;
    return text.slice(0, 200);
  } catch (error) {
    console.warn(JSON.stringify({ event: "discard_explain_failed", error: (error as Error)?.message?.slice(0, 120) }));
    return null;
  }
}
