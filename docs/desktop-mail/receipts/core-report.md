# T01/T02 — durable Cloudflare send and incoming event foundation

Status: implemented locally; no deployment, live mail, push or provider credential access. Owning branch: `codex/inbox-core`. Scope follows the root task packet `core-brief.md` and the approved [brief](../../../docs/desktop-mail/brief.md) / [architecture](../../../docs/desktop-mail/architecture.md).

## Delivered

- One outgoing coordinator inside MailboxDO for HTTP compose/reply/forward and MCP send/reply. Mailbox sender validation applies at the shared boundary. Existing MCP draft verification stays in preparation; its derived text is not the idempotency identity.
- SQLite outbox states pending/sending/accepted/failed/unknown. Immutable canonical request digest and mailbox+idempotency key uniqueness; SQL compare-and-set and in-process coalescing prevent concurrent duplicate transport calls. Caller keys use `Idempotency-Key` or `idempotencyKey` in HTTP and `idempotencyKey` in MCP. Keys are at most 200 characters.
- Payload chunks commit in the same transaction as intent, avoiding the Durable Object per-row limit for attachment payloads. Provider effect follows persistence flush. Rate caps include attempted outcomes and use attempt time, including recovered old pending items.
- Accepted receipt commits before Sent projection. An R2 or SQL projection failure returns accepted with projectionStatus=pending; alarms retry projection without transport. Constructor recovery converts interrupted sending into unknown. Ambiguous delivery/partial delivery and absent receipts become unknown and are never automatically resent. Known pre-acceptance rejection codes become failed. Receipt-storage failure becomes unknown.
- `GET /api/v1/mailboxes/:mailboxId/outbox` and `/outbox/:actionId` expose only journal fields, no body, recipients, attachment contents, arbitrary provider exception text, or idempotency key. Accepted means provider transport acceptance; deliveryStatus stays unconfirmed.
- Cloudflare owns Message-ID and forbids overriding it. A RFC-shaped provider receipt becomes local message_id and matching projected header; opaque receipts remain providerMessageId with no invented RFC identity. Replies to an opaque Sent identity fail explicitly. Incoming References/In-Reply-To resolves provider Message-ID to the stored conversation.
- Incoming SMTP envelope routing supports BCC/aliases without MIME To. Exact raw-bytes+envelope digest is stable across replay and does not conflate reused Message-IDs carrying different content. Receipt ledger, Inbox email and attachment metadata commit together; deterministic R2 attachment keys avoid concurrent replay copies.
- Incoming automation snapshot and Inbox commit atomically. Mailbox alarm and incoming replay drain pending events to `AUTOMATIONS.getByName(mailboxId).ingest(mailboxId,event)`. Ack follows successful RPC; a lost ack retries the same event ID. Absent optional binding preserves pending snapshots. Root supplies AutomationDO and its binding; no automation implementation is duplicated here.

## Shared interface

See [send command/result](../../../shared/mail/send.ts), [journal contract](../../../shared/mail/outbox.ts), [incoming event](../../../shared/mail/incoming.ts).

`MailboxDO.sendMail({mailboxId,idempotencyKey?,kind?:'send'|'reply'|'forward',originalEmailId?,request,verifyContent?})` returns OutboxEntry or `{error,code:'INVALID_REQUEST'|'IDEMPOTENCY_CONFLICT'|'NOT_FOUND'}`. Request carries to/from/subject and html or text, optional cc/bcc/attachments and threading. Automation must provide its deterministic action key.

`receiveEmail()` returns `{mailboxId,emailId,inserted}` or undefined for an out-of-scope recipient. The incoming handoff already happens inside MailboxDO; root should not add a second non-durable trigger.

## Verification actually run

- Initial red: `npx --yes tsx --test tests/outbox.test.ts` failed because outbox module did not exist.
- Behavioral red: incoming replay integration asserted one email and measured two before dedup implementation.
- Behavioral red: old pending actions sent 21 instead of the limit 20 before attempt timestamps were used.
- Behavioral red: incoming automation handoff expected one event and measured zero before journal/ack implementation.
- Behavioral red: incoming reply used provider receipt string as thread_id instead of the original local conversation before Message-ID resolution.
- Green: `npx --yes tsx --test tests/outbox*.test.ts`: **22 passed, 0 failed**. Includes SQLite database close/reopen, migration rollback, duplicate/concurrent sends, mailbox separation, missing/ambiguous receipt, receipt-storage failure, projection repair, rate cap, MCP helpers, sender denial, and eight real workerd/Miniflare integration tests using synthetic transport only.
- Green: `npm run typecheck` (Wrangler/React Router type generation and TypeScript build).
- Green: `git diff --check`.

Test sources: [SQLite behavior](../../../tests/outbox.test.ts), [workerd integration](../../../tests/outbox-integration.test.ts), [migration rollback](../../../tests/outbox-migrations.test.ts). Root should make `tsx`, `miniflare`, and `esbuild` explicit dev dependencies and expose the test command; this task did not own package.json.

## Provider evidence and remaining work

Official documentation read during implementation:
- [Workers send API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/): binding returns messageId; error code classes. No recipient delivery status is returned.
- [Email headers](https://developers.cloudflare.com/email-service/reference/headers/): Message-ID is platform-controlled and rejects custom override.
- [REST response distinction](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/): Workers and REST have different receipt contracts.

No live binding acceptance/header correspondence or actual recipient delivery was verified. A controlled provider fixture is still needed before production acceptance. Opaque provider receipts deliberately have no invented RFC message_id. Unknown actions require reconciliation/operator decision; there is no blind retry endpoint. Legacy clients that omit a key get a new action each request; root must persist client intent keys.

Inbound dedup covers identical raw deliveries and envelope, not semantically similar deliveries with different transport headers. Pre-existing mail is not backfilled. Incoming automation retries require root's idempotent ingest implementation; deletion before its rule execution can produce its explicit failed result. Existing auto-draft callback is still best effort, separate from the durable automation handoff. Full runtime permission grants, rule enforcement, delivery webhooks, and account/provider integrations are outside this packet.

Next task: root cherry-picks this commit, installs explicit test dependencies, connects AutomationDO binding and durable ingest, adds stable client intent keys and status UI, and runs the integrated suite. Do not deploy or send live mail as part of this packet.
