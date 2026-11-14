/**
 * A-11 (S02, S03, S04): the safety colour of every cell of a conversation, not only the open one. One
 * `POST /api/safety/lookup` already answers every message of the thread; a cell with no record, or one checked against
 * an older phishing list, is checked now as the open message is (deterministic, no model), at most `cap` of them. A cell
 * then marks amber or red with its word, and its links ask or open by its own record, as the open message's do.
 *
 * Plain module, no React and no aliases: tests load it as the app does.
 */
import { colourOf, type CheckedLink, type SafetyColour, type SafetyLikeRecord } from "../../../shared/mail/safety";

export interface CellSafety {
  colour: SafetyColour;
  links: CheckedLink[];
}

export interface LookupAnswer {
  records?: Record<string, SafetyLikeRecord>;
  feedVersion?: number | null;
  unavailable?: boolean;
}

/** Cells rechecked at most per conversation opened: a long thread stays light. */
export const CELL_CHECKS = 10;

/**
 * Each message's colour and checked links, by provider message id (the open one too: the answer is kept while the
 * person moves within the conversation, and the cell they leave keeps its colour). A check that fails leaves its cell
 * grey (its links ask); an unavailable lookup checks nothing.
 */
export async function threadCellSafety(
  account: string,
  ids: readonly string[],
  looked: LookupAnswer,
  check: (messageId: string) => Promise<{ record?: SafetyLikeRecord | null; feedVersion?: number | null } | null>,
  cap = CELL_CHECKS,
): Promise<Record<string, CellSafety>> {
  const key = (id: string) => `${account.toLowerCase()}|${id}`;
  let feed = looked.feedVersion ?? null;
  const records = new Map<string, SafetyLikeRecord>();
  for (const id of ids) { const r = looked.records?.[key(id)]; if (r) records.set(id, r); }
  const stale = (r: SafetyLikeRecord | undefined) => !r?.findings.check || (feed !== null && (r.findings.check.feedVersion ?? -1) < feed);
  const due = looked.unavailable ? [] : ids.filter((id) => stale(records.get(id))).slice(0, cap);
  const checked = await Promise.all(due.map((id) => check(id).catch(() => null)));
  due.forEach((id, i) => {
    const answer = checked[i];
    if (answer?.record) { records.set(id, answer.record); if (answer.feedVersion != null && (feed === null || answer.feedVersion > feed)) feed = answer.feedVersion; }
  });
  const out: Record<string, CellSafety> = {};
  for (const id of ids) {
    const record = records.get(id) ?? null;
    out[id] = { colour: colourOf(record, feed), links: record?.findings.check?.links ?? [] };
  }
  return out;
}
