// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog } from "@cloudflare/kumo";
import { useT } from "../lib/i18n";
import { DELETE_COPY, permanentDeleteDescription } from "~/lib/delete-policy";

export interface PermanentDeleteDialogProps {
	open: boolean;
	subject?: string | null;
	pending: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}

/** The one confirmation a permanent delete (inside Trash) must pass. */
export default function PermanentDeleteDialog({
	open,
	subject,
	pending,
	onCancel,
	onConfirm,
}: PermanentDeleteDialogProps) {
	const t = useT();
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onCancel();
			}}
		>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-2">
					{t.text(DELETE_COPY.permanent.confirmTitle)}
				</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle text-sm mb-5">
					{t.text(permanentDeleteDescription(subject))}
				</Dialog.Description>
				<div className="flex justify-end gap-2">
					<Dialog.Close
						render={(props) => (
							<Button {...props} variant="secondary" size="sm" disabled={pending}>
								{t("Cancel")}
							</Button>
						)}
					/>
					<Button variant="destructive" size="sm" loading={pending} onClick={onConfirm}>
						{t.text(DELETE_COPY.permanent.confirmAction)}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
