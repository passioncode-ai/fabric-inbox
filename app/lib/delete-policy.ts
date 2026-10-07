// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What "Delete" means for a message, decided by the folder it is in.
 *
 * Outside Trash, Delete moves the message to Trash, where it can be moved
 * back. Inside Trash, the only delete left is the permanent one, and it is
 * always confirmed first. The Trash empty state promises exactly this, so
 * the copy lives here beside the rule it describes.
 */
import { Folders } from "../../shared/folders";
import { englishT, msg, type T } from "../../shared/i18n";

export type DeleteMode = "trash" | "permanent";

export function deleteModeFor(folderId: string | null | undefined): DeleteMode {
	return folderId === Folders.TRASH ? "permanent" : "trash";
}

/** Where Undo returns a message that was just moved to Trash. */
export function restoreFolderFor(folderId: string | null | undefined): string {
	return folderId && folderId !== Folders.TRASH ? folderId : Folders.INBOX;
}

/** English, marked with msg(): the interface shows each one through `t.text()`. */
export const DELETE_COPY = {
	trash: {
		label: msg("Delete"),
		done: msg("Moved to trash"),
		undo: msg("Undo"),
	},
	permanent: {
		label: msg("Delete permanently"),
		confirmTitle: msg("Delete permanently?"),
		confirmAction: msg("Delete permanently"),
		done: msg("Deleted permanently"),
	},
} as const;

export function permanentDeleteDescription(subject: string | null | undefined, t: T = englishT): string {
	return subject?.trim()
		? t("“{subject}” will be deleted permanently. It can't be restored afterwards.", { subject: subject.trim() })
		: t("This message will be deleted permanently. It can't be restored afterwards.");
}

/** English, marked with msg(): the interface shows it through `t.text()`. */
export const TRASH_EMPTY_STATE = {
	title: msg("Trash is empty"),
	description: msg(
		"Deleted emails will appear here. Move one to another folder to restore it, or delete it permanently.",
	),
} as const;
