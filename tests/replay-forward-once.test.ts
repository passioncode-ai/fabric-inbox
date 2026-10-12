// receiveEmailResilient retries a delivery once after a transient Durable Object error. If the first
// attempt had already forwarded the copy and failed only while marking it settled, the retry found
// the copy still owed and forwarded it again (bug hunt 2026-10-12). Replays of one message now share
// one forward: the second call is a no-op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayEvent, forwardOnce } from "../workers/index";

test("two replays of one message forward its copy once", async () => {
  const calls: string[] = [];
  const event = { raw: new Response("x").body!, rawSize: 1, to: "me@p.invalid", from: "a@x.invalid",
    forward: async function (this: unknown, to: string) { calls.push(to); } } as never;
  const once = forwardOnce();
  const bytes = new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>;
  await (replayEvent(event, bytes, once) as any).forward("copy@elsewhere.invalid");
  await (replayEvent(event, bytes, once) as any).forward("copy@elsewhere.invalid");
  assert.deepEqual(calls, ["copy@elsewhere.invalid"]);
});

test("without a shared state each replay forwards (the single-attempt path is unchanged)", async () => {
  const calls: string[] = [];
  const event = { raw: new Response("x").body!, rawSize: 1, to: "me@p.invalid", from: "a@x.invalid",
    forward: async (to: string) => { calls.push(to); } } as never;
  const bytes = new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>;
  await (replayEvent(event, bytes) as any).forward("c@e.invalid");
  assert.deepEqual(calls, ["c@e.invalid"]);
});
