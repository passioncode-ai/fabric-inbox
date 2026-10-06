// The status beside Refresh (operator, 2026-10-06): how fresh the mail in view is, by the server's
// last successful read of each account in scope (`lastSyncAt` of a Gmail, IMAP or Outlook account),
// not by when this window last fetched the list. Cloudflare mail arrives by push: it is live.
// Pure, so the line, its tone and every row are tested without a browser.
import { englishT, type T } from "../../shared/i18n";
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
  /** The interface's language; English when absent (tests). */
  t?: T;
}

/**
 * Every string of the status line and its details, in the interface's language.
 * `who` names the provider ("Gmail", "Outlook", "iCloud Mail", "Its mail server").
 */
export function syncText(t: T) {
  return {
    justNow: t("just now"),
    minutesAgo: (n: number) => t.plural(n, { one: "{n} min ago", other: "{n} min ago" }),
    hoursAgo: (n: number) => t.plural(n, { one: "{n} h ago", other: "{n} h ago" }),
    onDate: (date: string) => t("on {date}", { date }),
    itsMailServer: t("Its mail server"),
    live: t("Live"),
    liveRow: t("Live: mail arrives as it is sent"),
    updating: t("Updating…"),
    updated: (age: string) => t("Updated {age}", { age }),
    updatedLower: (age: string) => t("updated {age}", { age }),
    notUpdated: t("Not updated yet"),
    notUpdatedLower: t("not updated yet"),
    withImport: (updated: string, n: number) => t("{updated} · importing {n}%", { updated, n }),
    importingRow: (n: number, updated: string) => t("Importing older mail: {n}% · {updated}", { n, updated }),
    waiting: (who: string, at: string) => t("{who} asked to slow down; next try at {at}", { who, at }),
    failedRow: (what: string, updated: string, at?: string) => at
      ? t("{what}; next try at {at} · {updated}", { what, at, updated })
      : `${what} · ${updated}`,
    reason: (short: string) => t("It {reason}", { reason: t.text(short) }),
    needsReconnect: t("It needs to be connected again"),
    couldNotRead: (who: string) => t("{who} could not be read", { who }),
    headlineFailed: (email: string) => t("{email} could not be updated", { email }),
    headlineReconnect: (email: string) => t("{email} needs to be connected again", { email }),
    headlineMany: (n: number) => t.plural(n, { one: "{n} account could not be updated", other: "{n} accounts could not be updated" }),
    newPassword: t("Enter a new app password"),
    reconnect: t("Reconnect in browser ↗"),
    why: t("Why, and what to do"),
    failed: {
      rate_limited: (who: string) => t("{who} asked to slow down", { who }),
      provider_unavailable: (who: string) => t("{who} could not be reached", { who }),
      provider_failed: (who: string) => t("{who} answered with an error", { who }),
      provider_auth_failed: (who: string) => t("{who} refused the request", { who }),
      credential_store_unavailable: () => t("its sign-in could not be read on the server"),
      mailbox_unavailable: () => t("its mailbox could not be found"),
      microsoft_secret_expired: () => t("the server's Outlook client secret has ended"),
      microsoft_client_rejected: () => t("Microsoft refuses the server's Outlook setup"),
      gmail_api_disabled: () => t.text(GMAIL_REASON_TEXT.gmail_api_disabled.short),
      google_client_rejected: () => t.text(GMAIL_REASON_TEXT.client_rejected.short),
    } as Record<string, (who: string) => string>,
    // The component (SyncStatus.tsx).
    checkNow: t("Check for new mail"),
    detailsLabel: t("Each account's sync"),
    hint: (shortcut: string) => t("Gmail, IMAP and Outlook accounts are read every few minutes while the server runs, whether or not this window is open; Cloudflare mail arrives as it is sent. {shortcut} checks now.", { shortcut }),
    updatingSr: t("Updating"),
  };
}
export type SyncText = ReturnType<typeof syncText>;
/** The English table: what tests read. */
export const SYNC_TEXT: SyncText = syncText(englishT);

/** "just now", "2 min ago", "3 h ago", "on 3 Oct". */
export function relativeAge(at: number, now: number, t: T = englishT): string {
  const T = syncText(t);
  const age = Math.max(0, now - at);
  if (age < 45_000) return T.justNow;
  if (age < 3_600_000) return T.minutesAgo(Math.max(1, Math.round(age / 60_000)));
  if (age < 86_400_000) return T.hoursAgo(Math.round(age / 3_600_000));
  return T.onDate(t.date(at, { day: "numeric", month: "short" }));
}

function row(a: StatusAccount, now: number, t: T, outcome?: RefreshOutcome): StatusRow {
  const T = syncText(t);
  const clock = (at: number) => t.time(at, { hour: "2-digit", minute: "2-digit" });
  const who = a.provider === "gmail" ? "Gmail" : a.provider === "outlook" ? "Outlook" : a.providerName && a.providerName !== "IMAP" ? a.providerName : T.itsMailServer;
  const reconnectAction: StatusRow["action"] = a.provider === "imap"
    ? { kind: "password", href: `/settings/accounts/${encodeURIComponent(a.id)}`, label: T.newPassword }
    : { kind: "reconnect", href: a.provider === "outlook" ? "/api/accounts/outlook/connect" : "/api/accounts/gmail/connect", label: T.reconnect };
  const base = { id: a.id, email: a.email, provider: a.provider };
  if (a.provider === "cloudflare") return { ...base, state: "live", text: T.liveRow };
  const settings = { kind: "settings" as const, href: `/settings/accounts/${encodeURIComponent(a.id)}`, label: T.why };
  const reason = isGmailReason(a.reason) ? GMAIL_REASON_TEXT[a.reason] : null;
  if (a.status === "reconnect_required" || outcome?.result === "reconnect" || reason?.action === "reconnect")
    return { ...base, state: a.provider === "imap" ? "password" : "reconnect", text: reason ? T.reason(reason.short) : T.needsReconnect, action: reconnectAction };
  const updated = a.lastSyncAt ? T.updatedLower(relativeAge(a.lastSyncAt, now, t)) : T.notUpdatedLower;
  if (outcome?.result === "failed" || outcome?.result === "backoff" || a.status === "error") {
    const code = outcome?.error ?? a.error ?? "";
    const what = reason ? T.reason(reason.short) : (T.failed[code]?.(who) ?? T.couldNotRead(who));
    const retry = outcome?.retryAt ?? a.retryAt;
    return { ...base, state: "failed", text: T.failedRow(what, updated, retry && retry > now ? clock(retry) : undefined), action: settings };
  }
  if (a.status === "rate_limited" && a.retryAt && a.retryAt > now)
    return { ...base, state: "waiting", text: T.waiting(who, clock(a.retryAt)) };
  if (a.importing !== undefined) return { ...base, state: "importing", text: T.importingRow(a.importing, updated) };
  if (!a.lastSyncAt) return { ...base, state: "never", text: T.notUpdated };
  return { ...base, state: "synced", text: T.updated(relativeAge(a.lastSyncAt, now, t)) };
}

/** The line beside Refresh and the rows of its details. */
export function syncStatus(input: StatusInput): SyncStatus {
  const t = input.t ?? englishT;
  const T = syncText(t);
  const outcomes = new Map((input.outcomes ?? []).map((o) => [o.accountId, o]));
  const rows = input.accounts.map((a) => row(a, input.now, t, outcomes.get(a.id)));
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
  const read = remote.map((a) => a.lastSyncAt).filter((at): at is number => typeof at === "number");
  if (!read.length) return { tone: "idle", headline: T.notUpdated, rows };
  const importing = remote.map((a) => a.importing).filter((n): n is number => typeof n === "number");
  const updated = T.updated(relativeAge(Math.min(...read), input.now, t));
  return { tone: "idle", headline: importing.length ? T.withImport(updated, Math.min(...importing)) : updated, rows };
}
