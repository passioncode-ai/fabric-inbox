import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import {
  GmailClient,
  ProviderError,
  makeMime,
  normalizeMessage,
} from "../workers/providers/gmail-client";
import {
  configuration,
  pkceChallenge,
  seal,
  unseal,
  createAuthorization,
  consumeState,
  type Store,
  type OAuthState,
} from "../workers/providers/google-oauth";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
export class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({
    prefix = "",
    limit,
    startAfter,
  }: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<
    Map<string, T>
  > {
    return new Map(
      [...this.data.entries()]
        .filter(
          ([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
        .map(([k, v]) => [k, structuredClone(v) as T]),
    );
  }
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    const p = this.tail.then(() =>
      fn({
        ...this,
        get: this.get.bind(this),
        put: this.put.bind(this),
        delete: this.delete.bind(this),
        list: this.list.bind(this),
        transaction: this.transaction.bind(this),
      }),
    );
    this.tail = p.catch(() => {});
    return p;
  }
}
const configEnv = {
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
export { configEnv };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("configuration fails closed for absent fields, invalid key, insecure public origin", () => {
  assert.equal(configuration({}).status, "not_configured");
  assert.equal(
    configuration({ ...configEnv, PUBLIC_APP_URL: "http://mail.example.invalid" })
      .status,
    "not_configured",
  );
  assert.equal(
    configuration({ ...configEnv, GMAIL_TOKEN_ENCRYPTION_KEY: "short" }).status,
    "not_configured",
  );
  assert.equal(configuration(configEnv).status, "configured");
});
test("PKCE uses S256; state is random browser-bound expiring one-use including concurrent callback", async () => {
  const config = configuration(configEnv);
  assert.equal(config.status, "configured");
  if (config.status !== "configured") return;
  const store = new MemoryStore();
  const a = await createAuthorization(store, config, 1000);
  const b = await createAuthorization(store, config, 1000);
  const url = new URL(a.authorizationUrl);
  assert.notEqual(
    url.searchParams.get("state"),
    new URL(b.authorizationUrl).searchParams.get("state"),
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state")!;
  const saved = await store.get<OAuthState>("oauth:" + state);
  assert.ok(saved);
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(saved.verifier).digest("base64url"),
  );
  assert.equal(
    await pkceChallenge(saved.verifier),
    url.searchParams.get("code_challenge"),
  );
  await assert.rejects(
    consumeState(store, state, "wrong-browser", 1100),
    /invalid_state/,
  );
  const results = await Promise.allSettled([
    consumeState(store, state, a.browserToken, 1100),
    consumeState(store, state, a.browserToken, 1100),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(
    consumeState(
      store,
      new URL(b.authorizationUrl).searchParams.get("state")!,
      b.browserToken,
      1000 + 600001,
    ),
    /invalid_state/,
  );
});
test("AES-GCM binds envelope to account and rejects tampering without plaintext persistence", async () => {
  const envelope = await seal(configEnv.GMAIL_TOKEN_ENCRYPTION_KEY, "acct-a", {
    refreshToken: "sensitive-value",
  });
  assert.ok(!JSON.stringify(envelope).includes("sensitive-value"));
  assert.deepEqual(
    await unseal(configEnv.GMAIL_TOKEN_ENCRYPTION_KEY, "acct-a", envelope),
    { refreshToken: "sensitive-value" },
  );
  await assert.rejects(
    unseal(configEnv.GMAIL_TOKEN_ENCRYPTION_KEY, "acct-b", envelope),
  );
  await assert.rejects(
    unseal(configEnv.GMAIL_TOKEN_ENCRYPTION_KEY, "acct-a", {
      ...envelope,
      ciphertext: "AAAA",
    }),
  );
});
test("client refreshes expired credentials and persists refreshed token before Gmail call", async () => {
  const calls: string[] = [];
  const saved: unknown[] = [];
  const client = new GmailClient(
    configEnv,
    { accessToken: "old", refreshToken: "refresh", expiresAt: 0 },
    async (t) => {
      saved.push(t);
    },
    async (input, init) => {
      calls.push(String(input));
      if (String(input).includes("/token")) {
        assert.match(String(init?.body), /grant_type=refresh_token/);
        return json({ access_token: "new", expires_in: 3600 });
      }
      assert.equal(saved.length, 1);
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer new",
      );
      return json({ emailAddress: "sender@example.invalid", historyId: "10" });
    },
  );
  assert.equal((await client.profile()).emailAddress, "sender@example.invalid");
  assert.equal(calls.length, 2);
});
test("client reports revoked grants, rate limits and expired history explicitly", async () => {
  const credentials = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  };
  const expired = new GmailClient(
    configEnv,
    credentials,
    async () => {},
    async () =>
      json({ error: { message: "provider secret must not be echoed" } }, 404),
  );
  await assert.rejects(
    expired.history("1"),
    (e: ProviderError) =>
      e.code === "history_expired" && !e.message.includes("secret"),
  );
  const limited = new GmailClient(
    configEnv,
    credentials,
    async () => {},
    async () => json({}, 429),
  );
  await assert.rejects(
    limited.profile(),
    (e: ProviderError) => e.code === "rate_limited",
  );
  const revoked = new GmailClient(
    configEnv,
    { ...credentials, expiresAt: 0 },
    async () => {},
    async () => json({ error: "invalid_grant" }, 400),
  );
  await assert.rejects(
    revoked.profile(),
    (e: ProviderError) => e.code === "reconnect_required",
  );
});
test("MIME preserves selected identity, encodes unicode and rejects injected recipient/subject", () => {
  const payload = {
    to: ["recipient@example.invalid"],
    subject: "Привет",
    text: "Hello\nWorld",
  };
  const mime = Buffer.from(
    makeMime("owner@example.invalid", payload),
    "base64url",
  ).toString("utf8");
  assert.match(mime, /From: owner@example.invalid\r\n/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  assert.throws(
    () =>
      makeMime("owner@example.invalid", {
        ...payload,
        to: ["good@example.invalid\r\nBcc: thief@example.invalid"],
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      makeMime("owner@example.invalid", {
        ...payload,
        subject: "Hi\nBcc: thief@example.invalid",
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      makeMime("owner@example.invalid", {
        ...payload,
        from: "other@example.invalid",
      } as never),
    /sender_mismatch/,
  );
});
test("normalization namespaces IDs and decodes nested MIME bodies and attachment metadata", () => {
  const raw = {
    id: "123",
    threadId: "456",
    internalDate: "1234",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      headers: [
        { name: "Subject", value: "hello" },
        { name: "From", value: "sender@example.invalid" },
      ],
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("actual body").toString("base64url") },
        },
        {
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "attachment", size: 42 },
        },
      ],
    },
  };
  const a = normalizeMessage("a", raw);
  const b = normalizeMessage("b", raw);
  assert.notEqual(a.id, b.id);
  assert.equal(a.text, "actual body");
  assert.equal(a.read, false);
  assert.equal(a.attachments[0].providerAttachmentId, "attachment");
});

test("normalization keeps Cc and Reply-To, so a reply reaches the right people (agent audit 1, 2)", () => {
  const m = normalizeMessage("a", {
    id: "1", threadId: "1",
    payload: { headers: [
      { name: "From", value: "Ann <ann@example.invalid>" }, { name: "To", value: "me@example.invalid" },
      { name: "CC", value: "Bob <bob@example.invalid>, carol@example.invalid" }, { name: "Reply-To", value: "help@example.invalid" },
    ] },
  });
  assert.equal(m.cc, "Bob <bob@example.invalid>, carol@example.invalid");
  assert.equal(m.replyTo, "help@example.invalid");
  const bare = normalizeMessage("a", { id: "2", threadId: "2", payload: { headers: [] } });
  assert.equal(bare.cc, "", "a message without the header still says it has none");
  assert.equal(bare.replyTo, "");
});
