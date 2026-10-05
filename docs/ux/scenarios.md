# UX Scenarios

<!-- Managed with super-ux (ux-contract v4). Update affected layers in the same change as behavior. -->

## Index

| ID | Title | Feature | Persona | Traces | Status | Last audit |
|---|---|---|---|---|---|---|
| SCN-001 | Start the desktop app | Resume and manage preferences | P-01 | ST-007, FLW-07 | validated | not audited |
| SCN-002 | Connect a supported provider | Connect an account | P-01 | ST-001, FLW-01 | validated | not audited |
| SCN-003 | Handle unsupported or revoked accounts | Connect an account | P-01 | ST-001, FLW-01 | draft | not audited |
| SCN-004 | Read all accounts and one account | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-005 | Search and recover an empty result | Find and handle a conversation | P-01 | ST-002, FLW-02 | draft | not audited |
| SCN-006 | Compose and save a draft | Write and send mail | P-01 | ST-003, FLW-03 | validated | not audited |
| SCN-007 | Send from the chosen identity | Write and send mail | P-01 | ST-003, FLW-03 | validated | not audited |
| SCN-008 | Reply to a thread | Write and send mail | P-01 | ST-003, FLW-03 | validated | not audited |
| SCN-009 | Forward with attachments | Write and send mail | P-01 | ST-003, FLW-03 | validated | not audited |
| SCN-010 | Read and download an attachment | Find and handle a conversation | P-01 | ST-002, FLW-02 | draft | not audited |
| SCN-011 | Organize a message | Find and handle a conversation | P-01 | ST-002, FLW-02 | draft | not audited |
| SCN-012 | Change mail settings | Resume and manage preferences | P-01 | ST-007, FLW-07 | draft | not audited |
| SCN-013 | Ask AI for an explanation or draft | Review AI help | P-01 | ST-004, FLW-04 | validated | not audited |
| SCN-014 | Dry-run a rule | Set up a rule | P-01 | ST-005, FLW-05 | validated | not audited |
| SCN-015 | Enable and pause a rule | Set up a rule | P-01 | ST-005, FLW-05 | validated | not audited |
| SCN-016 | Inspect cloud run history | Inspect and control a run | P-01 | ST-006, FLW-06 | validated | not audited |
| SCN-017 | Resolve an action approval | Inspect and control a run | P-01 | ST-006, FLW-06 | draft | not audited |
| SCN-018 | Wait for a local tool or denied tool | Inspect and control a run | P-01 | ST-006, FLW-06 | draft | not audited |
| SCN-019 | Resume offline or after restart | Resume and manage preferences | P-01 | ST-007, FLW-07 | validated | not audited |
| SCN-020 | Resolve an unknown action outcome | Inspect and control a run | P-01 | ST-006, FLW-06 | draft | not audited |
| SCN-021 | Connect a project address | Put an agent on a project address | P-01 | ST-008, FLW-08 | draft | not audited |
| SCN-022 | Create a reusable agent | Put an agent on a project address | P-01 | ST-008, FLW-08 | draft | not audited |
| SCN-023 | Put one agent on several addresses | Put an agent on a project address | P-01 | ST-008, FLW-08 | draft | not audited |
| SCN-024 | Agent answers within its policy | Put an agent on a project address | P-01 | ST-008, FLW-08 | draft | not audited |
| SCN-025 | Mail to an address with no mailbox | Put an agent on a project address | P-01 | ST-008, FLW-08 | draft | not audited |
| SCN-026 | See what matters first across accounts | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-027 | Open one group of automated mail | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-028 | First run with a ready setup | Resume and manage preferences | P-01 | ST-007, FLW-07 | validated | not audited |
| SCN-029 | Bring existing Cloudflare addresses in | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-030 | Create my server from the app | Resume and manage preferences | P-01 | ST-007, FLW-07 | validated | not audited |
| SCN-031 | Receive a domain's mail here | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-032 | Add or remove an address on a domain | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-033 | Keep copies and unknown addresses somewhere | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-034 | Give an agent a knowledge collection | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-035 | An agent answers from its collections only | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-036 | Keep a category of the mail that matters | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-037 | See one project's mail in one place | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-038 | Raise a category's mail to Important | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-039 | Spam stays out of the inbox | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-040 | Report spam, or bring a message back | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-041 | Keep the spam rules | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-042 | List only the addresses that matter | Find and handle a conversation | P-01 | ST-002, FLW-02 | validated | not audited |
| SCN-043 | Give an outside agent a key | Resume and manage preferences | P-01 | ST-007, FLW-07 | draft | not audited |
| SCN-044 | See what agents changed, and revoke a key | Resume and manage preferences | P-01 | ST-007, FLW-07 | draft | not audited |
| SCN-045 | Choose which Cloudflare accounts show | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-046 | Connect another Cloudflare account | Put an agent on a project address | P-01 | ST-008, FLW-08 | validated | not audited |
| SCN-047 | Connect a hub on this Mac by allowing it | Resume and manage preferences | P-01 | ST-007, FLW-07 | draft | not audited |
| SCN-048 | Turn the anonymous usage counts off or on | Resume and manage preferences | P-01 | ST-007, FLW-07 | draft | not audited |

## Personas
See [foundation](foundation.md), P-01. Evidence RE-001 supports approved requirements; RE-002 is partial source inventory; RE-003 names unresolved providers/tools. Coverage now names partial source behavior. No full scenario has passed end-to-end acceptance; validated/draft statuses are unchanged and Product remains unobserved. RE-008 records the unified-workbench request; RE-009 records scoped synthetic UI observation. Detailed limits are in each Today field and the [integration receipt](implementation-receipt.md).

## Shared interaction requirements
For every scenario: keyboard order follows visible navigation, scope, content, then actions; focused controls remain visible; dialogs trap focus and restore it on close; Escape cancels a transient panel without silently deleting input. Loading and action results use accessible status announcements; errors focus the relevant field or summary. Message bodies cannot steal app focus or invoke desktop capabilities. Text/background and focus/surface contrast must be measured in both Fabric themes. RE-010 records only a scoped token-pair check; it is not a full rendered accessibility audit. Reduced motion removes decorative transitions; loading meaning remains in text. Narrow windows collapse list/detail with a reachable Back action rather than hiding sender identity.

## Scenarios

### SCN-001: Start the desktop app
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001, RE-003
- **Entry point:** SCR-01
- **Preconditions:** No connected account required.
- **Steps:**
  1. Open Fabric Inbox -> the session is checked.
  2. Complete sign-in if requested -> the inbox opens with account status.
- **Expected result:** A macOS user reaches their inbox or an actionable sign-in state.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-01; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Denied or expired session stays at sign-in; retry preserves unsent local work.
- **Status:** validated
- **Coverage:** desktop/main.cjs:30, desktop/main.cjs:74, desktop/setup.html:14
- **Product:** unobserved
- **Today:** Partial. Native setup, invalid-origin rejection, connection-refused recovery and packaged session-marker restart were observed with a local synthetic fixture (RE-004). The root packaged app also reached the local home through setup (RE-007). Real Access sign-in and external identity-provider handoff remain unverified. No mailto registration.

### SCN-002: Connect a supported provider
- **Persona:** P-01
- **Feature:** Connect an account
- **Traces:** ST-001, FLW-01, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-02
- **Preconditions:** No connected account required.
- **Steps:**
  1. Choose a provider -> supported capabilities and cloud processing location are shown.
  2. Complete authorization -> the account appears with sync progress.
- **Expected result:** Cloudflare or configured Gmail accounts become addressable without changing MX.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-02; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Cancel leaves no connected account; unavailable configuration shows setup needed; provider refusal offers reconnect.
- **Audit refinement (2026-09-28):** Until the account list loads, Accounts shows "Checking Gmail setup…" instead of claiming Gmail is not configured; a failed load says setup is unknown beside the Retry alert. Evidence: `tests/frontend-states.test.ts` ("Gmail is only called 'not configured'…").
- **Status:** validated
- **Coverage:** app/routes/fabric-accounts.tsx:61, app/lib/account-status.ts, workers/routes/accounts.ts:83, desktop/main.cjs:151
- **Product:** unobserved
- **Today:** Partial. Accounts lists Gmail and Cloudflare separately; the configured Gmail link starts at the server in a browser. The not_configured state was reported from the running app (RE-006). No real OAuth grant, mailbox synchronization or send acceptance was performed. Outlook/IMAP are explicitly unavailable.

### SCN-003: Handle unsupported or revoked accounts
- **Persona:** P-01
- **Feature:** Connect an account
- **Traces:** ST-001, FLW-01, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-02
- **Preconditions:** No connected account required.
- **Steps:**
  1. Open an unavailable account -> the reason is visible.
  2. Choose reconnect or return -> other account mail remains usable.
- **Expected result:** The user can distinguish unsupported provider, expired access and initial synchronization.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-02; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** No adapter or credentials: keep capability unavailable, never simulate a connected account.
- **Status:** draft
- **Coverage:** app/routes/fabric-accounts.tsx:61, app/routes/fabric-accounts.tsx:76, app/routes/fabric-accounts.tsx:134
- **Product:** unobserved
- **Today:** Partial. Missing configuration and unsupported providers have visible text; account status and sync errors have source coverage. A real revoked-token/reconnect walkthrough is not recorded. Disconnect is two-step — "Disconnect…" arms it for one account, then "Disconnect <email>" confirms or "Keep" (default focus, also Escape) backs out — and reports whether provider revocation succeeded.

### SCN-004: Read all accounts and one account
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-03, SCR-04
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Choose All inboxes -> messages retain account labels.
  2. Choose one account and open a message -> its thread and source identity appear.
- **Expected result:** A thread belongs to the selected account even when provider message IDs coincide.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-03, SCR-04; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** One account sync failure is shown separately; initial loading is not an empty inbox.
- **Status:** validated
- **Coverage:** app/routes/unified-inbox.tsx (`UnifiedInbox`, `scope`, detail query); app/components/inbox/model.ts (`messagePath`); workers/routes/inbox.ts
- **Product:** unobserved
- **Today:** Partial. The unified workbench shows all-account mail with source labels and filters one account in place through URL scope. Root observed three synthetic accounts, six messages and a one-account view with two messages (RE-009). Detail queries retain account and provider message identity. Individual-message reading exists; full threads, real multi-account synchronization and live account acceptance remain unverified.

### SCN-005: Search and recover an empty result
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-03
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Enter a query -> current scope stays visible while results load.
  2. Open a result or clear the query -> the corresponding thread or inbox appears.
- **Expected result:** No matches differs from no mail and from unavailable account data.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-03; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Search failure retains the query and offers retry; cached results are marked stale.
- **Audit refinement (2026-09-28):** In a Cloudflare mailbox, a failed search shows "Search failed" with Retry (role="alert") instead of "No results found"; a failed refresh over shown results is a one-line Retry bar.
- **Status:** draft
- **Coverage:** app/routes/unified-inbox.tsx (`scope`, list query, search form); app/routes/search-results.tsx; app/components/LoadError.tsx; workers/routes/inbox.ts
- **Product:** unobserved
- **Today:** Partial. Search cached mail retains account/folder scope in the URL, distinguishes no matches from no accounts or failed load, and offers Clear search. Load older messages follows the API cursor. Search covers cached provider data, not all provider history or offline desktop mail. Live search completeness and stale-result labeling remain unverified.

### SCN-006: Compose and save a draft
- **Persona:** P-01
- **Feature:** Write and send mail
- **Traces:** ST-003, FLW-03, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-05
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Choose Compose -> sender, recipients, subject and body are editable.
  2. Select the sender and save -> draft save state is shown.
  3. Reopen the draft -> stored fields and account are restored.
- **Release refinement (REL-03):** Compose starts an independent draft; Drafts reopens a selected saved item. Each sender, reply context and uncertain attempt survives separately. A blocked attempt does not block a new message. Concurrent edits must report conflict rather than overwrite another window.
- **Expected result:** A draft is associated with its selected account and is never silently sent.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-05; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Save failure preserves current input and does not claim it was saved.
- **Status:** validated
- **Coverage:** app/components/inbox/draft-store.ts; app/components/inbox/use-drafts.ts; app/components/inbox/DraftsDialog.tsx; tests/inbox-drafts.test.ts
- **Product:** unobserved
- **Today:** Partial. Independent versioned local drafts retain sender, reply context and recovery key. Compose creates a new item; Drafts reopens a selected item. Root observed two different senders/content surviving reload at the synthetic 5190 fixture. Web Locks and revisions refuse conflicting writes; unknown attempts remain immutable. Storage failure is explicit. Cross-device drafts and a fully offline renderer remain unavailable.


### SCN-007: Send from the chosen identity
- **Persona:** P-01
- **Feature:** Write and send mail
- **Traces:** ST-003, FLW-03, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-05
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Review sender and recipients -> the account identity remains visible.
  2. Choose Send -> the message enters an explicit pending state.
  3. View delivery status -> provider confirmation or failure is shown.
- **Expected result:** Queued, sending, sent, failed and unknown outcomes are distinct.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-05; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Invalid recipient blocks send inline; rejection preserves draft; unknown outcome is SCN-020.
- **Status:** validated
- **Coverage:** app/components/inbox/Composer.tsx (`send`); app/components/inbox/send-state.ts (`sendRecovery`)
- **Product:** unobserved
- **Today:** Partial. Compose requires an explicit sender, saves a locked attempt before transport and reports accepted only after provider acceptance. An uncertain attempt locks its fields and exposes Retry same attempt with the same recovery key; a later request refusal alone cannot unlock an earlier uncertain send. No actual provider send or recipient delivery was exercised.

### SCN-008: Reply to a thread
- **Persona:** P-01
- **Feature:** Write and send mail
- **Traces:** ST-003, FLW-03, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-04, SCR-05
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Choose Reply or Reply all -> original recipients and account are presented for review.
  2. Edit and send -> the message follows the send-state flow.
- **Expected result:** Reply stays in the selected account and thread with a visible recipient review.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-04, SCR-05; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Unsupported reply is explicitly unavailable; failed transport keeps the draft.
- **Status:** validated
- **Coverage:** app/routes/unified-inbox.tsx (`compose`); app/components/inbox/Composer.tsx (`send`, From selector); app/components/inbox/send-state.ts (`replyRecipient`)
- **Product:** unobserved
- **Today:** Partial. Reply prepares recipients from the selected message, keeps its account fixed and retains Gmail thread/message references. Replying to a sent message selects its original recipient. Reply all and complete-thread continuity remain open; no live reply acceptance is claimed.

### SCN-009: Forward with attachments
- **Persona:** P-01
- **Feature:** Write and send mail
- **Traces:** ST-003, FLW-03, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-04, SCR-05
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Choose Forward -> recipients, sender and attachments are reviewable.
  2. Select attachments and send -> upload and send states are distinct.
- **Expected result:** Only chosen successfully prepared attachments go with the reviewed forward.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-04, SCR-05; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Attachment failure blocks sending incomplete content and preserves draft.
- **Status:** validated
- **Coverage:** app/routes/unified-inbox.tsx (`compose`); app/components/inbox/Composer.tsx (forward notice); app/routes/automation.tsx:273
- **Product:** unobserved
- **Today:** Partial. Forward prepares a draft with source account and original-file metadata. Explicit original inclusion captures all files or refuses incomplete forwarding; files persist on this device and share the 10-file/5-MiB bound. New/reply drafts support Cc/Bcc and added files. Legacy uncertain attempts retain their original request identity. Automated attachment tests pass; synthetic browser draft reload preserved a selected file and Cc/Bcc. Live original attachment forwarding remains unobserved; automation retains its separate text-only boundary. Evidence: `tests/attachment-composer.test.ts`, `docs/app-store/verification.md`.

### SCN-010: Read and download an attachment
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-04
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Open a message -> attachment names and availability appear.
  2. Choose an attachment -> retrieval progress and its result are shown.
- **Release refinement (REL-05):** HTML remote images start blocked. Load external images grants this message only; selecting another message resets permission. Message HTML cannot submit forms or set a base URL, and sends no referrer.
- **Expected result:** The attachment belongs to the selected message and account.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-04; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Unavailable content names the missing download; retry does not imply cached content exists.
- **Status:** draft
- **Coverage:** app/routes/unified-inbox.tsx (`download`, attachment controls); app/components/inbox/model.ts (`messagePath`); desktop/main.cjs:82
- **Product:** unobserved
- **Today:** Partial. Attachment controls request content through the selected account/provider message path and initiate a download; Electron asks for a save location. No real provider attachment or desktop download was exercised. Offline attachment availability is absent.

### SCN-011: Organize a message
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001, RE-003
- **Entry point:** SCR-03, SCR-04
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Choose read status, star status or archive -> the action reports progress and result.
  2. Choose Move to trash -> provider confirmation removes this message from the current list.
  3. In Trash choose Restore message (Gmail) or Restore to inbox (Cloudflare) -> provider-confirmed restoration remains scoped to this account. Permanent deletion is outside these controls.
- **Expected result:** Failed organization does not silently remove the only visible copy.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-03, SCR-04; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** On failure restore the previous visible state; undo only when supported by the provider.
- **Audit refinement (2026-09-28), Cloudflare mailbox view:** Delete outside Trash moves the message to Trash and offers Undo (back to the folder it came from). Inside Trash the control reads "Delete permanently" and a dialog titled "Delete permanently?" must be confirmed. Moving a message out of Trash restores it — the Trash empty state says exactly this. A failed star, read change, move, delete or folder create raises an error toast announced as an alert; a failed folder load shows an error with Retry, never "Your inbox is empty". Row actions appear on keyboard focus as well as hover; the star has an accessible name. Evidence: `tests/delete-policy.test.ts`, `tests/mutation-errors.test.ts`, `tests/frontend-states.test.ts`.
- **Status:** draft
- **Coverage:** app/routes/unified-inbox.tsx (`perform`, reader toolbar); app/routes/email-list.tsx; app/components/EmailPanel.tsx; app/hooks/useDeleteMessage.ts; app/lib/delete-policy.ts; app/components/MutationErrorToasts.tsx; tests/automation-integration.test.ts:170
- **Product:** unobserved
- **Today:** Partial. The unified reader offers read/unread, archive, star/unstar, soft trash and restore. Provider mutations precede visible confirmation; late completion cannot clear another selected message. Synthetic browser acceptance exercised star/unstar and trash/restore for Gmail and Cloudflare. Gmail untrash does not promise Inbox. Live organization, bulk controls and permanent deletion remain unverified or absent. Evidence: `tests/mail-actions.test.ts`; `docs/app-store/verification.md`.

### SCN-012: Change mail settings
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001, RE-003
- **Entry point:** SCR-06
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Open Settings -> current saved values load.
  2. Change values and save -> success appears only after persistence.
  3. Switch the workbench between light and dark -> the choice survives reload if device storage succeeds; a storage failure names the window-only change.
- **Expected result:** Settings can be reviewed and saved without losing the inbox context.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-06; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Validation identifies the field; save failure retains edits and offers retry.
- **Audit refinement (2026-09-28):** Mailbox settings that fail to load show "Couldn't load settings" with Retry instead of an endless spinner.
- **Status:** draft
- **Coverage:** app/routes/unified-inbox.tsx (`toggleTheme`); app/root.tsx (theme bootstrap); app/routes/settings.tsx:15; desktop/setup.js (theme control)
- **Product:** unobserved
- **Today:** Partial. The workbench defaults to white/light and offers dark with a device-stored preference. Root observed dark toggle and persistence after reload on the synthetic app (RE-009). Storage failure reports a window-only change. Existing mailbox preferences and native server settings remain separate; full settings acceptance is not re-run.

### SCN-013: Ask AI for an explanation or draft
- **Persona:** P-01
- **Feature:** Review AI help
- **Traces:** ST-004, FLW-04, JTBD-02, JRN-02; RE-001, RE-003
- **Entry point:** SCR-04
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Select a thread and ask AI -> the source is stated while it works.
  2. Review the answer or draft -> source links and editable content are available.
- **Expected result:** AI output remains a proposal; ordinary mail remains usable.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-04; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Model failure offers retry without sending; mail instructions do not expand permissions.
- **Audit refinement (2026-09-28):** The chat agent's Markdown never renders images: Markdown image syntax becomes a visible "Image: alt (host)" link, so a hostile email cannot make a reply fetch an attacker URL on display. Evidence: `tests/agent-markdown.test.ts`.
- **Status:** validated
- **Coverage:** app/components/AgentPanel.tsx:296, app/components/AgentMarkdown.tsx, workers/automation/index.ts:180, app/routes/automation.tsx:433
- **Product:** unobserved
- **Today:** Partial. Existing Cloudflare AI surface remains and rule analysis/draft output is rendered in history. Gmail has no equivalent interactive thread AI panel in its current view. No live model response, source-link completeness or editable-draft handoff was observed.

### SCN-014: Dry-run a rule
- **Persona:** P-01
- **Feature:** Set up a rule
- **Traces:** ST-005, FLW-05, JTBD-02, JRN-02; RE-001, RE-003
- **Entry point:** SCR-07
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Define accounts, condition, actions, recipients, tools and limits -> missing requirements are identified.
  2. Choose Dry-run -> matched input and proposed actions are shown without external side effects.
- **Expected result:** The user can inspect the exact destinations and allowed work before enabling.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-07; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Unknown destination, missing grant or tool schema blocks enable; dry-run failure preserves rule input.
- **Status:** validated
- **Coverage:** app/routes/automation.tsx:168, app/routes/automation.tsx:390, workers/automation/index.ts:206
- **Product:** unobserved
- **Today:** Partial. Rule fields and dry-run JSON preview are wired; preview text states no mail mutation. The save/enable control does not require a completed dry-run, so the target pre-enable review constraint is not fully met. Live AI/tool preview acceptance remains open.

### SCN-015: Enable and pause a rule
- **Persona:** P-01
- **Feature:** Set up a rule
- **Traces:** ST-005, FLW-05, JTBD-02, JRN-02; RE-001, RE-003
- **Entry point:** SCR-07
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Review a completed dry-run and enable -> enabled version and scope are visible.
  2. Pause -> future launches stop and current run state remains inspectable.
- **Expected result:** The user can enable cloud execution and stop future work explicitly.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-07; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Save or pause failure reports the last confirmed state; editing grants requires a new reviewed version.
- **Status:** validated
- **Coverage:** app/routes/automation.tsx:121, app/routes/automation.tsx:372, workers/automation/engine.ts:29, tests/automation-integration.test.ts:196
- **Product:** unobserved
- **Today:** Partial. Enable/pause controls and durable version checks exist. The local workerd pause test verifies an approved pending action is cancelled before a synthetic mailbox mutation (RE-005). Continuous deployed execution with a Mac off is not observed.

### SCN-016: Inspect cloud run history
- **Persona:** P-01
- **Feature:** Inspect and control a run
- **Traces:** ST-006, FLW-06, JTBD-02, JRN-02; RE-001, RE-003
- **Entry point:** SCR-08
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Open history after the Mac was off -> cloud runs and timestamps load.
  2. Open a run -> source, rule version, actions, attempts, result and cost availability appear.
- **Expected result:** Run history explains whether work completed, failed, waits or has an unknown outcome.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-08; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** History failure offers retry, not an empty success list; unavailable cost is labeled unavailable.
- **Status:** validated
- **Coverage:** app/routes/automation.tsx:433, workers/automation/index.ts:60, tests/automation-integration.test.ts:239
- **Product:** unobserved
- **Today:** Partial. Recent runs show status, action destination, analysis and detail; Cloudflare also shows outbox states. Rule version, full source link, attempt and cost fields are not all surfaced. Workerd restart recovery is locally tested, not proof of production cloud history.

### SCN-017: Resolve an action approval
- **Persona:** P-01
- **Feature:** Inspect and control a run
- **Traces:** ST-006, FLW-06, JTBD-02, JRN-02; RE-001, RE-003
- **Entry point:** SCR-08
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Open a waiting approval -> exact account, source, destination and effect appear.
  2. Approve or reject -> the decision and resulting state are shown.
- **Expected result:** No action outside a rule grant executes merely because mail or model output requests it.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-08; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Expired or changed proposal requires review again; rejection has no external side effect.
- **Status:** draft
- **Coverage:** app/routes/automation.tsx:433, workers/automation/index.ts:121, workers/automation/engine.ts:47, tests/automation-integration.test.ts:290
- **Product:** unobserved
- **Today:** Partial. History exposes exact proposed action, Approve this action and Cancel run. Local workerd tests verify archive/read wait for approval and changed message content cancels prepared work. Live external tools and UI approval clickthrough are not verified by those tests.

### SCN-018: Wait for a local tool or denied tool
- **Persona:** P-01
- **Feature:** Inspect and control a run
- **Traces:** ST-006, FLW-06, JTBD-02, JRN-02; RE-001, RE-003
- **Entry point:** SCR-08
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Open a waiting run -> local device or permission blocker is named.
  2. Reconnect the device or review permissions -> eligible work resumes or stays blocked.
- **Expected result:** A disconnected Mac produces waiting-for-device; denied tool access produces a visible denial.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-08; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Timeout remains failed or unknown according to evidence; no fallback tool silently receives data.
- **Status:** draft
- **Coverage:** workers/automation/engine.ts:77, workers/automation/mcp.ts:5, app/routes/automation.tsx:433
- **Product:** unobserved
- **Today:** Partial. Engine names waiting_device, while the UI currently configures cloud tools only. No local runner exists, so reconnect cannot fulfill this scenario. Cloud tool host/credential checks exist; no real permitted/denied/timeout tool acceptance is recorded.

### SCN-019: Resume offline or after restart
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001, RE-003
- **Entry point:** SCR-01, SCR-03, SCR-05
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Reopen offline -> available cached mail is labeled with its sync state.
  2. Open a saved draft -> its stored content is restored.
  3. Reconnect -> synchronization resumes without blind resend.
- **Expected result:** Offline, missing cache and pending work are distinguishable; manual mail does not claim fresh data.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-01, SCR-03, SCR-05; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Expired session offers sign-in; unavailable attachment remains unavailable; unsaved content is never claimed durable.
- **Status:** validated
- **Coverage:** desktop/main.cjs:90, desktop/setup.html:27, app/routes/gmail-inbox.tsx:41
- **Product:** unobserved
- **Today:** Partial. Native connection-refused/retry behavior and session partition restart were observed. Gmail localStorage draft/recovery code now exists, but no runtime draft-restoration receipt is recorded. There is no offline mailbox cache or bundled renderer to read it; this original requirement remains open.

### SCN-020: Resolve an unknown action outcome
- **Persona:** P-01
- **Feature:** Inspect and control a run
- **Traces:** ST-006, FLW-06, JTBD-02, JRN-02; RE-001, RE-003
- **Entry point:** SCR-08, SCR-05
- **Preconditions:** User session and relevant account or fixture available; capabilities are checked before action.
- **Steps:**
  1. Open an unknown send or tool action -> uncertainty and attempt details are shown.
  2. Refresh reconciliation -> confirmed result or unresolved uncertainty remains visible.
- **Expected result:** No automatic retry duplicates an action whose previous outcome is unknown.
- **Alt paths:** Return to the previous surface without causing an external action; preserve confirmed saved work.
- **UI elements:** SCR-08, SCR-05; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Only a proven non-executed action may be retried; unresolved outcome retains history and a review path.
- **Status:** draft
- **Coverage:** app/routes/gmail-inbox.tsx:141, app/routes/gmail-inbox.tsx:193, workers/automation/index.ts:29, tests/automation-integration.test.ts:239
- **Product:** unobserved
- **Today:** Partial. Gmail unknown sends stay locked for status inspection; interrupted automation runs become unknown. Local workerd restart test verifies no automatic replay of an uncertain synthetic effect. Manual provider reconciliation and safe retry after proof of non-execution are not fully implemented/verified.

**Telemetry:** none declared; no analytics implementation or production signal is asserted.

### SCN-021: Connect a project address
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** User session available; the project domain uses Cloudflare Email Routing and the operator can change its routing.
- **Steps:**
  1. Choose a project domain and type the local part (support, hello, billing) -> the full address and its project are previewed.
  2. Confirm -> the mailbox exists and the routing check shows whether mail for this address reaches the service.
  3. Send the test message offered on the screen -> it appears in the new mailbox within the page.
- **Expected result:** A new project address receives mail in minutes, and the screen says whether routing is verified, missing or unknown.
- **Alt paths:** Cancel before confirming leaves no mailbox; an address that already exists opens instead of being duplicated.
- **UI elements:** SCR-09; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Routing that cannot be read is shown as unknown with the dashboard step to fix it, never as working; a domain not routed to the service cannot be chosen without that warning.
- **Status:** draft
- **Coverage:** app/routes/project-addresses.tsx (ProjectAddressesPage), workers/routes/agents.ts (/api/project-addresses), workers/routing/email-routing.ts (EmailRoutingClient), tests/project-addresses.test.ts
- **Product:** unobserved
- **Today:** Partial. **Project addresses** creates an address on any served domain with its agent; with `CLOUDFLARE_EMAIL_ROUTING_TOKEN` it creates the Email Routing rule first (a refused rule leaves no mailbox) and shows routing as verified, missing or unknown with the fix; **Send test message** sends from the address to itself. Observed on the local Worker without a token (routing unknown). Project labels from Fabric's registry are not read yet; no live zone was exercised.

### SCN-022: Create a reusable agent
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-10
- **Preconditions:** User session available; the project domain uses Cloudflare Email Routing and the operator can change its routing.
- **Steps:**
  1. Create an agent from a template (support, sales, billing) or blank -> name, instructions, knowledge sources, tools and reply policy are shown.
  2. Grant tools from the allowed list and set the reply policy -> each grant shows what the agent may do and on which destination.
  3. Save -> the agent is listed with its version and the addresses it serves (none yet).
- **Expected result:** An agent is a named, versioned definition that is not tied to one mailbox.
- **Alt paths:** Leaving without saving keeps the previous version; a template never changes an existing agent.
- **UI elements:** SCR-10; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A tool whose host is not allowed, or whose schema cannot be read, blocks saving with the reason; a failed save keeps the input.
- **Status:** draft
- **Coverage:** app/routes/agents.tsx (AgentEditor), workers/agents/definition.ts (AGENT_TEMPLATES), workers/agents/registry.ts (createAgent, updateAgent), tests/agents-registry.test.ts
- **Product:** unobserved
- **Today:** Partial. **Agents** creates an agent from the Support, Sales or Billing template or blank, with instructions, knowledge, tool grants and reply policy; every save is a new version, a stale edit is refused, a disallowed tool host blocks saving with the reason. Tool schemas are not read from the server yet. Observed on the local Worker.

### SCN-023: Put one agent on several addresses
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** User session available; the project domain uses Cloudflare Email Routing and the operator can change its routing.
- **Steps:**
  1. Open an address and choose an agent -> the address shows the agent and its policy.
  2. Choose the same agent for another address -> both list the agent; the agent lists both addresses.
  3. Switch an address to Off -> new mail stays in the mailbox for the operator and the agent does nothing there.
- **Expected result:** One agent definition serves many addresses, and every address shows who answers it.
- **Alt paths:** Changing an agent later applies to new mail only; mail already handled keeps its record of the agent version used.
- **UI elements:** SCR-09; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Assignment that fails to save keeps the previous agent visibly; an agent removed from the registry leaves its addresses Off, never silently answered by another agent.
- **Status:** draft
- **Coverage:** workers/agents/runner.ts (resolveAgent), workers/routes/agents.ts (PUT /api/project-addresses/:email/agent), tests/agents-runner.test.ts, tests/agents-registry.test.ts
- **Product:** unobserved
- **Today:** Implemented in code and tests. One agent serves many addresses; each address shows its agent or Off; Off keeps mail and runs nothing; a deleted agent leaves its addresses Off; each run records the agent version. A mailbox from before the registry migrates once to its own drafting agent with its old prompt; after that the mailbox settings prompt only instructs the chat assistant, and Settings says so with links to Project addresses and Agents.

### SCN-024: Agent answers within its policy
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-10
- **Preconditions:** User session available; the project domain uses Cloudflare Email Routing and the operator can change its routing.
- **Steps:**
  1. Mail arrives at an address with an agent -> the run appears in history with the agent, version and decision.
  2. When the policy allows the answer (known question, source found, within the daily limit) -> the reply is sent and the run records exactly what was sent.
  3. When it does not -> a draft waits for approval with the reason it was not sent.
- **Expected result:** Routine mail is answered without the operator; everything outside the policy reaches the operator as a draft with its reason.
- **Alt paths:** No-reply, bulk and automated senders are recorded as skipped; a thread the operator already answered is not answered again. One message sent to several agent addresses is answered once, from the first agent address in To (else the first in Cc, a Bcc copy last); every other copy is recorded as skipped with "Duplicate: answered from <address>".
- **UI elements:** SCR-08; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A model or tool failure produces a draft or an unknown outcome, never a guessed send; a send whose acceptance is unknown is not repeated automatically; text in the mail cannot widen the grants of the agent.
- **Status:** draft
- **Coverage:** workers/agents/prefilter.ts (prefilter), workers/agents/policy.ts (decide), workers/agents/runner.ts (runAgent), workers/agents/dedupe.ts (electAnswerer, decideClaim), app/routes/agents.tsx (Recent answers), tests/agents-runner.test.ts, tests/agents-registry.test.ts, tests/agents-dedupe.test.ts
- **Product:** unobserved
- **Today:** Implemented and tested without a live model. No-reply, bulk, list, automatic and already-answered mail is skipped before any model call; an allowed grounded answer is sent once through the outbox; limits, disallowed intents, ungrounded answers and tool failures become drafts with the reason; an unknown send is recorded and not retried; a failed safety check is recorded as such. A message delivered to several agent addresses is answered once per workspace (B-22): a copy that is not chosen waits up to 20 minutes for the chosen address, then shows as a skipped duplicate naming it, or answers itself if that address never took the message. Runs are listed on **Agents → Recent answers** rather than SCR-08. No real model call or delivery observed.

### SCN-025: Mail to an address with no mailbox
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** User session available; the project domain uses Cloudflare Email Routing and the operator can change its routing.
- **Steps:**
  1. Mail arrives for an address on a project domain that has no mailbox -> the address policy of that domain decides: reject, or deliver to the domain catch-all mailbox.
  2. Open the domain -> recent unknown recipients are listed with a one-click Create address.
- **Expected result:** No inbound mail is lost silently.
- **Alt paths:** A domain without a catch-all rejects with a clear bounce so the sender knows.
- **UI elements:** SCR-09; named actions and fields in the steps; visible state and recovery control.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** If neither rejecting nor storing is possible, the failure is logged with the recipient and time.
- **Status:** draft
- **Coverage:** workers/index.ts (resolveRecipient), app/routes/project-addresses.tsx (unknown recipients), tests/incoming-routing.test.ts, tests/project-addresses.test.ts
- **Product:** unobserved
- **Today:** Implemented. Unknown addresses are rejected with "Address not found" or kept in a per-domain catch-all, recorded without sender or body, and listed on **Project addresses** with **Create address** (observed on the local Worker with a synthetic message).

### SCN-026: See what matters first across accounts
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-03
- **Preconditions:** At least one connected account with unread mail.
- **Steps:**
  1. Open All inboxes -> Focus shows an Important section first: unread mail from people, security and sign-in messages, monitoring alerts, app review rejections, failed payments, CI failures and starred mail.
  2. Read each important row -> it names its account and why it was raised ("Payment problem", "Needs action").
  3. Open one -> it is marked read and keeps its place in Important until the operator moves on; afterwards it sits in its group.
- **Expected result:** The handful of messages that need the operator are visible without scrolling past newsletters and notifications.
- **Alt paths:** Newest shows the flat list with a group tag on every row; Unread only narrows the list in every account. Mail from the operator's own domains goes to Your addresses, never to Important as a person's mail. One email received by several inboxes is one row with "+N".
- **UI elements:** SCR-03; Focus / Newest, Unread only, Important section, row reason tag.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** An account that fails to load is named above the list and its mail is absent, never shown as read; marking read that fails leaves the message unread and says so.
- **Status:** validated
- **Coverage:** shared/mail/triage.ts (triage), workers/lib/inbox-query.ts (mailboxInboxMessage), workers/providers/account-service.ts (listInboxMessages), app/components/inbox/TriagedList.tsx, app/routes/unified-inbox.tsx, tests/triage.test.ts, tests/inbox-integration.test.ts, tests/inbox-ui.test.ts
- **Product:** unobserved
- **Today:** Implemented for Cloudflare mailboxes and Gmail accounts by header and label rules, no model. Sections cover the loaded pages (50 at a time, Load older); personal accounts over IMAP arrive with roadmap L1. Observed with the synthetic fixture in light and dark.

### SCN-027: Open one group of automated mail
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-03
- **Preconditions:** Loaded mail includes automated senders.
- **Steps:**
  1. Below Important, groups are collapsed with their count and unread count -> the operator expands one.
  2. Or choose a group chip -> only that group is listed, expanded.
- **Expected result:** Newsletters, notifications and receipts stay out of the way until asked for, and one group can be read on its own.
- **Alt paths:** All clears the group filter; the choice lives in the address bar and survives reload.
- **UI elements:** SCR-03; group headings with counts, group chips.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Collapsing never marks read, moves or deletes mail; a group with no loaded mail is not offered.
- **Status:** validated
- **Coverage:** app/components/inbox/triage-view.ts (focusSections, groupCounts), app/components/inbox/TriagedList.tsx, tests/inbox-ui.test.ts
- **Product:** unobserved
- **Today:** Implemented; bulk actions per group (mark read, archive with a count preview) are roadmap L5.

### SCN-028: First run with a ready setup
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001
- **Entry point:** SCR-01
- **Preconditions:** Fabric Inbox is installed from its disk image; no server is saved yet.
- **Steps:**
  1. Open the app -> a welcome explains in two sentences what the server is (a small server in the owner's own Cloudflare account that receives and keeps the mail) and offers: Create my server on Cloudflare (SCN-030), open a setup file, or I already have a server; a personal build also offers the setup bundled for its owner.
  2. Choose a setup -> a review shows its server, sign-in, domains and addresses, what stays as it is (domains in other accounts) and what will happen.
  3. Connect -> the server opens in the app; sign-in by the emailed code happens inside it; then the setup page applies the addresses and shows each result.
- **Expected result:** A first-time user reaches a working inbox without knowing what an origin or an Access team is.
- **Alt paths:** The public build carries no one's setup, so no one else's domains are ever shown; a setup file from another installation works the same way; "I already have a server" keeps the manual form; Back returns to the welcome without saving.
- **UI elements:** SCR-01 (welcome, setup review, manual form), SCR-11 (apply results).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A file that is not a setup names its problems and nothing is saved; an unreachable server keeps the choice and offers Retry; a partly applied setup can be applied again safely.
- **Status:** validated
- **Coverage:** desktop/setup.html, desktop/setup.js, desktop/main.cjs, deployments/setup.example.json, desktop/dist-mac.mjs, app/routes/setup.tsx, workers/routes/setup.ts
- **Product:** unobserved
- **Today:** Built in this change; checked with a local server, not with the deployed one.

### SCN-029: Bring existing Cloudflare addresses in
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-11
- **Preconditions:** The server has an Email Routing token for the project zones.
- **Steps:**
  1. Open Setup and choose Read from Cloudflare -> every forwarded address becomes a proposed mailbox that keeps forwarding a copy to the same destination; a forwarding catch-all becomes catch-all@<domain>.
  2. Review and Apply -> mailboxes are created with no agent; each result is listed.
- **Expected result:** Existing project addresses are collected in the app while their mail still reaches the old destination.
- **Alt paths:** Export saves the current setup as a file for another installation.
- **UI elements:** SCR-11; Read from Cloudflare, Open file, Apply, Export.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A refused forward keeps the mail and is shown on the address; routing rules are not changed by applying a setup.
- **Status:** validated
- **Coverage:** workers/routes/setup.ts, workers/routing/to-setup.ts, tests/setup.test.ts, app/routes/setup.tsx
- **Product:** unobserved
- **Today:** Server side built and tested in workerd; switching each routing rule to the Worker is a separate operator step.

### SCN-030: Create my server from the app
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001
- **Entry point:** SCR-01
- **Preconditions:** The app is installed; the person has a Cloudflare account (free plan) and no Fabric Inbox server, or an older one.
- **Steps:**
  1. Choose Create my server on Cloudflare -> the app lists the permissions for one Custom Token and opens Cloudflare's API Tokens page.
  2. Paste the token, Continue -> the account is found; if it already has a server the app says it will be updated and keep its mail.
  3. Enter the email that signs in (and, the first time, names for the workers.dev address and the sign-in page), Create my server -> eight steps are shown as they run: web address, storage, sign-in page, codes by email, only you can open it, upload, start, publish.
  4. The server opens in the app -> sign in with the emailed code -> Domains & addresses opens.
- **Expected result:** A person with only a Cloudflare account has their own server running and is signed in, without a terminal.
- **Alt paths:** Fabric Inbox → Connect Cloudflare account… runs the same flow for an existing server, which is updated in place (only missing storage migrations; DOMAINS, secrets and sign-in rules kept).
- **UI elements:** SCR-01 (Create my server: token, details, progress).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A token Cloudflare does not accept, a missing permission (named), R2 or Zero Trust not turned on yet (the dashboard step is named) or a taken name stop at that step; Continue runs the rest again and what is done stays done; a server newer than the app is refused.
- **Status:** validated
- **Coverage:** desktop/cloudflare-deploy.cjs, desktop/main.cjs, desktop/preload.cjs, desktop/setup.html, desktop/setup.js, scripts/server-bundle.mjs, tests/desktop-deploy.test.ts
- **Product:** unobserved
- **Today:** Built and tested against a fake Cloudflare; the upload, update and Access application were exercised live on the owner's account with a throwaway Worker; a full first run on a new account has not been observed.

### SCN-031: Receive a domain's mail here
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** The server has the Cloudflare token.
- **Steps:**
  1. Open Domains & addresses -> every domain of the account; the ones receiving here first.
  2. Receive mail here on a domain -> if another provider's MX records are on it, the app names them and asks before replacing them.
  3. The steps run and are listed: Email Routing on, domain served, each existing address brought in keeping its old destination as a copy, rules pointed here, sending on, DMARC added where missing.
- **Expected result:** The domain's mail arrives here, nothing that used to reach a person stops reaching them, and replies can leave from the domain.
- **Alt paths:** On a domain already receiving, Bring them here moves addresses that still go elsewhere; Turn on sending alone; Stop receiving here sends every address back to its copy and keeps the mail. A domain in another Cloudflare account than the server's gets one more step, Carry the mail from its account: the server installs its relay Worker there (once per account), and the domain's rules point at it; sending goes through that account's Email Sending API.
- **UI elements:** SCR-09; Receive mail here, the MX confirmation, the step list, Bring them here, Turn on sending, Stop receiving here; the account named on each domain.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A missing permission is named; a failure stops at that step with what was already done, and running it again continues; sending and DMARC failures do not undo receiving. A relay that cannot be installed stops before any rule moves, leaving no sign-in behind.
- **Status:** validated
- **Coverage:** workers/routing/domains.ts, workers/routes/domains.ts, workers/relay/install.ts, workers/relay/ingress.ts, app/components/domains/DomainCard.tsx, app/routes/project-addresses.tsx, tests/domains.test.ts, tests/cloudflare-relay.test.ts
- **Product:** unobserved
- **Today:** Built and tested in workerd against a stateful fake Cloudflare; the owner's 19 domains were moved by hand earlier the same day with the same steps. 0.8.0: turning Email Routing on sends no domain name (Cloudflare refused the apex as "must be a subdomains", seen on an owner domain 2026-09-30); the relay step for another account (operator decision 2026-09-30).

### SCN-032: Add or remove an address on a domain
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** The domain receives here.
- **Steps:**
  1. Open the domain, type the name before @, choose who answers and optionally a copy to a confirmed destination, Add -> the routing rule and the address are created; Send test message proves it.
  2. Remove… on an address -> confirm -> its rule, then the address and its mail are deleted; the answer says where new mail to it goes now.
- **Expected result:** Addresses for a new account or project exist in seconds and go away cleanly.
- **Alt paths:** From Mail for addresses that do not exist, Use this name fills the form.
- **UI elements:** SCR-09; per-domain add form, Remove… with its confirmation.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A refused rule creates no address; a copy to an unconfirmed destination or to a served domain is refused with the reason; the catch-all address cannot be removed until another one (or none) is chosen.
- **Status:** validated
- **Coverage:** workers/lib/address-ops.ts, workers/routes/agents.ts, workers/routing/email-routing.ts, app/components/domains/AddressRow.tsx, app/components/domains/DomainCard.tsx, app/routes/home.tsx, tests/domains.test.ts
- **Product:** unobserved
- **Today:** Built and tested in workerd against a fake Cloudflare. The Mailboxes screen creates and removes through the same steps; on 2026-09-29 an address created there got its rule and, removed, lost it, with the answer naming the catch-all that now keeps its mail. An existing address's copy is changed with Change.

### SCN-033: Keep copies and unknown addresses somewhere
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** The server has the Cloudflare token.
- **Steps:**
  1. Forwarding destinations -> add an outside address -> Cloudflare sends it a confirmation link; it is listed as waiting until opened.
  2. On a domain, Mail for an address that does not exist -> keep it in one of the domain's addresses, or refuse it so the sender is told.
- **Expected result:** Copies go only where someone confirmed them, and mail to a mistyped address is either kept or refused, never silently dropped.
- **Alt paths:** A copy that fails later is shown on the address with its reason, and the mail itself is kept.
- **UI elements:** SCR-09; Forwarding destinations, the catch-all choice.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A destination on a served domain is refused (it would loop); choosing a catch-all points Cloudflare's catch-all here and reports if Cloudflare refused.
- **Status:** validated
- **Coverage:** workers/routing/domains.ts, workers/routes/domains.ts, app/components/domains/Destinations.tsx, app/components/domains/DomainCard.tsx, tests/domains.test.ts
- **Product:** unobserved
- **Today:** Built and tested in workerd against a fake Cloudflare.

### SCN-034: Give an agent a knowledge collection
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-12
- **Preconditions:** The server runs 0.4 or later (KnowledgeDO).
- **Steps:**
  1. Open Knowledge, New collection -> name it and say what is in it.
  2. Upload .md or .txt files, or paste a document -> each is listed with its source and size; a file with the same name replaces the old one.
  3. Try a search -> the passages an agent would get, with their source.
  4. On Agents, edit the agent and tick the collection -> the agent card says which collections it searches.
- **Expected result:** An agent can use material far longer than a prompt, and only the material chosen for it.
- **Alt paths:** A collection filled from Fabric (source `fabric`) is read-only here; deleting a collection an agent uses is refused until it is unticked.
- **UI elements:** SCR-12 (New collection, Upload, Paste, Try a search, Delete), SCR-10 (Knowledge collections it may search).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A document over the limit or with no text is refused alone with its reason; an agent cannot be saved with a collection that no longer exists.
- **Status:** validated
- **Coverage:** app/routes/knowledge.tsx, app/routes/agents.tsx (KnowledgeGrants), workers/routes/knowledge.ts, workers/knowledge/store.ts, tests/knowledge.test.ts
- **Product:** unobserved
- **Today:** Built, tested in workerd, and used live on 2026-09-29 with a throwaway collection (removed after).

### SCN-035: An agent answers from its collections only
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-10
- **Preconditions:** An agent with at least one collection is on an address.
- **Steps:**
  1. A message arrives -> its subject and first lines are searched in the agent's collections; the best five passages reach the model with their source.
  2. The model may search again with other words (search_knowledge), never outside those collections.
  3. The run lists the passages under Answered from; the draft or the sent answer states only what they, the notes or a tool said.
- **Expected result:** Customers get answers from the chosen material, and the operator sees which document each answer came from.
- **Alt paths:** A question the collections do not answer is passed on ("I will pass the question to the team") instead of guessed.
- **UI elements:** SCR-10 (Recent answers → Answered from).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A failed search keeps the answer a draft with the reason, even for an agent allowed to send; a model that ends without an answer gets one turn that can only submit it, and if it still gives none the run is Failed and the message waits for a person.
- **Status:** validated
- **Coverage:** workers/agents/runner.ts, workers/agents/model.ts, workers/agents/policy.ts, tests/knowledge.test.ts, tests/agents-model.test.ts, tests/agents-runner.test.ts
- **Product:** unobserved
- **Today:** Live on 2026-09-29: a Russian question was answered in Russian from two passages of the granted collection, and the part only an ungranted collection could answer was passed on.

### SCN-036: Keep a category of the mail that matters
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-13
- **Preconditions:** The server runs 0.5 or later (CategoriesDO).
- **Steps:**
  1. Categories, New category -> name it ("Refund requests") and choose where to look: all inboxes, or projects, domains and single inboxes (searchable).
  2. Say what belongs in words ("the sender asks for a refund or disputes a charge"), and/or plain conditions (From, Subject has, Text mentions) -> the form says whether the model or the conditions sort it.
  3. Save -> recent mail in scope is sorted in the background, with progress; the category appears under CATEGORIES in the sidebar.
  4. Open it -> its messages newest first, each with Why: and the reason; the count shows what arrived since it was last opened.
- **Expected result:** Mail of one kind, from any inbox, sits in one view with the reason each message is there.
- **Alt paths:** Conditions alone use no model; Edit changes it (changing where it looks, the description or the conditions sorts again, a rename does not); Delete removes the category and moves no mail; Change on the category's view opens its editor.
- **UI elements:** SCR-13 (New category, Where to look, What belongs here, Plain conditions, Save category, Open, Edit, Delete…), SCR-03 (CATEGORIES section, category view, Why:).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A model that is down or over the daily budget leaves messages waiting with the count and the reason ("wait for tomorrow's model budget", "could not be sorted"), never silently dropped; a message moved to Trash leaves the view.
- **Status:** validated
- **Coverage:** app/routes/categories.tsx, app/components/inbox/CategorySidebar.tsx, app/routes/unified-inbox.tsx, workers/categories/store.ts (CategoriesDO), workers/categories/classify.ts, workers/routes/categories.ts, workers/routes/inbox.ts (readCategory), tests/categories.test.ts, tests/inbox-ui.test.ts
- **Product:** unobserved
- **Today:** Live on 2026-09-29: "Refund requests" over all inboxes sorted 27 messages (no match), then matched a refund request in under 15 s with its reason; the message left the view when trashed. A message restored from Trash returns only when the category next changes (board B-26).

### SCN-037: See one project's mail in one place
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-13
- **Preconditions:** The server runs 0.5 or later.
- **Steps:**
  1. Categories, New project -> name it ("Acme") with its domains and any single addresses elsewhere.
  2. New category -> tick the project under Where to look and leave the rest empty -> the form says it shows every message there.
  3. Open it from the sidebar -> the project's live mail from all its inboxes, in Focus with its groups; the sidebar counts its unread.
- **Expected result:** A product's mail across its domains and addresses reads as one inbox.
- **Alt paths:** Add a description to keep only part of it ("Acme support questions"); editing the project re-sorts the described categories that use it.
- **UI elements:** SCR-13 (New project, Projects), SCR-03 (category view).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A project a category uses cannot be deleted, and the screen says why; an inbox that fails to load is named above the list as in All inboxes.
- **Status:** validated
- **Coverage:** workers/categories/definition.ts (inScope), workers/routes/inbox.ts (readCategory), app/routes/categories.tsx, tests/categories.test.ts
- **Product:** unobserved
- **Today:** Built and tested in workerd; no project was created on the owner's server (no Acme domain is served there yet).

### SCN-038: Raise a category's mail to Important
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-13
- **Preconditions:** A category exists.
- **Steps:**
  1. Edit the category, tick Also raise its messages to Important in Focus, save.
  2. Open All inboxes -> its messages are in Important with the reason "Category: X"; every row names the categories it belongs to.
- **Expected result:** What the operator said matters is at the top of Focus, not only in its own view.
- **Alt paths:** Unticked, the category's mail stays in its triage group and carries only the chip.
- **UI elements:** SCR-13 (Also raise its messages to Important in Focus), SCR-03 (Important section, category chip).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A category whose sorting failed raises nothing it has not placed; the category's own progress line says what is waiting.
- **Status:** validated
- **Coverage:** workers/routes/inbox.ts (markCategories), app/components/inbox/TriagedList.tsx, tests/categories.test.ts
- **Product:** unobserved
- **Today:** Built and tested in workerd ("a described category classifies the last messages in scope, lists them with why, and raises them in Focus").

### SCN-039: Spam stays out of the inbox
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-03
- **Preconditions:** The server runs 0.6 or later; mail arrives at a Cloudflare address.
- **Steps:**
  1. A forged message arrives (it claims one of the operator's domains or fails DMARC where its domain asks to reject) -> it is stored in Spam with the reason, and no agent, rule or category sees it.
  2. A message from a stranger arrives -> the model reads it once; spam moves to Spam with its reason, anything else stays.
  3. Open Spam -> every message says why it is there; the banner says it is deleted after 30 days.
- **Expected result:** The inbox holds mail meant for the operator; what was taken out can be checked in one place.
- **Alt paths:** A sender the operator wrote to is never read by the model; an almost empty message is left alone; Delete all now empties Spam after a confirmation.
- **UI elements:** SCR-03 (Spam folder, Why in Spam, banner, Delete all now…).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** If the lists cannot be read the message goes to the inbox; a model that is down or over its budget leaves the message where it is; a Spam that cannot be emptied in some addresses says how many.
- **Status:** validated
- **Coverage:** shared/mail/spam.ts, workers/index.ts (spamVerdict), workers/durableObject/index.ts (receiveEmailOnce, purgeSpam), workers/categories/store.ts, app/routes/unified-inbox.tsx (SpamBanner), tests/spam.test.ts, tests/spam-workerd.test.ts
- **Product:** unobserved
- **Today:** Live on 2026-09-29; the first live verdict was a false positive on an almost empty message, which the model no longer reads.

### SCN-040: Report spam, or bring a message back
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-04
- **Preconditions:** A message is open.
- **Steps:**
  1. Report spam in the reader -> the message moves to Spam and the next one opens; the notice says new mail from that sender goes to Spam too.
  2. In Spam, Not spam -> it moves back to the inbox; mail from that sender is never treated as spam again.
- **Expected result:** One action fixes the message and teaches the filter.
- **Alt paths:** A Gmail message uses Gmail's own spam label, which trains Gmail.
- **UI elements:** SCR-04 (Report spam, Not spam), SCR-03 notice.
- **States covered:** loading, error, success
- **Errors & recovery:** A message that is no longer there says so; if the lists cannot be changed the message still moves and the notice says the rule was not saved.
- **Status:** validated
- **Coverage:** app/components/inbox/MessageActions.tsx (changeSpam), workers/routes/spam.ts, workers/spam/lists.ts, tests/inbox-ui.test.ts, tests/spam-workerd.test.ts
- **Product:** unobserved
- **Today:** Run on a real message on 2026-09-29, both ways; the list entry was removed afterwards.

### SCN-041: Keep the spam rules
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-14
- **Preconditions:** None.
- **Steps:**
  1. Open Spam rules -> what goes to Spam, today's checks and the model's allowance.
  2. Add or remove senders and domains on the Always spam and Never spam lists.
- **Expected result:** The operator can see and change exactly what the filter does.
- **Alt paths:** Open Spam from the rules; the rules from Spam's banner.
- **UI elements:** SCR-14.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** An entry that is not an address or a domain is refused with the reason; two changes at once both land.
- **Status:** validated
- **Coverage:** app/routes/spam.tsx, workers/routes/spam.ts, tests/spam-workerd.test.ts
- **Product:** unobserved
- **Today:** Built and seen in the installed app on 2026-09-29.

### SCN-042: List only the addresses that matter
- **Persona:** P-01
- **Feature:** Find and handle a conversation
- **Traces:** ST-002, FLW-02, JTBD-01, JRN-01; RE-001
- **Entry point:** SCR-03
- **Preconditions:** More addresses than the operator reads.
- **Steps:**
  1. The sidebar lists addresses with mail, catch-alls and the one open (With mail); "N without mail not listed" says how many are left out.
  2. Hide them… -> confirm -> the addresses with no mail are hidden; or the eye next to one address hides just it.
  3. Hidden (N) -> open one on its own, or Show again.
- **Expected result:** The sidebar and All inboxes hold the addresses the operator uses; nothing stops receiving.
- **Alt paths:** All lists every address again; the choice is remembered on the device, the hidden list on the server.
- **UI elements:** SCR-03 (With mail / All, the eye on each address, Hide them…, Hidden list, the stuck-mail banner with Retry).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A change that cannot be saved says so and changes nothing; mail that reached an address but not its rules, agents or categories is shown with its last error and Retry.
- **Status:** validated
- **Coverage:** app/components/inbox/AccountSidebar.tsx, app/components/inbox/account-groups.ts (sidebarAccounts), workers/routes/inbox.ts (hidden, counts), workers/lib/hidden-accounts.ts, tests/inbox.test.ts, tests/inbox-ui.test.ts, tests/spam-workerd.test.ts
- **Product:** unobserved
- **Today:** Built and seen on the owner's server on 2026-09-29 (36 addresses, 8 listed with mail); nothing was hidden there.

### SCN-043: Give an outside agent a key
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001
- **Entry point:** SCR-15
- **Preconditions:** The server has its Cloudflare token with Access: Service Tokens and Access: Apps and Policies.
- **Steps:**
  1. Open Agent access from the sidebar -> what it is, and that these are not the reply agents.
  2. Name the agent, choose Read, Mail or Admin, and for Mail or Admin Drafts only or Can send with a daily number; for Read or Mail choose All mailboxes or Only these mailboxes and tick them (an Admin key reaches every mailbox); choose when it expires; Make key.
  3. The key's Client ID and Client Secret, the Claude Code command and the JSON for other clients are shown once, each with Copy; I saved it closes them.
- **Expected result:** The agent connects to /mcp with the two headers and sees only the tools its level and sending allow; a key limited to mailboxes sees only the tools that stay inside a mailbox, and is refused, with the mailboxes it may use named, on any other mailbox or shared setting. The key list shows each key's mailboxes (All mailboxes, or Only ...).
- **Alt paths:** The server has no Cloudflare token: the form is replaced by where to add one. Only these mailboxes with none ticked: Make key stays off. A limited key whose only mailbox is gone gets an empty list with the reason, not a failure.
- **UI elements:** SCR-15 (name, Level, Sending, Mailboxes, Expires after, Make key, the one-time secret panel with Copy).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A token without the permission names it; a key Cloudflare made but the server could not save is deleted again, and the error says to try again.
- **Status:** draft
- **Coverage:** app/routes/agent-access.tsx, workers/routes/agent-keys.ts, workers/mcp/access.ts, workers/mcp/scope.ts, tests/mcp-auth.test.ts, tests/mcp-scope.test.ts, tests/mcp-workerd.test.ts, tests/agent-access-ui.test.ts
- **Product:** unobserved
- **Today:** Built in 0.7.0; the first live key is made at the release.

### SCN-044: See what agents changed, and revoke a key
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001
- **Entry point:** SCR-15
- **Preconditions:** At least one key.
- **Steps:**
  1. What agents changed lists every change made through the agent protocol: when, which key, the action, on what, and the result (Done, Failed, Refused, Asked to confirm); Show older pages back.
  2. Revoke… beside a key -> it stops working at once -> Revoke; or Keep.
- **Expected result:** The owner sees every change an agent made and can cut one off in one step.
- **Alt paths:** A key revoked here whose token Cloudflare could not delete says so and where to delete it by hand.
- **UI elements:** SCR-15 (Keys with Revoke…, What agents changed, Show older, Newer).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A list that cannot load offers Retry; nothing older says so.
- **Status:** draft
- **Coverage:** app/routes/agent-access.tsx, workers/routes/agent-keys.ts, workers/mcp/ledger.ts, tests/mcp-workerd.test.ts
- **Product:** unobserved
- **Today:** Built in 0.7.0.

### SCN-045: Choose which Cloudflare accounts show
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** The server has its Cloudflare token; the owner has more than one Cloudflare account.
- **Steps:**
  1. Open Domains & addresses -> Cloudflare accounts lists every account the server has a token for: its name, whether it has mail, how many domains and how many receive here, how it is reached (the server's token or its own), and whether its relay is installed.
  2. The server's account and every account with mail (or whose mail could not be read) are shown; an account without mail is listed as not shown -> Show puts its domains in the list below; Hide takes them out; Default goes back to the rule.
- **Expected result:** Every account where the owner has mail is on the screen without asking, and nothing else crowds it.
- **Alt paths:** An account whose saved token no longer works is listed with the reason, with Remove…, and Connect another account with a new token replaces it; its domains are not guessed; the other accounts still list.
- **UI elements:** SCR-09; Cloudflare accounts (one row per account, Show / Hide / Default).
- **States covered:** loading, empty, error, success
- **Errors & recovery:** Hiding an account whose domains receive here is refused and names them; an account that cannot be read shows why, the rest still list.
- **Status:** validated
- **Coverage:** workers/routing/accounts.ts, workers/routing/domains.ts, workers/routes/cloudflare-accounts.ts, workers/routes/domains.ts, app/components/domains/Accounts.tsx, tests/cloudflare-accounts.test.ts
- **Product:** unobserved
- **Today:** Operator, 2026-09-30: "every account there is must be visible by default where it has mail". Built in 0.8.0.

### SCN-046: Connect another Cloudflare account
- **Persona:** P-01
- **Feature:** Put an agent on a project address
- **Traces:** ST-008, FLW-08, JTBD-02, JRN-02; RE-001
- **Entry point:** SCR-09
- **Preconditions:** The server has its own Cloudflare token.
- **Steps:**
  1. Connect another account -> the window says what the token needs (the permissions table) and where to create it, in the other account.
  2. Paste the token, Connect -> the server checks it, keeps it as its own secret for each account it sees that has no token yet, and lists them; the token is never shown again.
  3. The account appears in Cloudflare accounts within seconds; Receive mail here on one of its domains installs the relay there (SCN-031).
  4. Remove… on an account connected this way -> confirm -> its relay and the relay's sign-in are removed, then its token.
- **Expected result:** Domains from any of the owner's Cloudflare accounts receive here, not only the one the server runs in.
- **Alt paths:** A token that reaches several accounts connects each one it sees; the server's own account keeps its own token and is skipped.
- **UI elements:** SCR-09; Connect another account (permissions, token field, Connect), Remove… with its confirmation.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** A token Cloudflare does not accept, or one without Account Settings: Read, is refused with the reason and nothing is saved; an account whose domains receive here cannot be removed until they stop; a new account not yet visible after saving says the server is starting to use it and reads again.
- **Status:** validated
- **Coverage:** workers/routes/cloudflare-accounts.ts, workers/relay/install.ts, app/components/domains/Accounts.tsx, tests/cloudflare-accounts.test.ts, tests/cloudflare-relay.test.ts
- **Product:** unobserved
- **Today:** Operator, 2026-09-30: "the ones that are missing are connected from the connection window". Built in 0.8.0.

### SCN-047: Connect a hub on this Mac by allowing it
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03, JRN-03; RE-001
- **Entry point:** SCR-15
- **Preconditions:** The app is set up with its server and signed in; a local hub (Fabric) opens a `fabric-inbox://connect` link with its name, the level it needs, a callback on this Mac and a one-time request id.
- **Steps:**
  1. The link opens Fabric Inbox -> a native prompt: "Connect Fabric?", who asks, on which server, the level in plain words, that the key goes only to this Mac (its loopback address) and that it is listed under Agent access; Deny is the default.
  2. Allow -> the app makes the key with the owner's own session (the Agent access route) and hands it to the callback once -> "Fabric is connected".
  3. The key appears on SCR-15 under its name like any other key; Revoke… there ends it.
- **Expected result:** A hub on this Mac gets its own key without anyone copying a Client ID or Secret. Every call the hub makes for one of its agents carries X-Fabric-Accounts, so it reaches only the mailboxes that agent was allowed.
- **Alt paths:** Deny: nothing is made and the hub hears "denied". No server set up yet: the setup window opens and the hub hears why. The sign-in has lapsed: the mail window opens to sign in, nothing is made, and the person connects again from the hub. A link that is not a valid connect link (a callback off this Mac, an unknown level, no request id) is refused with the reason and nothing is asked.
- **UI elements:** Native prompt (Deny, Allow), the "Connected" or "Not connected" notice, SCR-15 key list.
- **States covered:** loading, empty, error, success
- **Errors & recovery:** The hub does not receive the key within 10 seconds: the key is revoked at once and the notice says so (or says to revoke it on SCR-15 if Cloudflare refused); the server refuses to make a key: the notice quotes its reason.
- **Status:** draft
- **Coverage:** desktop/connect.cjs, desktop/main.cjs, workers/mcp/scope.ts, workers/mcp/handler.ts, tests/desktop-connect.test.ts, tests/mcp-scope.test.ts, tests/mcp-workerd.test.ts
- **Product:** unobserved
- **Today:** Operator, 2026-10-03: "something pops up, you authorise, and it goes on" — the product connects without copying (ADR-0115 in passioncode-ai/fabric).

### SCN-048: Turn the anonymous usage counts off or on
- **Persona:** P-01
- **Feature:** Resume and manage preferences
- **Traces:** ST-007, FLW-07, JTBD-03; passioncode-ai/fabric-inbox#27
- **Entry point:** The app menu, Fabric Inbox → Share Anonymous Usage Counts (a checkmark) and About Usage Counts…
- **Preconditions:** A released disk image (it carries the App Key); no PassionCode app has turned the shared switch off.
- **Steps:**
  1. The person opens About Usage Counts… -> a native notice says what is sent (installed, opened, a day of use, how many Gmail accounts, Cloudflare mailboxes, agents and agent keys) and what never is (names, addresses, domains, messages, keys), and that the setting is shared by every PassionCode app on this Mac.
  2. They clear the checkmark -> the shared file says `analytics: false`, events still waiting are dropped, and nothing more is sent by this app or by any other PassionCode app on the Mac.
  3. They set it again -> counting resumes from that moment; nothing done while it was off is reported.
- **Expected result:** The person knows what leaves the Mac and has one switch for it that every PassionCode app honours.
- **Alt paths:** A build from source or the Mac App Store package: the checkmark is shown unavailable and nothing is sent. The shared file cannot be read (damaged): the checkmark cannot be set, a notice says nothing is sent, and the file is left as it is.
- **UI elements:** App menu checkbox item, About Usage Counts… item, native notice.
- **States covered:** empty, error, success
- **Errors & recovery:** The shared file is damaged: analytics stays off and the notice says so; the person can remove the file to start fresh. The server is unreachable: events wait in memory (at most 23 hours) and are sent when it answers; nothing blocks the window.
- **Status:** draft
- **Coverage:** desktop/analytics.cjs, desktop/main.cjs, tests/desktop-analytics.test.ts, tests/desktop-profile.test.ts
- **Product:** unobserved
- **Today:** Built 2026-10-05 for 0.10.0 (docs/ANALYTICS.md); the switch is the one Fabric Switchboard shipped first.
