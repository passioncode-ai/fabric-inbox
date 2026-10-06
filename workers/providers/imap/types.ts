/**
 * The stored shape of an IMAP/SMTP account (`imap:<id>`). No secret is here: the app password is
 * in `credentials`, sealed (credentials.ts), and opened only for a session.
 */
import type { AccountBase } from "../provider";

/**
 * The folders this server reads, by role. A message's id starts with its folder's key. "discarded" is
 * the folder named Discarded, made on the server the first time a message is discarded.
 */
export const FOLDER_ROLES = ["inbox", "sent", "drafts", "trash", "junk", "archive", "discarded"] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];
export const ROLE_KEY: Record<FolderRole, string> = { inbox: "i", sent: "s", drafts: "d", trash: "t", junk: "j", archive: "a", discarded: "x" };
/** The name the Discarded folder is made with. */
export const DISCARDED_FOLDER = "Discarded";

/** Where the account's servers are. IMAP is always TLS from the first byte (port 993 by default). */
export interface ServerSettings {
  imap: { host: string; port: number };
  /** "tls": TLS from the first byte (465); "starttls": upgraded after EHLO (587). Never plain. */
  smtp: { host: string; port: number; security: "tls" | "starttls" };
  /** The names the servers know the account by (usually the address; iCloud's IMAP takes the part before @). */
  imapUser: string;
  smtpUser: string;
}

/** One synced folder: where its sync stands. Numbers are UIDs unless named otherwise. */
export interface FolderState {
  role: FolderRole;
  path: string;
  uidValidity: number;
  /** The highest UID this server has read (or skipped past); new mail is everything above it. */
  top: number;
  /** The import's next sequence number, counting down from the newest; absent once the folder is imported. */
  importFrom?: number;
  /** Messages in the folder when its import started (for progress). */
  importTotal?: number;
  /** HIGHESTMODSEQ last read (CONDSTORE), as a decimal string; flag changes since it are read each sync. */
  modseq?: string;
  /** Messages of this folder in the cache; a server count that differs triggers a reconcile. */
  known: number;
  /** When the folder was last reconciled against the server's full UID list (epoch ms). */
  reconciledAt?: number;
}

export interface ImapSyncState {
  /** "initial" while any folder is still importing; history (new mail, flags, deletions) runs from the start. */
  mode: "initial" | "history";
  folders: FolderState[];
  /** Folders a move can target that are not synced (Gmail's All Mail as the archive). */
  targets?: Partial<Record<FolderRole, string>>;
  /** Server capabilities seen at the last login. */
  condstore?: boolean;
  /** The import's progress across folders. */
  imported?: number;
  total?: number;
  /** New mail or changes are still waiting after a tick ran out of time. */
  more?: boolean;
  /** When the folder list was last read (epoch ms); it is read again daily. */
  listedAt?: number;
}

export interface ImapAccount extends AccountBase {
  provider: "imap";
  /** The preset it was connected with (presets.ts), or "custom". */
  preset: string;
  server: ServerSettings;
  sync: ImapSyncState;
}

/** What is sealed in `credentials`. */
export interface ImapCredentials {
  password: string;
}
