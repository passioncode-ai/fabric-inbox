/**
 * S07 (B-272): a reply agent's draft lives only until the conversation is answered. When a reply is accepted, the drafts
 * of reply agents that answer the replied-to message or an earlier one are retired: the run's outcome is written first,
 * then an untouched draft on a Cloudflare address is deleted in one revision-checked step, its whole text already kept on
 * the run. A draft a person changed is theirs and stays in Drafts. Pure rules here; the mailbox's `project` step, the
 * registry and the discard route apply them.
 */
import { bareMessageId, replyTarget, type ReplyHeaders } from "../../shared/mail/reply-target";
import type { AgentRun, DraftOutcomeKind } from "./run";

/** One message of the conversation as the mailbox stores it. */
export interface ThreadRowFacts {
  id: string;
  folder_id: string;
  message_id?: string | null;
  /** A draft names the message it answers by internal id; every other row by Message-ID. */
  in_reply_to?: string | null;
  date?: string | null;
  draft_revision?: number | null;
}

/** The reply that was accepted, as its outbox payload carries it. */
export interface SentReply extends ReplyHeaders {
  /** The draft the send came from (a draft sent from the card or the composer): it leaves by the send, never here. */
  sourceDraftId?: string;
  /** The internal id of the message that draft answered, for a send whose Message-ID chain is empty. */
  sourceDraftAnswers?: string;
}

/** A draft retirement looks at: its id and the internal id of the message it answers. */
export interface DraftToRetire { draftId: string; answers: string; revision: number | null }

/**
 * An untouched draft (B-52): saved by its agent and never again. A Cloudflare draft starts with no revision or revision
 * 1; any save by a person makes it 2 or more, and a draft made again for a person starts at 2 (R6-4).
 */
export const isUntouched = (revision: number | null | undefined) => revision === null || revision === undefined || Number(revision) === 1;

/** The index, among `rows` (oldest first), of the message the reply answers, or -1. One rule (`replyTarget`). */
export function repliedIndex(rows: readonly ThreadRowFacts[], sent: SentReply): number {
  const byMessageId = new Map<string, number>();
  rows.forEach((row, i) => { if (row.folder_id !== "draft") { const id = bareMessageId(row.message_id); if (id) byMessageId.set(id, i); } });
  const { target } = replyTarget(sent, (id) => byMessageId.has(id));
  if (target !== null) return byMessageId.get(target)!;
  if (sent.sourceDraftAnswers) return rows.findIndex((row) => row.id === sent.sourceDraftAnswers);
  return -1;
}

/**
 * The drafts of the conversation the accepted reply retires: those answering the replied-to message or an earlier one
 * (a draft answering a later message, from another person, stays), never the draft the send came from. A reply that
 * answers no message of the conversation (a forward, a new message) retires nothing.
 */
export function draftsToRetire(rows: readonly ThreadRowFacts[], sent: SentReply): DraftToRetire[] {
  const replied = repliedIndex(rows, sent);
  if (replied < 0) return [];
  const indexOf = new Map(rows.map((row, i) => [row.id, i] as const));
  return rows.filter((row) => row.folder_id === "draft" && row.id !== sent.sourceDraftId && !!row.in_reply_to)
    .filter((row) => { const i = indexOf.get(row.in_reply_to!); return i !== undefined && i <= replied && rows[i]!.folder_id !== "draft"; })
    .map((row) => ({ draftId: row.id, answers: row.in_reply_to!, revision: row.draft_revision ?? null }));
}

/** Who sent an accepted reply: a person (the composer, the card, the app) or an agent (a key, the in-app agent, a reply agent). */
export type SentByKind = "person" | "agent";

/**
 * The outcome a reply gives a run (R6-3): an agent's reply is `answered_by_agent` whatever its key; a person's reply is
 * `answered_by_person`, except that sending the run's own draft as the agent wrote it is `approved_by_person` (S06).
 */
export function outcomeKindFor(sentBy: SentByKind, source: { isRunDraft: boolean; untouched: boolean } | null): DraftOutcomeKind {
  if (sentBy === "agent") return "answered_by_agent";
  if (source?.isRunDraft && source.untouched) return "approved_by_person";
  return "answered_by_person";
}

/**
 * A retired draft may be deleted only when the run holds its whole text (KIMI-46), so "Make a draft of it again" can
 * always bring it back; a run written before this change, or one whose draft was longer than the run keeps, keeps it.
 */
export function runKeepsWholeDraft(run: Pick<AgentRun, "draftId" | "draftText" | "draftTextComplete" | "priorDrafts">, draftId: string): boolean {
  if (run.draftId === draftId) return run.draftTextComplete === true && typeof run.draftText === "string";
  return !!run.priorDrafts?.some((d) => d.id === draftId && d.complete && typeof d.text === "string");
}

/** A draft that is the run's own: its current one or an earlier attempt's (K-5); never the person's copy. */
export const isRunsAgentDraft = (run: Pick<AgentRun, "draftId" | "priorDrafts">, draftId: string) =>
  run.draftId === draftId || !!run.priorDrafts?.some((d) => d.id === draftId);

/** One earlier attempt's draft the run remembers (K-5). */
export type PriorDraft = NonNullable<AgentRun["priorDrafts"]>[number];

/**
 * S07 (K-5): before a run's draft is replaced by a new attempt's, the earlier one is remembered with its kept text, so a
 * reply later retires it too (by the same rules: untouched and its whole text kept). Every earlier attempt is returned;
 * `trimPriorDrafts` decides which fall beyond the limit.
 */
export function withPriorDraft<R extends Pick<AgentRun, "draftId" | "draftText" | "draftTextComplete" | "priorDrafts">>(run: R, nextDraftId: string): R {
  if (!run.draftId || run.draftId === nextDraftId) return run;
  const prior = { id: run.draftId, text: run.draftText ?? "", complete: run.draftTextComplete === true && typeof run.draftText === "string" };
  return { ...run, priorDrafts: [...(run.priorDrafts ?? []).filter((d) => d.id !== prior.id), prior] };
}

/**
 * Round 2, K-5: past `keep` remembered attempts, the oldest that could be retired (its whole text kept) are retired now
 * instead of being forgotten, so no untouched draft outlives its conversation; one whose text was not kept can never be
 * retired and stays tracked (it costs only its id).
 */
export function trimPriorDrafts(list: readonly PriorDraft[], keep: number): { kept: PriorDraft[]; toRetire: PriorDraft[] } {
  const toRetire: PriorDraft[] = [];
  let over = list.filter((d) => d.complete).length - keep;
  const kept = list.filter((d) => {
    if (over > 0 && d.complete) { over--; toRetire.push(d); return false; }
    return true;
  });
  return { kept, toRetire };
}

/** What deleting an untouched draft found (the mailbox's `deleteUntouchedDraft`). */
export type RetireState = "deleted" | "edited" | "gone";

/**
 * K-5: the run's earlier attempts after a new one replaces its draft. Each attempt beyond the limit is retired by the
 * mailbox's revision-checked delete (`retire`): deleted, edited (a person's draft now, which stays in Drafts) or gone, it
 * is no longer tracked. Where retiring cannot run (no `retire`, as on an account, or it failed) it stays tracked, so
 * the reply that answers the conversation still retires it.
 */
export async function rememberPriorDraft<R extends Pick<AgentRun, "draftId" | "draftText" | "draftTextComplete" | "priorDrafts">>(
  run: R, nextDraftId: string, keep: number, retire?: (draftId: string) => Promise<RetireState>,
): Promise<{ priorDrafts: PriorDraft[] | undefined; retired: { id: string; state: RetireState }[] }> {
  const all = withPriorDraft(run, nextDraftId).priorDrafts ?? [];
  const { kept, toRetire } = trimPriorDrafts(all, keep);
  const retired: { id: string; state: RetireState }[] = [];
  const stay: PriorDraft[] = [];
  for (const d of toRetire) {
    if (!retire) { stay.push(d); continue; }
    try { retired.push({ id: d.id, state: await retire(d.id) }); }
    catch { stay.push(d); }
  }
  const order = new Map(all.map((d, i) => [d.id, i] as const));
  const priorDrafts = [...stay, ...kept].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { priorDrafts: priorDrafts.length ? priorDrafts : undefined, retired };
}
