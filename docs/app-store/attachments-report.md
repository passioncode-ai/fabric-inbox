# REL-04 attachment transport handoff — 2026-09-27

Objective and scope: [bounded attachment transport packet](tasks/attachments.md), based on `d23137c`. Implementation and tests are committed as `d2e879804ffeab375ee45539d4f24d66e2fed7fd` on `codex/release-attachments`. File/line references below refer to that immutable commit (`git show <commit>:<path>`). No UI, packages, credentials, provider messages, deployment or upload changed in this task.

## Completed contract

[shared/mail/attachments.ts](../../shared/mail/attachments.ts):2 defines the shared wire shape used by Gmail and Cloudflare: `{content, filename, type, disposition, contentId?}`. Content is canonical padded RFC 4648 base64; missing attachments remain supported. Every file is validated before any send reservation or provider call. Lowercase MIME types and a fixed metadata field order form the canonical representation. Malformed padding, nonzero padding bits, URL-safe/whitespace base64, control characters, path separators, invalid UTF-8 filenames and injected header metadata are rejected.

| Product limit | Value and receipt |
| --- | --- |
| Aggregate decoded attachment bytes | 5 MiB = 5,242,880; validator constants at `shared/mail/attachments.ts:10` |
| File count | 10, including zero-byte files; `shared/mail/attachments.ts:27` |
| Filename | 255 UTF-8 bytes; `shared/mail/attachments.ts:43` |
| Media type | 127 ASCII characters, `type/subtype` without parameters, canonicalized lowercase; `shared/mail/attachments.ts:46` |
| Disposition | Required `attachment` or `inline`; `shared/mail/attachments.ts:48` |
| Content-ID | Optional bare identifier, at most 200 ASCII characters; `shared/mail/attachments.ts:49` |
| Gmail HTTP send/draft request | 16 MiB serialized UTF-8 body, including base64 and JSON; `workers/routes/accounts.ts:28`, `:155`, `:231` |

The limits above are product limits, not a claim about provider account quotas. Gmail returns HTTP 413 for attachment size/count and HTTP 400 for invalid metadata. Cloudflare retains its existing HTTP 400 `INVALID_REQUEST` mapping for both size and metadata errors (`workers/durableObject/index.ts:215`, `workers/routes/reply-forward.ts:17`). Gmail's existing 100-recipient and 1,000,000-code-unit text/HTML limits remain (`workers/providers/gmail-client.ts:163`).

[workers/providers/gmail-client.ts](../../workers/providers/gmail-client.ts):223 wraps plain text or multipart/alternative in multipart/mixed, wraps binary base64 at 76 columns, and emits RFC 2231 UTF-8 filename continuations. The postal-mime roundtrip test covers all byte values, UTF-8/quoted filenames, inline Content-ID, both body alternatives, To/Cc/Bcc, selected sender and reply headers (`tests/attachments.test.ts:9`, `:49`). Encoding uses bounded string conversion (`workers/providers/gmail-client.ts:137`); a full-limit workerd test exercises this (`tests/attachments.test.ts:58`).

Gmail's durable digest now includes canonical content and all attachment metadata, while retaining the previous digest shape for absent/empty attachments (`workers/providers/account-service.ts:505`). A changed file under an existing key conflicts, and an unknown send remains unknown after restart without another provider call (`tests/providers-accounts.test.ts:452`, `:471`). Cloudflare already hashes the full request; validation and normalization now happen before that hash and before reservation (`workers/durableObject/index.ts:174`). Both adapters reject header controls before sending.

## Storage evidence and decision

Both mailbox and Gmail DO classes are declared SQLite-backed in `wrangler.jsonc:65`. Cloudflare documents a **2 MB maximum SQL string/BLOB/table row**, and a **2 MB combined key/value limit for SQLite storage**. The separate legacy KV-backed limit is **128 KiB per value**. Source checked on 2026-09-27: [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

The mailbox already stores the prepared request in transactional **32,768-character SQL chunks**, not one giant value (`workers/actions/outbox-store.ts:59`). That existing architecture accommodates the 6,990,508 base64 characters required for one 5 MiB file; no blob-reference redesign or lower attachment limit is needed. Projection stores decoded attachment bytes in R2 (`workers/durableObject/index.ts:147`). The real local workerd/SQL/R2 test sends at the exact limit, reads matching R2 bytes, replays the same receipt once, and rejects changed content (`tests/outbox-integration.test.ts:219`).

Gmail persists a receipt/digest rather than the raw MIME or file content (`workers/providers/account-service.ts:531`). Its full-limit service test verifies every stored fixture value stays under 4 KiB and preserves the original thread ID (`tests/providers-accounts.test.ts:481`). The original unknown-outcome behavior remains conservative: payloads are not retried automatically.

## Checks actually run

- Red first: the new postal-mime roundtrip test failed with `attachments_not_supported` against the starting implementation; passed after MIME support.
- Focused transport/storage tests passed, including malformed second-file rejection with zero reservations/effects, exact/over-size limits, unknown replay and real SQL/R2 persistence.
- Final `npm test`: exit 0, **100 tests passed, 0 failed**.
- Final `npm run typecheck`: exit 0, including Wrangler and React Router type generation. Direct `tsc -b` before generation had missing environment/router types and one new ES2024 string-method error; the method was replaced with ES2022-compatible validation before the successful complete typecheck.
- `git diff --check`: exit 0 before implementation commit.
- No external provider calls: tests use injected transport functions and local Miniflare. Dependencies came from the controller-provided workbench node_modules through a local-only symlink; generated types and caches are untracked.

Self-review checked validation ordering, digest canonicalization, no-attachment digest compatibility, CRLF refusal, MIME nesting and filename encoding, request gates, actual storage backend limits and unknown-send replay behavior. Runtime tests caught the second old 3 MB route gate; both send and draft gates now use the declared body limit.

## Open work and exact next task

The controller must separately review and integrate this branch. This report is not release approval or remote delivery.

Forwarding **does not copy the original files automatically**: Cloudflare's forward branch clears thread headers and sends only the request's explicit attachments (`workers/durableObject/index.ts:202`); the real integration test confirms an original with a file produces a forward without files when none are supplied (`tests/outbox-integration.test.ts:236`). Gmail likewise sends only the attachment objects submitted in its SendInput. The existing Cloudflare Sent projection still sanitizes filenames for R2 metadata (`workers/durableObject/index.ts:149`); provider attachment filenames are passed through the validated contract.

Next task: integrate the shared contract into the separate composer/reply/forward UI packet, add file selection/removal and limit/error feedback, and explicitly retrieve/re-encode any original attachments selected for forwarding. Preserve selected account, recipients and thread information, and keep the existing unknown-outcome UI from offering an automatic resend. Transport support alone does not complete that UI work.
