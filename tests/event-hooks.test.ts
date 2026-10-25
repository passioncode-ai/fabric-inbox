import { test } from "node:test";
import assert from "node:assert/strict";
import { addHook, checkHookUrl, HookInvalid, readHooks, removeHook } from "../workers/agents/event-hooks";

// B-137: webhooks of agent events.
function bucket() {
  const objects = new Map<string, { text: string; etag: string }>();
  let n = 0;
  return {
    objects,
    async get(key: string) { const o = objects.get(key); return o ? { etag: o.etag, json: async () => JSON.parse(o.text), text: async () => o.text } : null; },
    async put(key: string, text: string, opts?: { onlyIf?: { etagMatches?: string } | Headers }) {
      const cur = objects.get(key);
      const only = opts?.onlyIf as { etagMatches?: string } | undefined;
      if (only?.etagMatches && cur?.etag !== only.etagMatches) return null;
      objects.set(key, { text, etag: String(++n) });
      return {};
    },
  } as unknown as R2Bucket & { objects: Map<string, unknown> };
}

test("a hook's URL is https on a public host, with no credentials in it", () => {
  assert.equal(checkHookUrl("https://hooks.example/x?a=1"), "https://hooks.example/x?a=1");
  for (const bad of ["http://hooks.example/x", "https://localhost/x", "https://10.0.0.1/x", "https://box.local/x", "https://u:p@hooks.example/x", "not a url"])
    assert.throws(() => checkHookUrl(bad), HookInvalid, bad);
});

test("a hook is added with the default kinds and a secret, listed, and removed", async () => {
  const b = bucket();
  const hook = await addHook(b, { url: "https://hooks.example/fabric" });
  assert.deepEqual(hook.kinds, ["agent.handoff", "agent.needs_look", "agent.waiting", "agent.abandoned"], "B-170: abandoned conversations by default");
  assert.match(hook.secret, /^[0-9a-f]{64}$/);
  assert.equal((await readHooks(b)).length, 1);
  await assert.rejects(addHook(b, { url: "https://hooks.example/x", kinds: ["agent.nope"] }), /Unknown event kinds/);
  assert.equal(await removeHook(b, hook.id), true);
  assert.equal(await removeHook(b, hook.id), false);
  assert.equal((await readHooks(b)).length, 0);
});
