import {
  loadAttachments,
  type AttachmentStorage,
  type AttachmentRef,
} from "./attachment-store";
import { recipientAddresses } from "./send-state";
import type { Draft } from "./draft-store";
import { msg } from "../../../shared/i18n";
import { withForward, withForwardText } from "../../../shared/mail/forward";
import { includedOriginalIds, leftOutIds } from "./forward-files";

/**
 * Originals a forward neither carries nor left out on purpose (B-274): in the original, not included
 * (its bytes wait here or are on the server) and not in `leftOut`. Send waits for them.
 */
export function missingOriginals(draft: Draft) {
  const included = includedOriginalIds(draft);
  const left = leftOutIds(draft);
  return draft.forwardSource?.files.filter((f) => !included.has(f.id) && !left.has(f.id)) ?? [];
}
/** Merge only references into the current identity, never captured message text. */
export function appendAttachments(
  current: Draft | undefined,
  draftId: string,
  refs: AttachmentRef[],
): Draft {
  if (!current || current.id !== draftId || current.locked)
    throw new Error(
      msg("The draft changed while files were loading. Open the original draft and choose the files again."),
    );
  return { ...current, attachments: [...(current.attachments ?? []), ...refs] };
}
export async function prepareMessage(draft: Draft, storage: AttachmentStorage) {
  if (draft.pendingAttachments?.length)
    throw new Error(
      msg("Files are not ready. Wait for loading to finish, or remove pending files and add them again."),
    );
  const to = recipientAddresses(draft.to);
  if (/[\r\n]/.test((draft.cc ?? "") + (draft.bcc ?? "")))
    throw new Error(msg("Recipients cannot contain line breaks."));
  const cc = draft.cc?.trim() ? recipientAddresses(draft.cc) : [];
  const bcc = draft.bcc?.trim() ? recipientAddresses(draft.bcc) : [];
  if (draft.mode === "forward" && !draft.forwardSource && !draft.locked)
    throw new Error(
      msg("Original attachment information is unavailable for this saved draft. Open the original message and start a new forward."),
    );
  if (missingOriginals(draft).length)
    throw new Error(
      msg("Some of the original's files are not attached. Retry or remove each one."),
    );
  const attachments = await loadAttachments(
    storage,
    draft.attachments ?? [],
    draft.id,
  );
  return {
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: draft.subject,
    // A forward carries its original as it was: buttons and links still work (operator, 2026-10-21).
    ...(draft.forwardHtml
      ? { text: withForwardText(draft.text, draft.forwardHtml), html: withForward(draft.text, draft.forwardHtml) }
      : { text: draft.text }),
    idempotencyKey: draft.idempotencyKey,
    ...(attachments.length ? { attachments } : {}),
  };
}
export function stageAttachments(
  current: Draft | undefined,
  draftId: string,
  refs: AttachmentRef[],
): Draft {
  const next = appendAttachments(current, draftId, refs);
  return {
    ...next,
    pendingAttachments: [
      ...(current?.pendingAttachments ?? []),
      ...refs.map((ref) => ref.id),
    ],
  };
}
export function finishAttachments(
  current: Draft | undefined,
  draftId: string,
  ids: string[],
): Draft {
  if (!current || current.id !== draftId || current.locked)
    throw new Error(
      msg("The draft changed while files were loading. Open the original draft to check its files."),
    );
  return {
    ...current,
    pendingAttachments: current.pendingAttachments?.filter(
      (id) => !ids.includes(id),
    ),
  };
}
