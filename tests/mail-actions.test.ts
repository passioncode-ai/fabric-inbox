import test from "node:test";
import assert from "node:assert/strict";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, type Store } from "../workers/providers/google-oauth";
import { accountsRouter } from "../workers/routes/accounts";
import { applyMessageChange, changeMessage, type ActionMessage } from "../app/components/inbox/MessageActions";

class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix = "" } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>; }
  async transaction<T>(fn: (s: Store) => Promise<T>) { return fn(this); }
}
const env = { GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic", PUBLIC_APP_URL: "https://mail.example.invalid", GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url") };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function fixture() {
  const store = new MemoryStore();
  let labels = ["INBOX"], failure = "", calls: { path: string; method?: string; body?: any }[] = [];
  for (const id of ["a", "b"]) await store.put<AccountRecord>("account:" + id, {
    id, provider: "gmail", email: id + "@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(env.GMAIL_TOKEN_ENCRYPTION_KEY, id, { accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Date.now() + 3600000 }), sync: { mode: "initial" },
  });
  const service = new AccountService(store, env, async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init?.method, body });
    if (failure === "write" && init?.method === "POST") throw new Error("timeout");
    if (failure === "read" && !init?.method) throw new Error("timeout");
    if (path.endsWith("/modify")) labels = [...new Set([...labels.filter(l => !body.removeLabelIds.includes(l)), ...body.addLabelIds])];
    if (path.endsWith("/trash")) labels = [...new Set([...labels, "TRASH"])];
    if (path.endsWith("/untrash")) labels = labels.filter(l => l !== "TRASH");
    return json({ id: "same", threadId: "thread", labelIds: labels, payload: { headers: [{ name: "Subject", value: "Synthetic" }] } });
  });
  return { service, store, calls, fail: (value: string) => { failure = value; } };
}

test("Gmail star/trash assignments are idempotent, read back confirmed labels and preserve another account", async () => {
  const { service, calls } = await fixture();
  await service.setStarred("b", "same", false);
  for (const value of [true, true, false, false]) {
    const message = await service.setStarred("a", "same", value);
    assert.equal(message.labels.includes("STARRED"), value);
    assert.equal((await service.getMessage("a", "same")).labels.includes("STARRED"), value);
  }
  assert.equal((await service.getMessage("b", "same")).labels.includes("STARRED"), false);
  for (const value of [true, true, false, false]) {
    const message = await service.setTrashed("a", "same", value);
    assert.equal(message.labels.includes("TRASH"), value);
    assert.equal((await service.getMessage("a", "same")).labels.includes("TRASH"), value);
    assert.equal(calls.at(-2)?.path.endsWith(value ? "/trash" : "/untrash"), true);
    assert.equal(calls.at(-2)?.body, undefined);
    assert.equal(calls.at(-1)?.method, undefined);
  }
  assert.equal((await service.getMessage("b", "same")).labels.includes("TRASH"), false);
  assert.ok(calls.every(c => c.method !== "DELETE"));
});

test("invalid booleans, account and message IDs refuse before provider I/O", async () => {
  const { service, calls } = await fixture();
  for (const method of ["setStarred", "setTrashed"] as const) {
    for (const value of [undefined, null, "false", 0, {}, []]) await assert.rejects(service[method]("a", "same", value as boolean), /invalid_.*_state/);
    for (const id of ["", "../a", "a/b", "x".repeat(129), undefined]) {
      await assert.rejects(service[method](id as string, "same", true), /invalid_id/);
      await assert.rejects(service[method]("a", id as string, true), /invalid_id/);
    }
    await assert.rejects(service[method]("missing", "same", true), /account_not_found/);
  }
  assert.equal(calls.length, 0);
});

test("write timeout and failed confirmation read retain previous cache and never claim success", async () => {
  const { service, calls, store, fail } = await fixture();
  await service.setStarred("a", "same", false);
  const before = await service.getMessage("a", "same");
  for (const mode of ["write", "read"]) {
    fail(mode);
    const writes = calls.filter(c => c.method === "POST").length;
    await assert.rejects(service.setStarred("a", "same", true), /provider_unavailable/);
    assert.equal(calls.filter(c => c.method === "POST").length, writes + 1);
    assert.deepEqual(await service.getMessage("a", "same"), before);
    await assert.rejects(service.setTrashed("a", "same", true), /provider_unavailable/);
    assert.deepEqual(await service.getMessage("a", "same"), before);
  }
  fail("");
  assert.equal((await service.setTrashed("a", "same", false)).labels.includes("TRASH"), false);
  assert.equal((await service.getMessage("a", "same")).labels.includes("STARRED"), true);
  assert.ok(store.data.has("message:a:same"));
});

test("action routes reject malformed payloads and IDs, enforce Origin, then forward explicit booleans", async () => {
  const calls: unknown[][] = [];
  const bindings = { ...env, GMAIL_ACCOUNTS: { getByName: () => ({
    setStarred: async (...args: unknown[]) => { calls.push(args); return { labels: ["STARRED"] }; },
    setTrashed: async (...args: unknown[]) => { calls.push(args); return { labels: ["TRASH"] }; },
  }) } };
  for (const field of ["starred", "trashed"]) {
    const path = env.PUBLIC_APP_URL + `/api/accounts/a/messages/same/${field}`;
    for (const body of ["null", "[]", "{}", "bad", JSON.stringify({ [field]: "false" })]) {
      const response = await accountsRouter.request(path, { method: "POST", headers: { Origin: env.PUBLIC_APP_URL }, body }, bindings as never);
      assert.equal(response.status, 400);
    }
    assert.equal((await accountsRouter.request(path, { method: "POST", body: JSON.stringify({ [field]: true }) }, bindings as never)).status, 403);
    assert.equal((await accountsRouter.request(path.replace("/a/", "/bad%20id/"), { method: "POST", headers: { Origin: env.PUBLIC_APP_URL }, body: JSON.stringify({ [field]: true }) }, bindings as never)).status, 400);
  }
  assert.equal(calls.length, 0);
  for (const field of ["starred", "trashed"]) {
    const response = await accountsRouter.request(env.PUBLIC_APP_URL + `/api/accounts/a/messages/same/${field}`, {
      method: "POST", headers: { Origin: env.PUBLIC_APP_URL }, body: JSON.stringify({ [field]: false }),
    }, bindings as never);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.deepEqual(calls, [["a", "same", false], ["a", "same", false]]);
});

const message: ActionMessage = { id: '["gmail:a","same"]', provider: "gmail", accountId: "gmail:a", providerMessageId: "same", starred: false };
test("UI actions use account-scoped reversible routes and preserve selection during pending completion", async () => {
  const calls: unknown[][] = [];
  const request = async (...args: unknown[]) => {
    calls.push(args);
    return { labels: ["STARRED"], starred: false };
  };
  const other = { ...message, id: '["gmail:b","same"]', accountId: "gmail:b" };
  const star = await changeMessage(message, { starred: true }, request);
  assert.equal(applyMessageChange(other, star), other);
  assert.equal(applyMessageChange(message, star)?.starred, true);
  const trash = await changeMessage(message, { trashed: true }, request);
  assert.equal(applyMessageChange(other, trash), other);
  assert.equal(applyMessageChange(message, trash), null);
  await changeMessage(message, { trashed: false }, request);
  const cf = { ...message, provider: "cloudflare" as const, accountId: "cloudflare:box a", providerMessageId: "message/id" };
  await changeMessage(cf, { starred: false }, request);
  await changeMessage(cf, { trashed: true }, request);
  await changeMessage(cf, { trashed: false }, request);
  assert.deepEqual(calls, [
    ["/api/accounts/a/messages/same/starred", { starred: true }, "POST"],
    ["/api/accounts/a/messages/same/trashed", { trashed: true }, "POST"],
    ["/api/accounts/a/messages/same/trashed", { trashed: false }, "POST"],
    ["/api/v1/mailboxes/box%20a/emails/message%2Fid", { starred: false }, "PUT"],
    ["/api/v1/mailboxes/box%20a/emails/message%2Fid/move", { folderId: "trash" }, "POST"],
    ["/api/v1/mailboxes/box%20a/emails/message%2Fid/move", { folderId: "inbox" }, "POST"],
  ]);
  await assert.rejects(changeMessage(message, { trashed: true }, async () => { throw new Error("timeout"); }), /timeout/);
  await assert.rejects(changeMessage({ ...message, accountId: "cloudflare:a" }, { starred: true }, request), /account is unavailable/);
  assert.equal(calls.length, 6);
  const providerState = await changeMessage(message, { starred: true }, async () => ({ labels: [] }));
  assert.deepEqual(providerState, { id: message.id, starred: false });
  await assert.rejects(changeMessage(message, { starred: true }, async () => ({})), /state could not be confirmed/);
});

test("Cloudflare real DO preserves messages across reversible moves and refuses absent rows/folders", async () => {
  const { build } = await import("esbuild");
  const { Miniflare } = await import("miniflare");
  const bundle = await build({ stdin: { contents: `
    export { MailboxDO } from './workers/durableObject/index';
    export default { async fetch(request, env) {
      const { account, operation, id = 'same', folder } = await request.json();
      const mailbox = env.MAILBOX.getByName(account);
      if (operation === 'seed') { await mailbox.createEmail('inbox', {
        id, sender: 'sender@example.invalid', recipient: account, subject: 'Fixture', body: 'Preserve this body'
      }, []); return Response.json(true); }
      if (operation === 'move') return Response.json(await mailbox.moveEmail(id, folder));
      return Response.json(await mailbox.getEmail(id));
    }};
  `, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022" });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], durableObjects: { MAILBOX: { className: "MailboxDO", useSQLite: true } }, r2Buckets: ["BUCKET"] });
  const call = async (operation: string, account = "a@example.invalid", extra = {}) => {
    const response = await mf.dispatchFetch("http://localhost/action", { method: "POST", body: JSON.stringify({ operation, account, ...extra }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  try {
    await call("seed"); await call("seed", "b@example.invalid");
    for (const folder of ["trash", "trash", "inbox", "inbox"]) {
      assert.equal(await call("move", undefined, { folder }), true);
      const moved = await call("get");
      assert.equal(moved.folder_id, folder);
      assert.equal(moved.body, "Preserve this body");
      assert.equal((await call("get", "b@example.invalid")).folder_id, "inbox");
    }
    assert.equal(await call("move", undefined, { id: "missing", folder: "trash" }), false);
    assert.equal(await call("move", undefined, { folder: "missing" }), false);
    assert.equal((await call("get")).folder_id, "inbox");
  } finally { await mf.dispose(); }
});
