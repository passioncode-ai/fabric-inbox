# Local backlog

This is the canonical status source for the tasks below. Keep stable IDs, close with a
receipt in Source, and retain closed rows. The workspace derives its common backlog
from [backlog-sources.json](backlog-sources.json). Dated handoffs remain historical evidence.

| ID | Item | Status | Source |
|---|---|---|---|
| P6 | Finish remaining live acceptance: Gmail and documented external-mail cases | open | [Roadmap acceptance](app-store/tasks/2026-09-28-roadmap.md#p6--deploy-and-live-acceptance); [current handoff](app-store/README.md) |
| L1 | Server-side IMAP/SMTP accounts with app passwords (amended 2026-10-06 by operator decision: credentials on the server, encrypted, not the Mac Keychain; mail and agents keep working with the Mac closed) | done | 0.11.0 WS4, branch `ws4-providers-imap` (receipt: `tests/imap-provider.test.ts`, `tests/imap-client.test.ts`, `tests/smtp.test.ts`, `tests/imap-routes.test.ts`; [architecture → IMAP accounts](architecture.md#imap-accounts-011-ws4)); [Track L](app-store/tasks/2026-09-28-roadmap.md#track-l--local-accounts-and-triage-coarse) |
| L2 | Metadata-first incremental sync with recent and unread messages first | open | [Track L](app-store/tasks/2026-09-28-roadmap.md#track-l--local-accounts-and-triage-coarse) |
| L3 | Finish cheap-model fallback after the shipped header-rule triage | open | [Track L](app-store/tasks/2026-09-28-roadmap.md#track-l--local-accounts-and-triage-coarse) |
| L4 | Focus view, collapsed groups, counts, filters and source account | done | [2026-09-28 implementation receipt](app-store/tasks/2026-09-28-roadmap.md#track-l--local-accounts-and-triage-coarse) |
| L5 | Bulk group actions with count preview and undo | open | [Track L](app-store/tasks/2026-09-28-roadmap.md#track-l--local-accounts-and-triage-coarse) |
| L6 | Define permitted links between mail and Fabric projects | blocked: domain decision required | [Track L](app-store/tasks/2026-09-28-roadmap.md#track-l--local-accounts-and-triage-coarse) |
| W1 | Describe shipped project-address and unified-inbox capability on the product page | done | [Current product page](https://passioncode.ai/inbox/); [0.8.2 release](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v0.8.2) |
