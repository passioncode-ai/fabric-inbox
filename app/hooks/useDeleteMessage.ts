// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useState } from "react";
import { Folders } from "shared/folders";
import type { PermanentDeleteDialogProps } from "~/components/PermanentDeleteDialog";
import {
	DELETE_COPY,
	deleteModeFor,
	restoreFolderFor,
} from "~/lib/delete-policy";
import { useT } from "~/lib/i18n";
import { useDeleteEmail, useMoveEmail } from "~/queries/emails";
import type { Email } from "~/types";

/**
 * "Delete" for one message, as the delete policy defines it:
 * outside Trash it moves the message to Trash (with Undo); inside Trash it
 * asks for confirmation and then deletes permanently.
 *
 * Failures are announced by <MutationErrorToasts /> through the mutations'
 * `meta.errorMessage`. Results are awaited with `mutateAsync` so the success
 * toast still appears when the caller (the reading panel) has unmounted.
 */
export function useDeleteMessage(
	mailboxId: string | undefined,
	currentFolder: string | undefined,
) {
	const t = useT();
	const moveEmail = useMoveEmail();
	const deleteEmail = useDeleteEmail();
	const toastManager = useKumoToastManager();
	const [target, setTarget] = useState<{
		email: Email;
		onRemoved?: () => void;
	} | null>(null);

	const folderOf = (email: Email) => email.folder_id ?? currentFolder;

	/** `onRemoved` runs once the message leaves the view (close its panel). */
	const requestDelete = (email: Email, onRemoved?: () => void) => {
		if (!mailboxId) return;
		const from = folderOf(email);
		if (deleteModeFor(from) === "permanent") {
			setTarget({ email, onRemoved });
			return;
		}
		moveEmail
			.mutateAsync({ mailboxId, id: email.id, folderId: Folders.TRASH })
			.then(() => {
				const toastId: string = toastManager.add({
					title: t.text(DELETE_COPY.trash.done),
					actions: [
						{
							children: t.text(DELETE_COPY.trash.undo),
							variant: "secondary",
							size: "sm",
							onClick: () => {
								toastManager.close(toastId);
								moveEmail
									.mutateAsync({
										mailboxId,
										id: email.id,
										folderId: restoreFolderFor(from),
									})
									.catch(() => {
										// Announced by MutationErrorToasts.
									});
							},
						},
					],
				});
			})
			.catch(() => {
				// Announced by MutationErrorToasts.
			});
		onRemoved?.();
	};

	const confirmPermanentDelete = () => {
		if (!target || !mailboxId) return;
		const { email, onRemoved } = target;
		deleteEmail
			.mutateAsync({ mailboxId, id: email.id })
			.then(() => {
				toastManager.add({ title: t.text(DELETE_COPY.permanent.done) });
				onRemoved?.();
			})
			.catch(() => {
				// Announced by MutationErrorToasts; the message is still in Trash.
			})
			.finally(() => setTarget(null));
	};

	const dialogProps: PermanentDeleteDialogProps = {
		open: target !== null,
		subject: target?.email.subject,
		pending: deleteEmail.isPending,
		onCancel: () => setTarget(null),
		onConfirm: confirmPermanentDelete,
	};

	return {
		requestDelete,
		/** Label for the delete control of a message in `folderId`. */
		deleteLabel: (email?: Email) =>
			deleteModeFor(email ? folderOf(email) : currentFolder) === "permanent"
				? t.text(DELETE_COPY.permanent.label)
				: t.text(DELETE_COPY.trash.label),
		dialogProps,
	};
}
