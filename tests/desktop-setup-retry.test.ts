// B-294 (U5; docs/ux/plans/2026-11-18-ui-fixes/README.md): a launch that cannot reach the server set up shows the setup
// window's Retry view, asks the server every 30 s and on wake, and opens the mail once it answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync("desktop/main.cjs", "utf8");

test("U5: a failed load of a server set up opens the Retry view and starts asking the server", () => {
  assert.match(main, /Mail is not available offline in this version\.'\), 'offline'\);\s*startOfflineRetry\(\);/);
  assert.match(main, /const OFFLINE_RETRY_MS = 30000;/);
  assert.match(main, /offlineRetry = setTimeout\(async \(\) => \{ await retryIfAnswers\(\); if \(offlineRetry\) next\(\); \}, OFFLINE_RETRY_MS\);/);
  assert.match(main, /if \(offlineRetry\) void retryIfAnswers\(\);/, "and when the computer wakes");
});

test("U5: the server is asked through its own session first; the mail opens only once it answers", () => {
  const ask = main.slice(main.indexOf("async function serverAnswers()"), main.indexOf("function startOfflineRetry()"));
  assert.match(ask, /session\.fromPartition\(policy\.partitionFor\(config\)\)\.fetch\(config\.origin, \{ method: 'HEAD', redirect: 'manual'/);
  assert.match(ask, /if \(!\(await serverAnswers\(\)\)\) return;[\s\S]*stopOfflineRetry\(\);\s*retryMail\(\);/);
});

test("U5: the Retry view is not reloaded by each failed retry, and stops with the window or when the mail loads", () => {
  assert.match(main, /if \(start === 'offline' && setupOffline && setupWindow && !setupWindow\.isDestroyed\(\)\) \{ notice = message; return; \}/);
  assert.match(main, /setupWindow\.on\('closed', \(\) => \{ setupWindow = null; setupOffline = false; stopOfflineRetry\(\); \}\);/);
  assert.match(main, /logEvent\(\{ event: 'window_shown', window: 'mail' \}\);\s*stopOfflineRetry\(\);/);
});

test("U5: the setup page shows the server by name and keeps the address form behind Change server", () => {
  const html = readFileSync("desktop/setup.html", "utf8");
  const js = readFileSync("desktop/setup.js", "utf8");
  assert.match(html, /<section id="step-offline"[^>]*hidden>/);
  assert.match(html, /id="offline-retry"[^>]*>Try again now</);
  assert.match(js, /else if \(state\.start === 'offline' && state\.config\) \{[\s\S]{0,300}show\('offline'\);/);
  assert.match(js, /\$\('#offline-change'\)\.addEventListener\('click', \(\) => show\('manual'\)\);/);
  assert.match(main, /server: config \? serverList\.labelFor\(held \|\| config, t\) : ''/);
});
