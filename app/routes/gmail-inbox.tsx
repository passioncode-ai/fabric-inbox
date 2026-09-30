import { useState, useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { htmlToPlainText } from "~/lib/utils";
import { ApiError } from "~/services/api";
import {
  fabric,
  accountPath,
  type AccountList,
  type Mail,
} from "~/services/fabric";
const field = "w-full rounded-md border border-kumo-line bg-kumo-base p-2";
type Draft = {
  to: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  idempotencyKey: string;
};
type Receipt = { status: string; providerMessageId?: string; error?: string };
export function meta() {
  return [{ title: "Gmail · Fabric Inbox" }];
}
export default function GmailInbox() {
  const { accountId = "" } = useParams(),
    base = accountPath(accountId);
  const [cursor, setCursor] = useState(""),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState<Draft | null>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [locked, setLocked] = useState(false);
  const sending = useRef(false);
  const [loadedAccount, setLoadedAccount] = useState("");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("fabric-draft:" + accountId);
      const value = saved ? JSON.parse(saved) : null;
      setDraft(value?.draft ?? null);
      setLocked(value?.locked ?? false);
    } catch {
      setNotice("Saved draft could not be restored.");
    }
    setLoadedAccount(accountId);
  }, [accountId]);
  useEffect(() => {
    if (loadedAccount !== accountId) return;
    try {
      if (draft)
        localStorage.setItem(
          "fabric-draft:" + accountId,
          JSON.stringify({ draft, locked }),
        );
      else localStorage.removeItem("fabric-draft:" + accountId);
    } catch {
      setNotice(
        "This draft could not be saved on this device. Keep this window open.",
      );
    }
  }, [draft, locked, accountId, loadedAccount]);
  const accounts = useQuery({
    queryKey: ["fabric-accounts"],
    queryFn: () => fabric<AccountList>("/api/accounts"),
  });
  const account = accounts.data?.accounts.find((a) => a.id === accountId);
  const messages = useQuery({
    queryKey: ["gmail", accountId, cursor, search],
    queryFn: () =>
      fabric<{ messages: Mail[]; nextCursor?: string }>(
        base + "/messages?" + new URLSearchParams({ cursor, q: search }),
      ),
    refetchInterval: 30_000,
  });
  const message = useQuery({
    queryKey: ["gmail-message", accountId, selected],
    queryFn: () => fabric<Mail>(base + "/messages/" + selected),
    enabled: !!selected,
  });
  useEffect(() => {
    const handle = (e: BeforeUnloadEvent) => {
      if (draft) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, [draft]);
  async function perform(fn: () => Promise<unknown>) {
    setBusy(true);
    setNotice("");
    try {
      await fn();
      await messages.refetch();
      await accounts.refetch();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function compose(mode: "new" | "reply" | "forward") {
    if (draft) return;
    const mail = message.data;
    setLocked(false);
    setNotice("");
    setDraft({
      to:
        mode === "reply"
          ? (mail?.from.match(/<([^<>]+)>/)?.[1] ?? mail?.from ?? "")
          : "",
      subject:
        mode === "new"
          ? ""
          : (mode === "reply" ? "Re: " : "Fwd: ") + (mail?.subject ?? ""),
      text:
        mode === "forward"
          ? "\n\nForwarded message\nFrom: " +
            mail?.from +
            "\nSubject: " +
            mail?.subject +
            "\n\n" +
            (mail?.text ||
              (mail?.html ? htmlToPlainText(mail.html) : mail?.snippet) ||
              "")
          : "",
      ...(mode === "reply"
        ? {
            threadId: mail?.threadId,
            inReplyTo: mail?.rfcMessageId,
            references: mail?.references,
          }
        : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  }
  async function send() {
    if (!draft || sending.current || locked) return;
    sending.current = true;
    try {
      localStorage.setItem(
        "fabric-draft:" + accountId,
        JSON.stringify({ draft, locked: true }),
      );
    } catch {
      sending.current = false;
      setNotice(
        "Cannot save send recovery information on this device. Sending was not attempted.",
      );
      return;
    }
    setBusy(true);
    setLocked(true);
    setNotice("");
    try {
      const receipt = await fabric<Receipt>(base + "/send", {
        ...draft,
        to: draft.to
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      if (receipt.status === "accepted") {
        setNotice("Accepted by Gmail. Recipient delivery is not confirmed.");
        setDraft(null);
        setLocked(false);
      } else
        setNotice("Outcome unknown. Check send status before trying again.");
    } catch (e) {
      if (
        e instanceof ApiError &&
        [400, 401, 403, 404, 413].includes(e.status)
      ) {
        setLocked(false);
        setNotice(
          "Send refused: " +
            e.message +
            ". Correct the message or reconnect, then try again.",
        );
      } else
        setNotice(
          "Send was not confirmed. Check send status before trying again.",
        );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!draft) return;
    await perform(async () => {
      try {
        const receipt = await fabric<Receipt>(
          base + "/sends/" + encodeURIComponent(draft.idempotencyKey),
        );
        if (receipt.status === "accepted") {
          setDraft(null);
          setLocked(false);
          setNotice("Accepted by Gmail.");
        } else
          setNotice(
            "Send status: " +
              receipt.status +
              ". Check your Gmail Sent folder before repeating.",
          );
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 404 &&
          error.message === "receipt_not_found"
        ) {
          // Keep the same key: a delayed request and the explicit retry still share one intent.
          setLocked(false);
          setNotice(
            "No send attempt is recorded. You can retry with the same recovery key.",
          );
        } else throw error;
      }
    });
  }
  async function download(attachment: Mail["attachments"][number]) {
    await perform(async () => {
      const result = await fabric<{ data: string }>(
        base +
          "/messages/" +
          selected +
          "/attachments/" +
          encodeURIComponent(attachment.providerAttachmentId),
      );
      const bytes = Uint8Array.from(
        atob(result.data.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: attachment.mimeType }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const mail = message.data;
  return (
    <main className="min-h-screen p-6 text-kumo-default">
      <nav className="flex flex-wrap gap-6">
        <Link className="underline" to="/accounts">
          ← Accounts
        </Link>
        <Link
          className="underline"
          to={"/automation/" + encodeURIComponent("gmail:" + accountId)}
        >
          Rules and history
        </Link>
      </nav>
      <header className="my-6 flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {account?.email ?? "Gmail"}
          </h1>
          <p className="text-sm text-kumo-subtle">
            {account?.status.replaceAll("_", " ")} · Cloud sync
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => perform(() => fabric(base + "/sync", {}))}
          >
            Sync now
          </Button>
          <Button disabled={!!draft} onClick={() => compose("new")}>
            Compose
          </Button>
        </div>
      </header>
      {notice && (
        <p
          role="status"
          className="my-4 rounded-lg border border-kumo-line p-3"
        >
          {notice}
        </p>
      )}
      {draft && (
        <form
          className="mx-auto my-6 max-w-3xl space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-5"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <h2 className="text-xl font-semibold">Compose</h2>
          <p className="text-sm text-kumo-subtle">
            Drafts are saved on this device when storage is available. Forwarding here includes
            text only.
          </p>
          <label className="block">
            To (comma-separated)
            <input
              required
              disabled={locked}
              className={field}
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </label>
          <label className="block">
            Subject
            <input
              disabled={locked}
              className={field}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </label>
          <label className="block">
            Message
            <textarea
              disabled={locked}
              rows={9}
              className={field}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </label>
          <div className="flex gap-3">
            <Button type="submit" disabled={busy || locked}>
              Send
            </Button>
            {locked && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={check}
              >
                Check send status
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Discard this draft?")) {
                  setDraft(null);
                  setLocked(false);
                }
              }}
            >
              Discard
            </Button>
          </div>
        </form>
      )}
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <section aria-label="Messages">
          <label className="block mb-4">
            Search cached mail
            <input
              className={field}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor("");
              }}
            />
          </label>
          {messages.isPending && <p>Loading mail…</p>}
          {messages.error && (
            <p role="alert">
              Mail could not load.{" "}
              <button onClick={() => messages.refetch()}>Retry</button>
            </p>
          )}
          {messages.data?.messages.length === 0 && (
            <p>
              No matching mail in this page. Sync or continue to the next page.
            </p>
          )}
          {messages.data?.messages
            .slice()
            .sort((a, b) => b.timestamp - a.timestamp)
            .map((m) => (
              <button
                type="button"
                key={m.id}
                onClick={() => setSelected(m.providerMessageId)}
                className={
                  "block w-full border-b border-kumo-line p-4 text-left " +
                  (selected === m.providerMessageId ? "bg-kumo-tint" : "")
                }
              >
                <div className={m.read ? "" : "font-semibold"}>{m.from}</div>
                <div className="truncate">{m.subject || "(No subject)"}</div>
                <p className="truncate text-sm text-kumo-subtle">{m.snippet}</p>
                <span className="text-xs text-kumo-subtle">
                  {new Date(m.timestamp).toLocaleString()}
                </span>
              </button>
            ))}
          <div className="mt-4 flex gap-3">
            <Button
              variant="secondary"
              disabled={!cursor}
              onClick={() => setCursor("")}
            >
              First page
            </Button>
            <Button
              variant="secondary"
              disabled={!messages.data?.nextCursor}
              onClick={() => setCursor(messages.data?.nextCursor ?? "")}
            >
              Next page
            </Button>
          </div>
        </section>
        <section
          aria-label="Reading pane"
          className="min-w-0 rounded-xl border border-kumo-line p-5"
        >
          {!selected && (
            <p className="text-kumo-subtle">Select a message to read it.</p>
          )}
          {selected && message.isPending && <p>Loading message…</p>}
          {message.error && <p role="alert">Message could not load.</p>}
          {mail && (
            <>
              <h2 className="text-xl font-semibold">
                {mail.subject || "(No subject)"}
              </h2>
              <p className="mt-3 break-all">From: {mail.from}</p>
              <p className="text-kumo-subtle break-all">To: {mail.to}</p>
              <p className="my-2 text-sm text-kumo-subtle">
                Message ID: {mail.providerMessageId}
              </p>
              <div className="my-4 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={!!draft}
                  onClick={() => compose("reply")}
                >
                  Reply
                </Button>
                <Button
                  variant="secondary"
                  disabled={!!draft}
                  onClick={() => compose("forward")}
                >
                  Forward text
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await fabric(base + "/messages/" + selected + "/read", {
                        read: !mail.read,
                      });
                      await message.refetch();
                    })
                  }
                >
                  {mail.read ? "Mark unread" : "Mark read"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || mail.archived}
                  onClick={() =>
                    perform(async () => {
                      await fabric(
                        base + "/messages/" + selected + "/archive",
                        {},
                      );
                      await message.refetch();
                    })
                  }
                >
                  Archive
                </Button>
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
                {mail.text ||
                  (mail.html ? htmlToPlainText(mail.html) : mail.snippet) ||
                  "No message content."}
              </pre>
              {mail.attachments.map((a) => (
                <div key={a.providerAttachmentId} className="mt-3">
                  <Button variant="secondary" onClick={() => download(a)}>
                    {a.filename} · {Math.ceil(a.size / 1024)} KB
                  </Button>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
