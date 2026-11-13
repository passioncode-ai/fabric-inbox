'use strict';
// B-205 (Fabric's ADR-0188, the operator's words of 2026-11-04 relayed on board thread f7758225): the app reads its own
// log. Every log event that carries an `outcome` is counted by its `event` and outcome in the hour it happened; when an
// event of a later hour arrives, each closed hour folds into one `ops.digest.hourly@1` line, under `<userData>/digests/`.
// Each closed UTC day is folded from that hourly file into one `ops.digest.daily@1` line, the first line of an hour once,
// when a day closes and at every start (DEC-0153 OD-5, B-212): a day the app was not running at midnight gets its line
// at the next run, a day with no hour gets none, and no day gets two. The fold is Fabric's
// (apps/desktop/src/shared/opsDigest.ts, e1eecec0). No timer: an hour is written only when a log line was seen in it
// (OD-1: a sleep is not a run), even with nothing counted. B-213 (OD-1): the hour open at quit is kept with its counts
// (`open-hour.json`) and written at the next start once it has closed, before any day is folded; a start in the same
// hour goes on counting it. At start the last hourly line is read back for `previous` and the day's named operations are
// rebuilt; past MAX_NAMED_OPS names in a UTC day the rest are counted under OVERFLOW_OP (OD-3, published in
// docs/architecture.md). Counts only: no detail, path or identifier of the event leaves it.
const path = require('node:path');

const HOUR_MS = 60 * 60_000;
/** A failure count is a rise when it is at least this many in the hour, and at least twice the previous hour's. */
const RISE_MIN_FAILED = 10;
const RISE_FACTOR = 2;
const OP = /^[a-z][a-z0-9_]{0,63}$/;
/** OD-3: a UTC day keeps at most this many operation names; every other operation is counted under OVERFLOW_OP. */
const MAX_NAMED_OPS = 4095;
const OVERFLOW_OP = 'ops_overflow';
/** At most this many operations in a line (DEC-0153); a fold past it writes nothing, never a line readers skip. */
const MAX_OPS = MAX_NAMED_OPS + 1;
/** B-213: the hour open at quit, kept until the next start writes it. */
const OPEN_FILE = 'open-hour.json';

/**
 * How the log's own outcomes are counted (DEC-0153 OD-3, a product's published map, B-212; docs/architecture.md, "The
 * Mac app's log digests"): `ok` when the operation did what it was asked, `failed` when it tried and could not, `unknown` for a
 * skip, a person's choice, a setup or policy answer, and any outcome not named here, so an unfinished setup never
 * makes a rise. An outcome ending in `_failed` is a failure.
 */
const OUTCOME_OK = new Set(['ok', 'done', 'ready', 'started', 'running', 'connected', 'current', 'newer', 'older', 'installed',
  'verified', 'downloading', 'requested', 'handed_over', 'ended', 'on', 'off', 'left', 'stayed', 'superseded', 'applied',
  // B-236: a server link that added a server, or showed one already held.
  'added', 'shown',
  // B-261: a quiet console session that has output or input again (`quiet` itself is unknown on purpose).
  'active']);
const OUTCOME_FAILED = new Set(['failed', 'lost', 'unparsed', 'timeout', 'not_saved', 'not_written', 'storage_not_cleared',
  'directory_not_removed', 'leftovers', 'not_watched']);
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
  if (ops.length > MAX_OPS) return null;
  const risen = [...rose.entries()].map(([op, x]) => ({ op, ...x })).sort((a, b) => b.failed - a.failed || (a.op < b.op ? -1 : 1));
  return { schema: 'ops.digest.daily@1', day, hours: mine.length, ops, total: sum(ops), risen };
}

/**
 * deps: { fs (node:fs/promises), dir (`<userData>/digests`), log (optional, for a rise: one `failures_rose` line),
 * fsSync (node:fs, for `hold` at quit) }
 * → { count(event, at), start(now), hold(), catchUp(now), flush() }: counts one log event; writes the digests of hours
 * and days that closed before `at`.
 */
function createDigest({ fs, dir, log = () => {}, fsSync = null }) {
  let hour = null;            // the open hour's start: an hour a log line was seen in
  let counts = new Map();     // op → { ok, failed, unknown }
  let last = null;            // the last hourly digest written, or read back at start
  let namesDay = null;        // the UTC day `names` holds
  let names = new Set();      // the day's named operations (OD-3)
  let queue = Promise.resolve();

  const run = (step) => { queue = queue.then(step).catch(() => {}); return queue; };
  const write = async (file, value) => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(dir, file), JSON.stringify(value) + '\n', { mode: 0o600 });
  };
  const lines = async (file) => {
    try {
      return (await fs.readFile(path.join(dir, file), 'utf8')).split('\n').flatMap((line) => {
        try { return line ? [JSON.parse(line)] : []; } catch { return []; }
      });
    } catch { return []; }
  };
  const hourlyOf = async (month) => (await lines(`hourly-${month}.jsonl`)).filter((h) => h && h.schema === 'ops.digest.hourly@1' && typeof h.from === 'string' && Array.isArray(h.ops));
  const monthsTo = (now) => {
    const month = new Date(now).toISOString().slice(0, 7);
    return [new Date(Date.parse(`${month}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 7), month];
  };

  /** One closed hour's line, folded when the queue reaches it so `previous` is the line written just before. */
  function writeHour(from, held) {
    return run(async () => {
      if (held.size > MAX_OPS) return;
      const month = new Date(from).toISOString().slice(0, 7);
      // A held hour written by an earlier start is not written again (readers keep the first line).
      if ((await hourlyOf(month)).some((h) => Date.parse(h.from) === from)) return;
      const h = foldHour(held, from, last);
      await write(`hourly-${month}.jsonl`, h);
      if (!last || Date.parse(last.from) < from) last = h;
      for (const r of h.risen) log({ event: 'failures_rose', op: r.op, failed: r.failed, previous: r.previous });
    });
  }

  function close(nextHour) {
    if (hour === null) return;
    writeHour(hour, counts);
    if (new Date(nextHour).toISOString().slice(0, 10) !== new Date(hour).toISOString().slice(0, 10)) catchUp(nextHour);
    counts = new Map();
  }

  /**
   * OD-5's catch-up: every closed UTC day of this month and the last that has hourly lines and no daily line gets its
   * daily line now, folded from the hourly file. Queued behind the writes, so a day closing now is read with its last hour.
   */
  function catchUp(now = Date.now()) {
    return run(async () => {
      const today = new Date(now).toISOString().slice(0, 10);
      for (const month of monthsTo(now)) {
        const done = new Set((await lines(`daily-${month}.jsonl`)).map((d) => d && d.day));
        const hourly = await hourlyOf(month);
        const days = [...new Set(hourly.map((h) => h.from.slice(0, 10)))].filter((d) => d < today && !done.has(d)).sort();
        for (const day of days) {
          const digest = foldDay(day, hourly);
          if (digest) await write(`daily-${month}.jsonl`, digest);
        }
      }
    });
  }

  /** The hour kept at the last quit, as { from, kept }, or null when there is none or it does not read. */
  function heldOf(text) {
    let held;
    try { held = JSON.parse(text); } catch { return null; }
    const from = held && typeof held.hour === 'string' ? Date.parse(held.hour) : NaN;
    if (!Number.isFinite(from) || from !== hourStart(from) || !Array.isArray(held.ops)) return null;
    const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
    const kept = new Map();
    for (const c of held.ops) {
      if (c && typeof c.op === 'string' && OP.test(c.op)) kept.set(c.op, { ok: n(c.ok), failed: n(c.failed), unknown: n(c.unknown) });
    }
    return { from, kept };
  }

  /** A held hour still open now: its counts go on, with whatever was counted since. */
  function resume(held) {
    if (hour !== null && hour !== held.from) return;
    hour = held.from;
    for (const [op, c] of held.kept) {
      const s = counts.get(op) ?? { ok: 0, failed: 0, unknown: 0 };
      counts.set(op, { ok: s.ok + c.ok, failed: s.failed + c.failed, unknown: s.unknown + c.unknown });
    }
  }

  /**
   * B-213, at every start, before anything else is written: the hour kept at the last quit taken back (read at once
   * with `fsSync`, so a start in the same hour goes on counting it before the first new line), the last hourly line
   * read back for `previous`, the day's named operations rebuilt, the kept hour written once it has closed, and only
   * then the closed days folded (OD-1, OD-5).
   */
  function start(now = Date.now()) {
    const file = path.join(dir, OPEN_FILE);
    let held = null;
    if (fsSync) {
      try { held = heldOf(fsSync.readFileSync(file, 'utf8')); } catch { held = null; }
      try { fsSync.rmSync(file, { force: true }); } catch { /* written again at the next quit */ }
      if (held && held.from >= hourStart(now)) { resume(held); held = null; }
    }
    run(async () => {
      if (!fsSync) {
        held = heldOf(await fs.readFile(file, 'utf8').catch(() => ''));
        await fs.rm(file, { force: true }).catch(() => {});
        if (held && held.from >= hourStart(now)) { resume(held); held = null; }
      }
      const hourly = (await Promise.all(monthsTo(now).map(hourlyOf))).flat().sort((a, b) => (a.from < b.from ? -1 : 1));
      const latest = hourly[hourly.length - 1];
      if (latest && (!last || latest.from > last.from)) last = latest;
      const today = new Date(now).toISOString().slice(0, 10);
      if (namesDay === null || namesDay === today) {
        namesDay = today;
        for (const h of hourly) if (h.from.slice(0, 10) === today) for (const c of h.ops) if (typeof c.op === 'string') names.add(c.op);
      }
    });
    if (held) writeHour(held.from, held.kept);
    return catchUp(now);
  }

  /**
   * B-213, at quit: the open hour and its counts kept, synchronously, for the next start. Nothing is kept without
   * `fsSync` or an open hour, and a failure keeps nothing: that hour is then never written, never in part.
   */
  function hold() {
    if (!fsSync || hour === null) return false;
    const ops = [...counts.entries()].map(([op, c]) => ({ op, ...c })).sort(byName);
    try {
      fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fsSync.writeFileSync(path.join(dir, OPEN_FILE), JSON.stringify({ hour: new Date(hour).toISOString(), ops }), { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  function count(event, at = Date.now()) {
    if (!event || typeof event.event !== 'string') return;
    const h = hourStart(at);
    if (hour !== null && h !== hour) close(h);
    // Any line is a sign the app ran in this hour (OD-1); only a named operation with an outcome is counted.
    hour = h;
    if (event.outcome === undefined || !OP.test(event.event)) return;
    const day = new Date(at).toISOString().slice(0, 10);
    if (day !== namesDay) { namesDay = day; names = new Set(); }
    let op = event.event;
    if (!names.has(op)) {
      if (names.size >= MAX_NAMED_OPS) op = OVERFLOW_OP;
      else names.add(op);
    }
    const c = counts.get(op) ?? { ok: 0, failed: 0, unknown: 0 };
    c[outcomeOf(event.outcome)]++;
    counts.set(op, c);
  }

  return { count, start, hold, catchUp, flush: () => queue };
}

module.exports = { createDigest, foldHour, foldDay, outcomeOf, RISE_MIN_FAILED, RISE_FACTOR, MAX_NAMED_OPS, OVERFLOW_OP };
