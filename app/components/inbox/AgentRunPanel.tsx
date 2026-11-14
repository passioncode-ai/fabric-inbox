import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fabric } from "~/services/fabric";
import { useT } from "~/lib/i18n";
import { useMe } from "~/lib/me";
import { agentRunLabel, agentRunNeedsLook } from "./agent-run";
import { draftWaits } from "./draft-card";
import type { InboxMessage } from "./model";

/** A run as `GET /api/agent-runs/:id` answers it (workers/agents/run.ts), the fields the reader shows. */
interface AgentRunView {
  id: string; status: string; reason: string; agentId?: string; agentVersion?: number; intent?: string; grounded?: boolean;
  toolCalls: { name: string; ok: boolean; ms?: number }[];
  sources?: { ref: string; title: string }[];
  draftId?: string;
  sent?: { to: string; subject: string; body: string };
  /** S07 (B-272): how the conversation ended once the draft waited, and whether the run keeps the draft's whole text. */
  outcome?: { kind: string; at: string; edited?: boolean };
  draftTextComplete?: boolean;
  personDraftId?: string;
}

/** Runs that can be given back to the agent: never one already sent or that may have been sent. */
const AGAIN = new Set(["drafted", "held", "skipped", "failed", "interrupted", "send_failed"]);

/**
 * What the reply agent did with the open message (B-115): why, from what, with which tools, and the
 * reply it sent or the draft it left — read by the run's id when the message carries one.
 */
export default function AgentRunPanel({ message, onOpenDraft, hideWhileDraftWaits = false, onChanged }: {
  message: InboxMessage;
  onOpenDraft: (draftId: string) => void;
  /** S06 (B-271): in a conversation the waiting draft is a card under the message, which takes this panel's place. */
  hideWhileDraftWaits?: boolean;
  /** S07: the conversation changed (a draft made again). */
  onChanged?: () => void;
}) {
  const t = useT();
  // A member of a shared server does not see the reply agents' runs (B-149): agents are the administrator's.
  const me = useMe();
  const id = me.data?.role === "member" ? undefined : message.agentRun?.id;
  const run = useQuery({
    queryKey: ["agent-run", id],
    enabled: !!id && !me.isPending,
    queryFn: () => fabric<AgentRunView>(`/api/agent-runs/${encodeURIComponent(id!)}`),
    staleTime: 15_000,
  });
  const client = useQueryClient();
  // Gives the message back to its agent (the next attempt); refused for an answer already sent.
  const again = useMutation({
    mutationFn: () => fabric<AgentRunView>(`/api/agent-runs/${encodeURIComponent(id!)}/again`, {}, "POST"),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["agent-run", id] }),
  });
  // S07 (B-272): "Make a draft of it again": the agent's text, kept on the run, as a new draft of the person's (R6-4).
  const redraft = useMutation({
    mutationFn: () => fabric(`/api/agent-runs/${encodeURIComponent(id!)}/redraft`, {}),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["agent-run", id] }); onChanged?.(); },
  });
  if (!message.agentRun || !id) return null;
  if (hideWhileDraftWaits && draftWaits(message.agentRun)) return null;
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
          {r.outcome && (
            <p className="fi-agent-run-facts">{outcomeText(r.outcome.kind, !!r.outcome.edited, t)}</p>
          )}
          {r.draftId && status === "drafted" && !r.outcome && (
            <button type="button" className="fi-secondary" onClick={() => onOpenDraft(r.draftId!)}>{t("Open the agent's draft")}</button>
          )}
          {r.outcome && !r.outcome.edited && r.outcome.kind !== "approved_by_person" && r.draftTextComplete && (
            <button type="button" className="fi-secondary" disabled={redraft.isPending} onClick={() => redraft.mutate()}>{t("Make a draft of it again")}</button>
          )}
          {redraft.isSuccess && <p role="status">{t("Saved as your draft.")}</p>}
          {redraft.isError && <p role="alert">{t("The draft could not be made again. Try again.")}</p>}
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

/** S07: how the conversation ended once the agent's draft waited, in the reader's words. */
function outcomeText(kind: string, edited: boolean, t: ReturnType<typeof useT>): string {
  if (edited) return t("Your edited draft is in Drafts");
  if (kind === "approved_by_person") return t("You sent the agent's draft as it was written.");
  if (kind === "answered_by_agent") return t("An agent replied, so the agent's draft was removed. Its text is kept here.");
  if (kind === "superseded") return t("You set the agent's draft aside. Its text is kept here.");
  return t("You replied, so the agent's draft was removed. Its text is kept here.");
}
