import test from "node:test";
import assert from "node:assert/strict";
import { isTransientDo, readRetrying, retryRead } from "../workers/lib/do-retry";

/**
 * A read of a mailbox object survives the object being reset or replaced mid-call (live 2026-10-15 to
 * 2026-10-21: 33 failed calls, all of these messages); anything else fails at once, and a change is
 * never repeated.
 */
const live = [
  "Internal error while starting up Durable Object storage caused object to be reset; reference = 5oilalu2smgvs3rgd2kri27m",
  "Internal error in Durable Object storage caused object to be reset; reference = n0b5olfat2uldj8d7vp5645s",
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
  "internal error; reference = fops9fla4svvsuliba1e9u86",
];

test("the failures seen live are transient; a refusal, a bug and an overloaded object are not", () => {
  for (const message of live) assert.ok(isTransientDo(new Error(message)), message);
  assert.ok(isTransientDo(Object.assign(new Error("anything"), { retryable: true })));
  assert.equal(isTransientDo(new Error("account_not_found")), false);
  assert.equal(isTransientDo(new TypeError("x is not a function")), false);
  assert.equal(isTransientDo(Object.assign(new Error("Durable Object is overloaded"), { retryable: true, overloaded: true })), false);
  assert.equal(isTransientDo(null), false);
});

test("a read is tried once more after a transient failure, and only once", async () => {
  let calls = 0;
  assert.equal(await retryRead(async () => { if (++calls === 1) throw new Error(live[2]); return "page"; }, 1), "page");
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(retryRead(async () => { calls++; throw new Error(live[0]); }, 1), /object to be reset/);
  assert.equal(calls, 2, "the second failure is the answer");
  calls = 0;
  await assert.rejects(retryRead(async () => { calls++; throw new Error("account_not_found"); }, 1), /account_not_found/);
  assert.equal(calls, 1, "a failure a retry cannot fix is not retried");
});

test("a stub made retrying retries every call, keeps its values and is not taken for a promise", async () => {
  let calls = 0;
  const stub = { name: "box", async listInbox(n: number) { if (++calls === 1) throw new Error(live[1]); return [n]; } };
  const wrapped = readRetrying(stub, 1);
  assert.equal(wrapped.name, "box");
  assert.equal((wrapped as unknown as { then?: unknown }).then, undefined);
  assert.deepEqual(await wrapped.listInbox(3), [3]);
  assert.equal(calls, 2);
  assert.equal(await Promise.resolve(wrapped), wrapped, "awaiting the stub gives the stub");
});
