# REL-03 implementation handoff

Status: implemented; integration UI verification and shared UX/brand registers remain controller-owned.

Requirements: [bounded task](tasks/drafts.md). Implementation commit: `980f669ca665781b23da378cb923a52681f015f2`, branch `codex/release-drafts`, baseline `ef6357f`. Source references below are at this implementation commit. No push or integration performed by this agent.

## Delivered

- [draft-store.ts](../../app/components/inbox/draft-store.ts) replaces the singleton with version-2 per-draft localStorage records, independent draft/send identities, per-record revision checks under Web Locks, and tombstones. Unknown attempts retain their original key and content. Valid legacy payloads migrate by allow-list with reply/forward/account context; malformed bytes remain untouched. No attachment or credential fields migrate.
- [use-drafts.ts](../../app/components/inbox/use-drafts.ts) queues saves, distinguishes saving/unsaved/saved, keeps unsaved text in memory, and merges storage events without replacing dirty text. Only persisted lock success permits send. Reopening the saved version requires an explicit confirmation before replacing unsaved content.
- [Composer.tsx](../../app/components/inbox/Composer.tsx) settles only the matching draft/attempt; provider rejection rotates the attempt key only after persisted recovery. Storage failures keep recovery immutable. Close/Escape preserves drafts. Discard is available only when editable. Missing account identity remains visible with send disabled.
- [unified-inbox.tsx](../../app/routes/unified-inbox.tsx) always creates an independent draft on Compose/reply/forward, adds Drafts navigation, keys Composer by draft ID, and guards late close callbacks against the current active ID.
- [DraftsDialog.tsx](../../app/components/inbox/DraftsDialog.tsx) presents sender, subject and state in native keyboard-reachable dialog controls; [workbench.css](../../app/styles/workbench.css) uses existing `--pc-*` tokens without motion.

## Checks actually run

- Baseline: `node --import tsx --test tests/inbox-ui.test.ts tests/outbox.test.ts tests/inbox.test.ts` — 22 passed, zero failed.
- Final focused: `node --import tsx --test tests/inbox-drafts.test.ts tests/inbox-ui.test.ts tests/outbox.test.ts tests/inbox.test.ts` — 35 passed, zero failed. The 13 added tests exercise restart, independent contexts, conservative migration, corrupt bytes, quota failure, both edit/send race orders, stale deletion resurrection, immutable retries, delayed outcomes and failed settlement persistence.
- `npm run typecheck` — passed, including required Cloudflare/React Router type generation. Final `npx tsc -b` also passed. A direct initial typecheck before generation lacked generated Env types; that is not the final result.
- `git diff --check` — passed.
- `python3 docs/brand/lint.py` — 4 B021 errors, 281 B022 warnings. The four errors are register/source changes listed below; registers were explicitly reserved to controller.
- UI verification: NOT_RUN in this task. Controller owns the supported CUA fixture check after cherry-pick; no raw Playwright or weakened Vite filesystem boundary used.

## Controller integration packet

First task: cherry-pick the implementation and this report, update the shared registers below, then test two saved drafts plus an uncertain attempt through reload using the release preview fixture. Check missing-account display, save failure, keyboard focus, light/dark and narrow layout. Fixture changes were not needed for Node checks and were not made. Controller may need to adapt any fixture that expects singleton storage or “Continue draft” on the main Compose button.

Scenario deltas for SCN-006/007/019/020: Compose always creates; Drafts reopens by stable identity; accepting/discarding A leaves B intact; locked A does not block composing B; unknown A retries its unchanged key after restart; storage/lock unavailability refuses sends; another window's revision causes visible refusal and offers explicit reopening after copying unsaved text. Reply and forward preserve source/account context. Add a save-in-progress state before claiming saved.

Shared registry changes (Status: proposed; controller owns edits):

| Registry key / new state | Source | Text / required change |
|---|---|---|
| `action.inbox.continue_draft` | `DraftsDialog.tsx:70` | Move source from route; existing “Continue draft” retained |
| `state.inbox.draft_restore_failed` | `use-drafts.ts:50` | “A saved draft could not be restored. Its stored data has been kept. You can still compose a new message.” |
| `state.inbox.draft_save_failed`, `state.composer.save_failed` | `use-drafts.ts:10` | “Draft could not be saved on this device. Keep this window open and copy your text before leaving.” Composer displays the supplied message |
| Draft picker | `DraftsDialog.tsx:39–70` | Drafts; Close drafts; No saved drafts. Compose a new message to begin.; No subject; Outcome unknown · Retry same attempt |
| Saving / unsaved | `use-drafts.ts:172–174`, `Composer.tsx:285` | Not saved · Open to recover; Saving draft… |
| Read failures | `use-drafts.ts:33,37` | Preserve-data and retry-open messages; register exact source text |
| Conflict | `draft-store.ts` constant `conflict` | “This draft changed in another window. Copy any unsaved text, then reopen the saved version from Drafts.” |
| Recovery / discard | `Composer.tsx:146,251,272` | Register updated-result storage failure, explicit replacement confirmation, discard failure; button “Reopen saved version” |
| Missing sender | `Composer.tsx:197` | Account unavailable |

Update terminology's “Continue draft” definition from the singleton to the selected saved draft. Update facts' implementation-limit source from the removed route storage effect to `use-drafts.ts`/`draft-store.ts`; no new public claim or number is proposed. Humanization: on, own pass; concise operational copy reviewed for preservation and next action, no rhetorical markers identified and no wording changed by that final pass.

## Concerns and prerequisites

- Requires same-origin localStorage and Web Locks. Unsupported locks fail closed; this is intentionally visible degradation rather than an unsafe cross-window fallback. The actual desktop/browser runtime still needs CUA verification.
- Collection remains device/origin-local. Clearing site storage can remove drafts; this does not implement server sync or full offline mail.
- Legacy source bytes are retained conservatively even after a migrated draft is settled; a tombstone prevents reappearance. Tombstones are not garbage-collected in this scope.
- Coordination protects windows using this implementation. An old app version still writing the legacy singleton does not participate; deploy/reload all windows before relying on multi-window guarantees.
- No schema or server send/recovery policy changed. Real provider sending was not tested.
- `node_modules` is an untracked local symlink to the controller's existing dependency tree. It is deliberately excluded from commits. Generated type files remain ignored.
- Controller's separate EmailIframe privacy change should pass `messageKey={selected.id}` in the route after adding that optional prop; this task did not edit EmailIframe or introduce the prop before its contract exists.

Used: copywriting reviewed interface/recovery wording against the existing brand pack. Controller owns the overarching pipeline/scenario/design route; this bounded implementation did not start another route.
