/**
 * The stored shape of an Outlook account (`outlook:<id>`): Outlook.com, Hotmail, Live and Microsoft
 * 365 mailboxes reached through Microsoft Graph. No secret is here: the tokens are in `credentials`,
 * sealed (credentials.ts), and opened only for a session.
 */
import type { AccountBase } from "../provider";

/** The folders this server reads, by role, with Microsoft Graph's well-known name for each. */
export const OUTLOOK_FOLDERS = [
  { role: "inbox", wellKnown: "inbox" },
  { role: "sent", wellKnown: "sentitems" },
  { role: "drafts", wellKnown: "drafts" },
  { role: "trash", wellKnown: "deleteditems" },
  { role: "junk", wellKnown: "junkemail" },
  { role: "archive", wellKnown: "archive" },
] as const;
export type OutlookRole = (typeof OUTLOOK_FOLDERS)[number]["role"];
export const WELL_KNOWN: Record<OutlookRole, string> = Object.fromEntries(OUTLOOK_FOLDERS.map((f) => [f.role, f.wellKnown])) as Record<OutlookRole, string>;

/** One synced folder and where its delta query stands. */
export interface OutlookFolderState {
  role: OutlookRole;
  /** The folder's Graph id (folder ids do not change; only items get immutable ids). */
  id: string;
  /** The last round's `@odata.deltaLink`: present once the folder's first round (its import) is done. */
  deltaLink?: string;
  /** The `@odata.nextLink` of a round a tick did not finish: the import's, or a history round's. */
  nextLink?: string;
  /** Items in the folder when it was listed, for the import's progress. */
  total?: number;
  /** Messages the import has read so far. */
  seen?: number;
  /** The generation rows of this folder's import are saved with; a reset sweeps the others after it. */
  generation?: string;
  /** Graph ended the delta round (410 Gone): rows of this folder not seen again are removed after the import. */
  sweep?: boolean;
  /** Where a sweep stopped (a cache key), to resume on the next tick. */
  sweepAfter?: string;
}

export interface OutlookSyncState {
  /** "initial" while any folder's first round is running; history (the delta rounds) runs from the start. */
  mode: "initial" | "history";
  folders: OutlookFolderState[];
  /** When the folders were last listed (epoch ms); they are listed again daily. */
  listedAt?: number;
  /** When the account was connected: mail received since is new mail (rules, agents, categories). */
  since?: number;
  /** Changes are still waiting after a tick ran out of time. */
  more?: boolean;
  /** The import's progress across folders. */
  imported?: number;
  total?: number;
}

export interface OutlookAccount extends AccountBase {
  provider: "outlook";
  /** The Microsoft user's id (`GET /me` → id): reconnecting another user with the same address starts over. */
  userId?: string;
  sync: OutlookSyncState;
}

/** What is sealed in `credentials`. */
export interface OutlookCredentials {
  accessToken: string;
  refreshToken: string;
  /** When the access token ends (epoch ms). */
  expiresAt: number;
}
