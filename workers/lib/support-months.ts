// B-208: a mailbox's support work per month, counts only (docs/evidence/backlog.md B-208): threads received, the
// first answer by a reply agent or by a person, and the median time to it. A thread's month is its first incoming
// message's; its first answer is the first message sent after it that is not an agent's holding reply. Who sent it is
// the outbox's idempotency key, as `sentByIds` reads it (B-138): `agent-...` is an agent, anything else a person.

/** One thread as the mailbox reads it: its first incoming message and its first answer, if any. */
export interface ThreadRow {
  firstIn: string;
  firstReply: string | null;
  /** The outbox key of the first answer; null for a person's message sent outside the outbox. */
  replyKey: string | null;
}

export interface SupportMonth {
  month: string;
  threads: number;
  answeredByAgent: number;
  answeredByPerson: number;
  unanswered: number;
  /** Minutes from the first incoming message to the first answer, the median over the answered threads; null when none. */
  medianFirstReplyMinutes: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

export const byAgent = (key: string | null) => !!key && key.startsWith("agent-");

export function foldMonths(rows: ThreadRow[]): SupportMonth[] {
  const months = new Map<string, { threads: number; agent: number; person: number; waits: number[] }>();
  for (const r of rows) {
    const at = Date.parse(r.firstIn);
    if (!Number.isFinite(at)) continue;
    const month = new Date(at).toISOString().slice(0, 7);
    const m = months.get(month) ?? { threads: 0, agent: 0, person: 0, waits: [] };
    m.threads++;
    const replied = r.firstReply ? Date.parse(r.firstReply) : NaN;
    if (Number.isFinite(replied) && replied >= at) {
      if (byAgent(r.replyKey)) m.agent++; else m.person++;
      m.waits.push((replied - at) / 60_000);
    }
    months.set(month, m);
  }
  return [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, m]) => ({
    month, threads: m.threads, answeredByAgent: m.agent, answeredByPerson: m.person, unanswered: m.threads - m.agent - m.person,
    medianFirstReplyMinutes: median(m.waits),
  }));
}
