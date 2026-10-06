// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useT } from "../lib/i18n";
import { describeMutationError } from "~/lib/mutation-errors";

/**
 * Turns the failure of any mutation that carries `meta.errorMessage` into an
 * error toast. High priority makes the toast region announce it assertively
 * (role="alert"), so a failed star, move, delete or folder create is heard
 * as well as seen. Title and description are English (`msg()` constants, the
 * server's words) and are translated here, where they are shown (`t.text`).
 * Renders nothing; mount once inside <Toasty>.
 */
export default function MutationErrorToasts() {
	const t = useT();
	const tRef = useRef(t);
	tRef.current = t;
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const toastRef = useRef(toastManager);
	toastRef.current = toastManager;

	useEffect(
		() =>
			queryClient.getMutationCache().subscribe((event) => {
				if (event.type !== "updated" || event.action.type !== "error") return;
				const notice = describeMutationError(
					event.mutation.options.meta,
					event.mutation.state.variables,
					event.action.error,
				);
				if (!notice) return;
				const tr = tRef.current;
				toastRef.current.add({
					title: tr.text(notice.title),
					...(notice.description ? { description: tr.text(notice.description) } : {}),
					variant: "error",
					priority: "high",
				});
			}),
		[queryClient],
	);

	return null;
}
