import test, { after } from "node:test";
import assert from "node:assert/strict";
import { accountsRouter } from "../workers/routes/accounts";
const config = {
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  PUBLIC_APP_URL: "https://mail.example.invalid",
};
const origin = config.PUBLIC_APP_URL;
test("accounts explicitly reports unavailable setup without a namespace", async () => {
  const response = await accountsRouter.request(
    origin + "/api/accounts",
    {},
    {} as never,
  );
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { configuration: string }).configuration,
    "not_configured",
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
test("external browser can begin OAuth at server URL; secure state cookie is set before Google redirect", async () => {
  // Google's sign-in page, asked first (without following) whether it would only show an error.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/v3/signin/identifier" } })) as typeof fetch;
  after(() => { globalThis.fetch = realFetch; });
  const env = {
    ...config,
    GMAIL_ACCOUNTS: {
      getByName: () => ({
        beginConnect: async () => ({
          authorizationUrl:
            "https://accounts.google.com/o/oauth2/v2/auth?state=test",
          browserToken: "opaque-browser-state",
        }),
      }),
    },
  };
  const response = await accountsRouter.request(
    origin + "/api/accounts/gmail/connect",
    {},
    env as never,
  );
  assert.equal(response.status, 302);
  assert.match(
    response.headers.get("Location")!,
    /^https:\/\/accounts.google.com\//,
  );
  assert.match(
    response.headers.get("Set-Cookie")!,
    /__Host-fabric-gmail-state=opaque-browser-state/,
  );
  assert.match(response.headers.get("Set-Cookie")!, /HttpOnly/);
  assert.match(response.headers.get("Set-Cookie")!, /Secure/);
  assert.match(response.headers.get("Set-Cookie")!, /SameSite=Lax/);
});
test("mutation rejects foreign or absent Origin before any DO call", async () => {
  let called = false;
  const env = {
    ...config,
    GMAIL_ACCOUNTS: {
      getByName: () => {
        called = true;
        throw new Error();
      },
    },
  };
  for (const headers of [{ Origin: "https://evil.example.invalid" }, {}]) {
    const response = await accountsRouter.request(
      origin + "/api/accounts/a/disconnect",
      { method: "POST", headers },
      env as never,
    );
    assert.equal(response.status, 403);
  }
  assert.equal(called, false);
});
test("callback forwards state and browser cookie, consumes cookie and ignores redirect injection", async () => {
  let args: unknown[] = [];
  const env = {
    ...config,
    GMAIL_ACCOUNTS: {
      getByName: () => ({
        callback: async (...a: unknown[]) => {
          args = a;
          return { id: "g1", email: "connected@example.invalid", status: "connected" };
        },
      }),
    },
  };
  const response = await accountsRouter.request(
    origin +
      "/api/accounts/gmail/callback?state=random&code=synthetic&returnTo=https://evil.example",
    { headers: { Cookie: "__Host-fabric-gmail-state=browser" } },
    env as never,
  );
  // A fixed page, not a redirect: no OAuth parameter chooses where the browser goes.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Location"), null);
  const page = await response.text();
  assert.match(page, /Gmail is connected/);
  assert.match(page, /connected@example\.invalid/);
  assert.ok(!page.includes("evil.example"));
  assert.deepEqual(args.slice(0, 3), ["random", "browser", "synthetic"]);
  assert.match(response.headers.get("Set-Cookie")!, /Max-Age=0/);
});
test("provider error text is never reflected in browser responses", async () => {
  const env = {
    ...config,
    GMAIL_ACCOUNTS: {
      getByName: () => ({
        listMessages: async () => {
          throw new Error("upstream credential secret");
        },
      }),
    },
  };
  const response = await accountsRouter.request(
    origin + "/api/accounts/a/messages",
    {},
    env as never,
  );
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret"));
});

test('attachment-sized requests reach the account transport; public validation errors keep 400/413', async () => {
  const file = { content: Buffer.alloc(5 * 1024 * 1024).toString('base64'), filename: 'file.bin', type: 'application/octet-stream', disposition: 'attachment' };
  let calls = 0;
  const env = { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ send: async (_id: string, request: any) => {
    calls++;
    assert.equal(request.attachments[0].content.length, file.content.length);
    return { status: 'accepted' };
  } }) } };
  const response = await accountsRouter.request(origin + '/api/accounts/a/send', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ attachments: [file] }),
  }, env as never);
  assert.equal(response.status, 202);
  assert.equal(calls, 1);
  for (const [code, expected] of [['invalid_attachment', 400], ['message_too_large', 413]] as const) {
    const result = await accountsRouter.request(origin + '/api/accounts/a/send', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
    }, { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ send: async () => { throw new Error(code); } }) } } as never);
    assert.equal(result.status, expected);
    assert.deepEqual(await result.json(), { error: code });
  }
});

test('streamed request limit rejects without a declared Content-Length or account side effect', async () => {
  let called = false;
  const env = { ...config, GMAIL_ACCOUNTS: { getByName: () => { called = true; throw new Error(); } } };
  const response = await accountsRouter.request(origin + '/api/accounts/a/send', {
    method: 'POST', headers: { Origin: origin }, body: 'x'.repeat(16 * 1024 * 1024 + 1),
  }, env as never);
  assert.equal(response.status, 413);
  assert.equal(called, false);
});

test("the Gmail messages route passes each search field typed, and refuses one it cannot read (agent audit 5)", async () => {
  let options: Record<string, unknown> = {};
  const env = { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ listMessages: async (_id: string, o: Record<string, unknown>) => { options = o; return { messages: [] }; } }) } };
  const ok = await accountsRouter.request(origin + "/api/accounts/a/messages?q=x&from=ann&to=bob&subject=May&after=2026-05-01&before=2026-06-01T00:00:00Z&unread=true&starred=false&hasAttachment=true&folder=inbox&limit=10", {}, env as never);
  assert.equal(ok.status, 200);
  assert.deepEqual(options, { cursor: undefined, limit: 10, query: "x", from: "ann", to: "bob", subject: "May", after: Date.parse("2026-05-01"),
    before: Date.parse("2026-06-01T00:00:00Z"), unread: true, starred: false, hasAttachment: true, folder: "inbox" });
  for (const query of ["after=soon", "unread=maybe"]) {
    const refused = await accountsRouter.request(origin + "/api/accounts/a/messages?" + query, {}, env as never);
    assert.equal(refused.status, 400, query);
    assert.deepEqual(await refused.json(), { error: "invalid_filter" });
  }
  const folder = await accountsRouter.request(origin + "/api/accounts/a/messages?folder=Receipts",
    {}, { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ listMessages: async () => { throw new Error("invalid_folder"); } }) } } as never);
  assert.equal(folder.status, 400);
});

test("the Gmail inbox route moves a message to the inbox (agent audit 4)", async () => {
  let args: unknown[] = [];
  const env = { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ moveToInbox: async (...a: unknown[]) => { args = a; return { labels: ["INBOX"] }; } }) } };
  const response = await accountsRouter.request(origin + "/api/accounts/a/messages/m1/inbox", { method: "POST", headers: { Origin: origin } }, env as never);
  assert.equal(response.status, 200);
  assert.deepEqual(args, ["a", "m1"]);
});

test("the account list names where a person connects Gmail, only when Gmail is set up (parity gap 9)", async () => {
  const env = { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ listAccounts: async () => ({ configuration: "configured", accounts: [] }) }) } };
  const listed = (await (await accountsRouter.request(origin + "/api/accounts", {}, env as never)).json()) as { connectUrl?: string };
  assert.equal(listed.connectUrl, "https://mail.example.invalid/api/accounts/gmail/connect");
  const unset = { GMAIL_ACCOUNTS: { getByName: () => ({ listAccounts: async () => ({ configuration: "not_configured", accounts: [] }) }) } };
  const bare = (await (await accountsRouter.request(origin + "/api/accounts", {}, unset as never)).json()) as { connectUrl?: string };
  assert.equal(bare.connectUrl, undefined);
});

test("the Gmail headers route returns every header of one message (parity gap 7)", async () => {
  let args: unknown[] = [];
  const env = { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ getHeaders: async (...a: unknown[]) => { args = a; return { headers: [{ key: "Received", value: "x" }] }; } }) } };
  const response = await accountsRouter.request(origin + "/api/accounts/a/messages/m1/headers", {}, env as never);
  assert.equal(response.status, 200);
  assert.deepEqual(args, ["a", "m1"]);
  assert.deepEqual(await response.json(), { headers: [{ key: "Received", value: "x" }] });
});
