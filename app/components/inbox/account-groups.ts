import { englishT, type T } from "../../../shared/i18n";
import type { InboxAccount } from "./model";

export interface AccountGroup {
  /** "gmail", "outlook", "imap" or the domain of a group of Cloudflare addresses. */
  key: string;
  label: string;
  kind: "domain" | "gmail" | "outlook" | "imap";
  accounts: InboxAccount[];
  /** Sum of the known unread counts; undefined when no account reported one. */
  unread?: number;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Sidebar structure (CF-1): Cloudflare addresses grouped by domain, domains in
 * alphabetical order, catch-all last inside its domain; Gmail accounts in one
 * group at the top, Outlook accounts in one after it, IMAP accounts ("Other mail") after that.
 * Pure, so ordering is testable.
 */
export function groupAccounts(accounts: InboxAccount[], t: T = englishT): AccountGroup[] {
  const sum = (list: InboxAccount[]) => list.some((a) => typeof a.unread === "number")
    ? list.reduce((n, a) => n + (a.unread ?? 0), 0) : undefined;
  const gmail = accounts.filter((a) => a.provider === "gmail").sort((a, b) => a.email.localeCompare(b.email));
  const outlook = accounts.filter((a) => a.provider === "outlook").sort((a, b) => a.email.localeCompare(b.email));
  const imap = accounts.filter((a) => a.provider === "imap").sort((a, b) => a.email.localeCompare(b.email));
  const byDomain = new Map<string, InboxAccount[]>();
  for (const a of accounts.filter((x) => x.provider === "cloudflare")) {
    const d = domainOf(a.email);
    byDomain.set(d, [...(byDomain.get(d) ?? []), a]);
  }
  const groups: AccountGroup[] = [];
  if (gmail.length) groups.push({ key: "gmail", label: "Gmail", kind: "gmail", accounts: gmail, unread: sum(gmail) });
  if (outlook.length) groups.push({ key: "outlook", label: "Outlook", kind: "outlook", accounts: outlook, unread: sum(outlook) });
  if (imap.length) groups.push({ key: "imap", label: t("Other mail"), kind: "imap", accounts: imap, unread: sum(imap) });
  for (const [domain, list] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => (a.email.startsWith("catch-all@") ? 1 : 0) - (b.email.startsWith("catch-all@") ? 1 : 0) || a.email.localeCompare(b.email));
    groups.push({ key: domain, label: domain, kind: "domain", accounts: list, unread: sum(list) });
  }
  return groups;
}

/** What a row shows: the part before @ for a domain address ("everything else" for the catch-all). */
export function addressLabel(account: InboxAccount, t: T = englishT): string {
  if (account.provider !== "cloudflare") return account.email;
  const local = account.email.slice(0, account.email.lastIndexOf("@"));
  return local === "catch-all" ? t("everything else") : local;
}

export function totalUnread(accounts: InboxAccount[]): number | undefined {
  return accounts.some((a) => typeof a.unread === "number") ? accounts.reduce((n, a) => n + (a.unread ?? 0), 0) : undefined;
}

export type AddressFilter = "mail" | "all";

/** How long a new address or account is listed before its first message (2026-10-08). */
export const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Created (or connected) less than 7 days ago. An account with no creation time — every
 * Cloudflare address made before the server recorded it — is not new.
 */
export function isNewAccount(account: InboxAccount, now: number): boolean {
  return typeof account.createdAt === "number" && now - account.createdAt < NEW_ACCOUNT_MS;
}

/**
 * What the sidebar lists (2026-09-29): hidden addresses apart; with "mail", an address is
 * listed when it has mail in its inbox, keeps mail for other addresses (catch-all), is the one
 * open, its count is not known yet, or it was created in the last 7 days (2026-10-08: an address
 * just made must not vanish the moment it is made). `withoutMail` are the ones left out, which
 * "Hide them…" takes; a new address is never among them.
 */
export function sidebarAccounts(accounts: InboxAccount[], options: { filter: AddressFilter; hidden: Set<string>; selectedId?: string; now?: number }) {
  const now = options.now ?? Date.now();
  const hidden = accounts.filter((a) => options.hidden.has(a.id.toLowerCase()));
  const shown = accounts.filter((a) => !options.hidden.has(a.id.toLowerCase()));
  const listed = (a: InboxAccount) => typeof a.total !== "number" || a.total > 0 || (a.unread ?? 0) > 0 || !!a.catchAll || isNewAccount(a, now);
  const visible = options.filter === "all" ? shown : shown.filter((a) => listed(a) || a.id === options.selectedId);
  const withoutMail = shown.filter((a) => !listed(a));
  return { visible, hidden, withoutMail };
}
