import { useEffect, useRef, useState, type ReactNode } from "react";
import { fabric, accountPath } from "~/services/fabric";
import { recipientAddresses, sendFailure, sendFailureNotice } from "./send-state";
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
import {
  applyPlan,
  dropForRetry,
  leaveOut,
  leftOutFiles,
  noRoom,
  planOriginals,
  removeAttachment,
  removeServerFile,
  safetyOf,
} from "./forward-files";
import type { FileSafety } from "./draft-store";
import { sendSavedDraft, signatureFor, swapSignature } from "./server-drafts";
import type { SyncStatus } from "./use-drafts";
import { useT } from "../../lib/i18n";
import EmailIframe from "~/components/EmailIframe";
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
  // The draft as it is now, for work that finishes after an await (bug hunt 2026-10-12).
  const latest = useRef(draft);
  latest.current = draft;
  const senderTurn = useRef(0);
  /**
   * A new message's sender changed: its signature follows the sender. The sender is set at once; the
   * signature is applied to the draft as it is when it arrives (what was typed meanwhile stays), and a
   * reply for an earlier choice is dropped, so a slow answer cannot put the previous sender back.
   */
  async function changeSender(accountId: string) {
    const turn = ++senderTurn.current;
    onChange({ ...latest.current, accountId });
    let signature = "";
    try {
      signature = accountId ? await signatureFor(accountId, fabric) : "";
    } catch {
      if (turn === senderTurn.current) setNotice(t("The sender's signature could not be loaded; add it to the message if you need it."));
    }
    if (turn !== senderTurn.current) return;
    const now = latest.current;
    onChange({ ...now, accountId, text: swapSignature(now.text, now.signature, signature), signature });
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
      const failure = sendFailure(error, !!draft.locked);
      // A draft changed elsewhere, or past this server's sending budget (B-06): nothing went out,
      // so the draft stays editable; the provider's refusal unlocks it as failed.
      const recovery = failure.kind === "failed" ? "failed" : failure.kind === "uncertain" ? null : "editable";
      if (recovery && !(await recover(fixed, recovery))) return;
      // Saving again meets the change and offers the choice between the two versions.
      if (failure.kind === "conflict") void onResync(draft);
      setNotice(sendFailureNotice(failure, t));
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
      // With nothing left to fill (a forward's originals took the room), say so plainly (B-274).
      setNotice(noRoom(draft)
        ? t("No room left: remove a file first")
        : t("A message can carry up to 10 files, 5 MiB together. Remove a file before adding another."));
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
  /**
   * A forward's original files (B-274): attached one at a time in the original's order, while they fit
   * in one message; the rest, and a file the safety check found dangerous, are recorded as left out.
   * Without `ids` it takes every original not yet carried nor left out (as the composer opens); with
   * `ids` it puts those back or retries them. One failing file leaves the others attached.
   */
  async function attachOriginals(ids?: string[], { anyway = false, from = latest.current }: { anyway?: boolean; from?: Draft } = {}) {
    if (fileWork.current || sending.current || from.locked || !from.forwardSource) return;
    fileWork.current = true;
    setLoadingFiles(true);
    setNotice("");
    let failure: unknown;
    try {
      const source = from.forwardSource;
      const plan = planOriginals(from, ids, { anyway });
      const planned = applyPlan(from, plan);
      if (planned !== from) onChange(planned);
      // Putting a file back with no room left says what to do first.
      if (ids && plan.leftOut.some((x) => x.why === "no-room")) setNotice(t("No room left: remove a file first"));
      const prefix =
        source.provider !== "cloudflare"
          ? `${accountPath(rawAccount(source.accountId))}/messages/${encodeURIComponent(source.originalId)}`
          : `/api/v1/mailboxes/${encodeURIComponent(rawAccount(source.accountId))}/emails/${encodeURIComponent(source.originalId)}`;
      for (const file of plan.attach) {
        const one: Parameters<typeof captureFiles>[2][number] = {
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
        };
        try {
          await captureFiles(attachmentsOnDevice(), from.id, [one], [], {
            stage: (refs) => onAddAttachments(from.id, refs),
            complete: (done) => onCompleteAttachments(from.id, done),
          });
        } catch (error) {
          failure = error;
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      fileWork.current = false;
      setLoadingFiles(false);
    }
    if (failure)
      setNotice(
        t("Original attachment loading failed. {reason}", {
          reason:
            failure instanceof Error
              ? t.text(failure.message)
              : t("Try again before forwarding."),
        }),
      );
  }
  // A forward attaches the original's files by itself as the composer opens (B-274, S09); a draft
  // reopened later picks up only what it neither carries nor left out.
  const autoAttached = useRef(false);
  useEffect(() => {
    if (autoAttached.current) return;
    autoAttached.current = true;
    if (draft.mode === "forward" && draft.forwardSource && !draft.locked && missingOriginals(draft).length)
      void attachOriginals();
    // Once per composer: later changes go through Retry, Remove and Attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        {draft.forwardHtml && (
          // The original goes below the text as it was, with its links and buttons (operator,
          // 2026-10-21); on the screen it comes after the text and before the files (S09).
          <details className="fi-forward-original">
            <summary>{t("The original message goes below your text as it was, with its links and buttons. Show it")}</summary>
            <EmailIframe messageKey={draft.id + ":forward"} body={draft.forwardHtml} autoSize />
          </details>
        )}
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
                    <small>{bytes(file.size)} · {t("Saved")}</small>{" "}
                    <SafetyChip colour={safetyOf(draft, file.sourceId)} />
                  </span>
                  <button
                    type="button"
                    className="fi-text-button"
                    disabled={busy || loadingFiles || draft.locked}
                    aria-label={t("Remove {name}", { name: file.filename })}
                    onClick={() => onChange(removeServerFile(draft, file.id))}
                  >
                    {t("Remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!!draft.attachments?.length && (
            <ul>
              {draft.attachments.map((file) => {
                const pending = !!draft.pendingAttachments?.includes(file.id);
                // An original still pending once loading stopped could not be attached: Retry or Remove (S09).
                const failed = pending && !!file.sourceId && !loadingFiles;
                return (
                  <li key={file.id}>
                    <span>
                      {file.filename}{" "}
                      <small>
                        {bytes(file.size)}
                        {pending
                          ? ` · ${file.sourceId ? (failed ? t("Could not attach") : t("Attaching…")) : t("Pending")}`
                          : ""}
                      </small>{" "}
                      <SafetyChip colour={safetyOf(draft, file.sourceId)} />
                    </span>
                    <span className="fi-compose-file-actions">
                      {failed && (
                        <button
                          type="button"
                          className="fi-text-button"
                          disabled={busy || loadingFiles || draft.locked}
                          aria-label={t("Retry {name}", { name: file.filename })}
                          onClick={() => {
                            const retry = dropForRetry(latest.current, file.sourceId!);
                            onChange(retry);
                            void attachOriginals([file.sourceId!], { from: retry });
                          }}
                        >
                          {t("Retry")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="fi-text-button"
                        disabled={busy || loadingFiles || draft.locked}
                        aria-label={t("Remove {name}", { name: file.filename })}
                        onClick={() => onChange(removeAttachment(draft, file.id))}
                      >
                        {t("Remove")}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {draft.mode === "forward" && (
            <>
              <p className="fi-muted" role="status">
                {loadingFiles && missingOriginals(draft).length
                  ? t("Attaching files…")
                  : missingOriginals(draft).length
                    ? t("Some of the original's files are not attached. Retry or remove each one.")
                    : draft.forwardSource?.files.length
                      ? t("Original files selected for this draft.")
                      : draft.forwardSource
                        ? t("The original message has no attachments.")
                        : draft.locked
                          ? t("This saved attempt contains forwarded text only.")
                          : t("Original attachment information is unavailable. Open the original message and start a new forward.")}
              </p>
              {!!missingOriginals(draft).length && (
                <ul aria-label={t("Files of the original")}>
                  {missingOriginals(draft).map((f) => (
                    <li key={f.id}>
                      <span>
                        {f.filename}{" "}
                        <small>
                          {bytes(f.size)} · {loadingFiles ? t("Attaching…") : t("Could not attach")}
                        </small>
                      </span>
                      {!loadingFiles && (
                        <span className="fi-compose-file-actions">
                          <button
                            type="button"
                            className="fi-text-button"
                            disabled={busy || draft.locked}
                            aria-label={t("Retry {name}", { name: f.filename })}
                            onClick={() => void attachOriginals([f.id])}
                          >
                            {t("Retry")}
                          </button>
                          <button
                            type="button"
                            className="fi-text-button"
                            disabled={busy || draft.locked}
                            aria-label={t("Remove {name}", { name: f.filename })}
                            onClick={() => onChange(leaveOut(draft, f.id))}
                          >
                            {t("Remove")}
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <LeftOutFiles
                draft={draft}
                bytes={bytes}
                disabled={busy || loadingFiles || !!draft.locked}
                onAttach={(id, anyway) => void attachOriginals([id], { anyway })}
              />
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
              : draft.mode === "forward" && loadingFiles
                ? t("Attaching files…")
                : draft.locked
                ? t("Retry same attempt")
                : t("Send message")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/**
 * A file's safety chip, by S03's colour table (B-269), with its word: never colour alone. Shown only
 * when a check named a colour for the file; until then nothing is claimed about it.
 */
function SafetyChip({ colour }: { colour?: FileSafety }) {
  const t = useT();
  if (!colour) return null;
  const word =
    colour === "red" ? t("Dangerous") : colour === "amber" ? t("Suspicious") : colour === "green" ? t("Checked") : t("Not checked");
  return <span className={`fi-file-chip fi-file-chip-${colour}`}>{word}</span>;
}

/**
 * The original's files a forward does not carry (B-274, S09): those past what one message carries,
 * one the safety check found dangerous, and those the person removed; each can be attached again.
 */
function LeftOutFiles({
  draft,
  bytes,
  disabled,
  onAttach,
}: {
  draft: Draft;
  bytes: (size: number) => string;
  disabled: boolean;
  onAttach: (id: string, anyway: boolean) => void;
}) {
  const t = useT();
  const all = leftOutFiles(draft);
  if (!all.length) return null;
  const noRoomFiles = all.filter((x) => x.why === "no-room");
  const row = (x: (typeof all)[number], note: ReactNode, anyway = false) => (
    <li key={x.file.id}>
      <span>
        {x.file.filename}{" "}
        <small>{bytes(x.file.size)}</small>{" "}
        <SafetyChip colour={x.file.safety} />
        {note && <><br /><small>{note}</small></>}
      </span>
      <button
        type="button"
        className="fi-text-button"
        disabled={disabled}
        aria-label={anyway ? t("Attach {name} anyway", { name: x.file.filename }) : t("Attach {name}", { name: x.file.filename })}
        onClick={() => onAttach(x.file.id, anyway)}
      >
        {anyway ? t("Attach anyway") : t("Attach")}
      </button>
    </li>
  );
  return (
    <>
      {!!noRoomFiles.length && (
        <>
          <p className="fi-muted">
            {t.plural(noRoomFiles.length, {
              one: "{n} file did not fit in one message",
              other: "{n} files did not fit in one message",
            })}
          </p>
          <ul>{noRoomFiles.map((x) => row(x, null))}</ul>
        </>
      )}
      {all.some((x) => x.why !== "no-room") && (
        <ul>
          {all
            .filter((x) => x.why !== "no-room")
            .map((x) =>
              x.why === "dangerous"
                ? row(x, t("Not attached: the safety check found this file dangerous"), true)
                : row(x, t("Removed; it will not be sent")),
            )}
        </ul>
      )}
    </>
  );
}
