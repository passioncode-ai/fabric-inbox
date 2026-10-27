'use strict';
/**
 * B-158 M1 step 3d (SCN-094): the app moves a Cloudflare address from the server shown to another server it holds,
 * over the routes the servers carry since 0.65.0 (`/api/transfer/:email`, workers/routes/transfer.ts). Stages:
 * copy (folders, emails, attachments with their files), setup (rules, the agent, its knowledge), labels, precheck
 * (the counts, and that the receiving server can take the address's mail, before anything on the sending server changes), hold (the
 * sending copy stops), settle (sends and new mail handled there), catch-up (what arrived meanwhile), check (counts),
 * route (the address's Cloudflare rule to the receiving server), test (a test message arrives there), done.
 *
 * Every step is safe to repeat on the servers' side, and the state after each one is written to a journal, so a move
 * cut by a quit continues from where it stopped. Pure apart from what is passed in: tests drive it with fake servers.
 *
 * opts: { address, from: api, to: api, journal: { read() → state | null, write(state), clear() }, onProgress(state),
 *         now() → ms, sleep(ms), settleMs, testMs, pollMs }
 * api: { get(path) → { status, body }, send(method, path, body) → { status, body } }
 */

const TABLES = ['folders', 'emails', 'attachments'];
const LABEL_TABLES = ['verdicts', 'spam_checks', 'safety'];
const STAGES = ['copy', 'setup', 'labels', 'precheck', 'hold', 'settle', 'catchup', 'check', 'route', 'test', 'done'];

class MoveError extends Error {
  constructor(stage, code, detail) { super(`${stage}: ${detail}`); this.stage = stage; this.code = code; this.detail = detail; }
}

function createMover(opts) {
  const { address, from, to, journal } = opts;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const settleMs = opts.settleMs ?? 10 * 60_000;
  const testMs = opts.testMs ?? 3 * 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const base = `/api/transfer/${encodeURIComponent(address)}`;
  let state = null;
  let stopping = false;

  const save = async (patch) => {
    state = { ...state, ...patch, updatedAt: now() };
    await journal.write(state);
    if (opts.onProgress) opts.onProgress(state);
  };

  /** One call that must answer 2xx; anything else stops the move at this stage with the server's own words. */
  async function call(api, method, path, body) {
    let answer;
    try { answer = method === 'GET' ? await api.get(path) : await api.send(method, path, body); }
    catch (error) { throw new MoveError(state.stage, 'unreachable', error && error.message ? error.message : String(error)); }
    if (!answer || answer.status < 200 || answer.status >= 300)
      throw new MoveError(state.stage, answer && answer.status === 401 ? 'signed_out' : 'server', (answer && answer.body && answer.body.error) || `HTTP ${answer ? answer.status : 0}`);
    return answer.body;
  }

  async function copyTables() {
    for (const table of TABLES) {
      let after = (state.cursors && state.cursors[table]) || 0;
      for (;;) {
        const page = await call(from, 'GET', `${base}/rows?table=${table}&after=${after}&limit=100`);
        if (page.rows.length) await call(to, 'POST', `${base}/rows`, { table, rows: page.rows });
        for (const key of page.files || []) {
          const file = await from.get(`${base}/file?key=${encodeURIComponent(key)}`);
          // A file the sending server no longer stores is counted, not a reason to stop: the row says it existed.
          if (file && file.status === 404 && file.body && file.body.missing) { state.missingFiles = [...new Set([...(state.missingFiles || []), key])]; continue; }
          if (!file || file.status !== 200) throw new MoveError(state.stage, file && file.status === 413 ? 'too_large' : 'server', (file && file.body && file.body.error) || `HTTP ${file ? file.status : 0}`);
          await call(to, 'PUT', `${base}/file`, { key, data: file.body.data, contentType: file.body.contentType });
        }
        const copied = { ...(state.copied || {}) };
        copied[table] = (copied[table] || 0) + page.rows.length;
        if (page.next === null || page.next === undefined) { await save({ cursors: { ...state.cursors, [table]: after }, copied }); break; }
        after = page.next;
        await save({ cursors: { ...state.cursors, [table]: after }, copied });
        if (stopping) return;
      }
    }
  }

  async function copySetup() {
    const setup = await call(from, 'GET', `${base}/setup`);
    const rules = setup.rules && setup.rules.length ? await call(to, 'POST', `${base}/rules`, { rules: setup.rules }) : { saved: [], refused: [] };
    const map = {};
    for (const col of setup.collections || []) {
      const made = await call(to, 'POST', `${base}/collection`, { name: col.name, description: col.description });
      map[col.id] = made.id;
      for (let i = 0; i < col.documents.length; i += 100) {
        const batch = [];
        for (const d of col.documents.slice(i, i + 100)) {
          const doc = await call(from, 'GET', `${base}/document?collection=${encodeURIComponent(col.id)}&document=${encodeURIComponent(d.id)}`);
          batch.push({ sourceUri: doc.sourceUri, title: doc.title, revision: doc.revision, text: doc.text });
        }
        await call(to, 'POST', `${base}/documents`, { collection: made.id, documents: batch });
      }
    }
    const agent = setup.agent ? (await call(to, 'POST', `${base}/agent`, { agent: setup.agent, collections: map })).id : null;
    await save({ refusedRules: rules.refused || [], agentId: agent });
  }

  async function copyLabels() {
    const { categories } = await call(from, 'GET', `${base}/labels`);
    let skipped = 0;
    for (const table of LABEL_TABLES) {
      let after = 0;
      for (;;) {
        const page = await call(from, 'GET', `${base}/labels?table=${table}&after=${after}&limit=500`);
        if (page.rows.length) skipped += (await call(to, 'POST', `${base}/labels`, { table, rows: page.rows, categories })).skipped || 0;
        if (page.next === null || page.next === undefined) break;
        after = page.next;
      }
    }
    await save({ skippedLabels: skipped });
  }

  /** Sends and new mail still being handled on the sending server; waits, then hands the choice to the person. */
  async function settle() {
    const until = (state.settleSince || now()) + settleMs;
    if (!state.settleSince) await save({ settleSince: now() });
    for (;;) {
      const manifest = await call(from, 'GET', base);
      const b = manifest.blockers || {};
      if (!b.sends && !b.incoming) return manifest;
      if (now() >= until) throw new MoveError('settle', 'still_busy', JSON.stringify(b));
      if (stopping) return null;
      await sleep(pollMs);
    }
  }

  async function check() {
    const ids = await call(from, 'GET', `${base}/ids`);
    const result = await call(to, 'POST', `${base}/check`, ids);
    if (!result.complete) throw new MoveError(state.stage, 'counts', JSON.stringify({ missing: result.counts, source: { emails: ids.emails.length, attachments: ids.attachments.length } }));
    return { emails: ids.emails.length, attachments: ids.attachments.length };
  }

  /** The receiving server can point the address's Cloudflare rule at itself (same account, Cloudflare connected). */
  async function routable() {
    const where = await call(to, 'GET', `${base}/route`);
    if (!where || typeof where.here !== 'boolean') throw new MoveError('precheck', 'cannot_route', 'The receiving server cannot change this address\'s Cloudflare rule');
  }

  async function test() {
    const path = `/api/project-addresses/${encodeURIComponent(address)}/test`;
    if (!state.testSentAt) { await call(to, 'POST', path, {}); await save({ testSentAt: now() }); }
    for (;;) {
      const status = await call(to, 'GET', path);
      if (status && status.state === 'arrived') return;
      if (status && status.state === 'failed') throw new MoveError('test', 'test_failed', status.errorDetail || status.errorCode || 'failed');
      if (now() - state.testSentAt >= testMs) throw new MoveError('test', 'not_arrived', 'The test message did not arrive');
      if (stopping) return;
      await sleep(pollMs);
    }
  }

  /** Runs, or continues, the move to its end, to a stop the person must answer, or to an error. */
  async function run() {
    state = (await journal.read()) || null;
    if (state && state.stage === 'done') return state;
    if (!state) {
      state = { address, from: opts.fromOrigin || null, to: opts.toOrigin || null, stage: 'start', cursors: {}, copied: {}, startedAt: now() };
      const manifest = await call(from, 'GET', base);
      await call(to, 'POST', `${base}/open`, { settings: manifest.settings });
      await save({ stage: 'copy', counts: manifest.counts });
    }
    stopping = false;
    try {
      if (state.stage === 'copy') { await copyTables(); if (stopping) return state; await save({ stage: 'setup' }); }
      if (state.stage === 'setup') { await copySetup(); await save({ stage: 'labels' }); }
      if (state.stage === 'labels') { await copyLabels(); await save({ stage: 'precheck' }); }
      // SCN-094: counts that do not match stop the move before anything on the sending server changes.
      if (state.stage === 'precheck') { await check(); await routable(); await save({ stage: 'hold' }); }
      if (state.stage === 'hold') { await call(from, 'POST', `${base}/hold`, {}); await save({ stage: 'settle', held: true }); }
      if (state.stage === 'settle') { const m = await settle(); if (!m) return state; await save({ stage: 'catchup', counts: m.counts, settleSince: null }); }
      // Mail that arrived during the copy: the same cursors pick up the rows written after them.
      if (state.stage === 'catchup') { await copyTables(); if (stopping) return state; await save({ stage: 'check' }); }
      if (state.stage === 'check') { const counts = await check(); await save({ stage: 'route', counts }); }
      if (state.stage === 'route') { await call(to, 'POST', `${base}/route`, { expect: state.counts }); await save({ stage: 'test', routed: true }); }
      if (state.stage === 'test') { await test(); if (stopping) return state; await save({ stage: 'done', error: null }); }
      return state;
    } catch (error) {
      if (!(error instanceof MoveError)) throw error;
      await save({ error: { stage: error.stage, code: error.code, detail: error.detail } });
      return state;
    }
  }

  /** Test again for another few minutes (the person chose Wait Longer). */
  async function waitLonger() {
    state = await journal.read();
    if (!state || !state.error) return state;
    if (state.error.code === 'not_arrived') await save({ testSentAt: now(), error: null });
    else if (state.error.code === 'still_busy') await save({ settleSince: now(), error: null });
    else await save({ error: null });
    return run();
  }

  /** The way back: the address's mail to the sending server again, the hold lifted. The copy stays where it is. */
  async function putBack() {
    state = await journal.read();
    if (!state) return null;
    stopping = true;
    try {
      if (state.routed) { await call(to, 'POST', `${base}/unroute`, {}); await save({ routed: false }); }
      if (state.held) { await call(from, 'POST', `${base}/hold`, { release: true }); await save({ held: false }); }
      await save({ stage: 'back', error: null });
    } catch (error) {
      if (!(error instanceof MoveError)) throw error;
      await save({ error: { stage: 'back', code: error.code, detail: error.detail } });
    }
    return state;
  }

  /** Choose its agent on the receiving server (the copied one unless another is named). */
  async function chooseAgent(agentId) {
    const id = agentId || (state && state.agentId);
    if (!id) return null;
    return call(to, 'PUT', `/api/project-addresses/${encodeURIComponent(address)}/agent`, { agent: { id } });
  }

  return { run, waitLonger, putBack, chooseAgent, stop: () => { stopping = true; }, state: () => state };
}

/** Where a stored move stands, for the window's first look (null: nothing to continue). */
function describe(state) {
  if (!state) return null;
  return { address: state.address, from: state.from || null, to: state.to || null, stage: state.stage, index: Math.max(0, STAGES.indexOf(state.stage)), total: STAGES.length,
    counts: state.counts || null, copied: state.copied || {}, error: state.error || null, refusedRules: state.refusedRules || [],
    skippedLabels: state.skippedLabels || 0, missingFiles: (state.missingFiles || []).length, agentId: state.agentId || null,
    held: !!state.held, routed: !!state.routed };
}

module.exports = { createMover, describe, MoveError, STAGES, TABLES, LABEL_TABLES };
