import test from "node:test";
import assert from "node:assert/strict";
import type { AttachmentRecord, AttachmentStorage } from "../app/components/inbox/attachment-store";
import type { Draft, ForwardSource } from "../app/components/inbox/draft-store";
import { forwardMetaFor, readForwardMeta, restoreForward } from "../app/components/inbox/forward-meta";
import { openServerDraft, syncDraft, type Request } from "../app/components/inbox/server-drafts";
import { missingOriginals } from "../app/components/inbox/compose-payload";
import { leftOutFiles } from "../app/components/inbox/forward-files";

/**
 * B-277 (S09 step 0 defect D6): a forward saved to the server and opened where this device has no copy
 * comes back as a forward, with its original's files, its left-out files and their reasons. The server
 * keeps the forward's origin beside the draft (its routes have their own tests); here the fake answers
 * as they do.
 */
class Files implements AttachmentStorage {
  rows = new Map<string, AttachmentRecord>();
  async add(r: AttachmentRecord) { this.rows.set(r.ref.id, r); }
  async get(id: string) { return this.rows.get(id); }
  async remove(id: string) { this.rows.delete(id); }
}
type Call = { url: string; body?: unknown; method?: string };
function server(answers: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  const request: Request = async <T,>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const call = { url, body, method };
    calls.push(call);
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`no route ${method} ${url}`);
    return answer(call) as T;
  };
  return { request, calls };
}
const CF = "cloudflare:me@p.invalid", BOX = "/api/v1/mailboxes/me%40p.invalid", GM = "gmail:g1", GBASE = "/api/accounts/g1";
const source: ForwardSource = {
  accountId: "cloudflare:me@p.invalid", originalId: "orig-msg", provider: "cloudflare",
  files: [
    { id: "o1", filename: "plan.pdf", mimeType: "application/pdf", size: 400, safety: "green" },
    { id: "o2", filename: "notes.txt", mimeType: "text/plain", size: 400, safety: "amber" },
    { id: "o3", filename: "run.exe", mimeType: "application/octet-stream", size: 90, safety: "red" },
    { id: "o4", filename: "big.mov", mimeType: "video/quicktime", size: 9_000_000 },
  ],
};
const forward = (over: Partial<Draft> = {}): Draft => ({
  id: "local-1", accountId: CF, to: "ann@x.invalid", subject: "Fwd: Plan", text: "See below", idempotencyKey: "k1", mode: "forward",
  forwardHtml: "<p>The plan</p>", forwardSource: source, originalId: "orig-msg",
  serverFiles: [{ id: "srv-1", filename: "plan.pdf", mimetype: "application/pdf", size: 400, sourceId: "o1" }],
  leftOut: [{ id: "o2", why: "removed" }, { id: "o3", why: "dangerous" }, { id: "o4", why: "no-room" }],
  ...over,
});

test("B-277: a forward's meta names its origin, its left-out files and the originals it carries; any other draft has none", () => {
  const meta = readForwardMeta(forwardMetaFor(forward()));
  assert.ok(meta);
  assert.deepEqual(meta.source, source);
  assert.deepEqual(meta.leftOut.map((x) => x.why), ["removed", "dangerous", "no-room"]);
  assert.deepEqual(meta.attached, [{ sourceId: "o1", serverId: "srv-1", filename: "plan.pdf", size: 400 }]);
  assert.equal(forwardMetaFor(forward({ mode: "reply" })), undefined, "a reply carries no forward meta");
  assert.equal(forwardMetaFor(forward({ forwardSource: undefined })), undefined);
  for (const bad of ["", "not json", "[]", JSON.stringify({ v: 2, source, leftOut: [], attached: [] }),
    JSON.stringify({ v: 1, source: { ...source, provider: "fax" }, leftOut: [], attached: [] }),
    JSON.stringify({ v: 1, source, leftOut: [{ id: "o2", why: "lost" }], attached: [] }),
    JSON.stringify({ v: 1, source, leftOut: [], attached: [{ sourceId: "o1", filename: "plan.pdf", size: -1 }] })])
    assert.equal(readForwardMeta(bad), null, `refused: ${bad.slice(0, 40)}`);
});

test("B-277: reopened, the files match by server id, else by the one file of that stored name and size; size alone never matches", () => {
  const meta = readForwardMeta(forwardMetaFor(forward({
    serverFiles: [], attachments: [
      { id: "a1", draftId: "local-1", filename: "plan.pdf", type: "application/pdf", disposition: "attachment", size: 400, sourceId: "o1" },
      { id: "a2", draftId: "local-1", filename: "notes.txt", type: "text/plain", disposition: "attachment", size: 400, sourceId: "o2" },
    ], leftOut: [] })))!;
  // Another device: the server named the files itself; one more file of the same size is the person's own.
  const restored = restoreForward(meta, [
    { id: "x1", filename: "mine.txt", mimetype: "text/plain", size: 400 },
    { id: "x2", filename: "notes.txt", mimetype: "text/plain", size: 400 },
    { id: "x3", filename: "plan.pdf", mimetype: "application/pdf", size: 400 },
  ]);
  assert.equal(restored.mode, "forward");
  assert.equal(restored.originalId, "orig-msg");
  assert.deepEqual(restored.serverFiles!.map((f) => [f.id, f.sourceId ?? null]), [["x1", null], ["x2", "o2"], ["x3", "o1"]]);
  assert.deepEqual(restored.leftOut, [{ id: "o3", why: "removed" }, { id: "o4", why: "removed" }],
    "originals never carried come back left out, never fetched by themselves");

  // A name the server changed ("a/b.txt" is stored "a_b.txt") still matches; two files of one name and size match neither.
  const named = restoreForward({ ...meta, attached: [{ sourceId: "o2", filename: "a/b.txt", size: 400 }] },
    [{ id: "y1", filename: "a_b.txt", mimetype: "text/plain", size: 400 }]);
  assert.equal(named.serverFiles![0]!.sourceId, "o2");
  const twins = restoreForward({ ...meta, attached: [{ sourceId: "o2", filename: "notes.txt", size: 400 }] },
    [{ id: "z1", filename: "notes.txt", mimetype: "text/plain", size: 400 }, { id: "z2", filename: "notes.txt", mimetype: "text/plain", size: 400 }]);
  assert.deepEqual(twins.serverFiles!.map((f) => f.sourceId ?? null), [null, null]);
  assert.ok(twins.leftOut!.some((x) => x.id === "o2" && x.why === "removed"), "an original no file matches is offered with Attach");
});

test("B-277: a Cloudflare forward saves its meta beside the message and opens elsewhere as a forward, with nothing missing", async () => {
  let kept: string | undefined;
  const saved = server({
    [`PUT ${BOX}/drafts/local-1`]: (c) => {
      kept = (c.body as { forward?: string }).forward;
      return { id: "local-1", revision: 3, attachments: [{ id: "srv-1", filename: "plan.pdf", mimetype: "application/pdf", size: 400 }] };
    },
  });
  const result = await syncDraft(forward({ serverId: "local-1", serverRevision: 2 }), new Files(), saved.request);
  assert.equal(result.ok, true, JSON.stringify(result));
  const body = saved.calls[0]!.body as { body: string; forward?: string };
  assert.ok(kept, "the save carries the meta");
  assert.ok(!body.body.includes("orig-msg") && !body.body.includes("notes.txt"), "the message itself carries nothing of it");

  const opened = server({
    [`GET ${BOX}/drafts/local-1`]: () => ({ id: "local-1", revision: 3, to: "ann@x.invalid", cc: null, bcc: null, subject: "Fwd: Plan",
      body: '<div style="white-space:pre-wrap">See below</div><br><div data-fabric-forward="1"><p>The plan</p></div><!--/fabric-forward-->',
      inReplyTo: null, threadId: null, attachments: [{ id: "srv-1", filename: "plan.pdf", mimetype: "application/pdf", size: 400 }], forward: kept }),
  });
  const d = await openServerDraft({ accountId: CF, serverId: "local-1" }, opened.request);
  assert.equal(d.mode, "forward");
  assert.deepEqual(d.forwardSource, source);
  assert.equal(d.serverFiles![0]!.sourceId, "o1");
  assert.deepEqual(leftOutFiles(d).map((x) => [x.file.id, x.why]), [["o2", "removed"], ["o3", "dangerous"], ["o4", "no-room"]]);
  assert.deepEqual(missingOriginals(d), [], "nothing is attached by itself and Send is not refused");
});

test("B-277: a Gmail forward sends its meta on creation and on each change; a draft without meta, or with a broken one, opens as before", async () => {
  const bodies: Record<string, unknown>[] = [];
  const answers = {
    [`GET ${GBASE}/drafts/draft-local-1-aa`]: () => { throw Object.assign(new Error("not found"), { status: 404, body: {} }); },
    [`POST ${GBASE}/drafts`]: (c: Call) => { bodies.push(c.body as Record<string, unknown>); return { status: "accepted", providerDraftId: "r1", providerMessageId: "m1" }; },
    [`GET ${GBASE}/drafts/r1/content`]: () => ({ attachments: [] }),
    [`PUT ${GBASE}/drafts/r1`]: (c: Call) => { bodies.push(c.body as Record<string, unknown>); return { revision: "m2" }; },
  };
  const g = server(answers);
  const base = forward({ accountId: GM, serverFiles: [], leftOut: [{ id: "o1", why: "removed" }, { id: "o2", why: "removed" }, { id: "o3", why: "dangerous" }, { id: "o4", why: "no-room" }] });
  const created = await syncDraft({ ...base, pendingCreateKey: "draft-local-1-aa" }, new Files(), g.request);
  assert.equal(created.ok, true, JSON.stringify(created));
  const changed = await syncDraft({ ...base, serverId: "r1", serverRevision: "m1" }, new Files(), g.request);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(bodies.length, 2);
  for (const b of bodies) assert.ok(readForwardMeta(b.forward as string), "both carry the meta");
  assert.ok(!String(bodies[0]!.html).includes("orig-msg"));

  const content = (forward: unknown) => server({
    [`GET ${GBASE}/drafts/r1/content`]: () => ({ draftId: "r1", revision: "m2", to: "ann@x.invalid", cc: null, bcc: null, subject: "Fwd: Plan", text: "See below",
      html: "", threadId: null, inReplyTo: null, references: null, attachments: [], forward }),
  }).request;
  for (const missing of [null, undefined, "{broken"]) {
    const d = await openServerDraft({ accountId: GM, serverId: "r1" }, content(missing));
    assert.equal(d.mode, "new", "today's rebuild");
    assert.equal(d.forwardSource, undefined);
  }
  const restored = await openServerDraft({ accountId: GM, serverId: "r1" }, content(bodies[1]!.forward));
  assert.equal(restored.mode, "forward");
  assert.equal(restored.leftOut!.length, 4);
});
