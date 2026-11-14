/**
 * S06 (B-271): a reply agent's draft as an editable card right under the message it answers, and S07 (B-272) what
 * happens to it once the conversation is answered. Pure rules here (where each card goes, why it waits, the autosave,
 * the tuning message); `AgentDraftCard.tsx` and `ConversationList.tsx` draw them.
 */
import type { AgentRunView } from "../../../shared/mail/agent-run-view";
import { fenceUntrusted, type FencedField } from "../../../shared/untrusted-fence";
import { isAgentDraft } from "./agent-run";
import { answeredRows } from "./quotes";
import type { ThreadRow } from "./thread";

/**
 * A reply agent's own draft (not the person's copy of it, R6-4): its run names this row as its draft, or, with no run
 * record kept, its id is a reply agent's (`isAgentDraft`) and the card shows it without the agent's notes.
 */
export const isAgentDraftRow = (row: ThreadRow) => row.kind === "draft" && (row.message.agentRun
  ? row.message.agentRun.draftId === row.message.providerMessageId
  : isAgentDraft(row.message.providerMessageId));

/** The run's conversation was answered (or the draft set aside): no card, no editable panel (KIMI-38). */
export const runAnswered = (run: AgentRunView | undefined) => !!run?.outcome;

/** A draft card waits on the incoming row: its run drafted, left a draft, and the conversation is not answered yet. */
export const draftWaits = (run: AgentRunView | undefined) => !!run && run.status === "drafted" && !!run.draftId && !run.outcome;

export interface CardPlacement {
  /** Under the row at this index: the agent drafts that wait on it, as cards. */
  cards: Map<number, ThreadRow[]>;
  /** Under the row at this index: the agent's drafts a person changed, kept in Drafts once a reply was sent (one quiet line). */
  quiet: Map<number, ThreadRow[]>;
  /** Agent drafts answering a message that is not in this thread: cards at the end. */
  last: ThreadRow[];
  /** Rows drawn as a card or a quiet line, so not as an ordinary cell. */
  taken: Set<string>;
}

/**
 * Where each reply agent's draft is drawn (S06): under the message it answers (a draft names it by internal id), the
 * same rule the thread uses to show what a reply answered (`answeredRows`). A draft whose run has an outcome is not a
 * card: an untouched one is gone, an edited one is listed only as a quiet line under the same message (S07).
 */
export function cardPlacement(rows: readonly ThreadRow[]): CardPlacement {
  const answered = answeredRows(rows.map((r) => ({ internalId: r.message.providerMessageId, rfcMessageId: r.rfcMessageId,
    inReplyTo: r.inReplyTo, references: r.references, draft: r.kind === "draft" })));
  const cards = new Map<number, ThreadRow[]>(), quiet = new Map<number, ThreadRow[]>();
  const last: ThreadRow[] = [];
  const taken = new Set<string>();
  const add = (map: Map<number, ThreadRow[]>, at: number, row: ThreadRow) => map.set(at, [...(map.get(at) ?? []), row]);
  rows.forEach((row, i) => {
    if (!isAgentDraftRow(row)) return;
    const at = answered[i]!;
    taken.add(row.message.id);
    if (runAnswered(row.message.agentRun)) { if (at >= 0) add(quiet, at, row); return; }
    if (at >= 0) add(cards, at, row);
    else last.push(row);
  });
  return { cards, quiet, last, taken };
}

/** Why the agent's draft waits for a person, from its run (the card's header line). */
export type WaitReason = "limit" | "ungrounded" | "draft_mode";
export function waitReason(run: Pick<AgentRunView, "limited" | "grounded">): WaitReason {
  if (run.limited) return "limit";
  if (run.grounded === false) return "ungrounded";
  return "draft_mode";
}

/** The knowledge collection a source names (`<collection>/<document>#<chunk>`), for its link. */
export const sourceCollection = (ref: string) => /^([^/]+)\//.exec(ref)?.[1] ?? null;

// ── Autosave (S06, KIMI-48) ────────────────────────────────────────

/** Later changes are saved this long after typing stops (the first change is saved at once). */
export const SAVE_DELAY_MS = 1500;

export type SaveState = "idle" | "saving" | "saved" | "failed" | "conflict" | "gone";

export type SaveAnswer =
  | { ok: true; revision: number }
  | { ok: false; code: "conflict"; revision?: number; text?: string }
  | { ok: false; code: "gone" | "failed" };

export interface AutosaveDeps {
  /** Saves the text over the draft at `expectedRevision`. */
  save(text: string, expectedRevision: number): Promise<SaveAnswer>;
  /** Keeps the text on this device until a save is acknowledged; null forgets it. */
  keep(text: string | null): void;
  /** The state changed (the card draws it). */
  changed(state: SaveState): void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * The card's autosave: the first change is saved at once (from then on the draft is the person's, so a reply sent
 * elsewhere never retires it); later changes 1.5 s after typing stops and on leaving the field, only when the text
 * changed. Every save names the revision it read (B-52). A save meeting a newer revision is a conflict ("Use mine"
 * saves over it); one meeting a retired draft is `gone` ("Keep as my draft"). Until a save is acknowledged the text is
 * kept on the device.
 */
export class DraftAutosave {
  text: string;
  revision: number;
  state: SaveState = "idle";
  /** The text the server last acknowledged. */
  private saved: string;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private everChanged = false;
  /** The newer text a conflict found elsewhere, while the person's waits as "Your unsaved text". */
  theirs: string | null = null;

  constructor(text: string, revision: number, private deps: AutosaveDeps) {
    this.text = text;
    this.saved = text;
    this.revision = revision;
  }

  get dirty() { return this.text !== this.saved; }
  /** The person changed the text at least once: the draft is theirs (no Discard, never retired). */
  get edited() { return this.everChanged || this.revision > 1; }

  private set(state: SaveState) { this.state = state; this.deps.changed(state); }

  /** The person typed. */
  edit(text: string) {
    if (text === this.text) return;
    this.text = text;
    this.deps.keep(text);
    if (this.state === "conflict" || this.state === "gone") return;
    if (!this.everChanged) { this.everChanged = true; void this.saveNow(); return; }
    this.schedule();
  }

  /** The person left the field: save only when the text changed. */
  blur() { if (this.dirty && this.state !== "conflict" && this.state !== "gone") void this.saveNow(); }

  private schedule() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.saveNow(); }, SAVE_DELAY_MS);
  }

  /** Saves what is typed now; a save already running finishes first, then this one runs if the text moved on. */
  async saveNow(force = false): Promise<void> {
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
    if (this.running) { await this.running; if (!this.dirty && !force) return; }
    if ((!this.dirty && !force) || this.state === "gone" || this.state === "conflict") return;
    const text = this.text;
    this.set("saving");
    this.running = (async () => {
      let answer: SaveAnswer;
      try { answer = await this.deps.save(text, this.revision); }
      catch { answer = { ok: false, code: "failed" }; }
      if (answer.ok) {
        this.revision = answer.revision;
        this.saved = text;
        if (!this.dirty) this.deps.keep(null);
        this.set("saved");
      } else if (answer.code === "conflict") {
        this.theirs = answer.text ?? null;
        if (answer.revision) this.revision = answer.revision;
        this.set("conflict");
      } else this.set(answer.code);
    })();
    try { await this.running; } finally { this.running = null; }
    if (this.dirty && this.state === "saved") this.schedule();
  }

  /** Retry after a failed save. */
  retry() { if (this.state === "failed") { this.state = "idle"; void this.saveNow(); } }

  /** "Use mine": the person's text saved over the newer revision the conflict found. */
  async useMine() {
    if (this.state !== "conflict") return;
    this.theirs = null;
    this.state = "idle";
    await this.saveNow(true);
  }

  /** Send may go: nothing unsaved, nothing running, no failed save, no newer revision, not retired. */
  get sendable() { return !this.dirty && this.running === null && this.timer === null && (this.state === "idle" || this.state === "saved"); }

  /** Send first flushes the pending edit and waits for the save; the revision it then sends, or null when it may not. */
  async flush(): Promise<number | null> {
    if (this.dirty) await this.saveNow();
    else if (this.running) await this.running;
    return this.sendable ? this.revision : null;
  }

  dispose() { if (this.timer !== null) this.deps.clearTimer(this.timer); this.timer = null; }
}

/**
 * KIMI-48: the full composer saves the first change to a reply agent's untouched draft at once too, so the draft is the
 * person's before any reply sent elsewhere could retire it; every other save waits for typing to stop (`delay`).
 */
export function composerSaveDelay(before: { synced?: boolean; serverId?: string; serverRevision?: number | string } | undefined, delay: number): number {
  return before?.synced && before.serverId && isAgentDraft(before.serverId) && Number(before.serverRevision ?? 1) <= 1 ? 0 : delay;
}

// ── Tune the agent (S06) ────────────────────────────────────────────

/** Field caps inside the fence (the untrusted-fence pattern caps every variable part). */
export const TUNE_CAPS = { agent: 120, reason: 400, sources: 1200, sender: 320, subject: 300, message: 6000, draft: 6000 } as const;

export interface TuningInput {
  agentName: string;
  agentVersion: number | null;
  reason: string;
  sources: string[];
  sender: string;
  subject: string;
  /** The message's text; null when it is held by the safety check (B-178) and is not quoted. */
  message: string | null;
  draft: string;
}

/** The person's own data, outside the fence (KIMI-44): the agent's settings and the knowledge entries the draft cited. */
export interface TuningContext {
  instructions?: string;
  replyPolicy?: string;
  knowledge?: { title: string; text: string }[];
}

/** The words of the tuning message, in the reader's language (the app passes them through `t`). */
export interface TuningWords {
  intro: string;
  preamble: string;
  instructions: string;
  policy: string;
  knowledge: string;
  agent: string;
  version: string;
  reason: string;
  sources: string;
  sender: string;
  subject: string;
  message: string;
  held: string;
  draft: string;
}

/**
 * The prepared, not sent, first message of a tuning session: our fixed words, the person's own agent settings and cited
 * knowledge outside the fence, and every variable part someone else wrote (sender, subject, source titles, the message,
 * the draft, the reason) inside one fenced block with a fresh random token (`fenceUntrusted`). A held message is never
 * quoted: the block says only that it is held.
 */
export function tuningMessage(input: TuningInput, context: TuningContext, words: TuningWords, token?: string): string {
  const outside: string[] = [words.intro];
  if (context.instructions) outside.push(`${words.instructions}\n${context.instructions}`);
  if (context.replyPolicy) outside.push(`${words.policy}\n${context.replyPolicy}`);
  if (context.knowledge?.length) outside.push(`${words.knowledge}\n${context.knowledge.map((k) => `- ${k.title}: ${k.text}`).join("\n")}`);
  const fields: FencedField[] = [
    { label: words.agent, value: input.agentName, max: TUNE_CAPS.agent },
    ...(input.agentVersion ? [{ label: words.version, value: String(input.agentVersion), max: 12 }] : []),
    { label: words.reason, value: input.reason, max: TUNE_CAPS.reason },
    { label: words.sources, value: input.sources.join("; "), max: TUNE_CAPS.sources },
    { label: words.sender, value: input.sender, max: TUNE_CAPS.sender },
    { label: words.subject, value: input.subject, max: TUNE_CAPS.subject },
    { label: words.message, value: input.message ?? words.held, max: TUNE_CAPS.message },
    { label: words.draft, value: input.draft, max: TUNE_CAPS.draft },
  ];
  return `${outside.join("\n\n")}\n\n${fenceUntrusted(fields, words.preamble, token)}`;
}
