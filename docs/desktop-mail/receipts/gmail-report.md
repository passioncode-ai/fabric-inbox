# T03 — Gmail account service implementation report

Objective: implement the approved cloud Gmail account adapter in the isolated `fabric-inbox-gmail` worktree. Root owns bindings, mounting, UI, production configuration and end-to-end acceptance. No deploy, live consent, mailbox access, discovered credentials, package changes or push occurred here.

## Delivered

- `workers/providers/google-oauth.ts`: explicit configuration check, HTTPS origin-only callback configuration, 32-byte AES-GCM key, contextual authenticated encryption, random OAuth state and verifier, PKCE S256, browser-binding hash, transactional one-use state and 10-minute expiry.
- `workers/providers/gmail-client.ts`: native fetch/WebCrypto client, token refresh persisted before reuse, scope-checked code exchange, Gmail profile/messages/history/modify/attachment/send/drafts endpoints, MIME encoding and injection rejection, account-scoped normalized message IDs and nested MIME decoding. Public normalized fields include `rfcMessageId` and `references` for replies.
- `workers/providers/account-service.ts`: encrypted credentials, public account projection, resumable 25-message initial pages, history pages, 404 history resync, explicit revoked/rate-limit/backoff statuses, durable message bodies split below KV limits, generation-bound cache after resync. Updated bodies use versioned chunks; an interrupted update leaves the last committed body readable. Separate durable pending-event index and retained event markers prevent repeated history events. Full import/resync pages never enqueue automation; SENT/DRAFT additions are excluded.
- `workers/providers/accounts-do.ts`: serial account operations, alarm polling (default 300 seconds, configurable 60–3600 seconds), round-robin at most five accounts per alarm, persistent pending automation outbox. Automation delivery occurs outside the account mutex to permit RPC back into Gmail.
- `workers/routes/accounts.ts`: HTTP adapter, same-origin mutation checks, safe errors and no-store, fixed callback redirect, browser-bound secure HttpOnly SameSite=Lax cookie. GET connect is the system-browser entry point; POST connect supports same-browser clients.
- Draft/send intents are stored before provider I/O. Repeated key/payload replays receipt, changed payload conflicts, uncertain/crashed outcomes become `unknown` and are never automatically repeated. Stored identity mapping preserves account ID when the same Gmail address reconnects after disconnection. Receipt lookups perform no provider operation. Provider acceptance is not delivery.

## Root integration contract

Export `GmailAccountsDO` from worker entry; bind `GMAIL_ACCOUNTS` to the class with a new SQLite Durable Object migration. Mount `accountsRouter` at `/` after Access validation and before SSR. It intentionally follows the existing shared Access workspace, not tenant isolation. Use `env.GMAIL_ACCOUNTS.getByName('workspace')`.

Required configuration:

| Name | Value contract |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | Web client secret; server secret only |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Base64url-encoded 32 random bytes; server secret only; retain while existing accounts exist |
| `PUBLIC_APP_URL` | Exact HTTPS origin, no path, query, credentials or fragment |
| `GMAIL_POLL_SECONDS` | Optional; default 300, clamped 60–3600 |

Register `{PUBLIC_APP_URL}/api/accounts/gmail/callback` at Google, enable Gmail API, and configure a consent screen/test users or approved application. Requests use `https://www.googleapis.com/auth/gmail.modify` for read, labels, drafts and sending. No grant is present from this implementation.

For desktop OAuth, open **`{PUBLIC_APP_URL}/api/accounts/gmail/connect` in the system browser**. A POST performed in an embedded browser followed by a Google authorization URL opened in another browser loses the cookie binding and must not be used.

RPC methods:

- `listAccounts()`, `beginConnect()`, `callback(state,browserToken,code,error?)`.
- `sync(accountId)`, `listMessages(accountId,{cursor?,limit?,query?})`, `getMessage(accountId,providerMessageId)`.
- `send(accountId,request)`, `createDraft(accountId,request)`; request: `{idempotencyKey,to:string[],cc?,bcc?,subject,text,html?,threadId?,inReplyTo?,references?,from?}`. From is always the connected mailbox; mismatches fail.
- `getSendReceipt(accountId,idempotencyKey)`, `getDraftReceipt(accountId,idempotencyKey)`.
- `setRead(accountId,messageId,read)`, `archive(accountId,messageId)`, `getAttachment(accountId,messageId,attachmentId)`, `disconnect(accountId)`.

HTTP roots: `/api/accounts`; `/api/accounts/gmail/{connect,callback}`; `/api/accounts/:accountId/{sync,disconnect,messages,send,drafts}`; GET receipts `/sends/:idempotencyKey` and `/drafts/:idempotencyKey`; message detail and `/read`, `/archive`, `/attachments/:attachmentId` under `/messages/:messageId`.

Optional `AUTOMATIONS` binding must provide `getByName('gmail:'+accountId).ingest(account,{id,sender,subject,body,date,thread_id})`. Outbox acknowledgement happens only after successful ingest. Delivery is at-least-once; AutomationDO must deduplicate account + provider message ID. All imported history stays out of this outbox.

## Checks actually run

- `npm ci --ignore-scripts`: exit 0; 514 packages installed from unchanged lockfile. Existing dependency audit reported 62 vulnerabilities (7 low, 32 moderate, 23 high); no dependency upgrades were attempted.
- `npx --yes tsx --test tests/providers*.test.ts`: **23 tests passed, 0 failed**. Covers absent setup, PKCE/state expiry/reuse/concurrency/browser binding, AES-GCM context/tampering, refresh, revoked/rate-limited/history-404 errors, MIME injection, account namespacing, pagination resume, durable merge before cursor, history event replay, send/draft idempotency and receipt crash, pending delivery retry, large Unicode bodies, interrupted body update, encrypted callback persistence, HTTP cookie/origin/redirect/error boundary.
- TDD red runs observed missing modules first; later real assertions failed on missing GET connect (404 vs 302), missing draft method, and corrupt body after interrupted chunk write. Those same cases now pass.
- `npx tsc --noEmit --skipLibCheck --strict --target ES2022 --module ES2022 --moduleResolution bundler --types @cloudflare/workers-types/experimental workers/providers/*.ts workers/routes/accounts.ts`: exit 0.
- `git diff --check`: exit 0.
- A local update-policy check was run from this worktree and reported no policy update.

## Precise limitations and next task

1. Root still must mount/export/bind the implementation, update environment typing/configuration, wire UI and automation actions, and run the integrated build and desktop/browser checks. This slice was checked using real parser/storage/OAuth logic with mocked HTTP and an in-memory storage adapter; deployed Cloudflare alarms/RPC and a controlled live Google mailbox have not been tested.
2. Polling replaces Pub/Sub push for this implementation. Initial import advances one 25-message page per account sync/alarm; it is resumable but a large archive may need substantial time. Each alarm services at most five accounts.
3. Outbound attachment sending/forwarding is **explicitly rejected** as `attachments_not_supported`; inbound attachments can be fetched. Sender aliases, persistent draft editing/deletion, Gmail server-side search, dedicated thread fetch and label configuration are not implemented. Search covers cached header/snippet fields; list pagination uses provider-ID order, not global chronological order.
4. History expiry invalidates the old cache generation on completed resync. Old invisible cache rows, orphan chunks after a failed write, event tombstones and send/draft receipts do not yet have a retention/compaction policy. Disconnect clears cached content in bounded batches and attempts Google revocation; it reports `revoked:false` if that remote call failed. Identity mapping and receipts remain so disconnection cannot erase send uncertainty.
5. The encryption key is mandatory, and changing it without a migration makes existing credentials unreadable. There is no key rotation migration. No secrets were printed or stored in tracked files.
6. UI must sanitize HTML before display, preserve idempotency keys for retry/recovery, label accepted/unknown accurately, and distinguish cache/import status from a fully synchronized mailbox.

Exact next task: root cherry-picks this commit, applies the binding/migration/mount above, maps the normalized Message shape into its unified inbox and automation contracts, and runs the combined suite/build. Live OAuth/controlled mailbox acceptance remains prerequisite to claiming Gmail production readiness.

## Sources and skill actually used

The installed `google-auth` skill (its `SKILL.md` and `references/oauth2-web-server.md`) supplied server-side state/session binding, secret storage, refresh, fail-closed configuration and HTTPS rules. Official sources checked: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync). Native fetch and WebCrypto avoid adding a Node-oriented Google SDK to the Workers runtime. No visual/copy/design work was owned by this slice.
