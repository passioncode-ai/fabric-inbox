import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useState } from "react";
import { fabric, type AccountList, accountPath } from "~/services/fabric";
import { useMailboxes } from "~/queries/mailboxes";
import { gmailSetupState } from "~/lib/account-status";
import { Button, Loader } from "@cloudflare/kumo";
export function meta() {
  return [{ title: "Accounts · Fabric Inbox" }];
}
export default function Accounts() {
  const { data, error, refetch } = useQuery({
    queryKey: ["fabric-accounts"],
    queryFn: () => fabric<AccountList>("/api/accounts"),
    refetchInterval: 15_000,
  });
  const mailboxes = useMailboxes();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Disconnect is two-step: "Disconnect…" arms it for one account, then
  // "Disconnect <email>" confirms or "Keep" backs out.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // After "Keep", focus returns to the account's "Disconnect…" button.
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const keep = (id: string) => {
    setConfirmingId(null);
    setReturnFocusId(id);
  };
  const gmailSetup = gmailSetupState(data, error);
  async function disconnect(id: string) {
    setConfirmingId(null);
    setBusy(true);
    try {
      const result = await fabric<{ revoked: boolean }>(
        accountPath(id) + "/disconnect",
        {},
      );
      setNotice(
        result.revoked
          ? "Account disconnected."
          : "Account removed locally. Revoke its access in your Google account.",
      );
      await refetch();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-3xl p-6 text-kumo-default">
      <Link to="/">← Fabric Inbox</Link>
      <h1 className="mt-8 text-3xl font-semibold">Accounts</h1>
      <p className="my-3 text-kumo-subtle">
        Mail and rules keep running in the cloud when this app is closed.
      </p>
      {error && (
        <p role="alert">
          Accounts could not load.{" "}
          <button onClick={() => refetch()}>Retry</button>
        </p>
      )}
      {notice && (
        <p role="status" className="my-4">
          {notice}
        </p>
      )}
      <section className="my-6 rounded-xl border border-kumo-line p-5">
        <h2 className="text-xl font-medium">Gmail</h2>
        <p className="my-2 text-kumo-subtle">
          Connect each Google account separately.
        </p>
        {gmailSetup === "configured" ? (
          <a
            className="underline"
            href="/api/accounts/gmail/connect"
            target="_blank"
            rel="noreferrer"
          >
            Connect Gmail in browser ↗
          </a>
        ) : gmailSetup === "not-configured" ? (
          <p>
            Gmail connection is not configured on this server. Set up Google
            OAuth to enable it.
          </p>
        ) : gmailSetup === "loading" ? (
          <p role="status" className="flex items-center gap-2 text-kumo-subtle">
            <Loader size="sm" /> Checking Gmail setup…
          </p>
        ) : (
          <p className="text-kumo-subtle">
            Gmail setup is unknown until accounts load.
          </p>
        )}
        {data?.accounts.map((a) => (
          <div key={a.id} className="mt-4 border-t border-kumo-line pt-4">
            <div className="flex flex-wrap justify-between gap-3">
              <Link className="font-medium underline" to={"/accounts/" + a.id}>
                {a.email}
              </Link>
              <span>{a.status.replaceAll("_", " ")}</span>
            </div>
            <p className="my-2 text-sm text-kumo-subtle">
              {a.lastSyncAt
                ? "Last sync " + new Date(a.lastSyncAt).toLocaleString()
                : "Waiting for first sync"}
              {a.error ? " · " + a.error : ""}
            </p>
            <div className="flex gap-4">
              <Link
                className="underline"
                to={"/automation/" + encodeURIComponent("gmail:" + a.id)}
              >
                Rules and history
              </Link>
              {confirmingId === a.id ? (
                <span
                  role="group"
                  aria-label={"Confirm disconnecting " + a.email}
                  className="flex gap-2"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") keep(a.id);
                  }}
                >
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => disconnect(a.id)}
                  >
                    {"Disconnect " + a.email}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    autoFocus
                    onClick={() => keep(a.id)}
                  >
                    Keep
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  autoFocus={returnFocusId === a.id}
                  onClick={() => {
                    setReturnFocusId(null);
                    setConfirmingId(a.id);
                  }}
                >
                  Disconnect…
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
      <section className="my-6 rounded-xl border border-kumo-line p-5">
        <h2 className="text-xl font-medium">Cloudflare mailboxes</h2>
        {mailboxes.data?.map((a) => (
          <div key={a.id} className="mt-4 flex flex-wrap justify-between gap-3">
            <Link
              to={"/mailbox/" + encodeURIComponent(a.id)}
              className="underline"
            >
              {a.email}
            </Link>
            <Link
              to={"/automation/" + encodeURIComponent(a.id)}
              className="underline"
            >
              Rules and history
            </Link>
          </div>
        ))}
        <Link className="mt-4 block underline" to="/mailboxes">
          Manage mailboxes
        </Link>
      </section>
      <section className="rounded-xl border border-kumo-line p-5">
        <h2 className="text-xl font-medium">Other providers</h2>
        <p className="mt-2 text-kumo-subtle">
          Outlook and IMAP connections are not available in this build.
        </p>
      </section>
    </main>
  );
}
