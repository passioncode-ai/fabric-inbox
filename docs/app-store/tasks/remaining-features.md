> **History — do not follow as instructions.** Current entry: [release entry](../../app-store/README.md); status authority: the [roadmap](../../app-store/tasks/2026-09-28-roadmap.md). R1–R8 are superseded by the roadmap: R1/R2 → L1, R3 → L4, R5 → P2–P4, R7/R8 → W1 and release.

# Remaining release packets — proposal pending product decisions

Owner and status: [release entry](../README.md). Existing behavior and gaps are in [20 scenario contracts](../../ux/scenarios.md); this document defines future acceptance, not implemented features. Shared contracts: `shared/mail/inbox.ts` (account-scoped identity), `shared/mail/attachments.ts` (attachment bounds), `workers/providers/account-service.ts` (provider operations), `app/components/inbox/draft-store.ts` (per-draft revision/locked attempt), `desktop/main.cjs`/`preload.cjs` (desktop boundary). Keep those identities and uncertain-outcome semantics across every packet.

## R1 — Account ownership and first run (REL-01/02; SCN-001–004)

Delivery model decided 2026-09-28 ([decision](../architecture-options.md#decision--operator-2026-09-28)): local client for personal accounts, Cloudflare for project addresses; this packet becomes L1 in the [roadmap](2026-09-28-roadmap.md). Before the decision it read: blocked by the delivery-model answer. Choose local consumer client or explicitly shared own-server workspace; public multi-tenant service requires a separate isolation contract. Define connection/reconnect/revoke, token holder, cache holder, account removal and deletion before implementation. First run displays actual supported providers; a disconnected account retains its identity and drafts, explains the failure and gives reconnect. No automatic reassignment to another sender. Acceptance: two accounts with colliding provider IDs stay separate; cancelled OAuth leaves no account; revoked tokens stop access; removing one account cannot erase another account's mail. Controlled provider accounts and applicable OAuth registrations are prerequisites. Split local runtime/bridge and provider adapters into separately reviewable tasks after the decision.

## R2 — Complete provider adapters (REL-02; SCN-002–005/007–011)

Gmail and Cloudflare have partial implementations; Outlook and IMAP/SMTP remain absent (`app/routes/fabric-accounts.tsx`). Implement each against one capability matrix: OAuth/password mechanism, list/detail/thread/search, incremental sync, read/star/archive/trash/restore, attachments, MIME send and uncertain acceptance. IMAP needs UIDVALIDITY/UID identity and invalidation; SMTP timeout after DATA cannot become definite failure. Do not model Outlook categories as Gmail labels. Host/TLS errors stay actionable; no silent TLS downgrade. Acceptance: controlled incoming message, reply, binary attachment, trash/restore and revocation per provider; provider-limited features are disabled with a reason. Requires R1 transport/storage choice and appropriate test accounts, not credentials in Git.

## R3 — Complete conversations and search (REL-04/05; SCN-005/008)

Unified reader needs full conversation membership, Reply all and recipient editing. Deduplicate addresses, exclude the active identity from Reply all, honor Reply-To, retain thread references and fix the sender to the source account. Search must label cached versus provider scope and give a path past paginated cached results. Acceptance: sent-message reply, aliases, duplicate To/Cc, missing references, cross-account provider-ID collision and empty search; no hidden account switch. No generic claim of full-provider-history search until that path exists.

## R4 — Offline, synchronization and upgrades (REL-05/07; SCN-001/012/019/020)

Depends on R1. Package a usable renderer, define per-account cache location/encryption/deletion and versioned migrations. Offline startup exposes previously cached messages and local drafts with last-sync state; sending while offline must distinguish unsent from possibly accepted. Reconnection reconciles provider changes and uncertain receipts before resending. Do not queue permanent deletion. Acceptance: airplane-mode cold start, account isolation, failed upgrade preserving previous data, corrupt record recovery and no duplicate sends after connection loss. Current server cache and local drafts alone do not satisfy this packet.

## R5 — AI and rule controls (REL-06; SCN-013–017/020)

Apply agent-stack when implementing this agent system. Before data transfer, show processor, selected message scope and intended action; store account/rule-specific consent and enforce it server-side. Embed explain/draft in the unified reader; sending, forwarding and remote tools require explicit configured authority. Incoming text is untrusted data, never a source of tool permissions. Rule editor must support dry-run without effects, enable/pause, bounded actions, per-run history, approval/rejection and idempotent resumption. Acceptance: prompt-injection mail cannot add destinations/tools; paused/revoked rules stop new actions; duplicate delivery causes one action; rejected approval causes no effect; timeouts retain unknown outcomes. Use synthetic evals before controlled live accounts. AI processor/retention and R1 cloud/local split must be decided before consent wording becomes a public policy.

## R6 — Desktop actions within sandbox (REL-07; SCN-018)

First define a fixed allowlist of supported actions. No arbitrary shell/MCP installation assumption in the store build. Narrow authenticated IPC binds request to the trusted main frame/account/action; user-selected files use sandbox-supported access. Mailto opens an editable draft without auto-send; notifications need account/message deep links and a privacy preference. Acceptance: forged child-frame IPC denied, unavailable action explained, denied permission does not loop, app-offline run remains waiting, and release sandbox demonstrates every promised capability. Requires R1 packaged renderer and a signed sandbox development build.

## R7 — Privacy, retention and store content (REL-09; SCN-001/003/012/013)

Build a data-holder table for tokens, mail/cache/files, drafts, send receipts, prompts/results, remote tool arguments and diagnostics. For each: holder, purpose, retention, deletion, third parties and consent. Implement account removal/deletion according to actual architecture; verify it before publishing the policy. Public copy must distinguish development, beta and live availability; keep site/org links consistent. Screenshots must come from the real candidate with synthetic mail and both themes. Seller, pricing and R1/R5 decisions are prerequisites; no invented App Privacy declarations.

## R8 — Release acceptance and submission (REL-08/10; all scenarios)

Use [MAS procedure](../mas.md), [store requirements](../store-requirements.md), an exact clean source revision and signed sandbox candidate. Test clean install, update, OAuth callback, account isolation, receive/read/send/reply/forward, attachments, offline/reconnect, rule consent/approvals and accessibility in light/dark themes. Record failures and actual provider receipts without private payloads. Store review needs a usable review account/environment and truthful notes; upload/processing/TestFlight/review/live are separate states. Only after a live store URL is verified update the website and org product links to a download call to action. Existing main/submodule pins are not advanced to unreviewed branches.

## Exact next task

Record the operator's delivery-model answer in the architecture decision, then split R1 into renderer/runtime and account ownership packets with explicit holder/bridge contracts. In parallel, confirm seller/team access and pricing. Re-run capture-race review and combined verification before any integration; remaining hosted-toolchain audit advisories and live provider checks are release gates, not waived warnings.
