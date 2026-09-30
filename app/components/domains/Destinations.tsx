import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fabric } from "~/services/fabric";
import type { CloudflareAccount, Destination } from "~/services/domains";

export const DESTINATIONS_KEY = ["domain-destinations"];

/** The destinations of one Cloudflare account; the server's own when none is named. */
export function useDestinations(enabled: boolean, account?: string) {
  return useQuery({
    queryKey: [...DESTINATIONS_KEY, account ?? "server"], enabled, staleTime: 60_000,
    queryFn: () => fabric<{ destinations: Destination[] }>(`/api/domains/destinations${account ? `?account=${account}` : ""}`).then((r) => r.destinations),
  });
}

/**
 * Forwarding destinations (SCN-033): the outside addresses a copy of each
 * message may go to. Cloudflare delivers a copy only to a confirmed one, and
 * sends the confirmation link itself.
 */
export default function Destinations({ busy, run, accounts = [] }: {
  busy: boolean; run: (action: () => Promise<string>) => Promise<void>;
  /** The shown Cloudflare accounts: destinations belong to one account each. */
  accounts?: CloudflareAccount[];
}) {
  const [chosen, setChosen] = useState<string>("");
  const current = accounts.find((a) => a.id === chosen) ?? accounts.find((a) => a.server) ?? accounts[0];
  const account = current && !current.server ? current.id : undefined;
  const list = useDestinations(true, account);
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  return (
    <section className="my-8" aria-labelledby="destinations-heading">
      <h2 id="destinations-heading" className="text-xl font-medium">Forwarding destinations</h2>
      <p className="mt-1 text-sm text-kumo-subtle">
        An address here can keep forwarding a copy of each message to one of these, for example the Gmail you read today. Cloudflare
        only delivers to a destination that has confirmed it{accounts.length > 1 ? ", in the same Cloudflare account as the address's domain" : ""}.
      </p>
      {accounts.length > 1 && (
        <label className="mt-3 block text-sm font-medium">Cloudflare account
          <select className="mt-1 block rounded-lg border border-kumo-line bg-transparent px-3 py-2 text-sm" value={current?.id ?? ""} onChange={(e) => setChosen(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      {list.isPending ? <p role="status" className="mt-3 text-sm">Loading destinations…</p> : list.isError ? (
        <p role="alert" className="mt-3 text-sm">Destinations could not load: {(list.error as Error).message} <button className="underline" onClick={() => void list.refetch()}>Retry</button></p>
      ) : (
        <ul className="mt-3 divide-y divide-kumo-line rounded-xl border border-kumo-line text-sm">
          {!list.data.length && <li className="p-3">No destination yet.</li>}
          {list.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span>{d.email}</span>
              <span className={d.verified ? "text-kumo-subtle" : "font-medium"}>{d.verified ? "Confirmed" : "Waiting for confirmation: open the link Cloudflare sent to this address"}</span>
            </li>
          ))}
        </ul>
      )}
      <form className="mt-3 flex flex-wrap items-end gap-3" aria-label="Add a forwarding destination"
        onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const r = await fabric<{ destination: Destination; created: boolean }>(`/api/domains/destinations${account ? `?account=${account}` : ""}`, { email });
          setEmail("");
          await client.invalidateQueries({ queryKey: DESTINATIONS_KEY });
          return r.created ? `Cloudflare sent a confirmation link to ${r.destination.email}. It can receive copies once the link is opened.`
            : `${r.destination.email} is already a destination${r.destination.verified ? "" : ", still waiting for confirmation"}.`;
        }); }}>
        <label className="block text-sm font-medium">Add a destination
          <input type="email" required className="mt-1 w-72 max-w-full rounded-lg border border-kumo-line bg-transparent px-3 py-2 text-sm"
            placeholder="you@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" className="fi-secondary" disabled={busy || !email}>Send confirmation</button>
      </form>
    </section>
  );
}
