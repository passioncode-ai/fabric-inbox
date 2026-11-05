'use strict';
// B-205 (Fabric's ADR-0188, the operator's words of 2026-11-04 relayed on board thread f7758225): the app reads its own
// log. Every log event that carries an `outcome` is counted by its `event` and outcome in the hour it happened; when an
// event of a later hour arrives, each closed hour folds into one `ops.digest.hourly@1` line, under `<userData>/digests/`.
// Each closed UTC day is folded from that hourly file into one `ops.digest.daily@1` line, the first line of an hour once,
// when a day closes and at every start (DEC-0153 OD-5, B-212): a day the app was not running at midnight gets its line
// at the next run, a day with no hour gets none, and no day gets two. The fold is Fabric's
// (apps/desktop/src/shared/opsDigest.ts, e1eecec0). No timer: an idle app writes nothing, and the hour still open when
// it quits is not written. Counts only: no detail, path or identifier of the event leaves it.
const path = require('node:path');

const HOUR_MS = 60 * 60_000;
/** A failure count is a rise when it is at least this many in the hour, and at least twice the previous hour's. */
const RISE_MIN_FAILED = 10;
const RISE_FACTOR = 2;
const OP = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * How the log's own outcomes are counted (DEC-0153 OD-3, a product's published map, B-212; docs/ANALYTICS.md, "Log
 * digests"): `ok` when the operation did what it was asked, `failed` when it tried and could not, `unknown` for a
 * skip, a person's choice, a setup or policy answer, and any outcome not named here, so an unfinished setup never
 * makes a rise. An outcome ending in `_failed` is a failure.
 */
const OUTCOME_OK = new Set(['ok', 'done', 'ready', 'started', 'running', 'connected', 'current', 'newer', 'older', 'installed',
  'verified', 'downloading', 'requested', 'handed_over', 'ended', 'on', 'off', 'left', 'stayed']);
const OUTCOME_FAILED = new Set(['failed', 'lost', 'unparsed', 'timeout', 'not_saved', 'not_written', 'storage_not_cleared',
  'directory_not_removed', 'leftovers']);
function outcomeOf(outcome) {
  const o = String(outcome);
  if (OUTCOME_OK.has(o)) return 'ok';
  if (OUTCOME_FAILED.has(o) || o.endsWith('_failed')) return 'failed';
  return 'unknown';
}

const hourStart = (at) => Math.floor(at / HOUR_MS) * HOUR_MS;
const byName = (a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0);
const sum = (ops) => ops.reduce((t, c) => ({ ok: t.ok + c.ok, failed: t.failed + c.failed, unknown: t.unknown + c.unknown }), { ok: 0, failed: 0, unknown: 0 });

/** One closed hour: its counts, and the rises against the hour just before (a gap compares with nothing). */
function foldHour(counts, from, previous) {
  const ops = [...counts.entries()].map(([op, c]) => ({ op, ...c })).sort(byName);
  const prevOf = new Map((previous && Date.parse(previous.to) === from ? previous.ops : []).map((c) => [c.op, c.failed]));
  const risen = ops.filter((c) => c.failed >= RISE_MIN_FAILED && c.failed >= RISE_FACTOR * Math.max(1, prevOf.get(c.op) ?? 0))
    .map((c) => ({ op: c.op, failed: c.failed, previous: prevOf.get(c.op) ?? 0 }));
  return { schema: 'ops.digest.hourly@1', from: new Date(from).toISOString(), to: new Date(from + HOUR_MS).toISOString(), ops, total: sum(ops), risen };
}

/** The day's hourly digests folded into one, the first line of an hour once; null for a day with no hour (OD-5). */
function foldDay(day, hourly) {
  const seen = new Set();
  const mine = hourly.filter((h) => h.from.slice(0, 10) === day && !seen.has(h.from) && seen.add(h.from))
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  if (!mine.length) return null;
  const all = new Map(), rose = new Map();
  for (const h of mine) {
    for (const c of h.ops) { const s = all.get(c.op) ?? { op: c.op, ok: 0, failed: 0, unknown: 0 }; s.ok += c.ok; s.failed += c.failed; s.unknown += c.unknown; all.set(c.op, s); }
    for (const r of h.risen) { const x = rose.get(r.op) ?? { hours: 0, failed: 0 }; x.hours++; x.failed += r.failed; rose.set(r.op, x); }
  }
  const ops = [...all.values()].sort(byName);
  const risen = [...rose.entries()].map(([op, x]) => ({ op, ...x })).sort((a, b) => b.failed - a.failed || (a.op < b.op ? -1 : 1));
  return { schema: 'ops.digest.daily@1', day, hours: mine.length, ops, total: sum(ops), risen };
}

/**
 * deps: { fs (node:fs/promises), dir (`<userData>/digests`), log (optional, for a rise: one `failures_rose` line) }
 * → { count(event, at) }: counts one log event; writes the digests of hours and days that closed before `at`.
 */
function createDigest({ fs, dir, log = () => {} }) {
  let hour = null;            // the open hour's start
  let counts = new Map();     // op → { ok, failed, unknown }
  let last = null;            // the last hourly digest written
  let queue = Promise.resolve();

  const append = (file, value) => {
    queue = queue.then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.appendFile(path.join(dir, file), JSON.stringify(value) + '\n', { mode: 0o600 });
    }).catch(() => {});
    return queue;
  };

  function close(nextHour) {
    if (hour === null) return;
    if (counts.size) {
      const h = foldHour(counts, hour, last);
      last = h;
      append(`hourly-${h.from.slice(0, 7)}.jsonl`, h);
      for (const r of h.risen) log({ event: 'failures_rose', op: r.op, failed: r.failed, previous: r.previous });
    }
    if (new Date(nextHour).toISOString().slice(0, 10) !== new Date(hour).toISOString().slice(0, 10)) catchUp(nextHour);
    counts = new Map();
  }

  const lines = async (file) => {
    try {
      return (await fs.readFile(path.join(dir, file), 'utf8')).split('\n').flatMap((line) => {
        try { return line ? [JSON.parse(line)] : []; } catch { return []; }
      });
    } catch { return []; }
  };

  /**
   * OD-5's catch-up: every closed UTC day of this month and the last that has hourly lines and no daily line gets its
   * daily line now, folded from the hourly file. Queued behind the writes, so a day closing now is read with its last hour.
   */
  function catchUp(now = Date.now()) {
    queue = queue.then(async () => {
      const today = new Date(now).toISOString().slice(0, 10);
      const first = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      const months = [new Date(first.getTime() - 86_400_000).toISOString().slice(0, 7), today.slice(0, 7)];
      for (const month of months) {
        const done = new Set((await lines(`daily-${month}.jsonl`)).map((d) => d && d.day));
        const hourly = (await lines(`hourly-${month}.jsonl`)).filter((h) => h && h.schema === 'ops.digest.hourly@1' && typeof h.from === 'string');
        const days = [...new Set(hourly.map((h) => h.from.slice(0, 10)))].filter((d) => d < today && !done.has(d)).sort();
        for (const day of days) {
          const digest = foldDay(day, hourly);
          if (!digest) continue;
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          await fs.appendFile(path.join(dir, `daily-${month}.jsonl`), JSON.stringify(digest) + '\n', { mode: 0o600 });
        }
      }
    }).catch(() => {});
    return queue;
  }

  function count(event, at = Date.now()) {
    if (!event || typeof event.event !== 'string' || event.outcome === undefined || !OP.test(event.event)) return;
    const h = hourStart(at);
    if (hour !== null && h !== hour) close(h);
    hour = h;
    const c = counts.get(event.event) ?? { ok: 0, failed: 0, unknown: 0 };
    c[outcomeOf(event.outcome)]++;
    counts.set(event.event, c);
  }

  return { count, catchUp, flush: () => queue };
}

module.exports = { createDigest, foldHour, foldDay, outcomeOf, RISE_MIN_FAILED, RISE_FACTOR };
