/**
 * Mail to an address of a served domain that has no mailbox (SCN-025): one R2 object per address,
 * `unknown-recipients/<domain>/<address>.json`, for the Create address list. Only the address, its
 * domain, the action, counts and times are kept: no sender, subject or body.
 *
 * B-10: the count is written on the etag it read (a new address only if none exists), so two
 * deliveries at once both count; and a domain keeps at most UNKNOWN_PER_DOMAIN addresses, so mail to
 * random addresses cannot grow the bucket without bound. At the cap, the address seen longest ago
 * gives way when it was last seen more than UNKNOWN_STALE_MS ago; otherwise the new one is not kept.
 */
import { bodyForUpdate } from "./r2-json";

export const UNKNOWN_PREFIX = "unknown-recipients/";
export const UNKNOWN_PER_DOMAIN = 500;
export const UNKNOWN_STALE_MS = 30 * 86_400_000;

type Bucket = Pick<R2Bucket, "get" | "put" | "list" | "delete">;
export type UnknownOutcome = "counted" | "capped";

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
export const unknownRecipientKey = (address: string) => `${UNKNOWN_PREFIX}${domainOf(address)}/${address}.json`;

/** Makes room for a new address of `domain`; false when the domain is full of recently seen ones. */
async function room(bucket: Bucket, domain: string, now: number): Promise<boolean> {
  const page = await bucket.list({ prefix: `${UNKNOWN_PREFIX}${domain}/`, limit: UNKNOWN_PER_DOMAIN });
  if (page.objects.length < UNKNOWN_PER_DOMAIN) return true;
  // An object's upload time is its last count, so the oldest is found without reading any body.
  const oldest = page.objects.reduce((a, b) => (a.uploaded <= b.uploaded ? a : b));
  if (now - oldest.uploaded.getTime() <= UNKNOWN_STALE_MS) return false;
  await bucket.delete(oldest.key);
  return true;
}

export async function recordUnknownRecipient(bucket: Bucket, address: string, action: "rejected" | "catch_all", now = new Date()): Promise<UnknownOutcome> {
  const key = unknownRecipientKey(address);
  const at = now.toISOString();
  for (let attempt = 0; attempt < 10; attempt++) {
    const object = await bucket.get(key);
    if (!object && !(await room(bucket, domainOf(address), now.getTime()))) return "capped";
    const prior = object ? ((await bodyForUpdate(object)) as { firstSeen?: string; count?: number } | null) : null;
    const written = await bucket.put(key, JSON.stringify({
      address, domain: domainOf(address), action,
      firstSeen: prior?.firstSeen ?? at, lastSeen: at, count: (Number(prior?.count) || 0) + 1,
    }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return "counted";
    // Another delivery wrote first: read its count again after a short, spread-out wait.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * (attempt + 1)));
  }
  throw new Error("unknown_recipient_conflict");
}
