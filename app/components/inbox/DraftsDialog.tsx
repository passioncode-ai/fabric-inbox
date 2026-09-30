import { useEffect, useRef } from "react";
import type { Draft } from "./draft-store";
import type { InboxAccount } from "./model";
export default function DraftsDialog({
  drafts,
  accounts,
  statuses,
  onOpen,
  onClose,
  onCompose,
}: {
  drafts: Draft[];
  statuses: Record<string, string>;
  accounts: InboxAccount[];
  onOpen: (id: string) => void;
  onClose: () => void;
  onCompose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="fi-drafts-dialog"
      aria-labelledby="drafts-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="drafts-title">Drafts</h2>
        <button
          type="button"
          className="fi-icon-button"
          aria-label="Close drafts"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <p className="fi-muted">
        Drafts on this device. Open a draft to continue or check an uncertain
        send.
      </p>
      {!drafts.length ? (
        <p>No saved drafts. Compose a new message to begin.</p>
      ) : (
        <ul className="fi-draft-list">
          {drafts.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onOpen(d.id)}>
                <strong>{d.subject || "No subject"}</strong>
                <span>
                  {accounts.find((a) => a.id === d.accountId)?.email ||
                    d.accountId ||
                    "Choose a sender"}
                </span>
                <span className="fi-muted">
                  {statuses[d.id] ||
                    (d.locked
                      ? "Outcome unknown. Retry same attempt"
                      : "Continue draft")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="fi-primary" onClick={onCompose}>
        Compose
      </button>
    </dialog>
  );
}
