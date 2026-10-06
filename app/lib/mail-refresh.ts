// Keeping the mail list fresh: what Refresh asks Gmail for and how its answer reads (P1-5).

/** What Refresh did for one Gmail account (workers/providers/gmail-scheduler.ts, RefreshOutcome). */
export interface RefreshOutcome {
	accountId: string;
	email: string;
	result: "synced" | "backoff" | "reconnect" | "failed" | "not_reached";
	retryAt?: number;
	error?: string;
	importing?: number;
}
export interface RefreshResponse {
	accounts: RefreshOutcome[];
	refreshedAt: number;
}

/**
 * The Gmail accounts Refresh reads for the list in view: `null` when there is nothing to ask
 * Gmail (one Cloudflare address or a domain of them: that mail arrives by push), `undefined` for
 * every Gmail account, or the one account shown.
 */
export function refreshScope(scope: { accountId: string; domain: string }): string[] | undefined | null {
	if (scope.accountId) return scope.accountId.startsWith("gmail:") ? [scope.accountId] : null;
	if (scope.domain) return null;
	return undefined;
}

/** Plain words for why Gmail could not be read. */
const FAILED: Record<string, string> = {
	rate_limited: "Gmail asked us to slow down",
	provider_unavailable: "Gmail could not be reached",
	provider_failed: "Gmail answered with an error",
	provider_auth_failed: "Gmail refused the request",
	credential_store_unavailable: "its sign-in could not be read on the server",
};
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** One sentence per account that did not simply sync; `ok` when every account did. */
export function refreshSummary(outcomes: RefreshOutcome[]): { ok: boolean; text: string } {
	const notes: string[] = [];
	let ok = true;
	for (const o of outcomes) {
		if (o.result === "synced") {
			if (o.importing !== undefined) notes.push(`${o.email} is still importing older mail (${o.importing}%); new mail is in.`);
			continue;
		}
		ok = false;
		if (o.result === "backoff") notes.push(`${o.email}: Gmail failed a moment ago; it tries again at ${clock(o.retryAt ?? Date.now())}.`);
		else if (o.result === "reconnect") notes.push(`${o.email} needs to be connected again (Manage accounts).`);
		else if (o.result === "not_reached") notes.push(`${o.email} was not checked in time; it syncs on its own within minutes.`);
		else notes.push(`${o.email}: ${FAILED[o.error ?? ""] ?? "Gmail could not be read"}. Try again in a minute.`);
	}
	return { ok, text: [ok ? "Updated just now." : "Updated, except:", ...notes].join(" ") };
}
