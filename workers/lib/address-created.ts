/**
 * When each Cloudflare address was created (2026-10-08): the sidebar's With mail filter lists an
 * address made in the last few days before its first message arrives, so the person who just made
 * it can find it (app/components/inbox/account-groups.ts, `isNewAccount`). One R2 object for the
 * workspace, written conditionally like hidden-accounts.ts so two creates at once never lose one.
 * An address created before this record existed has no entry and reads as old.
 */
export const CREATED_KEY = "config/address-created.json";
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const LIMIT = 5000;

/** Address (lowercase) -> creation time in epoch ms; anything malformed is left out. */
function normalise(value: unknown): Record<string, number> {
  const raw = (value as { created?: unknown })?.created;
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [email, at] of Object.entries(raw as Record<string, unknown>).slice(0, LIMIT))
    if (ADDRESS.test(email) && typeof at === "number" && Number.isSafeInteger(at) && at > 0) out[email.toLowerCase()] = at;
  return out;
}

export async function readCreated(bucket: R2Bucket): Promise<Record<string, number>> {
  const object = await bucket.get(CREATED_KEY);
  return object ? normalise(await object.json().catch(() => null)) : {};
}

async function changeCreated(bucket: R2Bucket, change: (current: Record<string, number>) => Record<string, number> | null): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(CREATED_KEY);
    const next = change(object ? normalise(await object.json().catch(() => null)) : {});
    if (!next) return;
    const written = await bucket.put(CREATED_KEY, JSON.stringify({ created: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return;
  }
  throw new Error("address_created_conflict");
}

/** Records that `email` was created at `at` (a re-created address gets its new time). */
export function recordCreated(bucket: R2Bucket, email: string, at: number): Promise<void> {
  const key = email.trim().toLowerCase();
  return changeCreated(bucket, (current) => {
    const rest = Object.entries(current).filter(([e]) => e !== key);
    // Full: the oldest entries go first; they are long past the window anyway.
    rest.sort(([, a], [, b]) => b - a);
    return Object.fromEntries([[key, at], ...rest.slice(0, LIMIT - 1)]);
  });
}

/** Forgets a deleted address; nothing is written when it had no entry. */
export function forgetCreated(bucket: R2Bucket, email: string): Promise<void> {
  const key = email.trim().toLowerCase();
  return changeCreated(bucket, (current) => {
    if (!(key in current)) return null;
    const { [key]: _gone, ...rest } = current;
    return rest;
  });
}
