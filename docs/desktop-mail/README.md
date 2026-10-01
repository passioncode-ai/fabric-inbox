> **History — do not follow as instructions.** Current entry: [release entry](../app-store/README.md); status authority: the [roadmap](../app-store/tasks/2026-09-28-roadmap.md). PR #1 was merged into `main` on 2026-09-27 (`gh pr view 1 -R passioncode-ai/fabric-inbox`: MERGED); the `codex/*` branches named below no longer exist on the remote.

# Latest: unified account workbench

Start at [workbench handoff](workbench-handoff.md) for the updated UI, canonical Fabric themes, website/profile publication and repository index. [Verification](workbench-verification.md) distinguishes local checks from live-provider acceptance.

# Fabric Inbox — handoff

Objective: build the owner's desktop mail client from Cloudflare's Agentic Inbox template (imported as `93b86c6`), covering Cloudflare, Gmail and other accounts, plus AI rules and tools. macOS and cloud automation were approved. **Current delivery is a working initial implementation; live-account acceptance and several requested capabilities remain open.**

Owner: `https://github.com/passioncode-ai/fabric-inbox.git`; working branch `main` (all `codex/*` branches consolidated on 2026-09-27, see [release continuation](../app-store/verification.md#delivery-and-exact-continuation)); upstream source ancestor `93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c`. The original Cloudflare Worker was not modified. `fabric` was the operator's product family; the verified organization containing the Fabric repositories is `passioncode-ai`.

Implementation source snapshot: `fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf`. Documentation-only follow-ups may be newer; see the immutable links in implementation.md.

## Read and run

- [Implementation and exact checks](implementation.md)
- [Runtime/OAuth/tool setup](setup.md)
- [Approved scope and unresolved provider/tool inventory](brief.md)
- [Task packets and statuses](tasks/README.md)
- [Target architecture and current deviations](architecture.md)
- [Formal UX coverage](../ux/README.md)

Run `npm ci`, `npm run dev`, then `npm run desktop`. Enter the dev server's loopback URL in the desktop setup. Package with `npm run desktop:package -- arm64`. The root arm64 bundle was built and opened against the local app; its receipt/hash lives in implementation.md.

## Completed in this change

- Dedicated public repository; imported upstream code retains its Apache-2.0 notices in
  [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Deployment data stays local-only.
- Cloudflare persisted outbox with accepted/failed/unknown semantics, matching sender identity, incoming envelope-based deduplication and durable automation handoff. API and MCP sends share the coordinator.
- Gmail server OAuth/PKCE, AES-GCM credentials, account-scoped cache, history/expiry sync, cloud polling, durable send/draft receipts and incoming event outbox.
- Rule runner with exact configured actions, dry-run, approval/automatic mode, daily action cap, pause, incoming-event receipt and restart/uncertainty handling. Resolved tool proposals are tied to the original email digest.
- Accounts, per-account Gmail reading/composing, rules/history/outbox UI, persistent Gmail draft/recovery key, and isolated macOS Electron host.
- Source, bounded implementation reports and tests in Git. Detailed scope and non-live evidence are in [implementation](implementation.md); no production deployment/merge is implied.

## Open work and exact next task

**Next task: finish controlled provider acceptance before regular mail is routed.** Review [setup](setup.md), configure the new Fabric Inbox server/Access and Google OAuth application through normal provider administration, obtain the owner's account consent, and use dedicated test mailboxes to walk receive → read → reply → unknown-result recovery → rule preview → approval → pause. Record actual receipts without credentials/mail contents. A deployment and permission grant were not performed during this implementation.

Independent work can continue on T04 once the owner names the other email providers, and on the combined inbox/attachment paths in T07. The requested “all accounts” scope is still open. No connector from the coding agent substitutes for a runtime provider adapter.

Prerequisites: new Cloudflare resources/Access identity, Gmail client and consent, supported other-provider inventory, chosen controlled tool destination, production dependency-advisory review. No secrets should enter Git/chat. Additional open work: local device executor, offline cache, unified per-agent permissions, mailto, full Gmail threads/attachments, signing/notarization, retention and performance. The [task table](tasks/README.md) is the status authority.

## Validation and delivery boundary

Local focused tests, typecheck, build, native and browser observations are recorded in [implementation](implementation.md). Production OAuth, actual delivery, real model/tool calls and nightly hosted checks were not run. Missing hosted checks are not passing checks.

Keep dependencies, `.wrangler`, `.react-router`, generated types, `build`, desktop `release`, local application settings/cookies and secrets out of Git. The branch is a source handoff, not a deployment or package release. Validate remote branch access from a fresh checkout before handoff; do not force-push or overwrite unrelated work.

## Delivery receipt

Remote branch `codex/fabric-inbox` was cloned from GitHub into a fresh checkout at `48ce8a1008092617916b545979ecbe6ad609554d`. Validation found the handoff, checked 113 relative Markdown links with zero unresolved paths, and confirmed package/lock direct dependency maps match. This receipt is a documentation-only follow-up to that checked tree. The implementation source snapshot above is unchanged.

[Draft PR #1](https://github.com/passioncode-ai/fabric-inbox/pull/1) contains the change. Draft status reflects the open live-provider and feature acceptance; it is not a merged release.
