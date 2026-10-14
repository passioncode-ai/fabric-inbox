/**
 * The per-account draft of the account page (`app/routes/gmail-inbox.tsx`, SCN-019): kept on this
 * device under `fabric-draft:<accountId>` with whether its send attempt is locked, so a reload or a
 * restart brings back the text and an uncertain send's recovery key. Plain functions over a
 * storage, so the restore path has a runtime receipt (`tests/c2-frontend.test.ts`, AUD-B1-04).
 */
export type GmailDraft = {
  to: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  idempotencyKey: string;
};
export type SavedGmailDraft = { draft: GmailDraft | null; locked: boolean };

export const gmailDraftKey = (accountId: string) => "fabric-draft:" + accountId;

/** What was saved for this account; nothing saved is no draft. Throws when the saved entry cannot be read. */
export function restoreGmailDraft(storage: Pick<Storage, "getItem">, accountId: string): SavedGmailDraft {
  const saved = storage.getItem(gmailDraftKey(accountId));
  const value = saved ? JSON.parse(saved) : null;
  return { draft: value?.draft ?? null, locked: value?.locked ?? false };
}

/** Where an unreadable saved entry is kept, so the next save never deletes it (B-68). */
export const unreadableDraftKey = (accountId: string) => "fabric-draft-unreadable:" + accountId;

/**
 * Moves an entry that could not be read out of the draft's place, kept as it was, so the page can start
 * a new draft without deleting what was saved (B-68). Returns false when the device refuses the copy:
 * the entry then stays where it is, and the page must not save over it.
 */
export function setAsideUnreadableDraft(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, accountId: string): boolean {
  const raw = storage.getItem(gmailDraftKey(accountId));
  if (raw === null) return true;
  try { storage.setItem(unreadableDraftKey(accountId), raw); } catch { return false; }
  storage.removeItem(gmailDraftKey(accountId));
  return true;
}

/** Saves the draft and its lock, or removes the entry once there is no draft. Throws when the device refuses. */
export function keepGmailDraft(
  storage: Pick<Storage, "setItem" | "removeItem">,
  accountId: string,
  draft: GmailDraft | null,
  locked: boolean,
): void {
  if (draft) storage.setItem(gmailDraftKey(accountId), JSON.stringify({ draft, locked }));
  else storage.removeItem(gmailDraftKey(accountId));
}
