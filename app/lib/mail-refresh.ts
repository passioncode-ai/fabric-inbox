// Keeping the mail list fresh: what Refresh asks Gmail for and how its answer reads (P1-5), how
// a newly read first page joins pages loaded with "Load older" (P1-3), and when coming back to the
// window or waking the Mac reads the list again (P1-4).
import type { QueryClient } from "@tanstack/react-query";
import { compareInbox } from "../../shared/mail/inbox";

/** The fields of a list page this module reads. */
export interface FeedPage<M extends FeedRow = FeedRow> { messages: M[]; hasMore: boolean; cursor?: string }
/** A row of the list; the server sends `date` as the ISO form of the time it sorts by. */
export interface FeedRow { id: string; date: string; timestamp?: number; accountId: string; providerMessageId: string }
const position = (m: FeedRow) => ({ timestamp: m.timestamp ?? (Date.parse(m.date) || 0), accountId: m.accountId, providerMessageId: m.providerMessageId });
export interface Pages<P> { pages: P[]; pageParams: unknown[] }

/**
 * The loaded pages with a newly read first page in front (P1-3). The new page is the truth for
 * everything as new as its last row: rows of the old first page in that range that it no longer
 * has were archived, deleted or moved, and go. Older rows of the old first page stay, so nothing
 * between it and page 2 goes missing; pages 2 and on, and their cursors, are kept as they are.
 */
export function mergeHead<P extends FeedPage>(data: Pages<P> | undefined, head: P): Pages<P> {
	if (!data || data.pages.length <= 1 || !head.messages.length) return { pages: [head], pageParams: [data?.pageParams[0] ?? ""] };
	const last = position(head.messages[head.messages.length - 1]);
	const have = new Set(head.messages.map((m) => m.id));
	const tail = data.pages[0].messages.filter((m) => !have.has(m.id) && compareInbox(position(m), last) > 0);
	return { pages: [{ ...data.pages[0], ...head, messages: [...head.messages, ...tail], hasMore: data.pages[0].hasMore, cursor: data.pages[0].cursor }, ...data.pages.slice(1)], pageParams: data.pageParams };
}

/** A change the list shows before the server confirms it (P3-12): a row leaving, or a row's flags. */
export type FeedChange = { id: string; removed: true } | { id: string; patch: { read?: boolean; starred?: boolean } };
/** The cached list with `change` applied; rows of other messages are untouched. */
export function applyFeedChange<P extends { messages: { id: string }[] }>(data: Pages<P> | P | undefined, change: FeedChange): typeof data {
	if (!data) return data;
	const apply = (page: P): P => ({
		...page,
		messages: "removed" in change
			? page.messages.filter((m) => m.id !== change.id)
			: page.messages.map((m) => (m.id === change.id ? { ...m, ...change.patch } : m)),
	});
	return "pages" in data ? { ...data, pages: data.pages.map(apply) } : apply(data);
}

/**
 * Shows `change` in every cached list of the unified inbox (its pages, and the first page read
 * after Load older) before the server answers; the returned function puts them back exactly as
 * they were, for when the server refuses (P3-12).
 */
export async function showFeedChange(client: QueryClient, change: FeedChange): Promise<() => void> {
	const lists = [{ queryKey: ["unified-inbox"] }, { queryKey: ["unified-inbox-head"] }];
	// A read in flight would land on top of the change and bring the old row back.
	await Promise.all(lists.map((filter) => client.cancelQueries(filter)));
	const before = lists.flatMap((filter) => client.getQueriesData(filter));
	for (const filter of lists) client.setQueriesData(filter, (data: unknown) => applyFeedChange(data as never, change));
	return () => { for (const [key, data] of before) client.setQueryData(key, data); };
}

/**
 * When the list is read again because the person came back (P1-4): the window becoming active
 * after being away, or the Mac waking from sleep. Not more than once per `minGapMs`, so clicking
 * between windows does not refetch on every focus.
 */
export class WakeRefresh {
	private active = true;
	private last = 0;
	constructor(private minGapMs = 10_000) {}
	/** The window's activity changed; true when the list should be read now. */
	activity(active: boolean, now = Date.now()): boolean {
		const woke = active && !this.active;
		this.active = active;
		return woke && this.due(now);
	}
	/** The Mac woke from sleep (the desktop app's signal); true when the list should be read now. */
	resume(now = Date.now()): boolean {
		return this.due(now);
	}
	/** The list was read for another reason (a poll, Refresh): the next wake need not read it again soon. */
	read(now = Date.now()) {
		this.last = now;
	}
	private due(now: number) {
		if (now - this.last < this.minGapMs) return false;
		this.last = now;
		return true;
	}
}

/** What Refresh did for one Gmail or IMAP account (workers/providers/gmail-scheduler.ts, RefreshOutcome). */
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
 * The Gmail and IMAP accounts Refresh reads for the list in view: `null` when there is nothing to
 * ask (one Cloudflare address or a domain of them: that mail arrives by push), `undefined` for every
 * Gmail and IMAP account, or the one account shown.
 */
export function refreshScope(scope: { accountId: string; domain: string }): string[] | undefined | null {
	if (scope.accountId) return /^(gmail|imap):/.test(scope.accountId) ? [scope.accountId] : null;
	if (scope.domain) return null;
	return undefined;
}

/** Plain words for why an account could not be read; `who` is "Gmail" or "Its mail server". */
const FAILED: Record<string, (who: string) => string> = {
	rate_limited: (who) => `${who} asked us to slow down`,
	provider_unavailable: (who) => `${who} could not be reached`,
	provider_failed: (who) => `${who} answered with an error`,
	provider_auth_failed: (who) => `${who} refused the request`,
	credential_store_unavailable: () => "its sign-in could not be read on the server",
};
const providerOf = (accountId: string) => (accountId.startsWith("imap:") ? "Its mail server" : "Gmail");
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
		const who = providerOf(o.accountId);
		if (o.result === "backoff") notes.push(`${o.email}: ${who} failed a moment ago; it tries again at ${clock(o.retryAt ?? Date.now())}.`);
		else if (o.result === "reconnect") notes.push(`${o.email} needs to be connected again (Settings → Accounts).`);
		else if (o.result === "not_reached") notes.push(`${o.email} was not checked in time; it syncs on its own within minutes.`);
		else notes.push(`${o.email}: ${FAILED[o.error ?? ""]?.(who) ?? `${who} could not be read`}. Try again in a minute.`);
	}
	return { ok, text: [ok ? "Updated just now." : "Updated, except:", ...notes].join(" ") };
}
