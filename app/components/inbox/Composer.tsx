import { useEffect, useRef, useState } from "react";
import { fabric, accountPath } from "~/services/fabric";
import { ApiError } from "~/services/api";
import { recipientAddresses, sendRecovery } from "./send-state";
import { isRemote, rawAccount, type InboxAccount } from "./model";
import type { Draft } from "./draft-store";
import {
  attachmentsOnDevice,
  captureFiles,
  type AttachmentRef,
} from "./attachment-store";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  validateAttachments,
} from "../../../shared/mail/attachments";
import { missingOriginals, prepareMessage } from "./compose-payload";
import { sendSavedDraft, signatureFor, swapSignature } from "./server-drafts";
import type { SyncStatus } from "./use-drafts";
import { useT } from "../../lib/i18n";
export type { Draft } from "./draft-store";
export default function Composer({
  draft,
  storageError,
  saving,
  sync,
  onFlush,
  onResync,
  onResolve,
  onLock,
  onSettle,
  onDiscard,
  onReopen,
  accounts,
  onChange,
  onAddAttachments,
  onCompleteAttachments,
  onClose,
  onSent,
}: {
  draft: Draft;
  storageError: string;
  saving: boolean;
  /** How the server's copy stands (B-52). */
  sync: SyncStatus | null;
  onFlush: (d: Draft) => Promise<Draft | null>;
  onResync: (d: Draft) => Promise<void>;
  onResolve: (d: Draft, choice: "theirs" | "mine") => Promise<void>;
  onLock: (d: Draft) => Promise<Draft>;
  onSettle: (
    d: Draft,
    outcome: "accepted" | "failed" | "editable",
  ) => Promise<void>;
  onDiscard: (d: Draft) => Promise<void>;
  onReopen: (d: Draft) => void;
  accounts: InboxAccount[];
  onChange: (d: Draft) => void;
  onAddAttachments: (id: string, refs: AttachmentRef[]) => Promise<boolean>;
  onCompleteAttachments: (id: string, ids: string[]) => Promise<boolean>;
  onClose: () => void;
  onSent: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null),
    sending = useRef(false),
    fileWork = useRef(false),
    // The native file input shows its own words in the browser's language, not the one chosen in
    // Settings (L10N-01), so it stays hidden and a button of ours opens it.
    filePicker = useRef<HTMLInputElement>(null),
    // A validation failure moves focus to the field that failed, else to the alert itself (B10-03).
    toField = useRef<HTMLInputElement>(null),
    ccField = useRef<HTMLInputElement>(null),
    bccField = useRef<HTMLInputElement>(null),
    alertRef = useRef<HTMLParagraphElement>(null);
  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loadingFiles, setLoadingFiles] = useState(false);
  // A send stopped because the draft was not saved says so until the draft is saved again.
  const unsavedNotice = useRef("");
  useEffect(() => {
    if (sync?.state === "saved" && unsavedNotice.current) {
      setNotice((n) => (n === unsavedNotice.current ? "" : n));
      unsavedNotice.current = "";
    }
  }, [sync?.state]);
  useEffect(() => {
    const el = dialog.current;
    const previous = document.activeElement as HTMLElement;
    el?.showModal();
    el?.querySelector("textarea")?.focus();
    return () => {
      el?.close();
      previous?.focus();
    };
  }, []);
  const account = accounts.find((a) => a.id === draft.accountId);
  /** A file's size: as before in English (the system's digit grouping), with the noun's form in Russian. */
  const bytes = (size: number) =>
    t.plural(size, { one: "{size} byte", other: "{size} bytes" }, {
      size: t.locale === "en" ? size.toLocaleString() : t.number(size),
    });
  function change(patch: Partial<Draft>) {
    onChange({ ...draft, ...patch });
  }
  /** A new message's sender changed: its signature follows the sender. */
  async function changeSender(accountId: string) {
    let signature = "";
    try {
      signature = accountId ? await signatureFor(accountId, fabric) : "";
    } catch {
      setNotice(t("The sender's signature could not be loaded; add it to the message if you need it."));
    }
    change({ accountId, text: swapSignature(draft.text, draft.signature, signature), signature });
  }
  /** After a validation failure: focus the recipient field that fails (To, then Cc, then Bcc), else the alert. */
  function focusProblem() {
    const fields: [typeof toField, string, boolean][] = [
      [toField, draft.to, true],
      [ccField, draft.cc ?? "", false],
      [bccField, draft.bcc ?? "", false],
    ];
    const bad = fields.find(([, value, required]) => {
      if (!required && !value.trim()) return false;
      try {
        recipientAddresses(value);
        return false;
      } catch {
        return true;
      }
    });
    requestAnimationFrame(() => (bad?.[0].current ?? alertRef.current)?.focus());
  }
  async function send() {
    if (
      sending.current ||
      fileWork.current ||
      !account ||
      saving ||
      storageError
    )
      return;
    sending.current = true;
    setBusy(true);
    let prepared: Awaited<ReturnType<typeof prepareMessage>>;
    try {
      prepared = await prepareMessage(draft, attachmentsOnDevice());
    } catch (error) {
      setNotice(t.text((error as Error).message));
      focusProblem();
      sending.current = false;
      setBusy(false);
      return;
    }
    // A draft is sent from the server (B-52); an attempt begun before drafts lived there keeps its route.
    const legacy = !!draft.locked && !draft.serverId;
    let target = draft;
    if (!legacy && !draft.locked) {
      const saved = await onFlush(draft);
      if (!saved?.synced || !saved.serverId) {
        sending.current = false;
        setBusy(false);
        unsavedNotice.current = t("The draft could not be saved to your server, so it was not sent. Check the connection and try again.");
        setNotice(unsavedNotice.current);
        return;
      }
      target = saved;
    }
    let fixed: Draft;
    try {
      fixed = draft.locked ? draft : await onLock(target);
    } catch {
      sending.current = false;
      setBusy(false);
      setNotice(
        t("Could not save send recovery information. Sending was not attempted."),
      );
      return;
    }
    setNotice("");
    try {
      // Gmail, IMAP and Outlook accounts send through /api/accounts/<id>/send; a Cloudflare mailbox through its own route.
      const isGmail = isRemote(account.provider);
      if (!legacy) {
        const result = await sendSavedDraft(fixed, fabric);
        if (result.status === "accepted") {
          await onSettle(fixed, "accepted");
          onSent();
          onClose();
        } else
          setNotice(t("Acceptance is not confirmed. Keep this attempt unchanged and check again."));
        return;
      }
      const path = isGmail
        ? accountPath(rawAccount(account.id)) + "/send"
        : `/api/v1/mailboxes/${encodeURIComponent(rawAccount(account.id))}/emails` +
          (fixed.mode === "reply" && fixed.originalId
            ? `/${encodeURIComponent(fixed.originalId)}/reply`
            : "");
      const payload = isGmail
        ? {
            ...prepared,
            threadId: fixed.threadId,
            inReplyTo: fixed.inReplyTo,
            references: fixed.references,
          }
        : { ...prepared, from: account.email };
      const result = await fabric<{ status: string }>(path, payload);
      if (result.status === "accepted") {
        await onSettle(fixed, "accepted");
        onSent();
        onClose();
      } else
        setNotice(
          t("Acceptance is not confirmed. Keep this attempt unchanged and check again."),
        );
    } catch (error) {
      const code = error instanceof ApiError ? String(error.body.code ?? error.body.error ?? "") : "";
      if (error instanceof ApiError && error.status === 409 && /^(DRAFT_CONFLICT|draft_conflict)$/.test(code)) {
        // Changed elsewhere between saving and sending: nothing went out; the person decides.
        if (!(await recover(fixed, "editable"))) return;
        // Saving again meets the change and offers the choice between the two versions.
        void onResync(draft);
        setNotice(t("This draft was changed elsewhere just before sending, so it was not sent. Check it, then send again."));
      } else if (
        error instanceof ApiError &&
        sendRecovery(!!draft.locked, error.status, error.body) === "failed"
      ) {
        if (!(await recover(fixed, "failed"))) return;
        setNotice(
          t("The provider did not accept this attempt. Correct the draft and send again, or discard it."),
        );
      } else if (
        error instanceof ApiError &&
        sendRecovery(!!draft.locked, error.status, error.body) === "editable"
      ) {
        if (!(await recover(fixed, "editable"))) return;
        setNotice(
          t("Send refused: {reason}. Correct the message or reconnect.", {
            reason: t.text(error.message).replace(/[.!?]+$/, ""),
          }),
        );
      } else
        setNotice(
          t("Acceptance is not confirmed. Retry the same attempt; its recovery key prevents a duplicate send."),
        );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function addFiles(files: File[]) {
    if (fileWork.current || sending.current || draft.locked) return;
    // Files already saved with the draft count toward the same limits.
    const saved = draft.serverFiles ?? [];
    const count = saved.length + (draft.attachments?.length ?? 0) + files.length;
    const bytes = [...saved, ...(draft.attachments ?? []), ...files].reduce((n, f) => n + f.size, 0);
    if (count > MAX_ATTACHMENTS || bytes > MAX_ATTACHMENT_BYTES) {
      setNotice(t("A message can carry up to 10 files, 5 MiB together. Remove a file before adding another."));
      return;
    }
    fileWork.current = true;
    setLoadingFiles(true);
    setNotice("");
    try {
      await captureFiles(
        attachmentsOnDevice(),
        draft.id,
        files,
        draft.attachments,
        {
          stage: (refs) => onAddAttachments(draft.id, refs),
          complete: (ids) => onCompleteAttachments(draft.id, ids),
        },
      );
    } catch (error) {
      setNotice(
        t("File loading failed. {reason}", {
          reason:
            error instanceof Error
              ? t.text(error.message)
              : t("Check device storage and choose the files again."),
        }),
      );
    } finally {
      fileWork.current = false;
      setLoadingFiles(false);
    }
  }
  async function includeOriginals() {
    if (
      fileWork.current ||
      sending.current ||
      draft.locked ||
      !draft.forwardSource
    )
      return;
    fileWork.current = true;
    setLoadingFiles(true);
    setNotice("");
    try {
      const source = draft.forwardSource;
      const missing = missingOriginals(draft);
      const prefix =
        source.provider !== "cloudflare"
          ? `${accountPath(rawAccount(source.accountId))}/messages/${encodeURIComponent(source.originalId)}`
          : `/api/v1/mailboxes/${encodeURIComponent(rawAccount(source.accountId))}/emails/${encodeURIComponent(source.originalId)}`;
      const files: Parameters<typeof captureFiles>[2] = missing.map((file) => ({
        name: file.filename,
        type: file.mimeType,
        size: file.size,
        sourceId: file.id,
        arrayBuffer: async () => {
          const path = `${prefix}/attachments/${encodeURIComponent(file.id)}`;
          let bytes: ArrayBuffer;
          if (source.provider !== "cloudflare") {
            const result = await fabric<{ data: string }>(path);
            if (typeof result.data !== "string")
              throw new Error(t("The original file is unavailable."));
            let content = result.data.replaceAll("-", "+").replaceAll("_", "/");
            content += "=".repeat((4 - (content.length % 4)) % 4);
            validateAttachments([
              {
                content,
                filename: file.filename,
                type: file.mimeType || "application/octet-stream",
                disposition: "attachment",
              },
            ]);
            bytes = Uint8Array.from(atob(content), (c) =>
              c.charCodeAt(0),
            ).buffer;
          } else {
            const response = await fetch(path, {
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok)
              throw new Error(
                t("The original file could not be retrieved. Reconnect the source account and try again."),
              );
            if (
              Number(response.headers.get("Content-Length")) >
              MAX_ATTACHMENT_BYTES
            )
              throw new Error(t("An original file exceeds the 5 MiB limit."));
            bytes = await response.arrayBuffer();
          }
          return bytes;
        },
      }));
      await captureFiles(
        attachmentsOnDevice(),
        draft.id,
        files,
        draft.attachments,
        {
          stage: (refs) => onAddAttachments(draft.id, refs),
          complete: (ids) => onCompleteAttachments(draft.id, ids),
        },
      );
    } catch (error) {
      setNotice(
        t("Original attachment loading failed. {reason}", {
          reason:
            error instanceof Error
              ? t.text(error.message)
              : t("Try again before forwarding."),
        }),
      );
    } finally {
      fileWork.current = false;
      setLoadingFiles(false);
    }
  }
  async function recover(d: Draft, outcome: "failed" | "editable") {
    try {
      await onSettle(d, outcome);
      return true;
    } catch {
      setNotice(
        t("Could not save the updated send result. Keep this attempt unchanged and retry the same attempt."),
      );
      return false;
    }
  }
  return (
    <dialog
      ref={dialog}
      className="fi-compose"
      aria-labelledby="compose-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <header>
          <div>
            <span className="fi-eyebrow">
              {draft.mode === "reply"
                ? t("[mode] Reply")
                : draft.mode === "forward"
                  ? t("[mode] Forward")
                  : t("New message")}
            </span>
            <h2 id="compose-title">{t("Write a message")}</h2>
          </div>
          <button
            type="button"
            className="fi-icon-button"
            aria-label={t("Close and keep draft")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <label>
          {t("From")}
          <select
            required
            value={draft.accountId}
            disabled={busy || draft.locked || draft.mode !== "new" || !!draft.serverId}
            onChange={(e) => void changeSender(e.target.value)}
          >
            <option value="">{t("Choose a sender")}</option>
            {!account && draft.accountId && (
              <option value={draft.accountId}>
                {draft.accountId} · {t("Account unavailable")}
              </option>
            )}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email} · {a.provider === "cloudflare" ? "Cloudflare" : a.providerName ?? (a.provider === "gmail" ? "Gmail" : "IMAP")}
              </option>
            ))}
          </select>
        </label>
        {!!draft.serverId && (
          <p className="fi-muted">{t("Sender is fixed once the draft is on your server; discard to start over.")}</p>
        )}
        <label>
          {t("To")}
          <input
            ref={toField}
            required
            value={draft.to}
            placeholder="name@example.com"
            disabled={busy || draft.locked}
            onChange={(e) => change({ to: e.target.value })}
          />
        </label>
        <label>
          {t("Cc")}
          <input
            ref={ccField}
            value={draft.cc ?? ""}
            placeholder={t("Optional recipients")}
            disabled={busy || draft.locked}
            onChange={(e) => change({ cc: e.target.value })}
          />
        </label>
        <label>
          {t("Bcc")}
          <input
            ref={bccField}
            value={draft.bcc ?? ""}
            placeholder={t("Optional hidden recipients")}
            disabled={busy || draft.locked}
            onChange={(e) => change({ bcc: e.target.value })}
          />
        </label>
        <label>
          {t("Subject")}
          <input
            value={draft.subject}
            disabled={busy || draft.locked}
            onChange={(e) => change({ subject: e.target.value })}
          />
        </label>
        <label className="fi-body-label">
          {t("Message")}
          <textarea
            autoFocus
            value={draft.text}
            disabled={busy || draft.locked}
            onChange={(e) => change({ text: e.target.value })}
          />
        </label>
        <section
          className="fi-compose-attachments"
          aria-label={t("Message attachments")}
        >
          <div className="fi-compose-files">
            <button
              type="button"
              className="fi-secondary"
              disabled={busy || loadingFiles || draft.locked}
              aria-describedby="attachment-limits"
              onClick={() => filePicker.current?.click()}
            >
              {t("Add files…")}
            </button>
            <input
              ref={filePicker}
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              className="fi-visually-hidden"
              disabled={busy || loadingFiles || draft.locked}
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                if (files.length) void addFiles(files);
              }}
            />
          </div>
          <p id="attachment-limits" className="fi-muted">
            {t("Up to 10 files, 5 MiB total. Files are saved with the draft on your server.")}
          </p>
          {!!draft.serverFiles?.length && (
            <ul aria-label={t("Files saved with the draft")}>
              {draft.serverFiles.map((file) => (
                <li key={file.id}>
                  <span>
                    {file.filename}{" "}
                    <small>{bytes(file.size)} · {t("Saved")}</small>
                  </span>
                  <button
                    type="button"
                    className="fi-text-button"
                    disabled={busy || loadingFiles || draft.locked}
                    aria-label={t("Remove {name}", { name: file.filename })}
                    onClick={() => change({ serverFiles: draft.serverFiles?.filter((f) => f.id !== file.id) })}
                  >
                    {t("Remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!!draft.attachments?.length && (
            <ul>
              {draft.attachments.map((file) => (
                <li key={file.id}>
                  <span>
                    {file.filename}{" "}
                    <small>
                      {bytes(file.size)}
                      {draft.pendingAttachments?.includes(file.id)
                        ? ` · ${t("Pending")}`
                        : ""}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="fi-text-button"
                    disabled={busy || loadingFiles || draft.locked}
                    aria-label={t("Remove {name}", { name: file.filename })}
                    onClick={() =>
                      change({
                        attachments: draft.attachments?.filter(
                          (f) => f.id !== file.id,
                        ),
                        pendingAttachments: draft.pendingAttachments?.filter(
                          (id) => id !== file.id,
                        ),
                      })
                    }
                  >
                    {t("Remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {draft.mode === "forward" && (
            <>
              <p className="fi-muted">
                {missingOriginals(draft).length
                  ? t("Original attachments are not included yet. Load all files below before forwarding.")
                  : draft.forwardSource?.files.length
                    ? t("Original files selected for this draft.")
                    : draft.forwardSource
                      ? t("The original message has no attachments.")
                      : draft.locked
                        ? t("This saved attempt contains forwarded text only.")
                        : t("Original attachment information is unavailable. Open the original message and start a new forward.")}
              </p>
              {!!missingOriginals(draft).length && (
                <>
                  <ul>
                    {missingOriginals(draft).map((f) => (
                      <li key={f.id}>
                        <span>
                          {f.filename}{" "}
                          <small>{bytes(f.size)}</small>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="fi-secondary"
                    disabled={busy || loadingFiles || draft.locked}
                    onClick={() => void includeOriginals()}
                  >
                    {t("Include original attachments")}
                  </button>
                </>
              )}
            </>
          )}
          {!!draft.pendingAttachments?.length && !loadingFiles && (
            <p role="status" className="fi-muted">
              {t("Files are not ready. Wait for loading to finish, or remove pending files and add them again.")}
            </p>
          )}
          {loadingFiles && (
            <p role="status" className="fi-muted">
              {t("Loading and saving files… You can keep editing the message.")}
            </p>
          )}
        </section>
        {notice && (
          <p role="alert" className="fi-notice" ref={alertRef} tabIndex={-1}>
            {notice}
          </p>
        )}
        {sync && (sync.state === "conflict" || sync.state === "gone") && (
          <div role="alert" className="fi-notice">
            <p>{t.text(sync.message)}</p>
            {sync.state === "conflict" && (
              <button type="button" className="fi-text-button" disabled={busy} onClick={() => {
                if (window.confirm(t("Replace your text with the version saved on your server? Copy any text you need before continuing.")))
                  void onResolve(draft, "theirs");
              }}>
                {t("Show the saved version")}
              </button>
            )}
            <button type="button" className="fi-text-button" disabled={busy} onClick={() => void onResolve(draft, "mine")}>
              {t(sync.state === "conflict" ? "Keep my version" : "Save it again as a new draft")}
            </button>
          </div>
        )}
        {storageError && !saving && (
          <button
            type="button"
            className="fi-text-button"
            onClick={() => {
              if (
                window.confirm(
                  t("Replace unsaved changes with the saved version? Copy any text you need before continuing."),
                )
              )
                onReopen(draft);
            }}
          >
            {t("Reopen saved version")}
          </button>
        )}
        <footer>
          {!draft.locked && (
            <button
              type="button"
              className="fi-text-button"
              disabled={busy || saving || loadingFiles}
              onClick={async () => {
                try {
                  await onDiscard(draft);
                  onClose();
                } catch {
                  setNotice(
                    t("Draft could not be discarded. It has been kept; reopen Drafts to check the saved version."),
                  );
                }
              }}
            >
              {t("Discard draft")}
            </button>
          )}
          <span className="fi-muted" role="status">
            {storageError
              ? t.text(storageError)
              : saving
                ? t("Saving draft…")
                : draft.locked
                  ? t("Send recovery saved on this device")
                  : sync && sync.state !== "conflict" && sync.state !== "gone"
                    ? t.text(sync.message)
                    : sync
                      ? t("Kept on this device; not saved to your server")
                      : draft.synced
                        ? t("Saved to your server")
                        : t("Kept on this device; saving to your server…")}
          </span>
          <button
            type="submit"
            className="fi-primary"
            disabled={
              busy ||
              loadingFiles ||
              !account ||
              saving ||
              !!storageError ||
              !!draft.pendingAttachments?.length ||
              !!missingOriginals(draft).length
            }
          >
            {busy
              ? t("Sending…")
              : draft.locked
                ? t("Retry same attempt")
                : t("Send message")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
