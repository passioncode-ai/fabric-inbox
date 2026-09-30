// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What the Accounts page may say about Gmail setup. Until the account list
 * has loaded, nothing is known — "not configured" is a claim only a loaded
 * answer can make.
 */
export type GmailSetupState = "loading" | "unavailable" | "configured" | "not-configured";

export function gmailSetupState(
	data: { configuration: string } | undefined,
	error: unknown,
): GmailSetupState {
	if (data) return data.configuration === "configured" ? "configured" : "not-configured";
	return error ? "unavailable" : "loading";
}
