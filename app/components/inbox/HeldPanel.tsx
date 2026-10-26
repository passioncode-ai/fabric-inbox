import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fabric } from "~/services/fabric";
import { useT } from "~/lib/i18n";
import { useMe } from "~/lib/me";
import type { InboxMessage } from "./model";

/** A message's safety record as `POST /api/safety/lookup` answers it (workers/routes/safety.ts), the fields shown. */
interface SafetyView {
  state: "clear" | "held" | "released" | "kept"; reason: string; decidedBy: string;
  review: { verdict: string; reasons: string[] } | null;
  findings: { hidden: string; hiddenSignals: string[]; visibleStrong: string[]; model: boolean };
}

/**
 * B-178 (SCN-087): why the open message is held from agents with tools, what the review said, the hidden text that
 * was found (shown as text, never as HTML), and Release or Keep held. Releasing lets rules and the reply agent take it.
 */
export default function HeldPanel({ message }: { message: InboxMessage }) {
  const t = useT();
  const me = useMe();
  const client = useQueryClient();
  const key = { accountId: message.accountId.toLowerCase(), messageId: message.providerMessageId };
  const record = useQuery({
    queryKey: ["safety", key.accountId, key.messageId],
    enabled: !!message.held && me.data?.role !== "member",
    queryFn: async () => (await fabric<{ records: Record<string, SafetyView> }>("/api/safety/lookup", { keys: [key] }, "POST")).records[`${key.accountId}|${key.messageId}`] ?? null,
  });
  const decide = useMutation({
    mutationFn: (action: "release" | "keep") => fabric<{ state: string }>("/api/safety/decide", { ...key, action }, "POST"),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["safety", key.accountId, key.messageId] });
      void client.invalidateQueries({ queryKey: ["unified-inbox"] });
      void client.invalidateQueries({ queryKey: ["unified-inbox-head"] });
    },
  });
  if (!message.held) return null;
  const r = record.data;
  const state = decide.data?.state ?? r?.state ?? "held";
  const verdict = r?.review?.verdict;
  return (
    <section className="fi-agent-run needs-look" aria-label={t("Held for review")}>
      <p className="fi-agent-run-title"><strong>{state === "released" ? t("Released for agents") : t("Held for review")}</strong></p>
      <p>{t("Agents that can act (send, forward, use tools) do not get this message's text until you release it.")}</p>
      <p>{t.text(r?.reason ?? message.held.reason)}</p>
      {record.isError && <p role="alert">{t("Why it is held could not load.")}</p>}
      {verdict && (
        <p className="fi-agent-run-facts">
          {verdict === "agent_instructions" ? t("Review: it gives orders to an AI") : verdict === "phishing" ? t("Review: it looks like phishing")
            : verdict === "safe" ? t("Review: nothing aimed at an AI") : t("Review: unsure")}
        </p>
      )}
      {!!r?.review?.reasons.length && <ul>{r.review.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
      {!!r?.findings.hidden && (
        <details>
          <summary>{t("Hidden text that was found")}</summary>
          <pre>{r.findings.hidden}</pre>
        </details>
      )}
      {me.data?.role !== "member" && state !== "released" && (
        <p>
          <button type="button" className="fi-secondary" disabled={decide.isPending} onClick={() => decide.mutate("release")}>{t("Release")}</button>{" "}
          {state !== "kept" && <button type="button" className="fi-secondary" disabled={decide.isPending} onClick={() => decide.mutate("keep")}>{t("Keep held")}</button>}
        </p>
      )}
      {decide.isError && <p role="alert">{t.text((decide.error as Error).message || "")}</p>}
    </section>
  );
}
