// B-189: the daily quality judge measured against a person. A person grades sent answers on the judge's
// own rubric; the calibration compares the two per check. Packet: docs/app-store/tasks/2026-10-27-judge-calibration.md.
import { CHECKS, RUBRIC, type Check, type JudgeVerdict, type Mark } from "./judge";
import type { AgentRun } from "./run";
import { msg } from "../../shared/i18n";

export type Helped = JudgeVerdict["helped"];
export interface PersonGrade {
  rubric: string;
  checks: Record<Check, Mark>;
  helped: Helped;
  note?: string;
  /** The person's email, or `key:…` for a grade an agent key relayed. */
  by: string;
  /** person: a signed-in person graded; relayed: an agent key recorded a person's grade from `source`. */
  kind: "person" | "relayed";
  /** Where the person gave a relayed grade (a chat, a thread). */
  source?: string;
  at: string;
}

export const NOTE_CHARS = 200;
export const SOURCE_CHARS = 300;
/** Fewer pairs than this for a check is a number, not yet a verdict. */
export const SMALL_BELOW = 20;
const MARKS: readonly Mark[] = ["PASS", "FAIL", "NA"];
const HELPED: readonly Helped[] = ["yes", "partly", "no", "na"];

/** A grade from a request body, or the reason it is refused. */
export function parseGrade(body: unknown, actor: string | null, now = Date.now()):
  { ok: true; grade: PersonGrade } | { ok: false; error: ReturnType<typeof msg> } {
  if (!actor) return { ok: false, error: msg("A grade needs a signed-in person or an agent key") };
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const raw = (b.checks && typeof b.checks === "object" ? b.checks : {}) as Record<string, unknown>;
  const checks = {} as Record<Check, Mark>;
  for (const c of CHECKS) {
    const mark = String(raw[c] ?? "").toUpperCase() as Mark;
    if (!MARKS.includes(mark)) return { ok: false, error: msg("A grade marks every check PASS, FAIL or NA") };
    checks[c] = mark;
  }
  const helped = String(b.helped ?? "").toLowerCase() as Helped;
  if (!HELPED.includes(helped)) return { ok: false, error: msg("helped is one of yes, partly, no or na") };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > NOTE_CHARS) return { ok: false, error: msg("The note is at most 200 characters") };
  const relayed = actor.startsWith("key:");
  const source = typeof b.source === "string" ? b.source.trim() : "";
  if (relayed && !source) return { ok: false, error: msg("An agent key records a person's grade: name where the person gave it in source") };
  if (source.length > SOURCE_CHARS) return { ok: false, error: msg("The source is at most 300 characters") };
  return { ok: true, grade: { rubric: RUBRIC, checks, helped, ...(note ? { note } : {}), by: actor, kind: relayed ? "relayed" : "person",
    ...(source ? { source } : {}), at: new Date(now).toISOString() } };
}

export interface Agreement {
  /** Pairs where neither side marked it not applicable. */
  pairs: number;
  agree: number;
  /** checks: the judge passed what the person failed; helped: the judge said it helped more. */
  judgeHigher: number;
  judgeLower: number;
  /** One side marked it not applicable and the other did not. */
  naDiffers: number;
  rate: number | null;
  /** Cohen's kappa over the pairs; null when it is undefined (no pairs, or one category only on both sides). */
  kappa: number | null;
  small: boolean;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Agreement of (judge, person) marks; `order` ranks the categories, `na` is the not-applicable mark. */
export function agreementOf(marks: [string, string][], order: readonly string[], na: string): Agreement {
  const pairs = marks.filter(([j, p]) => j !== na && p !== na);
  const naDiffers = marks.filter(([j, p]) => (j === na) !== (p === na)).length;
  const rank = (m: string) => order.indexOf(m);
  const agree = pairs.filter(([j, p]) => j === p).length;
  const judgeHigher = pairs.filter(([j, p]) => rank(j) < rank(p)).length;
  const judgeLower = pairs.filter(([j, p]) => rank(j) > rank(p)).length;
  const n = pairs.length;
  let kappa: number | null = null;
  if (n) {
    const po = agree / n;
    const cats = [...new Set(pairs.flat())];
    const pe = cats.reduce((sum, k) => sum + (pairs.filter(([j]) => j === k).length / n) * (pairs.filter(([, p]) => p === k).length / n), 0);
    kappa = pe < 1 ? round((po - pe) / (1 - pe)) : null;
  }
  return { pairs: n, agree, judgeHigher, judgeLower, naDiffers, rate: n ? round(agree / n) : null, kappa, small: n < SMALL_BELOW };
}

export interface Calibration {
  rubric: string;
  /** Runs with both a judge verdict and a person's grade of this rubric. */
  graded: number;
  byPerson: number;
  relayed: number;
  /** Runs a person graded that the judge has not judged (they cannot be compared). */
  notJudged: number;
  checks: Record<Check, Agreement>;
  helped: Agreement;
  judgeModels: string[];
}

/** The calibration over runs: each one with a judge verdict and a person's grade of the current rubric is a pair. */
export function calibrationOf(runs: Pick<AgentRun, "judgement" | "personGrade">[]): Calibration {
  const graded = runs.filter((r) => r.personGrade?.rubric === RUBRIC);
  const both = graded.filter((r) => r.judgement?.rubric === RUBRIC) as Required<Pick<AgentRun, "judgement" | "personGrade">>[];
  const checks = {} as Record<Check, Agreement>;
  for (const c of CHECKS) checks[c] = agreementOf(both.map((r) => [r.judgement.checks[c], r.personGrade.checks[c]]), ["PASS", "FAIL"], "NA");
  return {
    rubric: RUBRIC,
    graded: both.length,
    byPerson: both.filter((r) => r.personGrade.kind === "person").length,
    relayed: both.filter((r) => r.personGrade.kind === "relayed").length,
    notJudged: graded.length - both.length,
    checks,
    helped: agreementOf(both.map((r) => [r.judgement.helped, r.personGrade.helped]), ["yes", "partly", "no"], "na"),
    judgeModels: [...new Set(both.map((r) => r.judgement.model))].sort(),
  };
}
