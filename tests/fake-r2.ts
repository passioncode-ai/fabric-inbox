/**
 * An in-memory R2 bucket with what the settings lock relies on: an etag per version, and conditional
 * puts (`onlyIf` as `{ etagMatches }` or as headers with `If-None-Match: *`) that answer null when
 * the condition does not hold, as R2 does, and a list with each object's upload time. Each operation
 * is atomic, as R2's are.
 */
export function fakeBucket(clock: () => Date = () => new Date()) {
  const objects = new Map<string, { value: string; etag: string; uploaded?: Date }>();
  let version = 0;
  const bucket = {
    objects,
    async head(key: string) { return objects.has(key) ? { etag: objects.get(key)!.etag } : null; },
    async get(key: string) {
      const o = objects.get(key);
      return o ? { etag: o.etag, json: async () => JSON.parse(o.value), text: async () => o.value } : null;
    },
    async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string } | Headers }) {
      const onlyIf = options?.onlyIf;
      const current = objects.get(key);
      if (onlyIf instanceof Headers) {
        if (onlyIf.get("If-None-Match") === "*" && current) return null;
      } else if (onlyIf?.etagMatches !== undefined && onlyIf.etagMatches !== current?.etag) return null;
      const etag = `v${++version}`;
      objects.set(key, { value: String(value), etag, uploaded: clock() });
      return { etag };
    },
    /** Keys in order, at most `limit`, each with the time it was last written (R2's `uploaded`). */
    async list(options: { prefix?: string; limit?: number } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
      const shown = keys.slice(0, options.limit ?? 1000);
      return { objects: shown.map((key) => ({ key, uploaded: objects.get(key)!.uploaded ?? new Date(0) })), truncated: shown.length < keys.length };
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return bucket;
}
