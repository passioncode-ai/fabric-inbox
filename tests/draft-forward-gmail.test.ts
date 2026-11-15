import test from "node:test";
import assert from "node:assert/strict";
import { accountsRouter } from "../workers/routes/accounts";

/**
 * B-277: a Gmail forward draft's origin, kept by the server beside the draft (never sent to Gmail): the
 * routes in front of the account service, with the service and the bucket as fakes. The creation's
 * idempotency payload is the message alone, so a replay with another meta is the same creation, and
 * it never overwrites a meta a later change wrote.
 */
class Bucket {
  rows = new Map<string, { text: string; customMetadata?: Record<string, string> }>();
  async head(key: string) { const r = this.rows.get(key); return r ? { customMetadata: r.customMetadata ?? {} } : null; }
  async get(key: string) { const r = this.rows.get(key); return r ? { text: async () => r.text } : null; }
  async put(key: string, text: string, options?: { customMetadata?: Record<string, string> }) { this.rows.set(key, { text, customMetadata: options?.customMetadata }); }
  async delete(key: string) { this.rows.delete(key); }
}
function fixture() {
  const seen: { method: string; args: unknown[] }[] = [];
  const service = {
    createDraft: async (...args: unknown[]) => { seen.push({ method: "createDraft", args }); return { status: "accepted", providerDraftId: "r1", providerMessageId: "m1" }; },
    getDraft: async () => ({ draftId: "r1", revision: "m2", to: "ann@x.invalid", subject: "Fwd", text: "", html: "", attachments: [] }),
    updateDraft: async (...args: unknown[]) => { seen.push({ method: "updateDraft", args }); return { revision: "m2" }; },
    deleteDraft: async () => ({ deleted: true }),
    sendDraft: async () => ({ status: "accepted", providerMessageId: "s1" }),
  };
  const bucket = new Bucket();
  const env = { GMAIL_ACCOUNTS: { getByName: () => service }, BUCKET: bucket } as never;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await accountsRouter.request(`http://localhost${path}`, { method, headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { status: r.status, body: await r.json() as any };
  };
  return { call, seen, bucket };
}
const KEY = "draft-forward/accounts/g1/r1.json";
const meta = (n: number) => JSON.stringify({ v: 1, source: { accountId: "gmail:g1", originalId: "orig-" + n, provider: "gmail", files: [] }, leftOut: [], attached: [] });
const message = { idempotencyKey: "draft-local-1-aa", to: ["ann@x.invalid"], subject: "Fwd", text: "See" };

test("B-277: a Gmail creation keeps the meta beside the draft, gives Gmail the message alone, and a replay never overwrites a later meta", async () => {
  const { call, seen, bucket } = fixture();
  const made = await call("POST", "/api/accounts/g1/drafts", { ...message, forward: meta(1) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(seen[0]!.args[1], message, "the service (and the creation's key) sees no meta");
  assert.equal(bucket.rows.get(KEY)?.text, meta(1));
  assert.equal((await call("PUT", "/api/accounts/g1/drafts/r1", { to: ["ann@x.invalid"], text: "See", expectedRevision: "m1", forward: meta(2) })).status, 200);
  assert.equal(seen[1]!.args[2] && (seen[1]!.args[2] as Record<string, unknown>).forward, undefined, "the change sent to Gmail has no meta");
  assert.equal((await call("POST", "/api/accounts/g1/drafts", { ...message, forward: meta(1) })).status, 201);
  assert.equal(bucket.rows.get(KEY)?.text, meta(2), "the replay left the later meta");
  assert.equal((await call("GET", "/api/accounts/g1/drafts/r1/content")).body.forward, meta(2));
  assert.equal((await call("PUT", "/api/accounts/g1/drafts/r1", { to: ["ann@x.invalid"], text: "Edited" })).status, 200);
  assert.equal(bucket.rows.get(KEY)?.text, meta(2), "a change without meta leaves it");
  assert.equal((await call("POST", "/api/accounts/g1/drafts", { ...message, idempotencyKey: "k2", forward: "[]" })).status, 400);
  assert.equal((await call("PUT", "/api/accounts/g1/drafts/r1", { to: [], text: "x", forward: "nope" })).status, 400);
});

test("B-277: a Gmail draft deleted or sent takes its meta along", async () => {
  for (const end of ["delete", "send"] as const) {
    const { call, bucket } = fixture();
    await call("POST", "/api/accounts/g1/drafts", { ...message, forward: meta(1) });
    assert.ok(bucket.rows.has(KEY));
    const r = end === "delete" ? await call("DELETE", "/api/accounts/g1/drafts/r1") : await call("POST", "/api/accounts/g1/drafts/r1/send", { idempotencyKey: "s-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(bucket.rows.has(KEY), false, end);
  }
});
