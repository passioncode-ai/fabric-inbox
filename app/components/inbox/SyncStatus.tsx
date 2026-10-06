import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowClockwiseIcon, CaretDownIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { syncStatus, type StatusAccount } from "~/lib/sync-status";
import type { RefreshOutcome } from "~/lib/mail-refresh";
import { useVisibleClock } from "~/hooks/useVisibleClock";

/**
 * Refresh and the status beside it, on the left of the inbox toolbar (operator, 2026-10-06): when
 * the server last read the accounts in view, Updating… while it reads, live for Cloudflare mail, and
 * which account failed. The line opens the details: each account with its own state and its fix.
 */
export default function SyncStatus({ accounts, checking, fetching, outcomes, onRefresh, mac }: {
  accounts: StatusAccount[];
  checking: boolean;
  fetching: boolean;
  outcomes?: RefreshOutcome[];
  onRefresh: () => void;
  mac: boolean;
}) {
  const now = useVisibleClock(15_000);
  const status = syncStatus({ accounts, now, checking, fetching, outcomes });
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const shortcut = mac ? "⌘⇧N" : "Ctrl+Shift+N";
  const busy = status.tone === "updating";
  return (
    <div className="fi-sync" data-tone={status.tone} ref={root}>
      <button type="button" className="fi-icon-button fi-refresh" aria-label="Check for new mail" title={`Check for new mail (${shortcut})`}
        aria-keyshortcuts={mac ? "Meta+Shift+N" : "Control+Shift+N"} onClick={onRefresh} disabled={checking}>
        <ArrowClockwiseIcon size={18} className={busy ? "fi-spin" : undefined} aria-hidden="true" />
      </button>
      {status.headline && (
        <button type="button" className="fi-sync-line" aria-expanded={open} aria-controls="fi-sync-details" onClick={() => setOpen(!open)}
          title="Each account's sync">
          {status.tone === "live" && <span className="fi-live-dot" aria-hidden="true" />}
          {status.tone === "error" && <WarningCircleIcon size={14} aria-hidden="true" />}
          <span>{status.headline}</span>
          <CaretDownIcon size={11} aria-hidden="true" />
        </button>
      )}
      {/* Said once when the state changes, not every time the minutes tick. */}
      <span className="fi-visually-hidden" role="status">{busy ? "Updating" : status.tone === "error" ? status.headline : ""}</span>
      {open && (
        <div id="fi-sync-details" className="fi-sync-details" role="region" aria-label="Each account's sync">
          <ul>
            {status.rows.map((r) => (
              <li key={r.id} data-state={r.state}>
                <strong>{r.email}</strong>
                <span>{r.text}</span>
                {r.action && (r.action.kind === "reconnect"
                  ? <a className="fi-text-button" href={r.action.href} target="_blank" rel="noreferrer">{r.action.label}</a>
                  : <Link className="fi-text-button" to={r.action.href} onClick={() => setOpen(false)}>{r.action.label}</Link>)}
              </li>
            ))}
          </ul>
          <p className="fi-hint">Gmail, IMAP and Outlook accounts are read every few minutes while the server runs, whether or not this window is open; Cloudflare mail arrives as it is sent. {shortcut} checks now.</p>
        </div>
      )}
    </div>
  );
}
