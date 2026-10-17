import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fabric } from "~/services/fabric";
import { useT } from "~/lib/i18n";
import { agentRunLabel, agentRunNeedsLook } from "./agent-run";
import type { InboxMessage } from "./model";

/** A run as `GET /api/agent-runs/:id` answers it (workers/agents/run.ts), the fields the reader shows. */
interface AgentRunView {
  id: string; status: string; reason: string; agentId?: string; agentVersion?: number; intent?: string; grounded?: boolean;
  toolCalls: { name: string; ok: boolean; ms?: number }[];
  sources?: { ref: string; title: string }[];
  draftId?: string;
  sent?: { to: string; subject: string; body: string };
}

/** Runs that can be given back to the agent: never one already sent or that may have been sent. */
const AGAIN = new Set(["drafted", "held", "skipped", "failed", "interrupted", "send_failed"]);

/**
 * What the reply agent did with the open message (B-115): why, from what, with which tools, and the
 * reply it sent or the draft it left — read by the run's id when the message carries one.
 */
export default function AgentRunPanel({ message, onOpenDraft }: { message: InboxMessage; onOpenDraft: (draftId: string) => void }) {
  const t = useT();
  const id = message.agentRun?.id;
  const run = useQuery({
    queryKey: ["agent-run", id],
    enabled: !!id,
    queryFn: () => fabric<AgentRunView>(`/api/agent-runs/${encodeURIComponent(id!)}`),
    staleTime: 15_000,
  });
  const client = useQueryClient();
  // Gives the message back to its agent (the next attempt); refused for an answer already sent.
  const again = useMutation({
    mutationFn: () => fabric<AgentRunView>(`/api/agent-runs/${encodeURIComponent(id!)}/again`, {}, "POST"),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["agent-run", id] }),
  });
  if (!message.agentRun) return null;
  const r = run.data;
  const status = r?.status ?? message.agentRun.status;
  return (
    <section className={"fi-agent-run" + (agentRunNeedsLook(status) ? " needs-look" : "")} aria-label={t("What the agent did")}>
      <p className="fi-agent-run-title">
        <strong>{agentRunLabel(status, t)}</strong>
        {(r?.agentId ?? message.agentRun.agentId) && <span> · {r?.agentId ?? message.agentRun.agentId}{(r?.agentVersion ?? message.agentRun.agentVersion) ? ` v${r?.agentVersion ?? message.agentRun.agentVersion}` : ""}</span>}
      </p>
      {run.isError && <p role="alert">{t("What the agent did could not load.")}</p>}
      {r && (
        <>
          {r.reason && <p>{t.text(r.reason)}</p>}
          <p className="fi-agent-run-facts">
            {r.intent && <span>{t("Intent: {intent}", { intent: r.intent })}</span>}
            {r.grounded !== undefined && <span>{r.grounded ? t("Answer grounded in its knowledge") : t("Not grounded: a person checks it")}</span>}
          </p>
          {!!r.sources?.length && (
            <p className="fi-agent-run-facts">{t("Answered from: {titles}", { titles: r.sources.map((s) => s.title).join(" · ") })}</p>
          )}
          {!!r.toolCalls.length && (
            <p className="fi-agent-run-facts">{t("Tools: {calls}", { calls: r.toolCalls.map((c) => `${c.name} ${c.ok ? "✓" : "✗"}`).join(" · ") })}</p>
          )}
          {r.sent && (
            <details>
              <summary>{t("What it sent")}</summary>
              <pre>{r.sent.body}</pre>
            </details>
          )}
          {r.draftId && status === "drafted" && (
            <button type="button" className="fi-secondary" onClick={() => onOpenDraft(r.draftId!)}>{t("Open the agent's draft")}</button>
          )}
          {AGAIN.has(status) && (
            <button type="button" className="fi-secondary" disabled={again.isPending} onClick={() => again.mutate()}>{t("Answer again")}</button>
          )}
          {again.isSuccess && <p role="status">{t("The agent will answer it again in a moment.")}</p>}
          {again.isError && <p role="alert">{t.text((again.error as Error).message || "")}</p>}
        </>
      )}
    </section>
  );
}
