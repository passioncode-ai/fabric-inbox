import test from "node:test";
import assert from "node:assert/strict";
import type { AttachmentRecord, AttachmentStorage } from "../app/components/inbox/attachment-store";
import type { Draft } from "../app/components/inbox/draft-store";
import { draftRows } from "../app/components/inbox/DraftsDialog";
import {
  contentKey, deleteSavedDraft, listServerDrafts, mergeSynced, openServerDraft, rebaseEdit, refreshFromServer, sendSavedDraft, swapSignature, syncDraft, type Request,
} from "../app/components/inbox/server-drafts";
import { missingOriginals } from "../app/components/inbox/compose-payload";

/**
 * The main window's drafts on the server (B-52): what the composer's copy sends to each provider,
 * how a change made elsewhere comes back, and how a draft kept only on this device is saved up.
 * The server is a recording fake answering as the routes do (they have their own tests).
 */
class Files implements AttachmentStorage {
  rows = new Map<string, AttachmentRecord>();
  async add(r: AttachmentRecord) { this.rows.set(r.ref.id, r); }
  async get(id: string) { return this.rows.get(id); }
  async remove(id: string) { this.rows.delete(id); }
}
class HttpError extends Error { constructor(public status: number, public body: Record<string, unknown>) { super(String(body.error)); } }
type Call = { url: string; body?: unknown; method?: string };
function server(answers: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  const request: Request = async <T,>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const call = { url, body, method };
    calls.push(call);
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new HttpError(404, { error: `no route ${method} ${url}` });
    return answer(call) as T;
  };
  return { request, calls };
}
const CF = "cloudflare:me@p.invalid", BOX = "/api/v1/mailboxes/me%40p.invalid", GM = "gmail:g1", GBASE = "/api/accounts/g1";
const draft = (over: Partial<Draft> = {}): Draft => ({ id: "local-1", accountId: CF, to: "ann@x.invalid", subject: "Hi", text: "Hello\nthere", idempotencyKey: "k1", mode: "new", ...over });

test("a Cloudflare draft is saved in place under its revision with its files, and its copy here keeps what was typed meanwhile (B-52)", async () => {
  const files = new Files();
  files.rows.set("f1", { ref: { id: "f1", draftId: "local-1", filename: "a.txt", type: "text/plain", disposition: "attachment", size: 2, sourceId: "orig-1" }, bytes: new TextEncoder().encode("hi").buffer as ArrayBuffer });
  const { request, calls } = server({
    [`PUT ${BOX}/drafts/local-1`]: () => ({ id: "local-1", revision: 1, attachments: [{ id: "local-1-ab", filename: "a.txt", mimetype: "text/plain", size: 2 }] }),
  });
  const snapshot = draft({ cc: "carol@x.invalid", attachments: [{ id: "f1", draftId: "local-1", filename: "a.txt", type: "text/plain", disposition: "attachment", size: 2, sourceId: "orig-1" }] });
  const result = await syncDraft(snapshot, files, request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls[0]!.body, { to: "ann@x.invalid", cc: "carol@x.invalid", subject: "Hi", body: '<div style="white-space:pre-wrap">Hello<br>there</div>',
    attachments: [{ content: "aGk=", filename: "a.txt", type: "text/plain", disposition: "attachment" }], keep_attachments: [], expected_revision: 0 });
  if (!result.ok) return;
  assert.deepEqual(result.serverFiles, [{ id: "local-1-ab", filename: "a.txt", mimetype: "text/plain", size: 2, sourceId: "orig-1" }], "an uploaded original keeps its source");

  const typed = { ...snapshot, text: "Hello there, more" };
  const merged = mergeSynced(typed, snapshot, result);
  assert.deepEqual([merged.serverId, merged.serverRevision, merged.synced, merged.text, merged.attachments], ["local-1", 1, false, "Hello there, more", []],
    "text typed during the save stays and is still to be saved; the uploaded file is now the server's");
  assert.equal(mergeSynced(snapshot, snapshot, result).synced, true);
  assert.deepEqual(missingOriginals({ ...merged, mode: "forward", forwardSource: { accountId: CF, originalId: "m1", provider: "cloudflare", files: [{ id: "orig-1", filename: "a.txt", mimeType: "text/plain", size: 2 }] } }), [],
    "an original on the server counts as included");

  // The next save names the revision it read and the files it keeps.
  const next = await syncDraft({ ...merged, mode: "reply", originalId: "in-1", threadId: "th-1" }, files, server({ [`PUT ${BOX}/drafts/local-1`]: (c) => {
    assert.deepEqual([(c.body as any).expected_revision, (c.body as any).keep_attachments, (c.body as any).in_reply_to, (c.body as any).thread_id], [1, ["local-1-ab"], "in-1", "th-1"]);
    return { id: "local-1", revision: 2, attachments: [] };
  } }).request);
  assert.equal(next.ok && next.serverRevision, 2);
});

test("a change made elsewhere, a draft sent elsewhere, no network and no sender each come back as what they are, and the copy here is kept", async () => {
  const files = new Files();
  const conflict = await syncDraft(draft({ serverId: "local-1", serverRevision: 1 }), files, server({ [`PUT ${BOX}/drafts/local-1`]: () => { throw new HttpError(409, { error: "x", code: "draft_conflict", revision: 3 }); } }).request);
  assert.deepEqual([conflict.ok, !conflict.ok && conflict.reason], [false, "conflict"]);
  const gone = await syncDraft(draft({ serverId: "local-1", serverRevision: 1 }), files, server({ [`PUT ${BOX}/drafts/local-1`]: () => { throw new HttpError(409, { error: "x", code: "draft_gone" }); } }).request);
  assert.equal(!gone.ok && gone.reason, "gone");
  const offline = await syncDraft(draft(), files, server({ [`PUT ${BOX}/drafts/local-1`]: () => { throw new HttpError(0, { error: "The server could not be reached." }); } }).request);
  assert.equal(!offline.ok && offline.reason, "offline");
  assert.equal(!(await syncDraft(draft({ accountId: "" }), files, server({}).request)).ok, true);
  const noSender = await syncDraft(draft({ accountId: "" }), files, server({}).request);
  assert.equal(!noSender.ok && noSender.reason, "no_sender");
  const incomplete = await syncDraft(draft({ accountId: GM, to: "ann@" }), files, server({}).request);
  assert.equal(!incomplete.ok && incomplete.reason, "incomplete", "Gmail keeps a draft only with a valid recipient");
});

test("a Gmail draft is made once under a kept creation key, found again after a lost answer, then changed under its revision (B-52)", async () => {
  const files = new Files();
  const first = await syncDraft(draft({ accountId: GM }), files, server({}).request);
  assert.equal(!first.ok && first.reason, "pending", "the creation key is kept on this device before Gmail is asked");
  const key = !first.ok && first.reason === "pending" ? first.patch.pendingCreateKey! : "";
  assert.match(key, /^draft-local-1-/);
  const created = server({
    [`GET ${GBASE}/drafts/${key}`]: () => { throw new HttpError(404, { error: "receipt_not_found" }); },
    [`POST ${GBASE}/drafts`]: () => ({ status: "accepted", providerDraftId: "r9", providerMessageId: "m1" }),
    [`GET ${GBASE}/drafts/r9/content`]: () => ({ attachments: [] }),
  });
  const made = await syncDraft(draft({ accountId: GM, pendingCreateKey: key, mode: "reply", threadId: "th", inReplyTo: "<o@x>", references: "<o@x>" }), files, created.request);
  assert.deepEqual(made.ok && [made.serverId, made.serverRevision], ["r9", "m1"]);
  const post = created.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
  assert.deepEqual([post.idempotencyKey, post.to, post.threadId, post.inReplyTo], [key, ["ann@x.invalid"], "th", "<o@x>"]);

  // The answer was lost: the receipt says it was made, so it is not made twice.
  const found = server({
    [`GET ${GBASE}/drafts/${key}`]: () => ({ status: "accepted", providerDraftId: "r9", providerMessageId: "m1" }),
    [`PUT ${GBASE}/drafts/r9`]: (c) => { assert.equal((c.body as any).expectedRevision, "m1"); return { revision: "m2" }; },
  });
  const adopted = await syncDraft(draft({ accountId: GM, pendingCreateKey: key, text: "Changed" }), files, found.request);
  assert.deepEqual(adopted.ok && [adopted.serverId, adopted.serverRevision], ["r9", "m2"]);
  assert.ok(!found.calls.some((c) => c.method === "POST"), "no second draft");
});

test("send, delete and open go to the draft's own provider; a draft not yet saved is never sent", async () => {
  const { request, calls } = server({
    [`POST ${BOX}/drafts/local-1/send`]: () => ({ status: "accepted" }),
    [`POST ${GBASE}/drafts/r9/send`]: () => ({ status: "accepted" }),
    [`DELETE ${BOX}/drafts/local-1`]: () => undefined,
    [`DELETE ${GBASE}/drafts/r9`]: () => { throw new HttpError(404, { error: "draft_not_found" }); },
  });
  assert.throws(() => sendSavedDraft(draft({ serverId: "local-1", serverRevision: 2, synced: false }), request), /Save the draft/);
  await sendSavedDraft(draft({ serverId: "local-1", serverRevision: 2, synced: true }), request);
  await sendSavedDraft(draft({ accountId: GM, serverId: "r9", serverRevision: "m2", synced: true }), request);
  assert.deepEqual(calls.map((c) => [c.url, c.body]), [[`${BOX}/drafts/local-1/send`, { idempotencyKey: "k1", expected_revision: 2 }], [`${GBASE}/drafts/r9/send`, { idempotencyKey: "k1", expectedRevision: "m2" }]]);
  await deleteSavedDraft(draft({ serverId: "local-1" }), request);
  await deleteSavedDraft(draft({ accountId: GM, serverId: "r9" }), request);
  await deleteSavedDraft(draft(), request);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 2, "a draft gone on the server counts as deleted; one never saved asks nothing");
});

test("the Drafts list shows every account's server drafts with this device's, each draft once; an agent's draft opens to edit (B-09, B-52)", async () => {
  const { request } = server({
    [`GET ${BOX}/drafts`]: () => ({ drafts: [{ id: "agent-1", revision: 4, to: "bob@x.invalid", subject: "From the agent", date: "2026-10-06T10:00:00Z", snippet: "Hi", attachments: [{}] },
      { id: "local-1", revision: 2, to: "ann@x.invalid", subject: "Hi", date: "2026-10-06T09:00:00Z", snippet: "", attachments: [] }] }),
    [`GET ${GBASE}/drafts`]: () => { throw new HttpError(401, { error: "reconnect_required" }); },
    [`GET ${BOX}/drafts/agent-1`]: () => ({ id: "agent-1", revision: 4, to: "bob@x.invalid", cc: null, bcc: null, subject: "From the agent", body: "<p>Line one</p><p>Line two</p>",
      inReplyTo: "in-7", threadId: "th-7", attachments: [{ id: "agent-1-aa", filename: "q.pdf", mimetype: "application/pdf", size: 9 }] }),
  });
  const listed = await listServerDrafts([CF, GM], request);
  assert.deepEqual(listed.failed, [GM], "an account that cannot be read is named");
  const rows = draftRows([draft({ serverId: "local-1", synced: true }), draft({ id: "only-here", accountId: "" })], listed.drafts);
  assert.deepEqual(rows.map((r) => (r.kind === "local" ? `local ${r.draft.id}` : `server ${r.row.serverId}`)), ["local local-1", "local only-here", "server agent-1"]);
  const opened = await openServerDraft({ accountId: CF, serverId: "agent-1" }, request);
  assert.deepEqual([opened.id, opened.mode, opened.originalId, opened.threadId, opened.serverRevision, opened.synced, opened.text],
    ["agent-1", "reply", "in-7", "th-7", 4, true, "Line one\nLine two"]);
  assert.deepEqual(opened.serverFiles, [{ id: "agent-1-aa", filename: "q.pdf", mimetype: "application/pdf", size: 9 }]);
  const theirs = await refreshFromServer({ ...opened, serverFiles: [...opened.serverFiles!, { id: "gone", filename: "x", mimetype: "text/plain", size: 1 }] }, request);
  assert.deepEqual(theirs.matchedFiles.map((f) => f.id), ["agent-1-aa"], "keeping my version keeps my files that are still there");
});

test("a keystroke from a window that has not shown the last save keeps the server's id, revision and files (B-52)", () => {
  const ref = { id: "f1", draftId: "local-1", filename: "a.txt", type: "text/plain", disposition: "attachment" as const, size: 2 };
  const before = draft({ serverId: "local-1", serverRevision: 3, synced: true, attachments: [],
    serverFiles: [{ id: "s-old", filename: "b.txt", mimetype: "text/plain", size: 1 }, { id: "s-new", filename: "a.txt", mimetype: "text/plain", size: 2 }] });
  // Rendered before the save: no server fields, the file still local, the old file listed.
  const stale = draft({ text: "Hello there!", attachments: [ref], serverFiles: [{ id: "s-old", filename: "b.txt", mimetype: "text/plain", size: 1 }] });
  const next = rebaseEdit(before, stale, new Set(["f1"]), new Set(["s-new"]));
  assert.deepEqual([next.serverId, next.serverRevision, next.attachments, next.serverFiles!.map((f) => f.id), next.synced, next.text],
    ["local-1", 3, [], ["s-old", "s-new"], false, "Hello there!"]);
  // The person removes a saved file: it goes.
  const removed = rebaseEdit(before, { ...before, serverFiles: [before.serverFiles![1]!] }, new Set(), new Set());
  assert.deepEqual(removed.serverFiles!.map((f) => f.id), ["s-new"]);
  assert.equal(removed.synced, false);
  // Nothing the server holds changed: still saved.
  assert.equal(rebaseEdit(before, { ...before, synced: false }, new Set(), new Set()).synced, true);
});

test("a sender's signature follows a change of sender, and only when the old one is still at the end", () => {
  assert.equal(swapSignature("\n\n— Ann", "— Ann", "— Bob"), "\n\n— Bob");
  assert.equal(swapSignature("Hello\n\n— Ann", "— Ann", ""), "Hello");
  assert.equal(swapSignature("Hello\n\n— Ann\nP.S. more", "— Ann", "— Bob"), "Hello\n\n— Ann\nP.S. more\n\n— Bob");
  assert.equal(contentKey(draft()) === contentKey(draft({ serverRevision: 9, synced: true })), true, "server fields are not content");
});
