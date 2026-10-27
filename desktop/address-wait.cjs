'use strict';
/**
 * O-10 (bug hunt 2026-10-26, B-184): a workers.dev name or Access team made a moment ago can take a few
 * minutes to appear in DNS. Opening the new server before it does failed with "could not reach the
 * server" on a server that was fine. After Create my server the app waits until every new host
 * resolves, then opens it; past the deadline it opens it anyway and the ordinary Retry takes over.
 */
const WAIT_MS = 3 * 60_000;
const POLL_MS = 5_000;

/**
 * Waits until every host resolves. `resolve(host)` throws while a host does not; `onWaiting` is told once,
 * at the first host that does not resolve yet. Answers whether all resolved and how long it waited.
 */
async function waitForHosts(hosts, { resolve, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, onWaiting = () => {},
  timeoutMs = WAIT_MS, pollMs = POLL_MS } = {}) {
  const started = now();
  const pending = [...new Set(hosts.filter(Boolean))];
  let told = false;
  for (;;) {
    for (const host of [...pending]) {
      try { await resolve(host); pending.splice(pending.indexOf(host), 1); } catch { /* not yet */ }
    }
    if (!pending.length) return { ok: true, waitedMs: now() - started };
    if (!told) { told = true; onWaiting(pending[0]); }
    if (now() - started + pollMs > timeoutMs) return { ok: false, waitedMs: now() - started, pending };
    await sleep(pollMs);
  }
}

/** The hosts of a deployed server's own address and its sign-in page, as they will be opened. */
function hostsOf(origin, accessOrigin) {
  const host = (u) => { try { return new URL(u).hostname; } catch { return null; } };
  return [host(origin), host(accessOrigin)].filter(Boolean);
}

module.exports = { waitForHosts, hostsOf, WAIT_MS, POLL_MS };
