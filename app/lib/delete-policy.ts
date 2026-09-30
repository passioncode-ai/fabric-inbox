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

export type DeleteMode = "trash" | "permanent";

export function deleteModeFor(folderId: string | null | undefined): DeleteMode {
	return folderId === Folders.TRASH ? "permanent" : "trash";
}

/** Where Undo returns a message that was just moved to Trash. */
export function restoreFolderFor(folderId: string | null | undefined): string {
	return folderId && folderId !== Folders.TRASH ? folderId : Folders.INBOX;
}

export const DELETE_COPY = {
	trash: {
		label: "Delete",
		done: "Moved to trash",
		undo: "Undo",
	},
	permanent: {
		label: "Delete permanently",
		confirmTitle: "Delete permanently?",
		confirmAction: "Delete permanently",
		done: "Deleted permanently",
	},
} as const;

export function permanentDeleteDescription(subject: string | null | undefined): string {
	const name = subject?.trim() ? `“${subject.trim()}”` : "This message";
	return `${name} will be deleted permanently. It can't be restored afterwards.`;
}

export const TRASH_EMPTY_STATE = {
	title: "Trash is empty",
	description:
		"Deleted emails will appear here. Move one to another folder to restore it, or delete it permanently.",
} as const;
