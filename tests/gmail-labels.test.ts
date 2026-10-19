import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory-store";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, configuration } from "../workers/providers/google-oauth";

/**
 * B-35: an agent works with a Gmail account's own labels, beyond inbox, archive and trash — it lists
 * them, finds the synced mail under one, and puts one on a message or takes it off. Only the account's
 * own labels change here: the system ones have their own actions, and Discarded is discard's.
 */
const configEnv = {
  GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });

async function fixture(provider: "gmail" | "imap" = "gmail") {
  const store = new MemoryStore();
  const config = configuration(configEnv);
  if (config.status !== "configured") throw new Error();
  const labels: Record<string, string[]> = { m1: ["INBOX", "Label_2"], m2: ["INBOX"] };
  const modified: { id: string; add: string[]; remove: string[] }[] = [];
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/labels")) return json({ labels: [
      { id: "INBOX", name: "INBOX", type: "system" }, { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
      { id: "Label_2", name: "Clients", type: "user" }, { id: "Label_3", name: "Invoices/2026", type: "user" }, { id: "Label_9", name: "Discarded", type: "user" },
    ] });
    const modify = u.pathname.match(/\/messages\/([^/]+)\/modify$/);
    if (modify) {
      const body = JSON.parse(String(init?.body));
      modified.push({ id: modify[1], add: body.addLabelIds, remove: body.removeLabelIds });
      labels[modify[1]] = [...labels[modify[1]].filter((l) => !body.removeLabelIds.includes(l)), ...body.addLabelIds];
      return json({ id: modify[1], labelIds: labels[modify[1]] });
    }
    const read = u.pathname.match(/\/messages\/([^/]+)$/);
    if (read) return json({ id: read[1], threadId: "t" + read[1], labelIds: labels[read[1]], payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "S " + read[1] }], body: { data: "" } } });
    throw new Error("unexpected request " + u.pathname);
  }) as typeof fetch;
  await store.put<AccountRecord>("account:a", {
    id: "a", provider, email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000 }),
    sync: provider === "gmail" ? { mode: "history", historyId: "10", generation: "g1" } : { mode: "idle", folders: [{ role: "inbox", path: "INBOX" }] },
  } as AccountRecord);
  await store.put("label:a:discarded", "Label_9");
  const service = new AccountService(store, configEnv, http);
  for (const id of ["m1", "m2"]) await service.getMessage("a", id).catch(() => undefined);
  return { store, service, modified, labels };
}

test("a Gmail account's labels: its own and the system ones, without the Discarded label discard keeps (B-35)", async () => {
  const { service } = await fixture();
  assert.deepEqual(await service.listLabels("a"), { labels: [
    { id: "INBOX", name: "INBOX", type: "system" }, { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
    { id: "Label_2", name: "Clients", type: "user" }, { id: "Label_3", name: "Invoices/2026", type: "user" },
  ] });
});

test("a label is put on a message and another taken off in one change; the cache reads it at once (B-35)", async () => {
  const { service, modified } = await fixture();
  const changed = await service.changeLabels("a", "m1", { add: ["Label_3"], remove: ["Label_2"] });
  assert.deepEqual(modified, [{ id: "m1", add: ["Label_3"], remove: ["Label_2"] }]);
  assert.deepEqual(changed.labels, ["INBOX", "Label_3"]);
  const found = await service.listMessages("a", { label: "Label_3" });
  assert.deepEqual(found.messages.map((m) => m.providerMessageId), ["m1"]);
  assert.deepEqual((await service.listMessages("a", { label: "Label_2" })).messages, []);
});

test("only the account's own labels change; system labels, Discarded and malformed changes are refused before Gmail is asked (B-35)", async () => {
  const { service, modified } = await fixture();
  for (const change of [
    { add: ["INBOX"], remove: [] }, { add: [], remove: ["UNREAD"] }, { add: ["Label_9"], remove: [] }, { add: [], remove: [] },
    { add: ["Label_2"], remove: ["Label_2"] }, { add: Array.from({ length: 21 }, (_, i) => "Label_" + i), remove: [] },
    { add: "Label_2", remove: [] }, { add: ["Label_2/../x"], remove: [] },
  ]) await assert.rejects(service.changeLabels("a", "m1", change as never), /invalid_label/, JSON.stringify(change));
  await assert.rejects(service.listMessages("a", { label: "bad label" }), /invalid_filter/);
  assert.equal(modified.length, 0);
});

test("an IMAP account keeps folders, not labels: both refuse with not_supported (B-35)", async () => {
  const { service } = await fixture("imap");
  await assert.rejects(service.listLabels("a"), /not_supported/);
  await assert.rejects(service.changeLabels("a", "m1", { add: ["Label_2"], remove: [] }), /not_supported/);
});

test("a label the account does not have is refused by name, never as Gmail's bare 400 (B-35)", async () => {
  const { service, modified } = await fixture();
  await assert.rejects(service.changeLabels("a", "m1", { add: ["Label_7"], remove: [] }), /invalid_label/);
  assert.equal(modified.length, 0);
});
