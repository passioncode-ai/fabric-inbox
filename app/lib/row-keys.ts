// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A list row acting as a button opens on Enter or Space — but only when the
 * key was pressed on the row itself. A key pressed on a button nested in the
 * row (star, mark read, delete) belongs to that button.
 */
export function isRowActivation(event: {
	key: string;
	target: unknown;
	currentTarget: unknown;
}): boolean {
	return (
		event.target === event.currentTarget &&
		(event.key === "Enter" || event.key === " ")
	);
}
