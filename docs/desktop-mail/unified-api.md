> **History — do not follow as instructions.** Current entry: [release entry](../app-store/README.md); status authority: the [roadmap](../app-store/tasks/2026-09-28-roadmap.md). Branch names and test counts below are from the packet.

# Unified mailbox API handoff

Objective: read the existing Cloudflare mailboxes and connected Gmail accounts through one date-ordered inbox, while preserving account identity and visible failure states.

Base: `d577462` on `codex/fabric-inbox`. Implementation branch: `codex/unified-mail-api`. This packet belongs with the unified interface change; the parent task owns the screen and its scenario/brand documentation.

## Contract and implementation

`GET /api/inbox` accepts `account` (optional stable account key), `folder` (`inbox`, `sent`, `archive`, `trash`, `starred`, default `inbox`), `query` (case-insensitive substring of subject/sender/recipient/snippet), `limit` (1–100, default 50), and an opaque `cursor` returned by the preceding page.

The canonical contract is [shared/mail/inbox.ts](../../shared/mail/inbox.ts). The response includes every discovered account for the selector, normalized messages, per-account/provider `issues`, `hasMore`, and a cursor when more successfully read local rows exist. It supplies no provider-wide total. Each message has a provider-specific ID for existing detail/action routes plus an unambiguous UI ID from `[accountId, providerMessageId]`.

- Cloudflare account ID: `cloudflare:<mailbox email>`.
- Gmail account ID: `gmail:<stored account id>`.
- Cloudflare detail/action mailbox path uses the email after `cloudflare:`.
- Gmail detail/action path uses the account ID after `gmail:` and `providerMessageId`.
- `date` is an ISO date; numeric `timestamp` supplies the sort key. Invalid/missing dates sort at epoch zero.

[workers/routes/inbox.ts](../../workers/routes/inbox.ts) mounts behind the existing application-wide Cloudflare Access policy in [workers/app.ts](../../workers/app.ts). That existing policy shares accounts across authorized workspace teammates. The route never accepts an undiscovered account as a new Durable Object identity. R2 existence is rechecked before each Cloudflare read. Responses use `Cache-Control: no-store`. This endpoint performs no sends, sync, credential reads, or outbound provider requests.

[workers/lib/inbox-query.ts](../../workers/lib/inbox-query.ts) implements Cloudflare SQL keyset reads, parameterizing every caller value. [workers/providers/account-service.ts](../../workers/providers/account-service.ts), `listInboxMessages`, reads Gmail's local cache and retains only the requested top page plus a lookahead row. Its result remains generation-filtered as in the existing account service. [workers/providers/accounts-do.ts](../../workers/providers/accounts-do.ts) exposes this read through the account object's serialized queue.

## Bounds and known limits

Gmail must scan the complete cache to establish date order because the existing storage keys are ordered by provider ID. The scan reads batches of 100 rows with a maximum of 20,000 storage rows (metadata **and** body chunks). It retains at most `limit + 1` matching candidates after each batch. An incomplete scan returns the account issue `cache_scan_limit` and excludes that account's rows rather than presenting an incorrectly ordered subset. A dedicated timestamp metadata index is the next step if actual account volume reaches this limit.

Discovery reads at most ten R2 listing pages; exceeding that limit produces `account_limit`. A response reads messages from at most 100 discovered accounts, at five concurrent calls, and reports any omitted providers with `account_limit`. The account selector still includes all successfully discovered accounts, so selecting one avoids the aggregate fan-out limit.

Gmail reads cover the locally synchronized cache. Accounts undergoing initial import have `status: syncing`; they are not represented as complete provider history. Reconnect/rate-limit/error states remain visible while cached messages can still be read. Archive excludes inbox, sent, draft, spam, and trash; starred excludes draft, spam, and trash. Cloudflare uses its existing folder membership.

The keyset order is descending timestamp, ascending account ID, ascending provider message ID. The cursor is validated and bound to the account/folder/query selection. Newer arrivals require refresh and do not shift older pages. This is a live view, not a snapshot: deleting messages or changing folders between requests changes later results. If an account fails on a page and later recovers, refresh the list to include its previously skipped rows. `hasMore` refers only to accounts that were successfully read; `issues` must remain visible in the UI.

## Verification and next task

Tests use synthetic mail only; no real account login or mail transport was used.

- `node --import tsx --test tests/inbox.test.ts`: five tests passed for identity collisions, tie pagination, account isolation/filter validation, safe partial failure, and arrivals during pagination.
- `node --import tsx --test tests/inbox-integration.test.ts`: one test passed against real local workerd Durable Object SQL and R2; checks fractional-millisecond ordering, folder/search filters, account selection, and SQL injection input as a literal search.
- `node --import tsx --test tests/providers-accounts.test.ts`: thirteen tests passed, including reverse-ID/date ordering, composed Gmail folder/search filters, cross-account isolation, and explicit cache scan refusal.
- `npm run typecheck`: passed after generated Cloudflare/React Router types (generated files remain ignored).
- `npm test`: all 82 tests passed, zero failures; includes existing automation, delivery, account, OAuth, and desktop-policy coverage.

Exact next task: cherry-pick the implementation commit into the parent unified-inbox branch; connect the root screen to the shared response contract, render `issues` and sync status, and use provider-specific existing APIs for detail/actions. Run the integrated UI build and browser scenarios before the parent handoff. No deployment or remote integration was performed by this task.
