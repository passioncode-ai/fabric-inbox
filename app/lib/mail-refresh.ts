// Keeping the mail list fresh: what Refresh asks Gmail for and how its answer reads (P1-5), how
// a newly read first page joins pages loaded with "Load older" (P1-3), and when coming back to the
// window or waking the Mac reads the list again (P1-4).
import type { QueryClient } from "@tanstack/react-query";
import { englishT, type T } from "../../shared/i18n";
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
 * The Gmail, IMAP and Outlook accounts Refresh reads for the list in view: `null` when there is
 * nothing to ask (one Cloudflare address or a domain of them: that mail arrives by push), `undefined`
 * for every one of them, or the one account shown.
 */
export function refreshScope(scope: { accountId: string; domain: string }): string[] | undefined | null {
	if (scope.accountId) return /^(gmail|imap|outlook):/.test(scope.accountId) ? [scope.accountId] : null;
	if (scope.domain) return null;
	return undefined;
}

/** Plain words for why an account could not be read; `who` is "Gmail" or "Its mail server". */
function failedText(code: string, who: string, t: T): string {
	switch (code) {
		case "rate_limited": return t("{who} asked us to slow down", { who });
		case "provider_unavailable": return t("{who} could not be reached", { who });
		case "provider_failed": return t("{who} answered with an error", { who });
		case "provider_auth_failed": return t("{who} refused the request", { who });
		case "credential_store_unavailable": return t("its sign-in could not be read on the server");
		default: return t("{who} could not be read", { who });
	}
}

/** One sentence per account that did not simply sync; `ok` when every account did. */
export function refreshSummary(outcomes: RefreshOutcome[], t: T = englishT): { ok: boolean; text: string } {
	const notes: string[] = [];
	const clock = (at: number) => t.time(at, { hour: "2-digit", minute: "2-digit" });
	let ok = true;
	for (const o of outcomes) {
		if (o.result === "synced") {
			if (o.importing !== undefined) notes.push(t("{email} is still importing older mail ({n}%); new mail is in.", { email: o.email, n: o.importing }));
			continue;
		}
		ok = false;
		const who = o.accountId.startsWith("imap:") ? t("Its mail server") : "Gmail";
		if (o.result === "backoff") notes.push(t("{email}: {who} failed a moment ago; it tries again at {at}.", { email: o.email, who, at: clock(o.retryAt ?? Date.now()) }));
		else if (o.result === "reconnect") notes.push(t("{email} needs to be connected again (Settings → Accounts).", { email: o.email }));
		else if (o.result === "not_reached") notes.push(t("{email} was not checked in time; it syncs on its own within minutes.", { email: o.email }));
		else notes.push(t("{email}: {problem}. Try again in a minute.", { email: o.email, problem: failedText(o.error ?? "", who, t) }));
	}
	return { ok, text: [ok ? t("Updated just now.") : t("Updated, except:"), ...notes].join(" ") };
}
