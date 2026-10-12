// Services sweep 2026-10-12: a model call that answered in 3 s kept its Durable Object running for
// the whole 45 s (CategoriesDO), 90 s (AgentRegistryDO) or 60 s (MailboxDO send), because
// AbortSignal.timeout's timer stays pending after the work is done. A deadline is cleared when the
// work ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deadline } from "../workers/lib/deadline";

test("a deadline aborts its signal when the time is up, with a TimeoutError", async () => {
  const d = deadline(20);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(d.signal.aborted, true);
  assert.equal((d.signal.reason as Error).name, "TimeoutError");
  d.clear();
});

test("a cleared deadline never aborts and leaves no timer behind", async () => {
  const d = deadline(20);
  d.clear();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(d.signal.aborted, false);
});

test("the Durable Object hot paths use a cleared deadline, not AbortSignal.timeout", () => {
  const files = ["workers/categories/classify.ts", "workers/agents/model.ts", "workers/routing/cloudflare-api.ts"];
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /AbortSignal\.timeout\(/, file);
});
