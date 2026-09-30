# Frontend audit fixes — Cloudflare mailbox view — 2026-09-28

Node of the [agents-triage run](2026-09-28-agents-triage-run.md): fix the verified audit findings
in the per-mailbox React Router frontend (`/mailbox/:id/...`, `/mailboxes`, `/accounts`, the chat
agent panel). Out of scope by ownership: `app/routes/unified-inbox.tsx`, `app/components/inbox/*`,
`app/components/EmailIframe.tsx`, `app/services/fabric.ts`, `app/routes/agents.tsx`,
`app/routes/project-addresses.tsx`, `app/styles/workbench.css`, `workers/`, `shared/`.

## What changed

| # | Finding | Fix | Check |
|---|---|---|---|
| 1 | Delete was permanent while the Trash empty state promised restore | Outside Trash, Delete moves to Trash with an Undo toast (`useMoveEmail`, `folderId:"trash"`); inside Trash the control is "Delete permanently" behind a "Delete permanently?" dialog. Policy and copy in `app/lib/delete-policy.ts`, flow in `app/hooks/useDeleteMessage.ts`, dialog in `app/components/PermanentDeleteDialog.tsx` | `tests/delete-policy.test.ts` |
| 2 | Agent Markdown rendered images (exfiltration on display) | `app/components/AgentMarkdown.tsx` renders every image as a visible link "Image: alt (host)"; no `<img>`, no preload | `tests/agent-markdown.test.ts` (baseline react-markdown emitted `<img>` + `<link rel="preload">`) |
| 3 | Load errors looked like empty states or spun forever | `app/components/LoadError.tsx` (role="alert", Retry) in email-list, EmailPanel (plus Close), home (config and mailboxes), search-results, settings; failed refresh over shown data is a compact bar | `tests/frontend-states.test.ts` (`describeLoadError`) |
| 4 | Auto-create mailbox errors swallowed | `Promise.allSettled`; failures listed with reasons and Retry; auto-create waits for a *successful* mailbox list | `tests/frontend-states.test.ts` (provisioning) |
| 5 | Failed mutations silent | `meta.errorMessage` on star/read, thread read, move, delete, folder create/rename/delete; `app/components/MutationErrorToasts.tsx` toasts them at `priority:"high"` (announced as alert). A send whose draft cleanup fails no longer reads as a failed send; "Draft discarded" only after success | `tests/mutation-errors.test.ts` |
| 6 | Gmail Disconnect had no confirmation; "not configured" shown while loading | Two-step "Disconnect…" → "Disconnect <email>" / "Keep" (default focus, Escape, focus returns); loading and unavailable states via `app/lib/account-status.ts` | `tests/frontend-states.test.ts` (`gmailSetupState`) |
| 7 | Sidebar "Mailboxes" went to `/` (unified inbox) | Navigates to `/mailboxes` (routes.ts: `route("mailboxes", "routes/home.tsx")`) | `npx tsc -b` |
| 8 | `cid:img1` also rewrote `cid:img10` | Rewrite moved to `app/lib/mail-image-policy.ts`, end-anchored, literal replacement (`$` in IDs), `<…>` stripping fixed | `tests/cid-rewrite.test.ts` |
| 9 | Row actions hover-only; star unnamed; row keys captured nested buttons | `group-focus-within:flex`; star `aria-label` + `aria-pressed`; `isRowActivation` (`app/lib/row-keys.ts`) in email-list and search-results | `tests/frontend-states.test.ts` (row keys); CSS rule present in build |

Docs in the same change: `docs/ux/scenarios.md` (SCN-002, -003, -005, -011, -012, -013 refinements),
`docs/brand/strings.md` (new strings registered, `proposed`).

## Checks run

- `npm test` — 226 tests, 226 pass (200 before this node).
- `npx tsc -b` — exit 0. `npm run build` — built.
- `python3 docs/ux/lint.py` — OK. `python3 docs/brand/lint.py` — 0 errors (warnings are the tool's
  pre-existing unregistered-literal noise).

## Open

- The threaded list deletes the row's message, not the whole conversation (pre-existing semantics).
- No browser walkthrough of the new states was recorded; next: exercise Delete → Undo, Trash →
  Delete permanently, and a forced 500 on the list in the preview fixture.
