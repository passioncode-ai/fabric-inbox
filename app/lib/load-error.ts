// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Wording for a query that failed to load, so a failure never reads as an
 * empty folder or an endless spinner.
 */

export interface LoadErrorCopy {
	description: string;
	/** False when retrying the same request cannot succeed (the thing is gone). */
	retryable: boolean;
}

function statusOf(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

export function describeLoadError(error: unknown): LoadErrorCopy {
	const status = statusOf(error);
	if (status === 404)
		return { description: "It may have been deleted or moved.", retryable: false };
	if (status === 401 || status === 403)
		return { description: "You don't have access to this. Sign in again and retry.", retryable: true };
	if (status !== undefined && status >= 500)
		return { description: "The server had a problem. Try again in a moment.", retryable: true };
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.name === "TimeoutError")
			return { description: "The request timed out. Try again.", retryable: true };
		if (error.name === "TypeError")
			return { description: "Check your connection and try again.", retryable: true };
		if (error.message.trim()) return { description: error.message.trim(), retryable: true };
	}
	return { description: "Something went wrong. Try again.", retryable: true };
}
