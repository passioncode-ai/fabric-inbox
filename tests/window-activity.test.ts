// LC-08 (knowledge/lifecycle.md): idle means idle. The Automation screen polled its runs and
// outbox every 5 s while visible, even with the window behind another app (raw/fabric-inbox.md §4,
// F6): TanStack Query pauses an interval only when the page is hidden, never on blur. It now polls
// at 30 s, and only while the window is both visible and focused (app/lib/window-activity.ts).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTOMATION_POLL_MS, MIN_POLL_MS, isWindowActive, pollInterval, subscribeWindowActivity } from "../app/lib/window-activity";

test("a visible window that has lost focus is not active; neither is a hidden one", () => {
  assert.equal(isWindowActive({ visibilityState: "visible", hasFocus: () => true }), true);
  assert.equal(isWindowActive({ visibilityState: "visible", hasFocus: () => false }), false);
  assert.equal(isWindowActive({ visibilityState: "hidden", hasFocus: () => true }), false);
});

test("polling is at least 30 s and stops when the window is not active", () => {
  assert.ok(AUTOMATION_POLL_MS >= 30_000);
  assert.equal(MIN_POLL_MS, 30_000);
  assert.equal(pollInterval(true, AUTOMATION_POLL_MS), AUTOMATION_POLL_MS);
  assert.equal(pollInterval(true, 5_000), 30_000, "a faster request is raised to the floor");
  assert.equal(pollInterval(false, AUTOMATION_POLL_MS), false);
});

test("activity follows focus, blur and visibility changes until unsubscribed", () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", focused: true, hasFocus() { return this.focused; } });
  const seen: boolean[] = [];
  const stop = subscribeWindowActivity(win, doc, (active) => seen.push(active));
  doc.focused = false; win.dispatchEvent(new Event("blur"));
  doc.focused = true; win.dispatchEvent(new Event("focus"));
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
  stop();
  doc.focused = false; win.dispatchEvent(new Event("blur"));
  assert.deepEqual(seen, [false, true, false, true]);
});

// The idle loop on a fake clock (the LC-08 check): one hour of the Automation runs query.
// TanStack never schedules intervals on a server (`typeof window === 'undefined'`, read once when it
// loads), so the browser is declared before the library is imported.
async function requestsPerHour(active: boolean) {
  (globalThis as { window?: unknown }).window ??= globalThis;
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  try {
    let calls = 0;
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ["runs", String(active)], queryFn: async () => { calls++; return []; },
      refetchInterval: pollInterval(active, AUTOMATION_POLL_MS),
    });
    const stop = observer.subscribe(() => {});
    for (let s = 0; s < 3600; s++) { mock.timers.tick(1000); await Promise.resolve(); }
    stop(); client.clear();
    return calls;
  } finally { mock.timers.reset(); }
}

test("an hour on the Automation screen: at most 121 requests while active, one while in the background", async () => {
  const active = await requestsPerHour(true);
  assert.ok(active <= 3600_000 / AUTOMATION_POLL_MS + 1, `active: ${active}`);
  assert.ok(active >= 100, `active polling still runs: ${active}`);
  assert.equal(await requestsPerHour(false), 1, "inactive: the first load only");
});

test("the Automation screen polls through the activity policy, never with a fixed fast interval", () => {
  const code = readFileSync("app/routes/automation.tsx", "utf8");
  assert.doesNotMatch(code, /refetchInterval:\s*\d/);
  assert.equal((code.match(/refetchInterval: pollInterval\(active, AUTOMATION_POLL_MS\)/g) ?? []).length, 2);
  assert.match(code, /const active = useWindowActive\(\)/);
});
