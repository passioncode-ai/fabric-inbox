// B-27: the journal of renames in progress, read by every operation that must not touch an address
// taking part in one (remove, pause, catch-all, a second rename). Its own module so address-ops and
// address-rename can both read it without importing each other.
/** B-27: a paused address keeps its mail but takes none (its key lives here so routing can read it without a cycle). */
export const pausedKey = (email: string) => `paused/${email.toLowerCase()}.json`;
export const renameKey = (from: string) => `renames/${from.toLowerCase()}.json`;
export const aliasKey = (from: string) => `renamed/${from.toLowerCase()}.json`;

export interface RenameRef { from: string; to: string }

/** Every rename in progress (a handful at most). */
export async function renamesInProgress<T extends RenameRef = RenameRef>(bucket: R2Bucket): Promise<T[]> {
  const listed = await bucket.list({ prefix: "renames/" });
  const all: unknown[] = await Promise.all(listed.objects.map((o) => bucket.get(o.key).then((b) => b?.json()).catch(() => null)));
  return all.filter((j): j is T => !!j && typeof (j as T).from === "string" && typeof (j as T).to === "string");
}

/** The rename an address takes part in, as its source or its target; null when none. */
export async function renameOf<T extends RenameRef = RenameRef>(bucket: R2Bucket, address: string): Promise<T | null> {
  const a = address.trim().toLowerCase();
  return (await renamesInProgress<T>(bucket)).find((j) => j.from === a || j.to === a) ?? null;
}
