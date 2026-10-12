// Changing the sender awaited its signature and then applied it to the draft captured before the
// await, so text typed meanwhile was lost, and a slower answer for an earlier choice put that sender
// back (bug hunt 2026-10-12). Read from source: the composer is not rendered in node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("app/components/inbox/Composer.tsx", "utf8");
const fn = src.slice(src.indexOf("async function changeSender"), src.indexOf("/** After a validation failure"));

test("the sender's signature is applied to the draft as it is when the answer arrives", () => {
  assert.match(fn, /const now = latest\.current;/);
  assert.match(fn, /swapSignature\(now\.text, now\.signature, signature\)/);
  assert.doesNotMatch(fn, /swapSignature\(draft\.text/, "never the draft captured before the await");
});

test("only the latest sender choice applies its answer", () => {
  assert.match(fn, /const turn = \+\+senderTurn\.current;/);
  assert.match(fn, /if \(turn !== senderTurn\.current\) return;/);
});

test("Reply, Reply all, Forward and New open one draft even when clicked twice (bug hunt 2026-10-12)", () => {
  const inbox = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const guard = inbox.slice(inbox.indexOf("const composing = useRef(false);"), inbox.indexOf("async function composeOnce("));
  assert.match(guard, /if \(composing\.current\) return;/);
  assert.match(guard, /finally \{ composing\.current = false; \}/);
});
