# REL-04 attachment composer handoff

Status: implemented; controller owns integration, shared registers and synthetic browser verification. Objective and ownership: [task packet](tasks/attachment-composer.md). Shared wire contract: [attachments.ts](../../shared/mail/attachments.ts). Draft context: [REL-03 report](drafts-report.md).

Implementation commit: `9ed052d6875f25aa0607b0196976240563b9c591`, branch `codex/release-attachment-composer`, baseline `7221353`. All source line references below name this commit. No real mail, deployment or integration was performed by this agent.

## Completed behavior and decisions

- [Composer.tsx](../../app/components/inbox/Composer.tsx), lines 70, 155, 190, 379: To/Cc/Bcc validate before locking, and both providers receive populated optional recipients and captured attachments. Empty optional fields stay omitted: Cloudflare's recipient schema rejects empty arrays, and legacy retry identity must remain stable. Reply/forward retain their selected sender; existing threading context and recovery keys survive.
- [attachment-store.ts](../../app/components/inbox/attachment-store.ts), lines 86, 150, 186: IndexedDB `files` records use unique IDs and `add`, never overwrite. Transaction completion acknowledges writes. localStorage contains allowlisted references, filenames, MIME types, byte counts and optional source IDs, never base64. Shared decoded-size/count/metadata validation runs before capture and again before sending. Empty files are valid under the shared contract; empty/malicious filenames and malformed types are not.
- Failed byte capture retains every selected reference, including missing records, so a reload cannot silently omit a quota-failed file. Preparation refuses any unavailable or mismatched record. Partial capture/failed cleanup may retain orphan bytes, deliberately favoring preservation.
- [draft-store.ts](../../app/components/inbox/draft-store.ts), lines 202, 278: Web Locks/revision guards remain; bytes are removed only after a read-back-acknowledged reference mutation, inside the draft lock. Save/accepted/discard failures retain referenced bytes. Initial quota failure can now be followed by a durable discard tombstone after storage recovers, while stale saves remain refused.
- [use-drafts.ts](../../app/components/inbox/use-drafts.ts), line 107, and [compose-payload.ts](../../app/components/inbox/compose-payload.ts), line 14: asynchronous attachment completion merges into the current draft identity without replacing newer message text. Switched drafts remain independent; deleted or locked drafts reject attachment completion.
- [unified-inbox.tsx](../../app/routes/unified-inbox.tsx), line 222, captures source attachment metadata when forwarding. Opening the composer does not retrieve bytes. The explicit action lists missing original files and retrieves all before installing references. Any missing/overlimit original refuses forwarding; retries send captured device bytes. Legacy editable forwards without source metadata ask the user to start again from the original; legacy locked text-only attempts retain their exact retry shape.

## Checks actually run

- `npm test`: **137 passed, 0 failed** on final implementation. [attachment-composer.test.ts](../../tests/attachment-composer.test.ts) adds 13 tests: reference reload and no base64 persistence; immutable retry; missing/tampered metadata; quota references; To/Cc/Bcc validation; empty/malicious/overlimit files; allowlist/ownership; removal/discard/accepted durability ordering; orphan retention; file-read/edit/switch races; forward completeness; initial quota discard; provider payload compatibility. Existing draft tests also pass.
- `npm run typecheck`: passed after required Cloudflare/React Router generation. Final `node_modules/.bin/tsc -b --pretty false`: passed after the payload and IndexedDB recovery changes. An initial direct invocation before generation failed on absent generated Env types; it is not the final result.
- `npm run build`: passed on final implementation. No package/lockfile changes.
- `git diff --check`: passed before implementation commit.
- `python3 docs/brand/lint.py`: **6 B021 errors, 313 warnings**. The errors name controller-owned baseline rows: `action.inbox.continue_draft`, `action.inbox.forward`, `state.inbox.draft_restore_failed`, `state.inbox.draft_save_failed`, `state.composer.forward_limit`, `state.composer.save_failed`. No claim of a passing brand gate.
- Actual browser IndexedDB transaction/quota/file-picker behavior: **NOT_RUN by this agent**. Tests use an immutable in-memory byte adapter and a localStorage-shaped adapter. Controller owns supported CUA checks; no raw Playwright, weakened Vite filesystem boundary or live-provider send was used.

## Controller's exact next task

Cherry-pick implementation and this report, reconcile shared brand/scenario rows, then use the synthetic preview through supported CUA. Exercise native file selection, filename/byte counts/removal, Cc/Bcc errors, file loading while typing, draft switch/reload, missing IndexedDB record, source-attachment loading failure, and immutable unknown-attempt retry. Check light/dark, keyboard focus and narrow layout. Keep all provider sends synthetic.

Scenario deltas for SCN-006/007/008/009: file selection never sends; adding/removing attachments has an explicit storage acknowledgement/error; unavailable file bytes refuse send before locking; reply/forward sender and context stay fixed; forward lists originals and requires all before sending; source fetch failure never produces a partial forward. The selected-file list can include an unavailable reference; the next send check explains removal/re-add for editable drafts. Locked attempts cannot substitute another file.

Proposed shared copy updates (controller-owned):

| Source | Required register change |
|---|---|
| `unified-inbox.tsx:756`, `Composer.tsx` heading | Replace “Forward text” with “Forward”; update terminology/facts that currently claim forwards always omit files |
| `Composer.tsx:379` | Add Cc, Bcc, Optional recipients, Optional hidden recipients |
| `Composer.tsx:418` | Add Add files; Up to 10 files, 5 MiB total. Files are saved on this device.; Remove and filename-specific accessible label |
| `Composer.tsx:463` | Replace text-only limit with missing-originals, selected-originals, no-originals and legacy-unavailable states; add Include original attachments |
| `Composer.tsx:498` | Add Loading and saving files… You can keep editing the message. |
| `Composer.tsx:155`, `attachment-store.ts`, `compose-payload.ts` | Register exact recovery strings for capture/quota failure, unavailable file, invalid metadata, count/size limit, changed draft, unavailable source and incomplete originals |
| `DraftsDialog.tsx`, `use-drafts.ts` | Outcome unknown. Retry same attempt; Not saved. Open to recover (controller requested sentence casing) |

Humanization: on, own pass; new operational strings reviewed against voice/terminology/channels. No rhetorical markers identified and no final-pass rewrite; confirmed preservation and next actions retained. The displayed limits are contract constraints, not new public product claims.

## Limits and prerequisites

Requires same-origin IndexedDB, localStorage and Web Locks. Clearing site storage can remove bytes. Missing bytes in an already locked attempt cannot be replaced; the app refuses replay instead of changing the request. Orphan records and draft tombstones are retained conservatively; this scope adds no background garbage collector. Source files exceeding 10 files or 5 MiB cannot be forwarded as one message; start a new message with selected files. This task does not establish server draft sync, offline mail, real Gmail/Cloudflare acceptance, or App Store readiness.

The untracked `node_modules` symlink is local-only, points to the controller's dependency tree, and is excluded from commits. Generated type/build files remain ignored. Controller owns branch publication and release integration.

Used: copywriting reviewed attachment recovery strings against the existing brand pack. Controller owns the measured pipeline/scenario/design route and shared evidence registers.


## Review followup: capture survives composer closure

The controller's independent review found that implementation `9ed052d` retained selection only after asynchronous reading. Closing and reopening the composer during a read could therefore send without the selected file. **Fix commit `8c28dd8c0f7f3dded657ac89e75ed38b880f8847` supersedes that capture ordering.** No CSS or shared registry edits are included; the controller owns footer layout and brand/scenario integration.

`attachment-store.ts:150` now stages references and `pendingAttachments` through an acknowledged draft write before any local file read or original-attachment network request. Only acknowledged completion of all byte transactions followed by another draft write clears pending IDs. `compose-payload.ts:25` and `draft-store.ts:267` both refuse pending files. `use-drafts.ts` includes pending IDs in `hasUnsaved`; reopening shows per-file pending state and recovery guidance. Removing a file removes its pending marker in the same durable mutation. Completion merges with current text and cannot resurrect a removed/locked draft. Original attachments use this same lifecycle, with lazy byte readers; merely opening Forward still fetches nothing.

Followup checks: focused attachment/draft tests **29/29 passed**; final `npm test` **140/140 passed**; `node_modules/.bin/tsc -b --pretty false` and `git diff --check` passed. Three additional tests cover deferred local/original reads across a fresh-store reopen, initial reference quota failure before any read, byte quota failure with durable pending recovery, and failed readiness acknowledgement after bytes exist. These remain adapter-level tests; the controller should run the supported browser close/Escape/reopen and reload checks with a deliberately deferred synthetic file. `python3 docs/brand/lint.py` reports the same six controller-owned B021 errors and 311 warnings. The earlier production build result predates this focused followup; controller integration should rebuild.

Followup copy to register (source references at `8c28dd8`):

| Source | Exact text |
|---|---|
| `Composer.tsx:474`, `compose-payload.ts:28` | Files are not ready. Wait for loading to finish, or remove pending files and add them again. |
| `Composer.tsx`, selected file size | · Pending |
| `use-drafts.ts:203` | Files pending. Open draft to recover |
| `attachment-store.ts:180` | File selection could not be saved. Keep this window open before sending. |
| `attachment-store.ts:196` | Files were saved, but their ready state could not be saved. Keep this draft open before sending. |
| `draft-store.ts:271` | Files are not ready. Wait for loading to finish before sending. |
| `compose-payload.ts:79` | The draft changed while files were loading. Open the original draft to check its files. |

The controller-requested send-refusal punctuation fix strips trailing sentence punctuation from the provider message before adding the existing recovery sentence. Humanization remains on, own pass; these additions state the pending condition and recovery action without new public claims. If a page reload interrupts a capture, pending references deliberately remain blocked until the user removes and re-adds the affected files.
