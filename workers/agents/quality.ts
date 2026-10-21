// B-130 (support quality standard A1, A2, A5): one `support.quality_daily` event per agent address and
// closed UTC day, computed from the address's agent runs and the mail it received. Counts and codes
// only: never a sender, a subject, a message's words or an id of a person. A family or field this
// server cannot measure is named in `notMeasured` and is null, never 0.
import type { AgentRun } from "./run";

/** The payload schema of `data.value`, a copy of the shared standard's v2 kept in this repository. */
export const QUALITY_SCHEMA = "https://github.com/passioncode-ai/fabric-inbox/blob/main/docs/agents/support-quality-daily.schema.json";
export const RUBRIC_VERSION = "v1";
const DAY = 86_400_000;

type Count = number | null;
export interface QualityDaily {
  date: string;
  channel: string;
  rubricVersion: string;
  judgeModel: string | null;
  coverage: { coverageBasis: "inbound"; turns: Count; delivered: Count; undelivered: Count; firstReplyP50Ms: Count; firstReplyP90Ms: Count;
    repeatAsk: Count; agentRepeat: Count; followupsAnswered: Count; followupsPending: Count };
  quality: Record<"judged" | "questions" | "helpedYes" | "helpedPartly" | "helpedNo" | "languagePass" | "languageFail" | "addressedPass" | "addressedFail"
    | "policySafePass" | "policySafeFail" | "routingPass" | "routingFail" | "actionablePass" | "actionableFail" | "continuityPass" | "continuityFail", Count>;
  stability: { errors: Count; modelCalls: Count; modelCallsFailed: Count; fallbackTurns: Count; processErrors: Count; restarts: Count };
  autonomy: { answered: Count; toPersonPolicy: Count; toPersonInability: Count; limitReplies: Count; smalltalk: Count;
    personQueueWaiting: Count; personQueueOldestMs: Count; noSafeDefault: Count };
  notMeasured: string[];
}

/** The schema's channel for a mail address: `mail:<domain>:<local part>`, other characters as "-". */
export function mailChannel(address: string): string {
  const at = address.lastIndexOf("@");
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `mail:${clean(address.slice(at + 1))}:${clean(address.slice(0, at))}`.slice(0, 81);
}

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
};
const subjectKey = (subject: string) => subject.toLowerCase().replace(/^(\s*(re|fwd?|aw|wg|отв|пересл)\s*:\s*)+/i, "").trim();

/** When a run's first reply left: its waiting reply, or the answer it sent; null while none did. */
export function firstReplyAt(run: AgentRun): number | null {
  // A run sent before `repliedAt` existed (2026-10-19) was saved as sent at its last update: that is its reply time.
  const replied = run.repliedAt ?? (run.status === "sent" && run.sent ? run.updatedAt : undefined);
  const times = [run.acknowledged?.status === "accepted" ? Date.parse(run.acknowledged.at) : NaN, replied ? Date.parse(replied) : NaN]
    .filter((t) => Number.isFinite(t));
  return times.length ? Math.min(...times) : null;
}

export interface QualityInput {
  address: string;
  /** The closed UTC day, YYYY-MM-DD. */
  day: string;
  /** Messages the address received that day (spam apart); null when the mailbox could not be read. */
  received: number | null;
  /** Every run of the address created from a week before the day to now (repeats look back, queues look at now). */
  runs: AgentRun[];
  /** The reply mode of an agent version, "draft" or "auto"; unknown counts as auto. */
  modeOf: (run: AgentRun) => "draft" | "auto";
  /** The judge's results for the day (B-132), or null when nothing was judged. */
  judged?: { model: string; quality: QualityDaily["quality"] } | null;
  now: number;
}

/** The day's event value for one address. Pure: every count comes from the input. */
export function qualityDay(input: QualityInput): QualityDaily {
  const start = Date.parse(`${input.day}T00:00:00.000Z`), end = start + DAY;
  const created = (r: AgentRun) => Date.parse(r.createdAt);
  const ofDay = input.runs.filter((r) => created(r) >= start && created(r) < end);
  const notMeasured = new Set<string>(["smalltalk", "processErrors", "restarts"]);
  const replies = ofDay.flatMap((r) => {
    const at = firstReplyAt(r);
    const from = Date.parse(r.receivedAt ?? r.createdAt);
    return at !== null && Number.isFinite(from) ? [Math.max(0, at - from)] : [];
  });
  // A person writing the same thing again within a day, to the same address.
  const repeatAsk = ofDay.filter((r) => input.runs.some((o) => o.id !== r.id && created(o) < created(r) && created(r) - created(o) <= DAY
    && o.sender && o.sender.toLowerCase() === r.sender.toLowerCase() && subjectKey(o.subject) === subjectKey(r.subject))).length;
  // The agent sending a reply it already sent to the same person within a week.
  const agentRepeat = ofDay.filter((r) => r.sent?.body && input.runs.some((o) => o.id !== r.id && o.sent && created(o) < created(r)
    && created(r) - created(o) <= 7 * DAY && o.sent.to.toLowerCase() === r.sent!.to.toLowerCase() && o.sent.body === r.sent!.body)).length;
  const repliedOnDay = (r: AgentRun) => { const t = r.repliedAt ? Date.parse(r.repliedAt) : NaN; return t >= start && t < end; };
  const followupsAnswered = input.runs.filter((r) => r.status === "sent" && (r.attempt ?? 1) > 1 && created(r) < start && repliedOnDay(r)).length;
  const recent = input.runs.filter((r) => input.now - created(r) <= 3 * DAY);
  const waiting = recent.filter((r) => r.status === "held" || (r.status === "drafted" && !r.answeredByPerson));
  const metered = ofDay.filter((r) => r.modelCalls);
  const usedModel = ofDay.filter((r) => r.toolCalls !== undefined && r.status !== "skipped" && r.status !== "off");
  if (metered.length < usedModel.filter((r) => r.model).length) notMeasured.add("modelCalls").add("modelCallsFailed").add("fallbackTurns");
  if (input.received === null) notMeasured.add("turns");
  const judged = input.judged ?? null;
  if (!judged) notMeasured.add("quality");
  const nullQuality = Object.fromEntries(["judged", "questions", "helpedYes", "helpedPartly", "helpedNo", "languagePass", "languageFail", "addressedPass",
    "addressedFail", "policySafePass", "policySafeFail", "routingPass", "routingFail", "actionablePass", "actionableFail", "continuityPass", "continuityFail"]
    .map((k) => [k, null])) as QualityDaily["quality"];
  const sum = (f: (r: AgentRun) => number) => ofDay.reduce((n, r) => n + f(r), 0);
  const modelMeasured = !notMeasured.has("modelCalls");
  return {
    date: input.day, channel: mailChannel(input.address), rubricVersion: RUBRIC_VERSION, judgeModel: judged?.model ?? null,
    coverage: {
      coverageBasis: "inbound", turns: input.received,
      delivered: ofDay.filter((r) => firstReplyAt(r) !== null).length,
      undelivered: ofDay.filter((r) => r.status === "send_failed" || r.status === "send_unknown").length,
      firstReplyP50Ms: percentile(replies, 50), firstReplyP90Ms: percentile(replies, 90),
      repeatAsk, agentRepeat, followupsAnswered,
      followupsPending: input.runs.filter((r) => r.status === "held").length,
    },
    quality: judged?.quality ?? nullQuality,
    stability: {
      errors: ofDay.filter((r) => r.status === "failed" || r.status === "interrupted").length,
      modelCalls: modelMeasured ? sum((r) => r.modelCalls?.calls ?? 0) : null,
      modelCallsFailed: modelMeasured ? sum((r) => r.modelCalls?.failed ?? 0) : null,
      fallbackTurns: modelMeasured ? ofDay.filter((r) => (r.modelCalls?.recovered ?? 0) > 0).length : null,
      processErrors: null, restarts: null,
    },
    autonomy: {
      answered: ofDay.filter((r) => r.status === "sent" && !r.handoff && !r.fallback).length,
      toPersonPolicy: ofDay.filter((r) => r.handoff || (r.status === "drafted" && !r.limited && input.modeOf(r) === "draft")).length,
      toPersonInability: ofDay.filter((r) => !r.handoff && (r.status === "held" || (r.status === "drafted" && !r.limited && input.modeOf(r) === "auto"))).length,
      limitReplies: ofDay.filter((r) => r.limited).length,
      smalltalk: null,
      personQueueWaiting: waiting.length,
      personQueueOldestMs: waiting.length ? Math.max(0, input.now - Math.min(...waiting.map(created))) : null,
      noSafeDefault: ofDay.filter((r) => r.status === "drafted" && r.escalatedAt && !r.answeredByPerson).length,
    },
    notMeasured: [...notMeasured].sort(),
  };
}
