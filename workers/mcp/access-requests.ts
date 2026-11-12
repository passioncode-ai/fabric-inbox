/**
 * B-246 W3 (D-4, R-3): the access requests a server keeps (`config/access-requests.json`), written on the version read,
 * as the grants are (grant-store.ts). A request that does not read as `access-request/1` is dropped; one past its end
 * reads as expired. Kept: the last MAX_KEPT, the waiting ones first.
 */
import { AccessRequestSchema, type AccessRequest } from "./grants";
import { bodyForUpdate } from "../lib/r2-json";

export const ACCESS_REQUESTS_KEY = "config/access-requests.json";
export const MAX_KEPT = 500;

/** What the store holds, each request past its end marked expired. */
export function normaliseRequests(raw: unknown, now = new Date()): AccessRequest[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { requests?: unknown }).requests) ? (raw as { requests: unknown[] }).requests : [];
  return list.flatMap((r) => {
    const parsed = AccessRequestSchema.safeParse(r);
    if (!parsed.success) return [];
    const req = parsed.data;
    return [req.state === "waiting" && Date.parse(req.expiresAt) <= now.getTime() ? { ...req, state: "expired" as const } : req];
  });
}

export async function readRequests(bucket: R2Bucket, now = new Date()): Promise<AccessRequest[]> {
  const object = await bucket.get(ACCESS_REQUESTS_KEY);
  return object ? normaliseRequests(await object.json().catch(() => null), now) : [];
}

export class RequestsConflict extends Error {}

/** One change on the version read; the newest MAX_KEPT are kept, waiting ones never dropped. */
export async function updateRequests<T>(bucket: R2Bucket, change: (requests: AccessRequest[]) => { next: AccessRequest[]; result: T }, now = new Date()): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(ACCESS_REQUESTS_KEY);
    const current = object ? normaliseRequests(await bodyForUpdate(object), now) : [];
    const { next, result } = change(current);
    const waiting = next.filter((r) => r.state === "waiting");
    const done = next.filter((r) => r.state !== "waiting").slice(-Math.max(0, MAX_KEPT - waiting.length));
    const written = await bucket.put(ACCESS_REQUESTS_KEY, JSON.stringify({ requests: [...done, ...waiting] }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return result;
  }
  throw new RequestsConflict("The access requests changed several times at once; try again");
}
