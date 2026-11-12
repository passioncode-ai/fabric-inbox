/**
 * B-246 W2c: the grants a server keeps (`config/grants.json`), beside today's keys and members. One R2 object for the
 * server, written conditionally on the version read, as the agent keys are (keys.ts `updateAgentKeys`). A grant that
 * does not read as `grant/1` is dropped, and a file that cannot be read gives no grant: it fails closed.
 */
import { GrantSchema, type StoredGrant } from "./grants";
import { bodyForUpdate } from "../lib/r2-json";

export const GRANTS_KEY = "config/grants.json";
export const MAX_GRANTS = 2000;

export function normaliseGrants(raw: unknown): StoredGrant[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { grants?: unknown }).grants) ? (raw as { grants: unknown[] }).grants : [];
  return list.flatMap((g) => { const r = GrantSchema.safeParse(g); return r.success ? [r.data] : []; });
}

export async function readGrants(bucket: R2Bucket): Promise<StoredGrant[]> {
  const object = await bucket.get(GRANTS_KEY);
  if (!object) return [];
  return normaliseGrants(await object.json().catch(() => null));
}

export class GrantsConflict extends Error {}

export async function updateGrants(bucket: R2Bucket, change: (grants: StoredGrant[]) => StoredGrant[]): Promise<StoredGrant[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(GRANTS_KEY);
    const current = object ? normaliseGrants(await bodyForUpdate(object)) : [];
    const next = change(current);
    if (next.length > MAX_GRANTS) throw new Error(`At most ${MAX_GRANTS} grants on a server; revoke some first`);
    const written = await bucket.put(GRANTS_KEY, JSON.stringify({ grants: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new GrantsConflict("The grants changed several times at once; try again");
}
