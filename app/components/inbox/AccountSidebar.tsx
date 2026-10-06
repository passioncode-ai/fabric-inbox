import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CaretDownIcon, CaretRightIcon, AtIcon, EyeIcon, EyeSlashIcon, GoogleLogoIcon } from "@phosphor-icons/react";
import type { InboxAccount } from "./model";
import { addressLabel, groupAccounts, sidebarAccounts, type AddressFilter } from "./account-groups";

interface Props {
  accounts: InboxAccount[];
  accountId: string;
  domain: string;
  /** "gmail" while every Gmail account is shown. */
  provider?: string;
  loading: boolean;
  onScope: (patch: Record<string, string>) => void;
  /** Addresses the operator hid (out of All inboxes and totals; still receiving). */
  hidden: Set<string>;
  /** Hide or show addresses; resolves when saved. */
  onHidden: (change: { hide?: string[]; show?: string[] }) => Promise<void>;
  busy?: boolean;
}

const FILTER_KEY = "fabric-inbox:address-filter";
function readFilter(): AddressFilter {
  try { return localStorage.getItem(FILTER_KEY) === "all" ? "all" : "mail"; } catch { return "mail"; }
}

function Count({ n, label, stale }: { n?: number; label: string; stale?: boolean }) {
  if (!n) return null;
  // A count the server could not read just now is the last one known, and says so (P2-11).
  return stale
    ? <span className="fi-unread-count is-stale" title="Last known count; it could not be updated just now" aria-label={`${n} unread in ${label}, may be out of date`}>{n}</span>
    : <span className="fi-unread-count" aria-label={`${n} unread in ${label}`}>{n}</span>;
}
/** What a Gmail account's sync is doing while it is not simply up to date (P2-10). */
export function syncLabel(a: { status: string; importing?: number }) {
  if (a.status !== "syncing") return "";
  return typeof a.importing === "number" ? `importing ${a.importing}%` : "importing";
}

/**
 * Accounts in the sidebar (CF-1): one row per domain that selects the whole
 * domain and expands to its addresses; Gmail accounts in their own group.
 * By default only addresses with mail are listed (plus catch-alls and the open one);
 * any address can be hidden, and hidden ones wait in their own list.
 */
export default function AccountSidebar({ accounts, accountId, domain, provider = "", loading, onScope, hidden, onHidden, busy }: Props) {
  const [filter, setFilterState] = useState<AddressFilter>("mail");
  useEffect(() => { setFilterState(readFilter()); }, []);
  const setFilter = (f: AddressFilter) => {
    setFilterState(f);
    try { localStorage.setItem(FILTER_KEY, f); } catch { /* per-device convenience only */ }
  };
  const { visible, hidden: hiddenAccounts, withoutMail } = sidebarAccounts(accounts, { filter, hidden, selectedId: accountId });
  const groups = groupAccounts(visible);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [confirmHideEmpty, setConfirmHideEmpty] = useState(false);
  const small = visible.length <= 6;
  const nav = useRef<HTMLElement>(null);
  // A selection made elsewhere (a link, the URL, a scrolled-away row) is brought into view once.
  // Polling changes the list length every few seconds; that alone never scrolls the sidebar again.
  const scrolledFor = useRef("");
  useEffect(() => {
    const key = `${accountId}|${domain}|${provider}`;
    if (scrolledFor.current === key) return;
    const active = nav.current?.querySelector(".is-active");
    if (!active) return;
    scrolledFor.current = key;
    active.scrollIntoView?.({ block: "nearest" });
  }, [accountId, domain, provider, accounts.length]);
  // The group of a selected address opens and stays open: choosing another one never folds the
  // previous group away under the pointer (the 2026-10-06 audit).
  const selectedGroup = groups.find((g) => g.accounts.some((a) => a.id === accountId))?.key;
  useEffect(() => {
    if (selectedGroup) setOpen((current) => (current.has(selectedGroup) ? current : new Set(current).add(selectedGroup)));
  }, [selectedGroup]);
  // Only the caret opens and closes a group; the name selects the whole domain and nothing else.
  const isOpen = (key: string, list: InboxAccount[]) =>
    small || open.has(key) || list.some((a) => a.id === accountId);
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const notListed = filter === "mail" ? withoutMail.filter((a) => a.id !== accountId).length : 0;
  return (
    <>
      <div className="fi-section-label">
        ADDRESSES
        <Link to="/settings/addresses?add=1" aria-label="Add an address">+</Link>
      </div>
      {accounts.length > 0 && (
        <div className="fi-address-filter" role="group" aria-label="Which addresses to list">
          <button type="button" aria-pressed={filter === "mail"} onClick={() => setFilter("mail")}>With mail</button>
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
        </div>
      )}
      <nav ref={nav} className="fi-account-list" aria-label="Addresses by domain">
        {groups.map((g) => {
          const expanded = isOpen(g.key, g.accounts);
          const selectedGroup = (g.kind === "domain" && domain === g.key) || (g.kind === "gmail" && provider === "gmail");
          return (
            <div key={g.key} className="fi-account-group">
              <div className={"fi-domain-row" + (selectedGroup ? " is-active" : "")}>
                <button type="button" className="fi-domain-toggle" aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${g.label}`} onClick={() => toggle(g.key)} disabled={small}>
                  {expanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
                </button>
                <button type="button" className="fi-domain-name" aria-pressed={selectedGroup}
                  title={g.kind === "gmail" ? "Every Gmail account" : `Every address on ${g.label}`}
                  onClick={() => g.kind === "gmail" ? onScope({ provider: "gmail", domain: "", account: "" }) : onScope({ domain: g.key, account: "", provider: "" })}>
                  {g.kind === "gmail" ? <GoogleLogoIcon size={14} /> : <AtIcon size={14} />}
                  <span>{g.label}</span>
                  <Count n={g.unread} label={g.label} />
                </button>
              </div>
              {expanded && (
                <ul className="fi-domain-addresses">
                  {g.accounts.map((a) => (
                    <li key={a.id} className="fi-address-item">
                      <button type="button" className={"fi-address" + (a.id === accountId ? " is-active" : "")}
                        aria-pressed={a.id === accountId} title={a.email}
                        onClick={() => onScope({ account: a.id, domain: "", provider: "" })}>
                        <span className="fi-address-name">{addressLabel(a)}</span>
                        {(a.error || !["connected", "syncing"].includes(a.status)) ? (
                          <span className="fi-address-alert" title={a.error || a.status}>needs attention</span>
                        ) : syncLabel(a) && (
                          <span className="fi-address-sync" title="Older Gmail mail is still being imported; new mail already arrives">{syncLabel(a)}</span>
                        )}
                        <Count n={a.unread} label={a.email} stale={a.countsStale} />
                      </button>
                      <button type="button" className="fi-address-hide" disabled={busy} aria-label={`Hide ${a.email}`}
                        title="Hide: out of All inboxes and the counts; it keeps receiving"
                        onClick={() => void onHidden({ hide: [a.id] })}>
                        <EyeSlashIcon size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      {!accounts.length && !loading && (
        <p className="fi-sidebar-empty">No addresses yet. Add an address on one of your domains, or connect Gmail.</p>
      )}
      {notListed > 0 && (
        <div className="fi-address-note">
          {!confirmHideEmpty ? (
            <>
              {notListed} without mail not listed.{" "}
              <button type="button" className="fi-text-button" onClick={() => setFilter("all")}>Show</button>
              {" · "}
              <button type="button" className="fi-text-button" disabled={busy} onClick={() => setConfirmHideEmpty(true)}>Hide them…</button>
            </>
          ) : (
            <span role="alert">
              Hide the {notListed} address{notListed === 1 ? "" : "es"} with no mail? They keep receiving; new mail shows under Hidden.{" "}
              <button type="button" className="fi-text-button" disabled={busy} onClick={() => {
                setConfirmHideEmpty(false);
                void onHidden({ hide: withoutMail.filter((a) => a.id !== accountId).map((a) => a.id) });
              }}>Hide</button>
              {" "}
              <button type="button" className="fi-text-button" onClick={() => setConfirmHideEmpty(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {hiddenAccounts.length > 0 && (
        <div className="fi-hidden-accounts">
          <button type="button" className="fi-text-button" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen(!hiddenOpen)}>
            {hiddenOpen ? <CaretDownIcon size={11} aria-hidden="true" /> : <CaretRightIcon size={11} aria-hidden="true" />}
            Hidden ({hiddenAccounts.length})
          </button>
          {hiddenOpen && (
            <ul>
              {hiddenAccounts.map((a) => (
                <li key={a.id} className="fi-address-item">
                  <button type="button" className={"fi-address" + (a.id === accountId ? " is-active" : "")} title={`Open ${a.email}`}
                    onClick={() => onScope({ account: a.id, domain: "", provider: "" })}>
                    <span className="fi-address-name">{a.email}</span>
                    <Count n={a.unread} label={a.email} />
                  </button>
                  <button type="button" className="fi-address-hide is-shown" disabled={busy} aria-label={`Show ${a.email} again`} title="Show again"
                    onClick={() => void onHidden({ show: [a.id] })}>
                    <EyeIcon size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="fi-add-links">
        <Link className="fi-add-account" to="/settings/addresses?add=1"><AtIcon size={15} /> Add address</Link>
        <Link className="fi-add-account" to="/settings/accounts?connect=gmail"><GoogleLogoIcon size={15} /> Connect Gmail</Link>
      </div>
    </>
  );
}
