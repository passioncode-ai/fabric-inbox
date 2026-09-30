import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { fabric } from "~/services/fabric";
import type { AgentList, Assignment, ProjectAddress, RoutingStatus } from "~/services/agents";

export const assignmentValue = (a: ProjectAddress["agent"]) => (a === "off" ? "off" : a === "legacy" ? "legacy" : a.id);
export const toAssignment = (value: string): Assignment => (value === "off" ? "off" : { id: value });

const ROUTING_TEXT: Record<RoutingStatus["state"], string> = {
  verified: "Arriving here",
  missing: "Not arriving here",
  unknown: "Routing unknown",
};

/** One project address: who answers, where its copy goes, whether mail reaches it, and removal (SCN-021, SCN-032). */
export default function AddressRow({ address, agents, busy, routingConfigured, isCatchAll, destinations, run }: {
  address: ProjectAddress; agents?: AgentList; busy: boolean; routingConfigured: boolean; isCatchAll: boolean;
  /** Confirmed forwarding destinations, or null when they cannot be read (no token). */
  destinations?: string[] | null;
  run: (action: () => Promise<string>) => Promise<void>;
}) {
  const path = "/api/project-addresses/" + encodeURIComponent(address.email);
  const routing = useQuery({ queryKey: ["routing", address.email], queryFn: () => fabric<RoutingStatus>(path + "/routing"), staleTime: 60_000 });
  const client = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editCopy, setEditCopy] = useState(false);
  const [copy, setCopy] = useState(address.forwardTo ?? "");
  const confirmRef = useRef<HTMLButtonElement>(null);
  // The confirmation takes the focus, so a keyboard user lands on the choice it asks for.
  useEffect(() => { if (confirmRemove) confirmRef.current?.focus(); }, [confirmRemove]);
  const current = assignmentValue(address.agent);
  const copyOptions = [...new Set([...(destinations ?? []), ...(address.forwardTo ? [address.forwardTo] : [])])];
  return (
    <article className="mt-3 rounded-xl border border-kumo-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link className="font-medium underline" to={"/?account=" + encodeURIComponent("cloudflare:" + address.email)}>{address.email}</Link>
        <label className="flex items-center gap-2 text-sm">Who answers
          <select className="rounded-lg border border-kumo-line bg-transparent px-2 py-1" value={current} disabled={busy}
            onChange={(e) => void run(async () => {
              await fabric(path + "/agent", { agent: toAssignment(e.target.value) }, "PUT");
              return e.target.value === "off" ? `${address.email} is Off. New mail stays for you.` : `${address.email} is answered by ${agents?.agents.find((a) => a.id === e.target.value)?.name ?? e.target.value}.`;
            })}>
            {current === "legacy" && <option value="legacy" disabled>Drafts with its old prompt (set on next message)</option>}
            <option value="off">Off</option>
            {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {/* Agents that could not be listed still show the one answering, never a false "Off". */}
            {typeof address.agent === "object" && !agents && <option value={address.agent.id}>{address.agentName ?? address.agent.id}</option>}
            {typeof address.agent === "object" && agents && !address.agentName && <option value={address.agent.id} disabled>Deleted agent — Off</option>}
          </select>
        </label>
      </div>
      {isCatchAll && <p className="mt-1 text-sm text-kumo-subtle">Also keeps mail for every other address on {address.domain}.</p>}
      {!editCopy ? (
        <p className="mt-1 text-sm text-kumo-subtle">
          {address.forwardTo ? `A copy of each message is forwarded to ${address.forwardTo}.` : "No copy is forwarded."}
          {destinations && <> <button type="button" className="underline" disabled={busy} onClick={() => { setCopy(address.forwardTo ?? ""); setEditCopy(true); }}>Change</button></>}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">Forward a copy to
            <select className="rounded-lg border border-kumo-line bg-transparent px-2 py-1" value={copy} onChange={(e) => setCopy(e.target.value)}>
              <option value="">No copy</option>
              {copyOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <button type="button" className="fi-primary" disabled={busy || copy === (address.forwardTo ?? "")} onClick={() => void run(async () => {
            const r = await fabric<{ warning?: string }>(path + "/copy", { forwardTo: copy || null }, "PUT");
            setEditCopy(false);
            return [copy ? `A copy of ${address.email}'s mail now goes to ${copy}.` : `${address.email} no longer forwards a copy.`, r.warning].filter(Boolean).join(" ");
          })}>Save</button>
          <button type="button" className="fi-secondary" onClick={() => setEditCopy(false)}>Cancel</button>
          {!destinations?.length && <span className="text-kumo-subtle">Add a destination under Forwarding destinations first.</span>}
        </div>
      )}
      {address.deliveryIssue && (
        <p role="alert" className="mt-1 text-sm font-medium">
          The copy to {address.deliveryIssue.target} failed {address.deliveryIssue.count} time{address.deliveryIssue.count > 1 ? "s" : ""}, last {new Date(address.deliveryIssue.lastAt).toLocaleString()}: {address.deliveryIssue.problem}. The mail itself is kept here.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        {routing.isPending ? <span role="status">Checking routing…</span> : routing.isError ? (
          <span role="alert">Routing unknown: {(routing.error as Error).message}</span>
        ) : (
          <span className={routing.data.state === "verified" ? "" : "font-medium"}>
            {ROUTING_TEXT[routing.data.state]} — {routing.data.detail}
          </span>
        )}
        <button className="underline" onClick={() => void client.invalidateQueries({ queryKey: ["routing", address.email] })}>Recheck</button>
        {routingConfigured && routing.data?.state === "missing" && !routing.data.detail.includes("somewhere else") && (
          <button className="fi-secondary" disabled={busy} onClick={() => void run(async () => {
            const status = await fabric<RoutingStatus>(path + "/routing", {});
            await client.invalidateQueries({ queryKey: ["routing", address.email] });
            return status.detail;
          })}>Send it here</button>
        )}
        <button className="fi-secondary" disabled={busy} onClick={() => void run(async () => {
          const result = await fabric<{ subject: string; status: string }>(path + "/test", {});
          return result.status === "accepted"
            ? `Test message accepted by the provider: "${result.subject}". It should appear in ${address.email} within a minute if routing works.`
            : `Test message ${result.status}: "${result.subject}". Check the address's outbox.`;
        })}>Send test message</button>
        {!isCatchAll && !confirmRemove && (
          <button className="underline" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove…</button>
        )}
      </div>
      {confirmRemove && (
        <div role="group" aria-label={`Remove ${address.email}`} className="mt-3 rounded-lg border border-kumo-line p-3 text-sm">
          <p className="font-medium">Remove {address.email} and delete its mail?</p>
          <p className="mt-1 text-kumo-subtle">Its routing rule is removed too. This cannot be undone.</p>
          <div className="mt-2 flex gap-3">
            <button ref={confirmRef} className="fi-primary" disabled={busy} onClick={() => void run(async () => {
              const r = await fabric<{ routing: string; afterwards: string }>(path, undefined, "DELETE");
              setConfirmRemove(false);
              return `${address.email} was removed. ${r.routing} ${r.afterwards}`;
            })}>Remove and delete mail</button>
            <button className="fi-secondary" onClick={() => setConfirmRemove(false)}>Keep it</button>
          </div>
        </div>
      )}
    </article>
  );
}
