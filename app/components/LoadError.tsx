// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, WarningIcon } from "@phosphor-icons/react";
import { useT } from "../lib/i18n";
import { describeLoadError } from "~/lib/load-error";

/**
 * What a screen shows when its data failed to load — never an empty state or
 * a spinner that never ends. `role="alert"` announces the failure; Retry
 * re-runs the query.
 */
export default function LoadError({
	title,
	error,
	onRetry,
	retrying = false,
	compact = false,
	extraAction,
}: {
	title: string;
	error: unknown;
	onRetry: () => void;
	retrying?: boolean;
	/** A one-line bar above content that is still shown (a failed refresh). */
	compact?: boolean;
	extraAction?: React.ReactNode;
}) {
	const t = useT();
	const description = t.text(describeLoadError(error).description);

	if (compact) {
		return (
			<div
				role="alert"
				className="flex items-center gap-2 px-4 py-2 border-b border-kumo-line bg-kumo-tint text-sm text-kumo-default md:px-5"
			>
				<WarningIcon size={16} className="shrink-0 text-kumo-warning" />
				<span className="min-w-0 flex-1 truncate">
					{title} {description}
				</span>
				<Button variant="ghost" size="xs" onClick={onRetry} loading={retrying}>
					{t("Retry")}
				</Button>
			</div>
		);
	}

	return (
		<div
			role="alert"
			className="flex flex-col items-center justify-center py-24 px-6 text-center"
		>
			<div className="mb-4">
				<WarningIcon size={48} weight="thin" className="text-kumo-subtle" />
			</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">{title}</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">{description}</p>
			<div className="flex items-center gap-2">
				<Button
					variant="secondary"
					size="sm"
					icon={<ArrowsClockwiseIcon size={16} />}
					onClick={onRetry}
					loading={retrying}
				>
					{t("Retry")}
				</Button>
				{extraAction}
			</div>
		</div>
	);
}
