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

/**
 * What the sidebar lists (2026-09-29): hidden addresses apart; with "mail", an address is
 * listed when it has mail in its inbox, keeps mail for other addresses (catch-all), is the one
 * open, or its count is not known yet. `withoutMail` are the ones "Hide those without mail" takes.
 */
export function sidebarAccounts(accounts: InboxAccount[], options: { filter: AddressFilter; hidden: Set<string>; selectedId?: string }) {
  const hidden = accounts.filter((a) => options.hidden.has(a.id.toLowerCase()));
  const shown = accounts.filter((a) => !options.hidden.has(a.id.toLowerCase()));
  const hasMail = (a: InboxAccount) => typeof a.total !== "number" || a.total > 0 || (a.unread ?? 0) > 0 || !!a.catchAll;
  const visible = options.filter === "all" ? shown : shown.filter((a) => hasMail(a) || a.id === options.selectedId);
  const withoutMail = shown.filter((a) => !hasMail(a));
  return { visible, hidden, withoutMail };
}
