# Reversible message actions — REL-05 / SCN-011

Implementation is complete in `7ea3a30a9f4d1a661f93358a0293bce8d3d5c21b`; reader-toolbar integration and browser acceptance remain controller-owned. No real accounts or messages were contacted. Task boundary: [mail-actions packet](tasks/mail-actions.md); shared contracts: [InboxMessage](../../shared/mail/inbox.ts), [account routes](../../workers/routes/accounts.ts), [provider service](../../workers/providers/account-service.ts). Evidence source: [implementation commit](https://github.com/passioncode-ai/fabric-inbox/commit/7ea3a30a9f4d1a661f93358a0293bce8d3d5c21b).

## Changes and decisions

- Gmail exposes explicit `setStarred(boolean)` and `setTrashed(boolean)` across client, service, serialized DO RPC and POST routes ending `/starred` and `/trashed`. Invalid state, IDs and missing accounts fail before provider I/O. Route parsing rejects malformed JSON, null, arrays and non-boolean state; existing Origin protection and no-store headers apply.
- Gmail star uses `messages.modify` with STARRED add/remove; trash/restore uses POST `messages/{id}/trash` and `/untrash`, empty bodies. No permanent deletion. Full-message readback precedes cache writes. A write timeout or failed readback rejects without optimistically updating the cache; subsequent sync or a repeated explicit state assignment can reconcile. Existing cached `getMessage` alone is not a provider refresh.
- Gmail restore is named **Restore message**: Google's untrash contract removes Trash and does not promise Inbox. Cloudflare **Restore to inbox** uses existing `/move` with `folderId: "inbox"`; moving to Trash uses `folderId: "trash"`. Its existing permanent-delete route is never called.
- A focused pre-existing Cloudflare defect was fixed: `moveEmail` now checks SQL RETURNING, so a missing message cannot report successful movement simply because the folder exists. Boolean API compatibility is preserved. The existing HTTP route returns 400 on false; its generic “Folder not found” error remains imprecise for a missing message.
- `MessageActions` uses Fabric `fi-icon-button` and existing Phosphor icons, accessible labels, title hints, disabled state and star `aria-pressed`. It imports a `Pick` of shared `InboxMessage`, so existing structural route types remain compatible. Provider response supplies actual star state. Parent `run` owns error display and refresh. `applyMessageChange` guards completion by the original account-scoped message ID; navigation or another selection cannot be cleared or starred by an old response.

API choices verified against official [Gmail REST reference](https://developers.google.com/workspace/gmail/api/reference/rest) and [trash method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash). The former lists modify, trash and untrash separately from permanent DELETE. Browser APIs and live provider behavior were not exercised by this packet.

## Exact controller integration

Import in the root-owned route:

```tsx
import MessageActions, { applyMessageChange } from "~/components/inbox/MessageActions";
import type { InboxFolder } from "../../shared/mail/inbox";
```

Insert beside the existing read/archive toolbar buttons:

```tsx
<MessageActions
  message={selected}
  folder={folder as InboxFolder}
  busy={busy || !detail.data}
  run={perform}
  onChanged={(change) => setSelected((current) => applyMessageChange(current, change))}
/>
```

`folder` is already constrained by the route's folder list; avoid introducing an unchecked cast for arbitrary URL strings. `perform(action, after?)` must call `after` only after successful action and refresh and surface errors. The component performs no automatic external calls on render.

Interface: `message: Pick<InboxMessage, "id" | "accountId" | "provider" | "providerMessageId" | "starred">`, `folder: InboxFolder`, `busy: boolean`, `run: (action: () => Promise<unknown>, after?: () => void) => Promise<unknown>`, `onChanged: (change: { id: string; starred: boolean } | { id: string; removed: true }) => void`.

## Checks actually run

- `node --import tsx --test tests/mail-actions.test.ts`: 6 passed, 0 failed. Synthetic Gmail, malformed-route inputs, no side effects on invalid arguments, repeat assignments, account collision isolation, write/read timeout cache preservation, provider-confirmed star state, stale-selection guard, correct reversible Cloudflare routes, real Miniflare SQLite DO moves, missing message/folder refusal and body preservation.
- `npm test`: 130 passed, 0 failed, 0 skipped. After that suite, the UI helper was refined to use returned star state rather than requested state; the complete focused six tests and `npx tsc -b` passed again.
- `npm run typecheck`: passed (Cloudflare and React Router generation plus TypeScript); final `npx tsc -b`: passed after the UI state refinement.
- `git diff --check`: passed before the implementation commit.
- Local dependency symlink points to workbench `node_modules`; it is untracked and must remain local-only. No dependencies, generated assets, credentials or shared registers were committed.

An initial integration-test seed returned `undefined` through `Response.json`; the test fixture was corrected to await the seed and return `true` before the successful runs. This was a fixture error, not a provider call failure.

## Root-owned acceptance and copy

Exact next task: integrate the snippet, add the new strings to the controller-owned brand register, update SCN-011, then exercise the reader toolbar in the browser for both providers (synthetic fixtures), including slow completion after selecting the same provider message ID in a different account. Verify the refreshed list and starred icon, Trash removal, restore behavior, keyboard names/disabled states and visible parent error notice. Existing archive/read handlers remain root-owned and should use the same selection guard if they clear selection after awaiting.

New UI strings in `MessageActions.tsx`: “Star message”, “Unstar message”, “Move to trash”, “Restore message”, “Restore to inbox”, “Message account is unavailable. Refresh and try again.”, “Message state could not be confirmed. Refresh and try again.” Public backend codes: `invalid_starred_state`, `invalid_trashed_state`.

Scenario delta: individual Gmail/Cloudflare messages can be starred/unstarred and moved to Trash; restoring uses provider-specific truthful naming and does not affect another account/selection. Failure does not claim success. No confirmation modal is needed for these reversible actions. No new visual tokens, composer edits, automatic action execution, permanent-delete control or live-mail acceptance is included. User-visible notices still use the parent's existing error presentation.

No additional skill was independently invoked by this bounded implementer. Controller owns the measured route, scenario/brand/design decisions and final integration validation. No nested delegation was used.
