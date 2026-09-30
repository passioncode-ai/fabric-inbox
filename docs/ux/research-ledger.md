# Evidence ledger

| ID | Kind | Source | Date | Supports | Limits |
|---|---|---|---|---|---|
| RE-001 | brief | [Approved brief](../desktop-mail/brief.md), approved status, requirements REQ-001..009 and D01/D04 | 2026-09-26 | P-01, jobs, macOS and cloud execution | Owner request, not usability research |
| RE-002 | code-inference | [Commit-addressed source inventory](../desktop-mail/evidence.md) | 2026-09-26 | Existing mail surfaces and known send-state defect | No authenticated UI or delivery observed |
| RE-003 | brief | [Brief D02/D03](../desktop-mail/brief.md) | 2026-09-26 | Provider and tool unknowns | No invented provider list or recipients |

No opportunity scores, emotion ratings, retention rates or outcome signals have been measured. All remain unknown. No competitor/reference sweep was performed; this bounded task derives the chain from the approved brief and repository inventory.

## Integration evidence added 2026-09-26

- RE-004: scoped native engineering observation in [desktop report](../../.task-pipeline/build/fabric-inbox/desktop-report.md). Local synthetic HTTP fixture, setup validation, connection-refused recovery, no remote Node/bridge, packaged restart with a test cookie. Not a real account or human usability session.
- RE-005: root-reported passing local workerd integration run; test definitions in `tests/automation-integration.test.ts:143` (duplicate ingestion), `tests/automation-integration.test.ts:170` (two approval cases), `tests/automation-integration.test.ts:196` (pause), `tests/automation-integration.test.ts:215` (durable handoff), `tests/automation-integration.test.ts:239` (restart), `tests/automation-integration.test.ts:265` (rule edit replay), `tests/automation-integration.test.ts:290` (changed mail). Eight cases: six standalone plus the two action cases. Real durable objects over synthetic mailbox fixtures; no provider delivery, model or external tool outcome implied.
- RE-006: root CUA receipt, 2026-09-26, local development server `http://127.0.0.1:5173/accounts`: Gmail not_configured and other providers unavailable. At the automation page of a local synthetic mailbox, root created a disabled approval rule named Archive receipts with subject receipt, saved it and observed Paused / Requires approval / archive / 20 per day plus empty runs/outbox. Root inspected the screenshot without overflow. Mailbox and rule were local synthetic fixtures; no real message or external action occurred. Source: `app/routes/fabric-accounts.tsx:61`, `app/routes/automation.tsx:121`, `app/routes/automation.tsx:433`. This is not a production deployment receipt.

The original persona/job validation axes and Product states remain unchanged. Engineering tests and app fixtures cannot supply observed product outcomes.

- RE-007: root native CUA receipt, 2026-09-26: the packaged app from the root release directory opened setup, accepted `http://127.0.0.1:5173`, and displayed the local app home. This verifies packaged-host connection to the running local app only; no live authentication or provider account was exercised. Host entry: `desktop/main.cjs:74`; root home: `app/routes/home.tsx:31`.

## Unified workbench evidence added 2026-09-26

- RE-008: owner request recorded in [workbench brief](../desktop-mail/workbench-brief.md): see all accounts and their mail together, filter one account in place, and use white/light and dark Fabric themes. This refines ST-002 and SCN-004/012 without changing personas or claiming a user outcome.
- RE-009: root-reported browser engineering observation at a local synthetic fixture on port 5183: three accounts and six messages loaded in the real workbench; the Gmail reader opened, a one-account filter showed two messages, and dark theme survived reload. This is synthetic data, not real mail or OAuth acceptance. Source: `app/routes/unified-inbox.tsx` (`UnifiedInbox`, `scope`, `toggleTheme`). Root owns the detailed and subsequent results in [workbench verification](../desktop-mail/workbench-verification.md); this ledger does not anticipate composer, narrow-window or live-effect acceptance.
- RE-010: canonical visual source is website `design-system/tokens.css`, website commit `6085d1073b28dc3b97fb9b029350a038d20afd3c`, SHA-256 `86866df1bec49b85e9def4132021401894483bb819dc2d3a3a70511d2e4b2a61`. Root reports a website check of 35 scoped light/dark text pairs with minimum 5.29:1. This is inherited token evidence, not a complete workbench render, focus, contrast or accessibility verdict. Local integration and exact checks belong in [workbench verification](../desktop-mail/workbench-verification.md).

The unified UI and API source inventory comes from the root integration tree; new source locators name files and functions so formatting cannot silently turn them into unrelated line citations. No scenario is promoted to implemented and Product stays unobserved. Figma remains deferred.

## Release work requested 2026-09-27

- RE-011: operator requested design and completion of missing features and Mac App Store release. [Release requirements](../app-store/README.md) retain the full SCN-001–020 scope and name unimplemented/externally blocked capabilities. REL-03 refines the existing accepted draft/restart/recovery requirement to independent drafts; this is owner-authorized work, not observed user validation. Store distribution/hosting/pricing questions are pending. Product states remain unobserved.
