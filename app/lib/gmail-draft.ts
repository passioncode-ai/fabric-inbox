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
