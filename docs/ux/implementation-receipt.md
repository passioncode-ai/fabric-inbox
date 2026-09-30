> **History — do not follow as instructions.** Current entry: [release entry](../app-store/README.md); status authority: the [roadmap](../app-store/tasks/2026-09-28-roadmap.md). Receipt of the unified-workbench integration; attachment compose and multiple drafts shipped later, and there are now 27 scenarios.

# Integration coverage receipt — 2026-09-26

Scope: update the formal chain and bounded string registry for the root integration working tree. Source and docs must be committed together by root. Legacy references retain their existing source lines. New unified-workbench references name the source file and function while root completes formatting; root must resolve them against the final integration commit. This is a partial coverage receipt, not an end-to-end UX PASS or a production deployment report. Entry: [scenarios](scenarios.md), [screens](screens.md), [research ledger](research-ledger.md).

## Current behavior and open work

| Surface | Evidence | What remains open |
|---|---|---|
| Desktop startup/session | `desktop/main.cjs:30`, `desktop/main.cjs:74`, [native receipt](../../.task-pipeline/build/fabric-inbox/desktop-report.md) | Native synthetic setup/isolation/session restart observed; real Access login/IdP handoff, mailto and offline mailbox cache remain unverified or absent |
| Accounts and unified inbox | `app/routes/unified-inbox.tsx` (`UnifiedInbox`, `scope`), `workers/routes/inbox.ts`, `app/routes/fabric-accounts.tsx` | Combined cached mail and in-place account filtering exist. Root observed synthetic all-account and one-account views (RE-009); live OAuth and full-history completeness remain unverified. Outlook/IMAP are absent |
| Unified read/search/attachments | `app/routes/unified-inbox.tsx` (detail query, search form, `download`), `app/components/inbox/model.ts` (`messagePath`) | Account-aware individual messages, scoped cached search and downloads are wired. Full threads, real attachments and full provider-history search remain unverified or absent |
| Workbench drafts and sending | `app/routes/unified-inbox.tsx` (`compose`, draft storage effects), `app/components/inbox/Composer.tsx` (`send`), `app/components/inbox/send-state.ts` (`sendRecovery`) | One device draft retains sender, with storage failure shown inside the dialog. Locked sends retry the same immutable attempt. Live provider sending, cross-device drafts and live-session restoration remain unverified |
| Forward/reply | `app/routes/unified-inbox.tsx` (`compose`), `app/components/inbox/Composer.tsx`, `app/components/inbox/send-state.ts` (`replyRecipient`) | New mail has sender selection; reply keeps its account fixed. Forward converts available HTML to text and excludes attachments. Reply-all, attachment compose and full-thread acceptance remain open |
| Fabric appearance | `app/routes/unified-inbox.tsx` (`toggleTheme`), `app/root.tsx`, `app/styles/fabric-tokens.css`, `desktop/fabric-tokens.css` | White/light default and stored dark preference, with root synthetic reload observation. Shared website-token provenance is RE-010; no complete accessibility claim |
| Rules and dry-run | `app/routes/automation.tsx:121`, `app/routes/automation.tsx:390`, `workers/automation/index.ts:206` | Local disabled-rule save was observed. Dry-run is optional, not an enforced activation gate. No actual model/tool preview acceptance |
| History/approval/outbox | `app/routes/automation.tsx:433`, `workers/automation/engine.ts:20` | Partial UI fields: source links/version/attempt/cost completeness still open. Local synthetic effect boundaries tested; live tools and production execution not accepted |
| Device/offline | `workers/automation/engine.ts:77`, `desktop/setup.html:27` | Waiting-device state exists without a local runner. Desktop displays recovery instead of offline mail; original offline requirement remains open |

## Evidence actually available

RE-004 is the delegated native walkthrough recorded in the desktop report: local synthetic HTTP fixture, denied nonlocal HTTP setup, connection refusal/retry, no remote Node or setup bridge, and packaged restart with a test cookie. It does not establish production authentication.

RE-005 is root-reported `npm test`: 74 passing tests, including seven desktop tests and eight real workerd integration cases over synthetic mailbox data. The eight workerd cases are defined by six standalone tests and a two-action approval loop in `tests/automation-integration.test.ts:143`, `tests/automation-integration.test.ts:170`, `tests/automation-integration.test.ts:196`, `tests/automation-integration.test.ts:215`, `tests/automation-integration.test.ts:239`, `tests/automation-integration.test.ts:265`, `tests/automation-integration.test.ts:290`. They cover duplicate input, archive/read approval boundaries, pausing, durable handoff, restart without replay, rule-edit replay and changed-message rejection. Root also reports typecheck passed. These are inherited execution receipts, not commands rerun by this documentation subtask.

RE-006 is root CUA at `http://127.0.0.1:5173/accounts` and the automation page of a local synthetic mailbox: not_configured Gmail, unavailable other providers, and creation of a disabled approval archive rule using a local synthetic mailbox. Root observed Paused, Requires approval, archive and the configured daily limit, plus empty runs/outbox; screenshot inspection found no overflow. No incoming real mail or external action occurred. This was a local browser run, not production.

RE-007 adds root native CUA evidence: the packaged root release app progressed from setup to `http://127.0.0.1:5173` and displayed the local home. It adds no live authentication/provider acceptance.

No scenario is promoted to implemented, no screen to built, and no Product state to observed. Existing validated/draft statuses express requirement approval only. All twenty scenarios retain explicit Today boundaries; SCN-004–012 now cover the unified UI, preserving their original IDs and target requirements. The original target behaviors remain intact instead of being narrowed to current code.

## Unified workbench follow-up

RE-008 carries the owner's all-account/filter and white/dark request. RE-009 records the root-reported synthetic browser walkthrough: three accounts, six messages, source-labeled Gmail reader, one-account filter with two messages, theme toggle and persistence on reload. RE-010 identifies canonical website tokens and a scoped website contrast check. Those observations are inherited from root; this documentation subtask did not operate the browser or use real mail.

Root reports 85 tests passing before the latest UI checks, plus typecheck/build passing. This is a prior scoped execution report, not a final integrated test count. [Workbench verification](../desktop-mail/workbench-verification.md) owns the exact final test totals, commands and browser results; further results must not be inferred from this record. Figma stays deferred, every Product field stays unobserved, and no complete scenario is accepted by a synthetic render alone.

## Documentation checks

Checks ran in a temporary assembled copy of root's current tracked/untracked source plus this branch's documentation, without modifying the root worktree. `python3 docs/ux/lint.py` exited 0 with 0 errors and 5 U040 warnings, all for the root-owned `docs/desktop-mail/workbench-verification.md` that had not yet been written. `python3 docs/ux/doctor.py .` exited 0 on ux-contract v4; optional vision is absent. `python3 docs/brand/lint.py` exited 0 with 0 errors and 274 unregistered-string warnings. `git diff --check -- docs/ux docs/brand` exited 0 in the docs worktree. The brand scan includes imports and CSS literals, so the registry does not add those as product copy. Root must rerun after final formatting and receipt creation. These checks validate document consistency and source wording, not provider behavior.

## Handoff and exact next task

Root integrates this docs-only commit with the matching workbench implementation, writes [workbench verification](../desktop-mail/workbench-verification.md), then reruns UX lint, doctor and brand lint against the final source. Preserve the approved all-account goal, source identity, cached-search boundary, text-only forwarding and locked unknown-send behavior. Continue controlled OAuth/mail/tool/desktop acceptance before claiming full scenarios; the current fixture pass does not authorize or prove a real send.

This packet owns only `docs/ux/{foundation,scenarios,flows,screens,research-ledger,implementation-receipt}.md` and `docs/brand/{facts,voice,terminology,strings}.md`. Shared implementation context is [workbench brief](../desktop-mail/workbench-brief.md). Root owns implementation, final checks, integration, remote delivery and any deployment.
