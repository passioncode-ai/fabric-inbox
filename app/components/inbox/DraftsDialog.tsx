import { useEffect, useRef } from "react";
import type { Draft } from "./draft-store";
import type { InboxAccount } from "./model";
import type { ServerDraftRow } from "./server-drafts";

/** A row of the Drafts list: a draft open here, or one on the server only (another device's, an agent's). */
export type DraftListRow = { kind: "local"; draft: Draft } | { kind: "server"; row: ServerDraftRow };

/**
 * The drafts on the server across every account, with the drafts kept on this device that are not
 * there yet (B-52). A draft open here is listed once, as its copy here.
 */
export function draftRows(local: Draft[], server: ServerDraftRow[]): DraftListRow[] {
  const here = new Set(local.filter((d) => d.serverId).map((d) => `${d.accountId}\n${d.serverId}`));
  return [
    ...local.map((draft) => ({ kind: "local" as const, draft })),
    ...server.filter((r) => !here.has(`${r.accountId}\n${r.serverId}`)).map((row) => ({ kind: "server" as const, row })),
  ];
}

export default function DraftsDialog({
  drafts,
  server,
  serverState,
  accounts,
  statuses,
  onOpen,
  onOpenServer,
  onClose,
  onCompose,
}: {
  drafts: Draft[];
  server: ServerDraftRow[];
  /** "loading", "ready", or the accounts whose drafts could not be read. */
  serverState: { loading: boolean; failed: string[] };
  statuses: Record<string, string>;
  accounts: InboxAccount[];
  onOpen: (id: string) => void;
  onOpenServer: (row: ServerDraftRow) => void;
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
  const email = (id: string) => accounts.find((a) => a.id === id)?.email || id || "Choose a sender";
  const rows = draftRows(drafts, server);
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
        Drafts saved on your server, yours and your agents', from every account. Open one to
        continue, send it, or check an uncertain send.
      </p>
      {serverState.loading && <p className="fi-muted" role="status">Loading drafts from your server…</p>}
      {!!serverState.failed.length && (
        <p className="fi-notice" role="alert">
          Drafts of {serverState.failed.map(email).join(", ")} could not be loaded. Drafts on this device are listed below.
        </p>
      )}
      {!rows.length ? (
        !serverState.loading && <p>No drafts. Compose a new message to begin.</p>
      ) : (
        <ul className="fi-draft-list">
          {rows.map((r) =>
            r.kind === "local" ? (
              <li key={"local:" + r.draft.id}>
                <button type="button" onClick={() => onOpen(r.draft.id)}>
                  <strong>{r.draft.subject || "No subject"}</strong>
                  <span>{email(r.draft.accountId)}</span>
                  <span className="fi-muted">
                    {statuses[r.draft.id] ||
                      (r.draft.locked
                        ? "Outcome unknown. Retry same attempt"
                        : "Continue draft")}
                  </span>
                </button>
              </li>
            ) : (
              <li key={"server:" + r.row.accountId + ":" + r.row.serverId}>
                <button type="button" onClick={() => onOpenServer(r.row)}>
                  <strong>{r.row.subject || "No subject"}</strong>
                  <span>{email(r.row.accountId)}</span>
                  <span className="fi-muted">
                    {r.row.to ? `To ${r.row.to}` : "No recipient yet"}
                    {r.row.files ? ` · ${r.row.files} file${r.row.files === 1 ? "" : "s"}` : ""}
                  </span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      <button type="button" className="fi-primary" onClick={onCompose}>
        Compose
      </button>
    </dialog>
  );
}
