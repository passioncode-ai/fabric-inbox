// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Creating the mailboxes the server config lists but that do not exist yet.
 * Every address that could not be created is reported, never dropped.
 */
import { errorDetail } from "./mutation-errors";

export interface ProvisioningFailure {
	address: string;
	reason: string;
}

export function mailboxesToCreate(
	configured: readonly string[],
	existing: readonly { email: string }[],
): string[] {
	const have = new Set(existing.map((m) => m.email.toLowerCase()));
	const seen = new Set<string>();
	return configured.filter((address) => {
		const key = address.toLowerCase();
		if (have.has(key) || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function provisioningFailures(
	addresses: readonly string[],
	results: readonly PromiseSettledResult<unknown>[],
): ProvisioningFailure[] {
	const failures: ProvisioningFailure[] = [];
	results.forEach((result, i) => {
		if (result.status === "rejected")
			failures.push({
				address: addresses[i],
				reason: errorDetail(result.reason) ?? "Unknown error",
			});
	});
	return failures;
}
