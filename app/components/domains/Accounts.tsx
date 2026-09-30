import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { fabric } from "~/services/fabric";
import type { CloudflareAccount, DomainList, TokenPermission } from "~/services/domains";
import { DOMAINS_KEY } from "./DomainCard";

/** Where a person creates a token; an account-owned one is under the account's own Manage Account page. */
const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

type Run = (action: () => Promise<string>) => Promise<void>;

function describe(a: CloudflareAccount): string {
  const mail = a.hasMail === true ? "Has mail" : a.hasMail === false ? "No mail yet" : "Mail not checked";
  const domains = `${a.domains} domain${a.domains === 1 ? "" : "s"}${a.served ? `, ${a.served} receiving here` : ""}`;
  const via = a.via === "account" ? "its own token" : "your server's token";
  return [mail, domains, `reached with ${via}`, ...(a.relay ? ["relay installed"] : [])].join(" · ");
}

/**
 * Cloudflare accounts on Domains & addresses (SCN-045, SCN-046): every account the server has a
 * token for, which ones show, and connecting or removing one more.
 */
export default function Accounts({ list, busy, run }: { list: DomainList; busy: boolean; run: Run }) {
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const choose = (a: CloudflareAccount, shown: boolean | null) => run(async () => {
    await fabric(`/api/cloudflare/accounts/${a.id}`, { shown }, "PUT");
    return shown === null ? `${a.name} is back to the default: shown when it has mail.` : shown ? `The domains of ${a.name} are shown.` : `The domains of ${a.name} are hidden.`;
  });
  const remove = (a: CloudflareAccount) => run(async () => {
    const r = await fabric<{ relay?: string }>(`/api/cloudflare/accounts/${a.id}`, undefined, "DELETE");
    setRemoving(null);
    return `${a.name} was removed from your server: its token was deleted${r.relay ? " and its relay removed" : ""}.`;
  });

  return (
    <section className="my-6" aria-labelledby="accounts-heading">
      <h2 id="accounts-heading" className="text-xl font-medium">Cloudflare accounts</h2>
      <p className="mt-1 text-sm text-kumo-subtle">
        Your server reads the domains of every Cloudflare account it has a token for. Accounts with mail are shown; show another one
        here, or connect an account your server cannot reach yet.
      </p>
      <ul className="mt-3 divide-y divide-kumo-line rounded-xl border border-kumo-line text-sm">
        {list.accounts.map((a) => (
          <li key={a.id} className="p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="font-medium">{a.name}</span>
                {a.server && <span className="text-kumo-subtle"> · your server's account</span>}
                <p className="text-kumo-subtle">{describe(a)}</p>
                {a.problem && <p role="alert" className="mt-1">Its domains could not be read: {a.problem}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="fi-secondary" disabled={busy} aria-pressed={a.shown}
                  onClick={() => void choose(a, !a.shown)}>{a.shown ? "Hide" : "Show"}</button>
                {a.choice && <button className="fi-secondary" disabled={busy} onClick={() => void choose(a, null)}>Default</button>}
                {a.via === "account" && !a.server && (
                  <button className="fi-secondary" disabled={busy} onClick={() => setRemoving(removing === a.id ? null : a.id)}>Remove…</button>
                )}
              </div>
            </div>
            {removing === a.id && (
              <div role="group" aria-label={`Remove ${a.name}`} className="mt-3 rounded-lg border border-kumo-line p-3">
                <p>
                  Remove {a.name} from your server? {a.relay ? "Its relay Worker is deleted, and " : ""}its token is deleted. Its
                  domains are no longer listed here; connecting it again needs a new token.
                  {a.served > 0 && " Stop receiving its domains here first."}
                </p>
                <div className="mt-2 flex gap-2">
                  <button className="fi-secondary" disabled={busy || a.served > 0} onClick={() => void remove(a)}>Remove {a.name}</button>
                  <button className="fi-secondary" autoFocus onClick={() => setRemoving(null)}>Keep</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {list.problems?.map((p) => <p key={p} role="alert" className="mt-2 text-sm">{p}</p>)}
      {connecting
        ? <ConnectAccount permissions={list.accountPermissions} onClose={() => setConnecting(false)} />
        : <button className="fi-secondary mt-3" disabled={busy} onClick={() => setConnecting(true)}>Connect another account</button>}
    </section>
  );
}

/** SCN-046: a token for one more account, checked and kept on the server; never shown again. */
function ConnectAccount({ permissions, onClose }: { permissions: TokenPermission[]; onClose: () => void }) {
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);

  async function connect() {
    setWorking(true); setResult(null);
    try {
      const r = await fabric<{ connected: { id: string; name: string }[]; skipped: { name: string; reason: string }[] }>("/api/cloudflare/accounts", { token });
      setToken("");
      if (!r.connected.length) {
        setResult({ tone: "alert", text: `Nothing new to connect: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.` });
        return;
      }
      const names = r.connected.map((a) => a.name).join(", ");
      setResult({ tone: "status", text: `Connected ${names}. Your server starts using the token within a few seconds…` });
      // A saved token is a new version of the server: read the accounts again until it is in use.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const list = await client.fetchQuery({ queryKey: DOMAINS_KEY, queryFn: () => fabric<DomainList>("/api/domains"), staleTime: 0 });
        if (r.connected.every((c) => list.accounts.some((a) => a.id === c.id))) {
          setResult({ tone: "status", text: `Connected ${names}. Its domains with mail are listed below.` });
          return;
        }
      }
      setResult({ tone: "alert", text: `Connected ${names}, but your server has not started using the token yet. Reload this page in a minute.` });
    } catch (error) {
      setResult({ tone: "alert", text: (error as Error).message });
      field.current?.focus();
    } finally { setWorking(false); }
  }

  return (
    <div role="group" aria-labelledby="connect-account-heading" className="mt-3 rounded-xl border border-kumo-line p-4 text-sm">
      <h3 id="connect-account-heading" className="font-medium">Connect another account</h3>
      <ol className="mt-2 list-decimal space-y-2 pl-5">
        <li>
          In Cloudflare, open the other account and create a token there: <strong>Manage Account → Account API Tokens</strong>, or{" "}
          <a className="underline" href={TOKEN_PAGE} target="_blank" rel="noreferrer">My Profile → API Tokens</a>. Choose{" "}
          <strong>Create Custom Token</strong>.
        </li>
        <li>
          Add these permissions, and under Account and Zone resources choose that account and <strong>All zones</strong>:
          <table className="mt-2 w-full text-left">
            <thead><tr className="text-kumo-subtle"><th className="py-1 pr-3 font-medium">Type</th><th className="py-1 pr-3 font-medium">Permission</th><th className="py-1 pr-3 font-medium">Access</th><th className="py-1 font-medium">Used to</th></tr></thead>
            <tbody>
              {permissions.map((p) => (
                <tr key={p.scope + p.name} className="border-t border-kumo-line">
                  <td className="py-1 pr-3">{p.scope}</td><td className="py-1 pr-3 font-medium">{p.name}</td><td className="py-1 pr-3">{p.level}</td><td className="py-1">{p.for}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
        <li>Paste the token here. Your server keeps it as its own secret; it is not shown again.</li>
      </ol>
      <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
        <label className="block font-medium">Token
          <input ref={field} type="password" autoComplete="off" spellCheck={false} required
            className="mt-1 w-96 max-w-full rounded-lg border border-kumo-line bg-transparent px-3 py-2" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <button type="submit" className="fi-secondary" disabled={working || !token.trim()}>{working ? "Connecting…" : "Connect"}</button>
        <button type="button" className="fi-secondary" onClick={onClose} disabled={working}>Close</button>
      </form>
      {result && <p role={result.tone} className="mt-2">{result.text}</p>}
    </div>
  );
}
