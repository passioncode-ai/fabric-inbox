import { test } from "node:test";
import assert from "node:assert/strict";
import { oneAtATime } from "../workers/lib/one-at-a-time";

test("M-4: drains asked for side by side run one after another, and a failed one does not stop the next", async () => {
  let running = 0, most = 0, runs = 0;
  const drain = oneAtATime(async () => {
    running++; most = Math.max(most, running); runs++;
    await new Promise((r) => setTimeout(r, 10));
    running--;
    if (runs === 1) throw new Error("network");
  });
  const results = await Promise.allSettled([drain(), drain(), drain()]);
  assert.equal(most, 1, "never two at once");
  assert.equal(runs, 3);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "fulfilled"]);
});
