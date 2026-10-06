/**
 * One change to the Worker's own settings at a time (L2, fabric-workspace lifecycle audit). The
 * server writes its settings itself — the credential key, the Gmail and Outlook setups — as a
 * read of the live bindings followed by a write of the whole list. Two such changes at once could
 * each see no credential key and each write a new one, and mail credentials sealed with the first
 * key would become unreadable; or one could drop what the other just wrote. A marker in R2, taken
 * with a conditional write, makes them run one after another.
 *
 * The marker (`config/worker-settings.lock`) holds who took it and when. It is taken when absent,
 * released, or stale — older than the longest a change can take (a settings read, 15 s, and its
 * write, 60 s: workers/routing/cloudflare-api.ts), so a request that died holding it blocks
 * nothing for long. Released by writing it free, conditionally on the version this request wrote.
 */
export const SETTINGS_LOCK_KEY = "config/worker-settings.lock";
export const SETTINGS_LOCK_STALE_MS = 120_000;

/** Another change to the server's settings is running and did not finish while this one waited. */
export class SettingsBusy extends Error {
  constructor() {
    super("Your server's settings are being changed by another request right now. Nothing was changed; try again in a few seconds.");
  }
}

interface Marker { owner: string | null; at: number }

export interface LockOptions {
  /** How many times to try for the marker, and how long to wait between tries. */
  attempts?: number;
  delayMs?: number;
  now?: () => number;
}

export async function withSettingsLock<T>(bucket: R2Bucket, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { attempts = 40, delayMs = 250, now = Date.now } = options;
  const owner = crypto.randomUUID();
  let etag: string | null = null;
  for (let attempt = 0; attempt < attempts && !etag; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const current = await bucket.get(SETTINGS_LOCK_KEY);
    const marker = current ? await current.json<Marker>().catch(() => null) : null;
    const free = !current || !marker?.owner || now() - Number(marker.at) > SETTINGS_LOCK_STALE_MS;
    if (!free) continue;
    if (current && marker?.owner) console.warn(JSON.stringify({ event: "settings_lock_stale_taken", age: now() - Number(marker.at) }));
    const written = await bucket.put(SETTINGS_LOCK_KEY, JSON.stringify({ owner, at: now() } satisfies Marker), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: current ? { etagMatches: current.etag } : new Headers({ "If-None-Match": "*" }),
    });
    etag = written?.etag ?? null;
  }
  if (!etag) {
    console.warn(JSON.stringify({ event: "settings_lock_busy", attempts }));
    throw new SettingsBusy();
  }
  try {
    return await fn();
  } finally {
    await bucket.put(SETTINGS_LOCK_KEY, JSON.stringify({ owner: null, at: now() } satisfies Marker), {
      httpMetadata: { contentType: "application/json" }, onlyIf: { etagMatches: etag },
    }).catch((error: unknown) => console.error(JSON.stringify({ event: "settings_lock_release_failed", error: (error as Error).message })));
  }
}
