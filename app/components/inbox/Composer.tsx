import { useEffect, useRef, useState } from "react";
import { fabric, accountPath } from "~/services/fabric";
import { ApiError } from "~/services/api";
import { sendRecovery } from "./send-state";
import { rawAccount, type InboxAccount } from "./model";
import type { Draft } from "./draft-store";
import {
  attachmentsOnDevice,
  captureFiles,
  type AttachmentRef,
} from "./attachment-store";
import {
  MAX_ATTACHMENT_BYTES,
  validateAttachments,
} from "../../../shared/mail/attachments";
import { missingOriginals, prepareMessage } from "./compose-payload";
export type { Draft } from "./draft-store";
export default function Composer({
  draft,
  storageError,
  saving,
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
  const dialog = useRef<HTMLDialogElement>(null),
    sending = useRef(false),
    fileWork = useRef(false);
  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loadingFiles, setLoadingFiles] = useState(false);
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
  function change(patch: Partial<Draft>) {
    onChange({ ...draft, ...patch });
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
      setNotice((error as Error).message);
      sending.current = false;
      setBusy(false);
      return;
    }
    let fixed: Draft;
    try {
      fixed = await onLock(draft);
    } catch {
      sending.current = false;
      setBusy(false);
      setNotice(
        "Could not save send recovery information. Sending was not attempted.",
      );
      return;
    }
    setNotice("");
    try {
      const isGmail = account.provider === "gmail";
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
          "Acceptance is not confirmed. Keep this attempt unchanged and check again.",
        );
    } catch (error) {
      if (
        error instanceof ApiError &&
        sendRecovery(!!draft.locked, error.status, error.body) === "failed"
      ) {
        if (!(await recover(fixed, "failed"))) return;
        setNotice(
          "The provider did not accept this attempt. Correct the draft and send again, or discard it.",
        );
      } else if (
        error instanceof ApiError &&
        sendRecovery(!!draft.locked, error.status, error.body) === "editable"
      ) {
        if (!(await recover(fixed, "editable"))) return;
        setNotice(
          "Send refused: " +
            error.message.replace(/[.!?]+$/, "") +
            ". Correct the message or reconnect.",
        );
      } else
        setNotice(
          "Acceptance is not confirmed. Retry the same attempt; its recovery key prevents a duplicate send.",
        );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function addFiles(files: File[]) {
    if (fileWork.current || sending.current || draft.locked) return;
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
        "File loading failed. " +
          (error instanceof Error
            ? error.message
            : "Check device storage and choose the files again."),
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
        source.provider === "gmail"
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
          if (source.provider === "gmail") {
            const result = await fabric<{ data: string }>(path);
            if (typeof result.data !== "string")
              throw new Error("The original file is unavailable.");
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
                "The original file could not be retrieved. Reconnect the source account and try again.",
              );
            if (
              Number(response.headers.get("Content-Length")) >
              MAX_ATTACHMENT_BYTES
            )
              throw new Error("An original file exceeds the 5 MiB limit.");
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
        "Original attachment loading failed. " +
          (error instanceof Error
            ? error.message
            : "Try again before forwarding."),
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
        "Could not save the updated send result. Keep this attempt unchanged and retry the same attempt.",
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
                ? "Reply"
                : draft.mode === "forward"
                  ? "Forward"
                  : "New message"}
            </span>
            <h2 id="compose-title">Write a message</h2>
          </div>
          <button
            type="button"
            className="fi-icon-button"
            aria-label="Close and keep draft"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <label>
          From
          <select
            required
            value={draft.accountId}
            disabled={busy || draft.locked || draft.mode !== "new"}
            onChange={(e) => change({ accountId: e.target.value })}
          >
            <option value="">Choose a sender</option>
            {!account && draft.accountId && (
              <option value={draft.accountId}>
                {draft.accountId} · Account unavailable
              </option>
            )}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email} · {a.provider === "gmail" ? "Gmail" : "Cloudflare"}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <input
            required
            value={draft.to}
            placeholder="name@example.com"
            disabled={busy || draft.locked}
            onChange={(e) => change({ to: e.target.value })}
          />
        </label>
        <label>
          Cc
          <input
            value={draft.cc ?? ""}
            placeholder="Optional recipients"
            disabled={busy || draft.locked}
            onChange={(e) => change({ cc: e.target.value })}
          />
        </label>
        <label>
          Bcc
          <input
            value={draft.bcc ?? ""}
            placeholder="Optional hidden recipients"
            disabled={busy || draft.locked}
            onChange={(e) => change({ bcc: e.target.value })}
          />
        </label>
        <label>
          Subject
          <input
            value={draft.subject}
            disabled={busy || draft.locked}
            onChange={(e) => change({ subject: e.target.value })}
          />
        </label>
        <label className="fi-body-label">
          Message
          <textarea
            autoFocus
            value={draft.text}
            disabled={busy || draft.locked}
            onChange={(e) => change({ text: e.target.value })}
          />
        </label>
        <section
          className="fi-compose-attachments"
          aria-label="Message attachments"
        >
          <label>
            Add files
            <input
              type="file"
              multiple
              disabled={busy || loadingFiles || draft.locked}
              aria-describedby="attachment-limits"
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = "";
                if (files.length) void addFiles(files);
              }}
            />
          </label>
          <p id="attachment-limits" className="fi-muted">
            Up to 10 files, 5 MiB total. Files are saved on this device.
          </p>
          {!!draft.attachments?.length && (
            <ul>
              {draft.attachments.map((file) => (
                <li key={file.id}>
                  <span>
                    {file.filename}{" "}
                    <small>
                      {file.size.toLocaleString()} bytes
                      {draft.pendingAttachments?.includes(file.id)
                        ? " · Pending"
                        : ""}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="fi-text-button"
                    disabled={busy || loadingFiles || draft.locked}
                    aria-label={`Remove ${file.filename}`}
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
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {draft.mode === "forward" && (
            <>
              <p className="fi-muted">
                {missingOriginals(draft).length
                  ? "Original attachments are not included yet. Load all files below before forwarding."
                  : draft.forwardSource?.files.length
                    ? "Original files selected for this draft."
                    : draft.forwardSource
                      ? "The original message has no attachments."
                      : draft.locked
                        ? "This saved attempt contains forwarded text only."
                        : "Original attachment information is unavailable. Open the original message and start a new forward."}
              </p>
              {!!missingOriginals(draft).length && (
                <>
                  <ul>
                    {missingOriginals(draft).map((f) => (
                      <li key={f.id}>
                        <span>
                          {f.filename}{" "}
                          <small>{f.size.toLocaleString()} bytes</small>
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
                    Include original attachments
                  </button>
                </>
              )}
            </>
          )}
          {!!draft.pendingAttachments?.length && !loadingFiles && (
            <p role="status" className="fi-muted">
              Files are not ready. Wait for loading to finish, or remove pending
              files and add them again.
            </p>
          )}
          {loadingFiles && (
            <p role="status" className="fi-muted">
              Loading and saving files… You can keep editing the message.
            </p>
          )}
        </section>
        {notice && (
          <p role="alert" className="fi-notice">
            {notice}
          </p>
        )}
        {storageError && !saving && (
          <button
            type="button"
            className="fi-text-button"
            onClick={() => {
              if (
                window.confirm(
                  "Replace unsaved changes with the saved version? Copy any text you need before continuing.",
                )
              )
                onReopen(draft);
            }}
          >
            Reopen saved version
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
                    "Draft could not be discarded. It has been kept; reopen Drafts to check the saved version.",
                  );
                }
              }}
            >
              Discard draft
            </button>
          )}
          <span className="fi-muted">
            {storageError
              ? storageError
              : saving
                ? "Saving draft…"
                : draft.locked
                  ? "Send recovery saved on this device"
                  : "Draft kept on this device"}
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
              ? "Checking…"
              : draft.locked
                ? "Retry same attempt"
                : "Send message"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
