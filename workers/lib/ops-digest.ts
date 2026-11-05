/**
 * B-205 (Fabric's ADR-0188, the contract's draft DEC-0153): the server's operations folded into `ops.digest.hourly@1`
 * and `ops.digest.daily@1`, on read from the ledger's `ops_hourly` rows; never by a timer. The fold and the rise rule
 * are Fabric's (apps/desktop/src/shared/opsDigest.ts, e1eecec0), the same as the Mac app's (desktop/ops-digest.cjs).
 * Counts only.
 */
export interface OpCount { op: string; ok: number; failed: number; unknown: number }
export interface HourlyDigest {
  schema: "ops.digest.hourly@1"; from: string; to: string; ops: OpCount[];
  total: { ok: number; failed: number; unknown: number }; risen: { op: string; failed: number; previous: number }[];
}
export interface DailyDigest {
  schema: "ops.digest.daily@1"; day: string; hours: number; ops: OpCount[];
  total: { ok: number; failed: number; unknown: number }; risen: { op: string; hours: number; failed: number }[];
}
export interface HourRow extends OpCount { hour: string }

/** A failure count is a rise when it is at least this many in the hour, and at least twice the previous hour's. */
export const RISE_MIN_FAILED = 10;
export const RISE_FACTOR = 2;
const HOUR_MS = 3_600_000;
/** DEC-0153 OD-3: a UTC day keeps at most this many operation names; the rest are counted under OVERFLOW_OP (B-213). */
export const MAX_NAMED_OPS = 4095;
/** The overflow name, published with the outcome map in docs/architecture.md ("The Mac app's log digests"); the Mac app uses the same. */
export const OVERFLOW_OP = "ops_overflow";

/**
 * A day's rows with at most MAX_NAMED_OPS names: the first in code-unit order keep theirs, every other operation is
 * summed under OVERFLOW_OP in its hour, its counts kept. Rows within the limit come back as they were.
 */
export function capNames<T extends OpCount & { hour: string }>(rows: T[]): T[] {
  const names = [...new Set(rows.map((r) => r.op))].sort();
  if (names.length <= MAX_NAMED_OPS) return rows;
  const kept = new Set(names.filter((n) => n !== OVERFLOW_OP).slice(0, MAX_NAMED_OPS));
  const out: T[] = [];
  const over = new Map<string, T>();
  for (const r of rows) {
    if (kept.has(r.op)) { out.push(r); continue; }
    const o = over.get(r.hour) ?? ({ ...r, op: OVERFLOW_OP, ok: 0, failed: 0, unknown: 0 } as T);
    o.ok += r.ok; o.failed += r.failed; o.unknown += r.unknown;
    over.set(r.hour, o);
  }
  return [...out, ...over.values()];
}

const byName = (a: OpCount, b: OpCount) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0);
const sum = (ops: OpCount[]) => ops.reduce((t, c) => ({ ok: t.ok + c.ok, failed: t.failed + c.failed, unknown: t.unknown + c.unknown }), { ok: 0, failed: 0, unknown: 0 });
const start = (hour: string) => Date.parse(`${hour}:00:00.000Z`);

/** One hour (`YYYY-MM-DDTHH`) from its rows; `previous` is the hour just before's rows (empty when none). */
export function foldHour(hour: string, rows: OpCount[], previous: OpCount[]): HourlyDigest {
  const from = start(hour);
  const ops = rows.map(({ op, ok, failed, unknown }) => ({ op, ok, failed, unknown })).sort(byName);
  const prevOf = new Map(previous.map((c) => [c.op, c.failed]));
  const risen = ops.filter((c) => c.failed >= RISE_MIN_FAILED && c.failed >= RISE_FACTOR * Math.max(1, prevOf.get(c.op) ?? 0))
    .map((c) => ({ op: c.op, failed: c.failed, previous: prevOf.get(c.op) ?? 0 }));
  return { schema: "ops.digest.hourly@1", from: new Date(from).toISOString(), to: new Date(from + HOUR_MS).toISOString(), ops, total: sum(ops), risen };
}

/** One UTC day (`YYYY-MM-DD`) from its hours' rows, each hour folded against the hour just before it (`before`: the
 *  previous day's 23rd hour, when known). A gap compares with nothing. */
export function foldDay(day: string, given: HourRow[], before: OpCount[] = []): DailyDigest | null {
  // OD-5: an hour's counts are folded once; a second row of one hour and operation (never in the ledger, whose key is
  // the pair) is left out, the first kept.
  const seen = new Set<string>();
  const rows = capNames(given.filter((r) => r.hour.startsWith(day) && !seen.has(`${r.hour}|${r.op}`) && !!seen.add(`${r.hour}|${r.op}`)));
  const hours = [...new Set(rows.map((r) => r.hour))].filter((h) => h.startsWith(day)).sort();
  // The contract's daily digest folds 1 to 24 hours (DEC-0153 `hours`); a day with nothing counted has none to fold.
  if (hours.length === 0) return null;
  const all = new Map<string, OpCount>(), rose = new Map<string, { hours: number; failed: number }>();
  let previous = { at: start(`${day}T00`) - HOUR_MS, rows: before };
  for (const hour of hours) {
    const mine = rows.filter((r) => r.hour === hour);
    const h = foldHour(hour, mine, previous.at + HOUR_MS === start(hour) ? previous.rows : []);
    for (const c of h.ops) { const s = all.get(c.op) ?? { op: c.op, ok: 0, failed: 0, unknown: 0 }; s.ok += c.ok; s.failed += c.failed; s.unknown += c.unknown; all.set(c.op, s); }
    for (const r of h.risen) { const x = rose.get(r.op) ?? { hours: 0, failed: 0 }; x.hours++; x.failed += r.failed; rose.set(r.op, x); }
    previous = { at: start(hour), rows: mine };
  }
  const ops = [...all.values()].sort(byName);
  const risen = [...rose.entries()].map(([op, x]) => ({ op, ...x })).sort((a, b) => b.failed - a.failed || (a.op < b.op ? -1 : 1));
  return { schema: "ops.digest.daily@1", day, hours: hours.length, ops, total: sum(ops), risen };
}

/** A closed UTC hour `YYYY-MM-DDTHH` of the last 14 days, or null. */
export function closedHour(raw: string | undefined, now = Date.now()): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(raw) || Number.isNaN(start(raw))) return null;
  return start(raw) + HOUR_MS <= now && start(raw) >= now - 14 * 86_400_000 ? raw : null;
}

/** A closed UTC day `YYYY-MM-DD` of the last 14 days, or null. Default: yesterday. */
export function closedDay(raw: string | undefined, now = Date.now()): string | null {
  const day = raw ?? new Date(now - 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return t + 86_400_000 <= now && t >= now - 14 * 86_400_000 ? day : null;
}
