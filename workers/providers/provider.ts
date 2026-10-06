/**
 * What a mail provider gives the accounts object (docs/architecture.md → "Mail providers").
 *
 * `AccountService` keeps everything every provider shares — the account records, the sealed
 * credentials, the message cache (`gmail-cache.ts`, whose label vocabulary every provider maps
 * onto), send receipts and their idempotency, the incoming-event queue, status and backoff — and
 * asks a `MailProvider` for the provider's own work through a `ProviderSession`: one page of sync,
 * a message read fresh, a change to a message, a file, a send, drafts, revoking access.
 *
 * Gmail (`gmail-provider.ts`), IMAP/SMTP (`imap/provider.ts`) and Outlook through Microsoft Graph
 * (`outlook/provider.ts`) implement it. An OAuth provider's `open()` renews its token through
 * `persist`, and a refused grant is `reconnect_required`, which stops syncing until the person
 * connects again.
 *
 * The capability matrix (`ProviderCapabilities`) is answered per account, because two IMAP
 * servers differ (one has an Archive folder, one does not); the app and the agent protocol read it
 * to offer only what works.
 */
import type { MailAttachment } from "../../shared/mail/attachments";
import type { RemoteProvider } from "../../shared/mail/accounts";
import type { Message, SendInput } from "./gmail-client";
import type { CredentialEnvelope } from "./credentials";
import type { GmailReason } from "../../shared/mail/gmail-reasons";

/** What one account's provider can do. Every field is a fact about this account, not a promise. */
export interface ProviderCapabilities {
  /** Gmail labels (a message can be in several) or IMAP and Outlook folders (a message is in exactly one). */
  organization: "labels" | "folders";
  /** Conversations as the provider keeps them, or derived here from Message-ID, In-Reply-To and References. */
  threads: "provider" | "headers";
  /** Drafts kept in the account itself (Gmail's drafts, an IMAP Drafts folder). */
  drafts: boolean;
  /** Archive moves a message out of the Inbox and keeps it (Gmail: removes INBOX; IMAP: an Archive folder). */
  archive: boolean;
  /** Report spam / Not spam moves the message to and from the provider's spam folder. */
  spam: boolean;
  /** Trash keeps the message where it can be restored. */
  trash: boolean;
  /** Searches read the mail synced to this server; neither provider's own search is used yet. */
  search: "cache";
  /** Who keeps the copy of sent mail in Sent: the provider itself, or this server (IMAP APPEND). */
  sentCopy: "provider" | "server";
  /** How the person signs in: the provider's consent page (Google's, Microsoft's), or an app password typed once into Settings. */
  auth: "oauth" | "app-password";
  /** How new mail reaches this server: read on a schedule (no push in this release). */
  delivery: "poll";
}

/** Fields every account record carries, whatever its provider. */
export interface AccountBase {
  id: string;
  email: string;
  runtime: "cloud";
  status: "connected" | "syncing" | "reconnect_required" | "rate_limited" | "error";
  createdAt: number;
  lastSyncAt?: number;
  /** A public error code (never provider text that could carry a secret). */
  error?: string;
  retryAt?: number;
  /** The provider's secret, sealed (credentials.ts); never leaves the accounts object. */
  credentials: CredentialEnvelope;
  /** Failed syncs in a row: the wait before the next one doubles from 60 s to 15 min. */
  failures?: number;
  /** Messages set aside after failing MAX_MESSAGE_ATTEMPTS times (kept under `skipped:`). */
  skipped?: number;
  /** Why it stopped working, in a word the app turns into a sentence (shared/mail/gmail-reasons.ts). */
  reason?: GmailReason;
  /** When access was last given on the provider's page (Gmail: connect or reconnect): dates a 7-day Testing expiry. */
  connectedAt?: number;
  /** When the provider said this access ends, if it gave an end (time-limited access, a Testing app). */
  accessUntil?: number;
}

/** A change to one message, as the app and agents ask for it; each provider maps it to its own model. */
export type MessageChange =
  | { read: boolean }
  | { starred: boolean }
  | { trashed: boolean }
  | { archive: true }
  | { inbox: true }
  | { spam: boolean }
  /**
   * Discarded (true): out of the inbox into the account's Discarded place — Gmail's "Discarded"
   * label, an IMAP or Outlook folder named Discarded, made when missing — and read. Not discarded
   * (false): out of that place, back to `to` (the inbox when absent; Undo names where it was).
   */
  | { discarded: boolean; to?: DiscardRestoreTarget };

/** Where a remote account's discarded message can go back to (a discard from Spam is refused). */
export type DiscardRestoreTarget = "inbox" | "archive" | "trash";
export const DISCARD_RESTORE_TARGETS: readonly DiscardRestoreTarget[] = ["inbox", "archive", "trash"];

/** The result of one unit of sync work. */
export interface PageResult {
  /** More of this kind of work is waiting. */
  more: boolean;
  /** Messages set aside on this page. */
  skipped: number;
}

/** A send that the provider refused before any part of the message was handed over: safe to retry. */
export class NotSentError extends Error {
  constructor(public code: string, public status = 502) {
    super(code);
  }
}

export interface SendResult { id: string; threadId: string; draftId?: string }

/** One draft as the drafts list (and, with its body, the composer) shows it. */
export interface DraftView {
  draftId: string; revision: string; messageId: string; threadId: string;
  to: string; cc: string | null; bcc: string | null; subject: string; date: string;
  inReplyTo: string | null; references: string | null; snippet: string;
  attachments: { id: string; filename: string; mimetype: string; size: number }[];
  text?: string; html?: string;
}
export interface DraftUpdate extends SendInput { expectedRevision?: string; keepAttachments?: string[] }

/**
 * The provider's work for one account, for as long as the caller holds it. A session may hold a
 * connection (IMAP); `close()` always ends it, after success or failure. Every method throws
 * `ProviderError` with a public code; none returns or logs a secret.
 */
export interface ProviderSession {
  /**
   * One page of history (new mail and changes) or of the import, changing `sync` on `account` in
   * place. `account` is the record as the caller read it for this page (a session may serve several).
   */
  syncPage(account: AccountBase & { provider: RemoteProvider; sync: unknown }, kind: "history" | "import", deadline: number): Promise<PageResult>;
  /** One message in full, read from the provider now. */
  message(messageId: string): Promise<Message>;
  /**
   * Applies a change and answers the message as the provider now has it: its id may change (an IMAP
   * move), `bodyless` when only its headers are known here, null when it moved where this server
   * does not read (Gmail's All Mail through IMAP) or its new place is not known until the next sync.
   */
  change(messageId: string, change: MessageChange): Promise<(Message & { bodyless?: boolean }) | null>;
  /** One file of a message: base64url data, as Gmail's API answers it. */
  attachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }>;
  /** Every header of one message. */
  headers(messageId: string): Promise<{ key: string; value: string }[]>;
  /** Sends a message from the account. Throws NotSentError when nothing left; any other failure is an unknown outcome. */
  send(input: SendInput): Promise<SendResult>;
  createDraft(input: SendInput): Promise<SendResult & { draftId: string }>;
  listDrafts(cursor?: string): Promise<{ drafts: DraftView[]; nextCursor: string | null }>;
  getDraft(draftId: string): Promise<DraftView>;
  /** The draft's current revision, read before a send that names the one it read. */
  draftRevision(draftId: string): Promise<string>;
  updateDraft(draftId: string, update: DraftUpdate): Promise<{ draftId: string; revision: string; messageId: string; threadId: string }>;
  deleteDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<SendResult>;
  close(): Promise<void>;
}

export interface MailProvider<A extends AccountBase & { provider: RemoteProvider } = AccountBase & { provider: RemoteProvider; sync: { mode: string } }> {
  readonly id: RemoteProvider;
  /** Whether this server is set up for the provider (Gmail: Google OAuth; IMAP: a credential key). */
  configured(): boolean;
  capabilities(account: A): ProviderCapabilities;
  /**
   * Opens the account's session with its opened credentials; `persist` seals and saves credentials
   * the provider renewed (an OAuth refresh).
   */
  open(account: A, credentials: unknown, persist: (credentials: unknown) => Promise<void>): Promise<ProviderSession>;
  /** Revokes this server's access at the provider, when it has a way to; true when it confirmed. */
  revoke(account: A, credentials: unknown): Promise<boolean>;
  /** The state a fresh import starts from (after history expired, or a reconnect that changed the mailbox). */
  restartSync(account: A): void;
  /** Whether sync work is still waiting (an import, or a page in progress). */
  pending(account: A): boolean;
  /** The first import's progress in percent, when known. */
  progress(account: A): number | undefined;
}

export type { MailAttachment };
