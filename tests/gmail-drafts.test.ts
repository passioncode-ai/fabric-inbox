import test from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../workers/providers/google-oauth";
import { seal, configuration } from "../workers/providers/google-oauth";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { ProviderError } from "../workers/providers/gmail-client";

/**
 * Gmail's own drafts through the account service (B-50, B-52): listed, read, changed under the
 * revision the writer read (the draft's message id), deleted, and sent once per idempotency key.
 * Gmail is a fake that keeps its drafts in memory, as the API answers.
 */
class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix = "", limit }: { prefix?: string; limit?: number } = {}) {
    return new Map([...this.data.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([k, v]) => [k, structuredClone(v) as T]));
  }
  transaction<T>(fn: (s: Store) => Promise<T>) { return fn(this); }
}
const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", PUBLIC_APP_URL: "https://mail.example.invalid", GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url") };
const json = (x: unknown, status = 200) => new Response(x === undefined ? null : JSON.stringify(x), { status });
const b64url = (s: string) => Buffer.from(s).toString("base64url");

function fakeGmail() {
  let n = 0;
  const drafts = new Map<string, { id: string; raw: string; messageId: string; threadId: string; files: { id: string; data: string }[] }>();
  const sent: string[] = [];
  const calls: string[] = [];
  const message = (d: { raw: string; messageId: string; threadId: string; files: { id: string; data: string }[] }) => {
    const mime = Buffer.from(d.raw, "base64url").toString();
    const header = (name: string) => mime.match(new RegExp(`^${name}: (.*)$`, "mi"))?.[1] ?? "";
    return { id: d.messageId, threadId: d.threadId, labelIds: ["DRAFT"], snippet: "", payload: { headers: [
      { name: "To", value: header("To") }, { name: "Subject", value: Buffer.from(header("Subject").replace(/=\?UTF-8\?B\?|\?=/g, ""), "base64").toString() },
      { name: "In-Reply-To", value: header("In-Reply-To") }], parts: d.files.map((f) => ({ filename: f.id + ".txt", mimeType: "text/plain", body: { attachmentId: f.id, size: 2 } })) } };
  };
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = u.pathname.replace("/gmail/v1/users/me/", "");
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === "drafts" && method === "GET") return json({ drafts: [...drafts.values()].map((d) => ({ id: d.id, message: { id: d.messageId, threadId: d.threadId } })) });
    if (path === "drafts" && method === "POST") {
      const d = { id: "r" + ++n, raw: body.message.raw, messageId: "m" + ++n, threadId: body.message.threadId ?? "t" + n, files: [{ id: "att" + n, data: b64url("hi") }] };
      drafts.set(d.id, d);
      return json({ id: d.id, message: { id: d.messageId, threadId: d.threadId } });
    }
    if (path === "drafts/send") {
      const d = drafts.get(body.id);
      if (!d) return json({ error: { code: 404 } }, 404);
      drafts.delete(body.id); sent.push(Buffer.from(d.raw, "base64url").toString());
      return json({ id: "sent-" + d.messageId, threadId: d.threadId });
    }
    const draftMatch = path.match(/^drafts\/([^/]+)$/);
    if (draftMatch) {
      const d = drafts.get(draftMatch[1]!);
      if (!d) return json({ error: { code: 404 } }, 404);
      if (method === "GET") return json({ id: d.id, message: message(d) });
      if (method === "DELETE") { drafts.delete(d.id); return new Response(null, { status: 204 }); }
      if (method === "PUT") { d.raw = body.message.raw; d.messageId = "m" + ++n; d.files = []; return json({ id: d.id, message: { id: d.messageId, threadId: d.threadId } }); }
    }
    const att = path.match(/^messages\/([^/]+)\/attachments\/([^/]+)$/);
    if (att) return json({ data: b64url("hi"), size: 2 });
    return json({ error: "unexpected " + method + " " + path }, 500);
  }) as typeof fetch;
  return { http, drafts, sent, calls };
}

async function fixture() {
  const gmail = fakeGmail();
  const store = new MemoryStore();
  const config = configuration(env);
  if (config.status !== "configured") throw new Error("config");
  await store.put<AccountRecord>("account:a", { id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 3_600_000 }), sync: { mode: "initial" } });
  return { gmail, service: new AccountService(store, env, gmail.http) };
}
const rejects = async (work: Promise<unknown>, code: string) => {
  try { await work; assert.fail(`expected ${code}`); } catch (error) { assert.ok(error instanceof ProviderError, String(error)); assert.equal(error.code, code); }
};

test("Gmail drafts are listed and read with their revision, changed under it, and deleted (B-50: Gmail drafts were write-once)", async () => {
  const { service, gmail } = await fixture();
  const created = await service.createDraft("a", { idempotencyKey: "k1", to: ["ann@x.invalid"], subject: "Hi", text: "One" });
  const draftId = created.providerDraftId!;
  const list = await service.listDrafts("a");
  assert.equal(list.drafts.length, 1);
  assert.deepEqual([list.drafts[0]!.draftId, list.drafts[0]!.revision, list.drafts[0]!.to, list.drafts[0]!.subject], [draftId, created.providerMessageId, "ann@x.invalid", "Hi"]);
  const read = await service.getDraft("a", draftId);
  assert.equal(read.attachments.length, 1);
  assert.equal(typeof read.text, "string");

  const changed = await service.updateDraft("a", draftId, { to: ["bob@x.invalid"], subject: "Hello", text: "Two", expectedRevision: read.revision });
  assert.notEqual(changed.revision, read.revision, "a change gives the draft a new revision");
  assert.match(Buffer.from(gmail.drafts.get(draftId)!.raw, "base64url").toString(), /^To: bob@x.invalid/m);
  assert.match(Buffer.from(gmail.drafts.get(draftId)!.raw, "base64url").toString(), /filename\*0\*=UTF-8''att/, "the kept file is written again with the new message");
  await rejects(service.updateDraft("a", draftId, { to: ["bob@x.invalid"], subject: "Lost", text: "Lost", expectedRevision: read.revision }), "draft_conflict");

  await service.deleteDraft("a", draftId);
  assert.equal(gmail.drafts.size, 0);
  await rejects(service.deleteDraft("a", draftId), "draft_not_found");
  await rejects(service.getDraft("a", draftId), "draft_not_found");
});

test("sending a Gmail draft goes out once per key, refuses a moved revision, and a retry answers the first send (B-50)", async () => {
  const { service, gmail } = await fixture();
  const created = await service.createDraft("a", { idempotencyKey: "k1", to: ["ann@x.invalid"], subject: "Re: Order", text: "Soon", threadId: "th1", inReplyTo: "<orig@x.invalid>" });
  const draftId = created.providerDraftId!;
  await rejects(service.sendDraft("a", draftId, "s1", "stale-revision"), "draft_conflict");
  assert.equal(gmail.sent.length, 0);
  const sent = await service.sendDraft("a", draftId, "s1", created.providerMessageId);
  assert.equal(sent.status, "accepted");
  assert.equal(sent.threadId, "th1");
  assert.match(gmail.sent[0]!, /^In-Reply-To: <orig@x.invalid>/m, "sent as Gmail holds it, threaded");
  const again = await service.sendDraft("a", draftId, "s1");
  assert.deepEqual(again, sent, "the draft is gone; the same key answers the first send");
  assert.equal(gmail.sent.length, 1);
  const receipt = await service.getSendReceipt("a", "s1");
  assert.equal(receipt.status, "accepted", "get_send_status finds it under its key");
  await rejects(service.sendDraft("a", "r999", "s2"), "draft_not_found");
  await rejects(service.sendDraft("a", "r998", "s1"), "idempotency_conflict");
});
