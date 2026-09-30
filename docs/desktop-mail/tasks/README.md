> **History — do not follow as instructions.** Current entry: [release entry](../../app-store/README.md); status authority: the [roadmap](../../app-store/tasks/2026-09-28-roadmap.md). The T00–T08 table is frozen; T04 → roadmap L1, T07 → shipped unified inbox and attachments, T08 → P6/release.

# Queue and bounded task packets

Status source: this table. Read: `cat docs/desktop-mail/tasks/README.md`.
Shared inputs of every packet: [brief](../brief.md), [contracts](../architecture.md), [evidence](../evidence.md). The paths in the original scope are targets; the actual implementation and the receipt for each packet are below. Task-pipeline stage five used bounded subagents. Full acceptance is different from the existence of code.

| ID | Result / scope | Dependency and what it hands over | Acceptance | Status |
|---|---|---|---|---|
| T00 | Agreed brief, runtime D01, full UX chain in docs/ux; platform/design/copy decisions | User request + evidence | Runtime and scope recorded; UX lint; unconfirmed decisions named explicitly | complete: approved brief + formal UX/brand chain; details remain draft |
| T01 | Provider/action contracts and the outbox/policy core; shared/mail/, workers/actions/, workers/db/ | T00: runtime boundary and approved requirements | Deny without a side effect; crash/unknown send; fixture migration; typed errors; REQ-007/009 | implemented/tested: outbox; unified per-agent grant layer remains open |
| T02 | Cloudflare adapter and event ingestion; workers/index.ts, workers/lib/tools.ts, workers/mcp/ | T01: IDs, policy, outbox, event schema | Receiving and repeats, attachment, API/agent/MCP through one executor; REQ-002/009 | implemented/tested: receive dedup + durable handoff; live acceptance open |
| T03 | Gmail adapter + OAuth/sync; workers/providers/gmail/ or a desktop service per D01 | T01: Account/MailProvider/Cursor; D01: token storage | Two accounts, history expiry, revoke, duplicate events, provider send receipt; REQ-003 | implemented/tested: Gmail cloud; OAuth/live acceptance open |
| T04 | Inventory of the "other" providers, IMAP/SMTP adapter, the separate provider adapters that are needed | T01: contracts; D01: host; D02: a verifiable list of providers | UIDVALIDITY, folder/label mapping, reconnect, SMTP unknown, the agreed list closed; REQ-004 | open: provider inventory; IMAP/Outlook absent |
| T05 | Durable rule runner, AI proposals, budget/pause, event/run ledger; workers/automation/ or a local runtime | T01/T02: durable events and grants; D01: runtime | Dry run, history import without actions, duplicate/crash/loop/budget/injection fixtures; REQ-006/007/009 | partial: durable rules and approval tested; real model/evals/cost meter open |
| T06 | Outbound tool registry/MCP + device executor; workers/integrations/, desktop service | T05: action proposals/runs; T01: grants; D03: selected tools | Mock read/write, denied arguments, timeout, waiting_device, one real agreed integration; REQ-008/009 | partial: cloud MCP path; live tool/device executor absent |
| T07 | Desktop shell + unified inbox/compose/accounts/rules/history; desktop/, app/ | T00: validated UX; T01: transport/contracts; T02/03/04: provider behavior; T05/06: rule UI contracts | macOS artifact, cold start, offline/reauth, two accounts, correct From, mailto, attachments, journal; REQ-001/005/009 | partial: arm64 host + per-account UI; unified inbox/offline/mailto/attachment gaps |
| T08 | End-to-end verification, packaging, docs, an agreed release | T02…T07: integrated version and receipts | Full REQ walkthrough on fixtures and then on dedicated real test mailboxes; artifact hash, a signature if distributed; no silent deploy | partial: local checks/artifact; live acceptance/deploy/signing open |

## Continuation after the first implementation

The next operational packet is T08 controlled acceptance per [setup](../setup.md). Independent development: T04 after the provider list, T07 unified inbox/attachments, T06 device runner only for a real selected tool. Do not declare the all-accounts task done while the adapter for a specific provider is missing.

Shared contracts/receipts: [as-built](../implementation.md), [core](../../../.task-pipeline/build/fabric-inbox/core-report.md), [Gmail](../../../.task-pipeline/build/fabric-inbox/gmail-report.md), [desktop](../../../.task-pipeline/build/fabric-inbox/desktop-report.md), [UX](../../ux/implementation-receipt.md). The original carry-over entries below are historical.

## Packet boundaries and checks

T01 changes only contracts/persistence/execution and the tests of those operations; T02 moves the existing entry points onto them. Shared contract changes in T03…T07 are agreed with T01, not copied into provider folders. At each integration: typecheck/build, targeted tests, the diff and documentation in the same change; do not run the full hosted CI on every push. T08 includes a browser/desktop walkthrough and explicit runtime prerequisites, not only a green compile.

## Carry-over (append-only)

- 2026-09-26: REQ-001…REQ-009 are open; this push contains only the intake. Next action — T00.
- 2026-09-26: D01 was put to the operator; D02/D03/D04 have a latest decision point in the brief. Their absence is not permission to choose real credentials, recipients or publication.
- 2026-09-26: auth/login blocking the authenticated baseline UI was left as not checked; it is not a reason to switch off Cloudflare Access.
- 2026-09-26: the original send state and repeated ingestion belong to T01/T02; they are not fixed in this packet.

- 2026-09-26 implementation: T00 complete; T01–T03 source/test slices integrated; T05–T08 partial. Current exact next task is in README; earlier intake-only statements are superseded.

## Saved delegation packets

- [Core brief](../../../.task-pipeline/build/fabric-inbox/core-brief.md)
- [Gmail brief](../../../.task-pipeline/build/fabric-inbox/gmail-brief.md)
- [UX brief](../../../.task-pipeline/build/fabric-inbox/ux-brief.md)
- [Desktop brief](../../../.task-pipeline/build/fabric-inbox/desktop-brief.md)

These are the original bounded packets; the actual status is determined by the table above and the implementation receipts, not by the expected results in the prompt.
