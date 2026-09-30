// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Visible failure notices for fire-and-forget mutations.
 *
 * A mutation opts in by carrying `meta.errorMessage` (a string, or a function
 * of the mutation's variables). The app-level listener turns every failure of
 * such a mutation into an error toast. Mutations awaited with `mutateAsync`
 * inside a try/catch report their own errors and carry no `errorMessage`, so
 * a failure is never announced twice.
 */

export type MutationErrorMessage = string | ((variables: unknown) => string);

export interface MutationNotice {
	title: string;
	description?: string;
}

export function errorDetail(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	if (error.name === "AbortError" || error.name === "TimeoutError")
		return "The request timed out. Try again.";
	if (error.name === "TypeError") return "Check your connection and try again.";
	return error.message.trim() || undefined;
}

export function describeMutationError(
	meta: Record<string, unknown> | undefined,
	variables: unknown,
	error: unknown,
): MutationNotice | null {
	const message = meta?.errorMessage;
	let title: string | undefined;
	if (typeof message === "string") title = message;
	else if (typeof message === "function") {
		try {
			title = (message as (v: unknown) => string)(variables);
		} catch {
			title = undefined;
		}
	}
	if (!title) return null;
	const description = errorDetail(error);
	return description ? { title, description } : { title };
}

/** Per-action wording for the one email update hook (star and read share it). */
export function emailUpdateErrorMessage(variables: unknown): string {
	const data = (variables as { data?: { starred?: unknown; read?: unknown } } | undefined)?.data;
	if (data && typeof data.starred === "boolean")
		return data.starred ? "Couldn't star the message." : "Couldn't unstar the message.";
	if (data && typeof data.read === "boolean")
		return data.read
			? "Couldn't mark the message as read."
			: "Couldn't mark the message as unread.";
	return "Couldn't update the message.";
}

export function emailMoveErrorMessage(variables: unknown): string {
	const folderId = (variables as { folderId?: unknown } | undefined)?.folderId;
	return folderId === "trash"
		? "Couldn't move the message to trash."
		: "Couldn't move the message.";
}
