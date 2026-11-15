/**
 * B-277: a forward draft's origin, kept by the server apart from the message. The app writes it as an
 * opaque JSON string with each save of a forward (a save without it leaves it as it was) (`app/components/inbox/forward-meta.ts`) and reads it
 * back when it opens the draft on a device with no copy. It lives in the mailbox's bucket, never in
 * the message's headers, HTML or text, so no send (the person's, an agent's `send_draft`, Gmail's own
 * window) carries it. A failed write or delete is logged and never fails the save, delete or send.
 */
export const FORWARD_META_MAX = 200_000;

/** The object's key: a Cloudflare address's draft, or a provider account's. */
export function forwardKey(owner: { mailbox: string } | { account: string }, draftId: string): string {
  return "mailbox" in owner
    ? `draft-forward/${encodeURIComponent(owner.mailbox.toLowerCase())}/${encodeURIComponent(draftId)}.json`
    : `draft-forward/accounts/${encodeURIComponent(owner.account)}/${encodeURIComponent(draftId)}.json`;
}

/** Whether a value is a forward meta the server keeps: a JSON object within the size limit. */
export function validForward(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > FORWARD_META_MAX) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Writes the meta a save carried (none: the meta stays as it was, so an older app or an agent's
 * `update_draft` never erases it). `revision` (a Cloudflare draft's number) keeps a late writer from
 * putting back an older meta over a newer one; `onlyIfAbsent` (a Gmail creation, whose replay may carry
 * an older meta) writes only where none is kept yet.
 */
export async function storeForward(bucket: R2Bucket, key: string, value: string | undefined, route: string,
  { revision, onlyIfAbsent = false }: { revision?: number; onlyIfAbsent?: boolean } = {}): Promise<void> {
  if (!value) return;
  try {
    if (onlyIfAbsent || revision !== undefined) {
      const kept = await bucket.head(key);
      if (kept && onlyIfAbsent) return;
      const keptRevision = Number(kept?.customMetadata?.revision);
      if (kept && revision !== undefined && Number.isFinite(keptRevision) && keptRevision > revision) return;
    }
    await bucket.put(key, value, { httpMetadata: { contentType: "application/json" }, ...(revision !== undefined ? { customMetadata: { revision: String(revision) } } : {}) });
  } catch (error) {
    console.warn(JSON.stringify({ event: "draft_forward_store_failed", route, error: String(error).slice(0, 200) }));
  }
}

/** Removes a draft's meta (the draft was deleted or sent). */
export async function removeForward(bucket: R2Bucket, key: string, route: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch (error) {
    console.warn(JSON.stringify({ event: "draft_forward_store_failed", route, error: String(error).slice(0, 200) }));
  }
}

/** The meta kept for a draft, or null. */
export async function readForward(bucket: R2Bucket, key: string): Promise<string | null> {
  try {
    const object = await bucket.get(key);
    return object ? await object.text() : null;
  } catch (error) {
    console.warn(JSON.stringify({ event: "draft_forward_store_failed", route: "read", error: String(error).slice(0, 200) }));
    return null;
  }
}

