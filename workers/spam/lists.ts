import { normaliseLists, type SpamLists } from "../../shared/mail/spam";

/**
 * The operator's spam lists (SP-1, SP-3, SP-6): one R2 object for the workspace.
 * Writes are conditional on the version read, so two reports at once never lose one.
 */
export const SPAM_LISTS_KEY = "config/spam.json";
export const EMPTY_SPAM_LISTS: SpamLists = { blockedSenders: [], blockedDomains: [], allowedSenders: [], allowedDomains: [] };

export async function readSpamLists(bucket: R2Bucket): Promise<SpamLists> {
  const object = await bucket.get(SPAM_LISTS_KEY);
  if (!object) return { ...EMPTY_SPAM_LISTS };
  return normaliseLists(await object.json().catch(() => null));
}

export class SpamListConflict extends Error {}

/** Applies `change` to the stored lists; retries when another write came first. */
export async function updateSpamLists(bucket: R2Bucket, change: (lists: SpamLists) => SpamLists): Promise<SpamLists> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(SPAM_LISTS_KEY);
    const current = object ? normaliseLists(await object.json().catch(() => null)) : { ...EMPTY_SPAM_LISTS };
    const next = normaliseLists(change(current));
    const written = await bucket.put(SPAM_LISTS_KEY, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      // A first write succeeds only while nothing is there (RFC 7232 If-None-Match: *).
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new SpamListConflict("The spam lists changed several times at once; try again");
}

/** Blocking puts the entry on the blocked list and takes it off the allowed one, and the reverse. */
export function listChange(lists: SpamLists, entry: { kind: "sender" | "domain"; value: string }, to: "blocked" | "allowed" | "none"): SpamLists {
  const pick = entry.kind === "sender" ? (["blockedSenders", "allowedSenders"] as const) : (["blockedDomains", "allowedDomains"] as const);
  const without = (xs: string[]) => xs.filter((x) => x !== entry.value);
  const next = { ...lists, [pick[0]]: without(lists[pick[0]]), [pick[1]]: without(lists[pick[1]]) };
  if (to === "blocked") next[pick[0]] = [entry.value, ...next[pick[0]]];
  if (to === "allowed") next[pick[1]] = [entry.value, ...next[pick[1]]];
  return next;
}
