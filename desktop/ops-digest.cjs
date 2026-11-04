'use strict';
// B-205 (Fabric's ADR-0188, the operator's words of 2026-11-04 relayed on board thread f7758225): the app reads its own
// log. Every log event that carries an `outcome` is counted by its `event` and outcome in the hour it happened; when an
// event of a later hour arrives, each closed hour folds into one `ops.digest.hourly@1` line and each closed UTC day into
// one `ops.digest.daily@1` line, under `<userData>/digests/`. The fold is Fabric's (apps/desktop/src/shared/opsDigest.ts,
// e1eecec0). No timer: an idle app writes nothing, and the hour still open when it quits is not written. Counts only:
// no detail, path or identifier of the event leaves it.
const path = require('node:path');

const HOUR_MS = 60 * 60_000;
/** A failure count is a rise when it is at least this many in the hour, and at least twice the previous hour's. */
const RISE_MIN_FAILED = 10;
const RISE_FACTOR = 2;
const OP = /^[a-z][a-z0-9_]{0,63}$/;

/** How an event's outcome is counted: a failure, unknown, or ok. */
function outcomeOf(outcome) {
  const o = String(outcome);
  if (o === 'unknown') return 'unknown';
  return /fail|^not_|_not_|lost|unparsed|refused/.test(o) ? 'failed' : 'ok';
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

/** The day's hourly digests folded into one. */
function foldDay(day, hourly) {
  const mine = hourly.filter((h) => h.from.slice(0, 10) === day);
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
  let dayHours = [];          // the hourly digests of the open day
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
      dayHours.push(h);
      append(`hourly-${h.from.slice(0, 7)}.jsonl`, h);
      for (const r of h.risen) log({ event: 'failures_rose', op: r.op, failed: r.failed, previous: r.previous });
    }
    const day = new Date(hour).toISOString().slice(0, 10);
    if (new Date(nextHour).toISOString().slice(0, 10) !== day && dayHours.length) {
      append(`daily-${day.slice(0, 7)}.jsonl`, foldDay(day, dayHours));
      dayHours = [];
    }
    counts = new Map();
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

  return { count, flush: () => queue };
}

module.exports = { createDigest, foldHour, foldDay, outcomeOf, RISE_MIN_FAILED, RISE_FACTOR };
