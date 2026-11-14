import type { Colour, FileEntry, MailCheck } from "../../shared/mail/safety";
import { safetyKey } from "./state";

/**
 * S03 §5 (B-269): a file's colour decides how it is served. Amber and red files go out as
 * `application/octet-stream` with `nosniff` and a sandbox CSP, so no browser renders or runs them; a red one (a
 * program, a disguised file) is served only with `override=1`, which is logged.
 */
export interface SafetyStore {
  safetyOf(keys: { accountId: string; messageId: string }[]): Promise<Record<string, { findings: { check?: MailCheck; riskyFiles?: string[] } }>>;
}

/** The colour of one attachment from its message's record (null: no record, or the file is not in it). */
export async function fileColour(store: SafetyStore | undefined, accountId: string, messageId: string, attachmentId: string, filename: string): Promise<Colour | null> {
  if (!store) return null;
  const key = { accountId: accountId.toLowerCase(), messageId };
  const record = (await store.safetyOf([key]).catch(() => ({} as Record<string, never>)))[safetyKey(key.accountId, messageId)];
  if (!record) return null;
  const entry: FileEntry | undefined = record.findings.check?.files.find((f) => f.id === attachmentId);
  if (entry) return entry.colour;
  return record.findings.riskyFiles?.includes(filename) ? "red" : null;
}

export type Served = { refuse: true } | { refuse: false; headers: Record<string, string> };

/** How a file of this colour is served; `override` is the person's "Save anyway". */
export function servedAs(colour: Colour | null, override: boolean): Served {
  if (colour === "red" && !override) return { refuse: true };
  if (colour === "red" || colour === "amber")
    return { refuse: false, headers: { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } };
  return { refuse: false, headers: {} };
}
