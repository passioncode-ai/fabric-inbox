/**
 * Addresses the operator hid (sidebar filter, 2026-09-29): out of the sidebar, All inboxes,
 * domain views and unread totals; still receiving and still read by agents and categories.
 * One R2 object for the workspace, written conditionally so two changes never lose one.
 */
export const HIDDEN_KEY = "config/hidden-accounts.json";
const ACCOUNT = /^(cloudflare|gmail):[^\s]{1,320}$/;
const LIMIT = 2000;

function normalise(value: unknown): string[] {
  const list = Array.isArray((value as { hidden?: unknown })?.hidden) ? (value as { hidden: unknown[] }).hidden : [];
  return [...new Set(list.filter((x): x is string => typeof x === "string" && ACCOUNT.test(x)).map((x) => x.toLowerCase()))].slice(0, LIMIT);
}

export async function readHidden(bucket: R2Bucket): Promise<string[]> {
  const object = await bucket.get(HIDDEN_KEY);
  return object ? normalise(await object.json().catch(() => null)) : [];
}

export class HiddenConflict extends Error {}

export async function changeHidden(bucket: R2Bucket, change: { hide?: string[]; show?: string[] }): Promise<string[]> {
  const hide = (change.hide ?? []).map((x) => x.toLowerCase()).filter((x) => ACCOUNT.test(x));
  const show = new Set((change.show ?? []).map((x) => x.toLowerCase()));
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(HIDDEN_KEY);
    const current = object ? normalise(await object.json().catch(() => null)) : [];
    const next = [...new Set([...current, ...hide])].filter((x) => !show.has(x)).slice(0, LIMIT);
    const written = await bucket.put(HIDDEN_KEY, JSON.stringify({ hidden: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new HiddenConflict("The hidden addresses changed several times at once; try again");
}
