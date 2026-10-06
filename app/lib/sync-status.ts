// The status beside Refresh (operator, 2026-10-06): how fresh the mail in view is, by the server's
// last successful read of each account in scope (`lastSyncAt` of a Gmail, IMAP or Outlook account),
// not by when this window last fetched the list. Cloudflare mail arrives by push: it is live.
// Pure, so the line, its tone and every row are tested without a browser.
import { GMAIL_REASON_TEXT, isGmailReason } from "../../shared/mail/gmail-reasons";
import type { RefreshOutcome } from "./mail-refresh";

export interface StatusAccount {
  id: string;
  provider: "cloudflare" | "gmail" | "imap" | "outlook";
  email: string;
  status: string;
  error?: string;
  reason?: string;
  lastSyncAt?: number;
  importing?: number;
  retryAt?: number;
  providerName?: string;
}
export type RowState = "live" | "synced" | "importing" | "waiting" | "never" | "reconnect" | "password" | "failed";
export interface StatusRow {
  id: string;
  email: string;
  provider: StatusAccount["provider"];
  state: RowState;
  text: string;
  /** What fixes it: a sign-in in the browser, a new app password in Settings, or the account's panel. */
  action?: { kind: "reconnect" | "password" | "settings"; href: string; label: string };
}
export interface SyncStatus {
  tone: "idle" | "live" | "updating" | "error";
  headline: string;
  rows: StatusRow[];
}
export interface StatusInput {
  accounts: StatusAccount[];
  now: number;
  /** Refresh (Check for new mail) is running. */
  checking: boolean;
  /** The list is being read again. */
  fetching: boolean;
  /** What the last Refresh said per account. */
  outcomes?: RefreshOutcome[];
}

/**
 * Every string of the status line and its details, in one table for the localization that follows.
 * `w` names the provider ("Gmail", "Outlook", "iCloud Mail", "Its mail server").
 */
export const SYNC_TEXT = {
  justNow: "just now",
  minutesAgo: (n: number) => `${n} min ago`,
  hoursAgo: (n: number) => `${n} h ago`,
  onDate: (date: string) => "on " + date,
  itsMailServer: "Its mail server",
  live: "Live",
  liveRow: "Live: mail arrives as it is sent",
  updating: "Updating…",
  updated: (age: string) => "Updated " + age,
  updatedLower: (age: string) => "updated " + age,
  notUpdated: "Not updated yet",
  notUpdatedLower: "not updated yet",
  importingHeadline: (n: number) => ` · importing ${n}%`,
  importingRow: (n: number, updated: string) => `Importing older mail: ${n}% · ${updated}`,
  waiting: (w: string, at: string) => `${w} asked to slow down; next try at ${at}`,
  nextTry: (at: string) => `; next try at ${at}`,
  reason: (short: string) => `It ${short}`,
  needsReconnect: "It needs to be connected again",
  couldNotRead: (w: string) => `${w} could not be read`,
  headlineFailed: (email: string) => `${email} could not be updated`,
  headlineReconnect: (email: string) => `${email} needs to be connected again`,
  headlineMany: (n: number) => `${n} accounts could not be updated`,
  newPassword: "Enter a new app password",
  reconnect: "Reconnect in browser ↗",
  why: "Why, and what to do",
  failed: {
    rate_limited: (w: string) => `${w} asked to slow down`,
    provider_unavailable: (w: string) => `${w} could not be reached`,
    provider_failed: (w: string) => `${w} answered with an error`,
    provider_auth_failed: (w: string) => `${w} refused the request`,
    credential_store_unavailable: () => "its sign-in could not be read on the server",
    mailbox_unavailable: () => "its mailbox could not be found",
    microsoft_secret_expired: () => "the server's Outlook client secret has ended",
    microsoft_client_rejected: () => "Microsoft refuses the server's Outlook setup",
    gmail_api_disabled: () => GMAIL_REASON_TEXT.gmail_api_disabled.short,
    google_client_rejected: () => GMAIL_REASON_TEXT.client_rejected.short,
  } as Record<string, (w: string) => string>,
  // The component (SyncStatus.tsx).
  checkNow: "Check for new mail",
  detailsLabel: "Each account's sync",
  hint: (shortcut: string) => `Gmail, IMAP and Outlook accounts are read every few minutes while the server runs, whether or not this window is open; Cloudflare mail arrives as it is sent. ${shortcut} checks now.`,
  updatingSr: "Updating",
};
const T = SYNC_TEXT;

/** "just now", "2 min ago", "3 h ago", "on 3 Oct". */
export function relativeAge(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age < 45_000) return T.justNow;
  if (age < 3_600_000) return T.minutesAgo(Math.max(1, Math.round(age / 60_000)));
  if (age < 86_400_000) return T.hoursAgo(Math.round(age / 3_600_000));
  return T.onDate(new Date(at).toLocaleDateString([], { day: "numeric", month: "short" }));
}
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const who = (a: StatusAccount) => (a.provider === "gmail" ? "Gmail" : a.provider === "outlook" ? "Outlook" : a.providerName && a.providerName !== "IMAP" ? a.providerName : T.itsMailServer);

function reconnectAction(a: StatusAccount): StatusRow["action"] {
  if (a.provider === "imap") return { kind: "password", href: `/settings/accounts/${encodeURIComponent(a.id)}`, label: T.newPassword };
  return { kind: "reconnect", href: a.provider === "outlook" ? "/api/accounts/outlook/connect" : "/api/accounts/gmail/connect", label: T.reconnect };
}

function row(a: StatusAccount, now: number, outcome?: RefreshOutcome): StatusRow {
  const base = { id: a.id, email: a.email, provider: a.provider };
  if (a.provider === "cloudflare") return { ...base, state: "live", text: T.liveRow };
  const settings = { kind: "settings" as const, href: `/settings/accounts/${encodeURIComponent(a.id)}`, label: T.why };
  const reason = isGmailReason(a.reason) ? GMAIL_REASON_TEXT[a.reason] : null;
  if (a.status === "reconnect_required" || outcome?.result === "reconnect" || reason?.action === "reconnect")
    return { ...base, state: a.provider === "imap" ? "password" : "reconnect", text: reason ? T.reason(reason.short) : T.needsReconnect, action: reconnectAction(a) };
  const updated = a.lastSyncAt ? T.updatedLower(relativeAge(a.lastSyncAt, now)) : T.notUpdatedLower;
  if (outcome?.result === "failed" || outcome?.result === "backoff" || a.status === "error") {
    const code = outcome?.error ?? a.error ?? "";
    const what = reason ? T.reason(reason.short) : (T.failed[code]?.(who(a)) ?? T.couldNotRead(who(a)));
    const retry = outcome?.retryAt ?? a.retryAt;
    return { ...base, state: "failed", text: `${what}${retry && retry > now ? T.nextTry(clock(retry)) : ""} · ${updated}`, action: settings };
  }
  if (a.status === "rate_limited" && a.retryAt && a.retryAt > now)
    return { ...base, state: "waiting", text: T.waiting(who(a), clock(a.retryAt)) };
  if (a.importing !== undefined) return { ...base, state: "importing", text: T.importingRow(a.importing, updated) };
  if (!a.lastSyncAt) return { ...base, state: "never", text: T.notUpdated };
  return { ...base, state: "synced", text: T.updated(relativeAge(a.lastSyncAt, now)) };
}

/** The line beside Refresh and the rows of its details. */
export function syncStatus(input: StatusInput): SyncStatus {
  const outcomes = new Map((input.outcomes ?? []).map((o) => [o.accountId, o]));
  const rows = input.accounts.map((a) => row(a, input.now, outcomes.get(a.id)));
  if (!rows.length) return { tone: input.checking || input.fetching ? "updating" : "idle", headline: input.checking || input.fetching ? T.updating : "", rows };
  if (input.checking || input.fetching) return { tone: "updating", headline: T.updating, rows };
  const failed = rows.filter((r) => r.state === "failed" || r.state === "reconnect" || r.state === "password");
  if (failed.length === 1) {
    const r = failed[0]!;
    return { tone: "error", headline: r.state === "failed" ? T.headlineFailed(r.email) : T.headlineReconnect(r.email), rows };
  }
  if (failed.length > 1) return { tone: "error", headline: T.headlineMany(failed.length), rows };
  const remote = input.accounts.filter((a) => a.provider !== "cloudflare");
  if (!remote.length) return { tone: "live", headline: T.live, rows };
  const read = remote.map((a) => a.lastSyncAt).filter((t): t is number => typeof t === "number");
  if (!read.length) return { tone: "idle", headline: T.notUpdated, rows };
  const importing = remote.map((a) => a.importing).filter((n): n is number => typeof n === "number");
  const progress = importing.length ? T.importingHeadline(Math.min(...importing)) : "";
  return { tone: "idle", headline: T.updated(relativeAge(Math.min(...read), input.now)) + progress, rows };
}
