import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalsKnown } from "../workers/automation/engine";
import { ActionRejected } from "../workers/automation/engine";

test("B-15: an account's known refusal is a failed run (nothing done); a lost connection stays uncertain", async () => {
  for (const code of ["send_rate_limited", "message_not_found", "recipient_rejected"])
    await assert.rejects(refusalsKnown(async () => { throw new Error(code); }), (e: Error) => e instanceof ActionRejected && e.message.includes(code), code);
  await assert.rejects(refusalsKnown(async () => { throw new Error("socket lost"); }), (e: Error) => !(e instanceof ActionRejected), "an unknown failure is not called a refusal");
  await assert.rejects(refusalsKnown(async () => { throw new Error("provider_unavailable"); }), (e: Error) => !(e instanceof ActionRejected));
  assert.equal(await refusalsKnown(async () => "ok"), "ok");
});
