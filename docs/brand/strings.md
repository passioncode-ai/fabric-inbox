Contract: brand-contract v1

# Interface strings

Bounded inventory of actual integrated source wording. Rows remain proposed because the draft voice and complete copy have not received a separate acceptance pass. These are source strings, not proof the surrounding scenario works. Imports, paths and CSS literals are deliberately not registered as product text.

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| action.mail.search | Search emails | app/components/Header.tsx:80 | SCN-005 | proposed |
| navigation.settings | Settings | app/routes/settings.tsx | SCN-012 | proposed |
| action.account.connect_gmail | Connect Gmail in browser ↗ | app/components/settings/sections/GmailSetup.tsx | SCN-002 | proposed |
| state.account.not_configured | Gmail is connected through a Google Cloud app of your own, so your mail goes only between Google and your server. | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| state.account.other_unavailable | Not available in this build | app/components/settings/sections/providers.ts | SCN-003 | proposed |
| navigation.rules | Rules and history | app/components/settings/sections/AccountsSection.tsx | SCN-016 | proposed |
| action.mail.sync | Sync now | app/routes/gmail-inbox.tsx:277 | SCN-004 | proposed |
| action.mail.compose | Compose | app/routes/gmail-inbox.tsx:280 | SCN-006 | proposed |
| action.mail.send | Send | app/routes/gmail-inbox.tsx:336 | SCN-007 | proposed |
| action.mail.check_send | Check send status | app/routes/gmail-inbox.tsx:172 | SCN-020 | proposed |
| action.draft.discard | Discard | app/routes/gmail-inbox.tsx:359 | SCN-006 | proposed |
| action.mail.reply | Reply | app/routes/gmail-inbox.tsx:452 | SCN-008 | proposed |
| action.mail.forward_text | Forward text | app/routes/gmail-inbox.tsx:459 | SCN-009 | proposed |
| action.mail.archive | Archive | app/routes/gmail-inbox.tsx:488 | SCN-011 | proposed |
| label.mail.search_cache | Search cached mail | app/routes/gmail-inbox.tsx:367 | SCN-005 | proposed |
| state.mail.loading | Loading mail… | app/routes/gmail-inbox.tsx:377 | SCN-005 | proposed |
| state.mail.no_match | No matching mail in this page. Sync or continue to the next page. | app/routes/gmail-inbox.tsx:386 | SCN-005 | proposed |
| state.mail.select | Select a message to read it. | app/routes/gmail-inbox.tsx:432 | SCN-004 | proposed |
| state.send.accepted | Accepted by Gmail. Recipient delivery is not confirmed. | app/routes/gmail-inbox.tsx:168 | SCN-007 | proposed |
| state.send.unknown | Outcome unknown. Check send status before trying again. | app/routes/gmail-inbox.tsx:172 | SCN-020 | proposed |
| state.draft.restore_failed | Saved draft could not be restored. | app/routes/gmail-inbox.tsx:46 | SCN-019 | proposed |
| state.draft.save_failed | This draft could not be saved on this device. Keep this window open. | app/routes/gmail-inbox.tsx:61 | SCN-006 | proposed |
| action.rule.new | New rule | app/routes/automation.tsx:94 | SCN-014 | proposed |
| action.rule.dry_run | Dry-run | app/routes/automation.tsx:404 | SCN-014 | proposed |
| action.rule.save | Save rule | app/routes/automation.tsx:420 | SCN-015 | proposed |
| action.run.approve | Approve this action | app/routes/automation.tsx:479 | SCN-017 | proposed |
| action.run.cancel | Cancel run | app/routes/automation.tsx:495 | SCN-017 | proposed |
| state.rule.preview | Preview only. No message is sent, moved or changed. | app/routes/automation.tsx:407 | SCN-014 | proposed |
| state.history.empty | No runs yet. History appears when an enabled rule matches new mail. | app/routes/automation.tsx:436 | SCN-016 | proposed |
| state.outbox.accepted | Accepted means the email provider took the message. Recipient delivery remains unconfirmed. | app/routes/automation.tsx:505 | SCN-007 | proposed |
| label.desktop.server | Server address | desktop/setup.html:18 | SCN-001 | proposed |
| action.desktop.connect | Save and connect | desktop/setup.html:25 | SCN-001 | proposed |
| action.desktop.retry | Retry connection | desktop/setup.html:25 | SCN-019 | proposed |
| state.desktop.offline_boundary | Mail needs a network connection in this version; there is no offline mailbox yet. | desktop/setup.html | SCN-019 | proposed |
| state.desktop.connection_failed | Fabric Inbox could not reach the server. Check your connection, then retry. Mail is not available offline in this version. | desktop/main.cjs:95 | SCN-019 | proposed |
| state.draft.storage_scope | Drafts are saved on this device when storage is available. | app/routes/gmail-inbox.tsx:302 | SCN-006 | proposed |


## Unified workbench source strings

Locations name the source function while the integration branch is being formatted. These rows inventory source wording and remain proposed; they do not assert live provider acceptance. Legacy route wording above remains a separate source inventory.

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| navigation.inbox.all | All inboxes | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| navigation.inbox.connect | Connect Gmail | app/components/inbox/AccountSidebar.tsx | SCN-002 | proposed |
| navigation.inbox.add_address | Add address | app/components/inbox/AccountSidebar.tsx | SCN-032 | proposed |
| action.desktop.create_server | Create my server on Cloudflare | desktop/setup.html | SCN-030 | proposed |
| action.domains.receive | Receive mail here | app/components/settings/sections/DomainsSection.tsx | SCN-031 | proposed |
| heading.domains.accounts | Cloudflare accounts | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| action.domains.account_hide | Hide | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| action.domains.account_show | Show | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| action.domains.account_default | Default | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| state.domains.account_has_mail | Has mail | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| state.domains.account_no_mail | No mail yet | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| state.domains.account_mail_unknown | Mail not checked | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| state.domains.account_server | your server's account | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| action.domains.account_connect | Connect account | app/components/settings/sections/AccountsSection.tsx | SCN-046 | proposed |
| action.domains.account_remove | from your server? | app/components/settings/sections/AccountsSection.tsx | SCN-046 | proposed |
| action.settings.cancel | Cancel | app/components/settings/ui.tsx | SCN-046 | proposed |
| state.domains.account_via_own | its own token | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| state.domains.account_via_server | your server's token | app/components/settings/sections/AccountsSection.tsx | SCN-045 | proposed |
| help.domains.account_token_paste | Paste the token here. Your server keeps it as its own secret; it is not shown again. | app/components/settings/sections/AccountsSection.tsx | SCN-046 | proposed |
| field.domains.account_token | Token | app/components/settings/sections/AccountsSection.tsx | SCN-046 | proposed |
| action.domains.account_connect_submit | Connect | app/components/settings/sections/AccountsSection.tsx | SCN-046 | proposed |
| step.domains.relay | Carry the mail from its account | workers/routing/domains.ts:205 | SCN-031 | proposed |
| navigation.settings.knowledge | Knowledge | app/components/settings/paths.ts | SCN-034 | proposed |
| action.knowledge.create | Create collection | app/components/settings/sections/KnowledgeSection.tsx | SCN-034 | proposed |
| label.agents.collections | Knowledge collections it may search | app/components/settings/sections/AgentsSection.tsx | SCN-034 | proposed |
| navigation.inbox.rules | Rules & history | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-016 | proposed |
| navigation.inbox.settings | Settings | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-012 | proposed |
| action.inbox.continue_draft | Continue draft | app/components/inbox/DraftsDialog.tsx | SCN-006 | proposed |
| action.inbox.compose | Compose | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-006 | proposed |
| action.inbox.search | Search | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-005 | proposed |
| action.inbox.clear_search | Clear search | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-005 | proposed |
| action.inbox.refresh | Check for new mail | app/lib/sync-status.ts | SCN-070 | proposed |
| label.inbox.cached_search | Search cached mail | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-005 | proposed |
| state.inbox.partial | inboxes are unavailable; the rest of your mail is shown. | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| navigation.inbox.categories | CATEGORIES | app/components/inbox/CategorySidebar.tsx | SCN-036 | proposed |
| action.categories.create | New category | app/components/settings/sections/CategoriesSection.tsx | SCN-036 | proposed |
| action.categories.project | New project | app/components/settings/sections/CategoriesSection.tsx | SCN-037 | proposed |
| label.categories.scope | Where to look | app/components/settings/sections/CategoriesSection.tsx | SCN-036 | proposed |
| label.categories.description | What belongs here, in your words (optional) | app/components/settings/sections/CategoriesSection.tsx | SCN-036 | proposed |
| label.categories.conditions | Plain conditions (optional, no model) | app/components/settings/sections/CategoriesSection.tsx | SCN-036 | proposed |
| label.categories.promote | Also raise its messages to Important in Focus | app/components/settings/sections/CategoriesSection.tsx | SCN-038 | proposed |
| action.categories.save | Save category | app/components/settings/sections/CategoriesSection.tsx | SCN-036 | proposed |
| label.inbox.category_reason | Why: | app/components/inbox/TriagedList.tsx | SCN-036 | proposed |
| label.agents.history_filter | Needs a look | app/components/settings/sections/AgentsSection.tsx | SCN-024 | proposed |
| action.agents.older | Show older | app/components/settings/sections/AgentsSection.tsx | SCN-024 | proposed |
| action.agents.reload_newest | Load the newest version | app/components/settings/sections/AgentsSection.tsx | SCN-022 | proposed |
| navigation.inbox.spam | Spam | app/routes/unified-inbox.tsx | SCN-039 | proposed |
| action.message.report_spam | Report spam | app/components/inbox/MessageActions.tsx | SCN-040 | proposed |
| action.message.not_spam | Not spam | app/components/inbox/MessageActions.tsx | SCN-040 | proposed |
| label.inbox.spam_reason | Why in Spam: | app/components/inbox/TriagedList.tsx | SCN-039 | proposed |
| state.spam.banner | Mail in Spam is deleted after 30 days. Nothing here reaches an agent, a rule or a category. | app/routes/unified-inbox.tsx | SCN-039 | proposed |
| action.spam.empty | Delete all now… | app/routes/unified-inbox.tsx | SCN-039 | proposed |
| state.spam.empty_title | No spam | app/routes/unified-inbox.tsx | SCN-039 | proposed |
| navigation.spam.rules | Spam rules | app/components/settings/sections/SpamSection.tsx | SCN-041 | proposed |
| label.spam.always_senders | Always spam: senders | app/components/settings/sections/SpamSection.tsx | SCN-041 | proposed |
| label.spam.never_senders | Never spam: senders | app/components/settings/sections/SpamSection.tsx | SCN-041 | proposed |
| label.settings.signature | Add a signature to mail sent from | app/components/settings/sections/SignatureForm.tsx | SCN-012 | proposed |
| action.address.copy_save | Forward a copy to | app/components/settings/sections/AddressesSection.tsx | SCN-032 | proposed |
| label.sidebar.with_mail | With mail | app/components/inbox/AccountSidebar.tsx | SCN-042 | proposed |
| action.sidebar.hide_empty | Hide them… | app/components/inbox/AccountSidebar.tsx | SCN-042 | proposed |
| label.sidebar.hidden | Hidden | app/components/inbox/AccountSidebar.tsx | SCN-042 | proposed |
| state.inbox.loading | Loading your mail | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| state.inbox.load_failed | Mail could not load | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| state.inbox.no_match | No matching mail | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-005 | proposed |
| state.inbox.empty | Nothing here yet | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| state.inbox.no_accounts | Your mail, in one place | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| state.inbox.connect_hint | Connect Gmail and your Cloudflare mailboxes. Then read them together or focus on one. | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| action.inbox.older | Load older messages | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-005 | proposed |
| action.inbox.back | Back to messages | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| action.inbox.archive | Archive message | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-011 | proposed |
| action.inbox.read | Mark as read | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-011 | proposed |
| action.inbox.unread | Mark as unread | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-011 | proposed |
| state.inbox.detail_loading | Loading message… | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| state.inbox.detail_failed | Message could not load | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-004 | proposed |
| action.inbox.reply | Reply | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-008 | proposed |
| action.inbox.forward | Forward | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-009 | proposed |
| action.inbox.account_rules | Rules for this account | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-016 | proposed |
| state.inbox.rules_scope | Choose the account whose mail the rule can act on. | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-016 | proposed |
| action.inbox.theme_dark | Switch to dark theme | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-012 | proposed |
| action.inbox.theme_light | Switch to light theme | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-012 | proposed |
| state.inbox.theme_unsaved | Theme changed for this window. This device could not save the preference. | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-012 | proposed |
| state.inbox.draft_restore_failed | A saved draft could not be restored. Its stored data has been kept. You can still compose a new message. | app/components/inbox/use-drafts.ts | SCN-006 | proposed |
| state.inbox.draft_save_failed | Draft could not be saved on this device. Keep this window open and copy your text before leaving. | app/components/inbox/use-drafts.ts | SCN-006 | proposed |
| state.inbox.accepted | Accepted by the email provider. Recipient delivery is not confirmed. | app/routes/unified-inbox.tsx:UnifiedInbox | SCN-007 | proposed |
| action.composer.close | Close and keep draft | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| label.composer.from | From | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| label.composer.choose_sender | Choose a sender | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| label.composer.to | To | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| label.composer.subject | Subject | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| label.composer.message | Message | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| state.composer.forward_limit | Original attachments are not included yet. Load all files below before forwarding. | app/components/inbox/Composer.tsx:Composer | SCN-009 | proposed |
| state.composer.send_not_attempted | Could not save send recovery information. Sending was not attempted. | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.acceptance_pending | Acceptance is not confirmed. Keep this attempt unchanged and check again. | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.failed | The provider did not accept this attempt. Correct the draft and send again, or discard it. | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.uncertain | Acceptance is not confirmed. Retry the same attempt; its recovery key prevents a duplicate send. | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.save_failed | Draft could not be saved on this device. Keep this window open and copy your text before leaving. | app/components/inbox/use-drafts.ts | SCN-006 | proposed |
| state.composer.recovery_saved | Send recovery saved on this device | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.draft_saved | Saved to your server | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| state.composer.draft_saving_server | Kept on this device; saving to your server… | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| state.composer.draft_not_on_server | Kept on this device; not saved to your server | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| state.drafts.saving_server | Saving to your server… | app/components/inbox/use-drafts.ts | SCN-006 | proposed |
| state.drafts.not_on_server | Kept on this device; not on your server yet | app/components/inbox/use-drafts.ts | SCN-019 | proposed |
| state.drafts.offline | Not saved to your server yet; it is kept on this device and saved when the server answers. | app/components/inbox/server-drafts.ts | SCN-019 | proposed |
| state.drafts.no_sender | Choose a sender to save this draft to your server; until then it is kept on this device. | app/components/inbox/server-drafts.ts | SCN-006 | proposed |
| state.drafts.gmail_incomplete | saves a draft once it has a recipient with a valid address; until then it is kept on this device. | app/components/inbox/server-drafts.ts | SCN-006 | proposed |
| state.drafts.changed_elsewhere | This draft was changed elsewhere (another window or device, an agent, or the mail account itself). Your text is kept here. | app/components/inbox/server-drafts.ts | SCN-006 | proposed |
| action.account.connect_other_mail | Connect other mail | app/components/inbox/AccountSidebar.tsx | SCN-053 | proposed |
| state.account.imap_intro | Choose who keeps the mail. Every one of them needs an app password: a password made for one app, which you can delete there at any time. | app/components/settings/sections/ImapAccount.tsx | SCN-053 | proposed |
| field.account.app_password | App password | app/components/settings/sections/ImapAccount.tsx | SCN-053 | proposed |
| action.account.new_app_password | Enter a new app password… | app/components/settings/sections/ImapAccount.tsx | SCN-054 | proposed |
| state.account.app_password_hint | It is checked with | app/components/settings/sections/ImapAccount.tsx | SCN-054 | proposed |
| state.account.imap_no_key | Your server needs a credential key before it can keep an app password: it seals every saved password and token with it. Your server can make one now and keep it in its own settings; the key never leaves the server. | app/components/settings/sections/AccountsSection.tsx | SCN-056 | proposed |
| state.drafts.gone_elsewhere | This draft was sent or deleted elsewhere. Your text is kept here. | app/components/inbox/server-drafts.ts | SCN-006 | proposed |
| action.composer.show_saved | Show the saved version | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| action.composer.keep_mine | Keep my version | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| action.composer.save_as_new | Save it again as a new draft | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| state.composer.not_sent_unsaved | The draft could not be saved to your server, so it was not sent. Check the connection and try again. | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.changed_before_send | This draft was changed elsewhere just before sending, so it was not sent. Check it, then send again. | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.signature_failed | The sender's signature could not be loaded; add it to the message if you need it. | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| state.composer.files_limit_total | A message can carry up to 10 files, 5 MiB together. Remove a file before adding another. | app/components/inbox/Composer.tsx:Composer | SCN-009 | proposed |
| action.composer.discard | Discard draft | app/components/inbox/Composer.tsx:Composer | SCN-006 | proposed |
| action.composer.retry | Retry same attempt | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| action.composer.send | Send message | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
| state.composer.checking | Checking… | app/components/inbox/Composer.tsx:Composer | SCN-007 | proposed |
## State-message interpretation

- Gmail accepted reports provider acceptance only, never recipient delivery. Unknown keeps send recovery locked; the next action is status inspection, not blind resend (SCN-007, SCN-020).
- Workbench cached search means stored provider data in the selected account/folder scope. It must not imply full provider history or an offline desktop mailbox (SCN-005, SCN-019).
- The workbench stores independent drafts on this device with their selected accounts. Save-failure text appears inside the composer and overrides the saved-state label. Synthetic browser reload preserved three drafts, including sender, Cc/Bcc and one file (SCN-006, SCN-019); live provider acceptance remains unverified.
- Workbench uncertain sending uses Retry same attempt with locked content and the same recovery key. This is distinct from creating a fresh send; later transport refusal alone is not proof that the earlier attempt failed (SCN-007, SCN-020).
- Disabled/unconfigured providers stay visibly unavailable. Outlook (SCN-057…SCN-060) and IMAP (SCN-052…SCN-056) are connected in 0.11; a card whose provider is not set up on the server says so and opens its setup, never a simulated account (SCN-003).
- Dry-run preview names no mail mutations; enabling does not currently enforce a successful preview. Copy is guidance, not proof of a policy gate (SCN-014).
- Device-waiting reconnect copy remains a future target because this build has no local tool runner (SCN-018).

## Copy follow-up

The Gmail helper now qualifies local persistence: “Drafts are saved on this device when storage is available.” (`app/routes/gmail-inbox.tsx:302`). Storage-failure messaging remains explicit (`app/routes/gmail-inbox.tsx:61`); no runtime restoration receipt is implied. The account page's cloud-continuity sentence is configured-product intent (`app/components/settings/sections/AccountsSection.tsx`), not measured uptime. This documentation pass records the source correction without changing product code.

Humanization: on; own advisory read of the registered labels and state messages. No source copy rewritten by this documentation pass (0% changed). Checked preservation claims, recipient-delivery uncertainty, text-only forwarding and recovery meaning; this was not an exhaustive legacy-copy audit.

## Mail image privacy

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| state.mail.images_blocked | External images are blocked to protect your privacy. | app/components/EmailIframe.tsx | SCN-010 | proposed |
| state.mail.images_enabled | External images enabled for this message. | app/components/EmailIframe.tsx | SCN-010 | proposed |
| action.mail.images_load | Load external images | app/components/EmailIframe.tsx | SCN-010 | proposed |
| action.mail.images_block | Block external images | app/components/EmailIframe.tsx | SCN-010 | proposed |

## Independent drafts

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| navigation.inbox.drafts | Drafts | app/components/inbox/DraftsDialog.tsx | SCN-006 | proposed |
| action.drafts.close | Close drafts | app/components/inbox/DraftsDialog.tsx | SCN-006 | proposed |
| state.drafts.empty | No drafts. Compose a new message to begin. | app/components/inbox/DraftsDialog.tsx | SCN-006 | proposed |
| state.drafts.scope | Drafts saved on your server, yours and your agents', from every account. Open one to continue, send it, or check an uncertain send. | app/components/inbox/DraftsDialog.tsx | SCN-006 | proposed |
| state.drafts.loading | Loading drafts from your server… | app/components/inbox/DraftsDialog.tsx | SCN-006 | proposed |
| state.drafts.no_recipient | No recipient yet | app/components/inbox/DraftsDialog.tsx | SCN-006 | proposed |
| state.drafts.unknown | Outcome unknown. Retry same attempt | app/components/inbox/DraftsDialog.tsx | SCN-020 | proposed |
| state.drafts.saving | Saving draft… | app/components/inbox/use-drafts.ts | SCN-006 | proposed |
| state.drafts.unsaved | Not saved. Open to recover | app/components/inbox/use-drafts.ts | SCN-006 | proposed |
| state.drafts.conflict | This draft changed in another window. Copy any unsaved text, then reopen the saved version from Drafts. | app/components/inbox/draft-store.ts | SCN-019 | proposed |
| action.drafts.reopen | Reopen saved version | app/components/inbox/Composer.tsx | SCN-019 | proposed |
| state.drafts.missing_sender | Account unavailable | app/components/inbox/Composer.tsx | SCN-007 | proposed |

## Attachments and reversible organization

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| action.mail.star | Star message | app/components/inbox/MessageActions.tsx | SCN-011 | proposed |
| action.mail.unstar | Unstar message | app/components/inbox/MessageActions.tsx | SCN-011 | proposed |
| action.mail.trash | Move to trash | app/components/inbox/MessageActions.tsx | SCN-011 | proposed |
| action.mail.restore_gmail | Restore message | app/components/inbox/MessageActions.tsx | SCN-011 | proposed |
| action.mail.restore_cf | Restore to inbox | app/components/inbox/MessageActions.tsx | SCN-011 | proposed |
| state.mail.account_missing | Message account is unavailable. Refresh and try again. | app/components/inbox/MessageActions.tsx | SCN-011 | proposed |
| state.mail.unconfirmed | Message state could not be confirmed. Refresh and try again. | app/components/inbox/MessageActions.tsx | SCN-011 | proposed |
| label.composer.cc | Cc | app/components/inbox/Composer.tsx | SCN-007 | proposed |
| label.composer.bcc | Bcc | app/components/inbox/Composer.tsx | SCN-007 | proposed |
| action.composer.add_files | Add files | app/components/inbox/Composer.tsx | SCN-009 | proposed |
| state.composer.file_limit | Up to 10 files, 5 MiB total. Files are saved with the draft on your server. | app/components/inbox/Composer.tsx | SCN-009 | proposed |
| state.composer.originals_ready | Original files selected for this draft. | app/components/inbox/Composer.tsx | SCN-009 | proposed |
| state.composer.originals_none | The original message has no attachments. | app/components/inbox/Composer.tsx | SCN-009 | proposed |
| state.composer.legacy_forward | This saved attempt contains forwarded text only. | app/components/inbox/Composer.tsx | SCN-020 | proposed |
| state.composer.forward_source_missing | Original attachment information is unavailable. Open the original message and start a new forward. | app/components/inbox/Composer.tsx | SCN-009 | proposed |
| state.files.pending | Files are not ready. Wait for loading to finish, or remove pending files and add them again. | app/components/inbox/Composer.tsx | SCN-009 | proposed |
| state.drafts.files_pending | Files pending. Open draft to recover | app/components/inbox/use-drafts.ts | SCN-009 | proposed |
| state.files.selection_unsaved | File selection could not be saved. Keep this window open before sending. | app/components/inbox/attachment-store.ts | SCN-009 | proposed |
| state.files.ready_unsaved | Files were saved, but their ready state could not be saved. Keep this draft open before sending. | app/components/inbox/attachment-store.ts | SCN-009 | proposed |
| state.files.lock_pending | Files are not ready. Wait for loading to finish before sending. | app/components/inbox/draft-store.ts | SCN-009 | proposed |
| state.files.draft_changed | The draft changed while files were loading. Open the original draft to check its files. | app/components/inbox/compose-payload.ts | SCN-009 | proposed |

## Mailbox view: delete, failures and account safety (audit fixes 2026-09-28)

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| action.mailbox.delete | Delete | app/lib/delete-policy.ts | SCN-011 | proposed |
| state.mailbox.moved_to_trash | Moved to trash | app/lib/delete-policy.ts | SCN-011 | proposed |
| action.mailbox.undo_trash | Undo | app/lib/delete-policy.ts | SCN-011 | proposed |
| action.mailbox.delete_permanently | Delete permanently | app/lib/delete-policy.ts | SCN-011 | proposed |
| title.mailbox.confirm_permanent | Delete permanently? | app/lib/delete-policy.ts | SCN-011 | proposed |
| state.mailbox.permanent_warning | will be deleted permanently. It can't be restored afterwards. | app/lib/delete-policy.ts | SCN-011 | proposed |
| state.mailbox.deleted_permanently | Deleted permanently | app/lib/delete-policy.ts | SCN-011 | proposed |
| state.mailbox.trash_empty | Deleted emails will appear here. Move one to another folder to restore it, or delete it permanently. | app/lib/delete-policy.ts | SCN-011 | proposed |
| state.mailbox.star_failed | Couldn't star the message. | app/lib/mutation-errors.ts | SCN-011 | proposed |
| state.mailbox.unstar_failed | Couldn't unstar the message. | app/lib/mutation-errors.ts | SCN-011 | proposed |
| state.mailbox.read_failed | Couldn't mark the message as read. | app/lib/mutation-errors.ts | SCN-011 | proposed |
| state.mailbox.unread_failed | Couldn't mark the message as unread. | app/lib/mutation-errors.ts | SCN-011 | proposed |
| state.mailbox.thread_read_failed | Couldn't mark the conversation as read. | app/queries/emails.ts | SCN-011 | proposed |
| state.mailbox.trash_failed | Couldn't move the message to trash. | app/lib/mutation-errors.ts | SCN-011 | proposed |
| state.mailbox.move_failed | Couldn't move the message. | app/lib/mutation-errors.ts | SCN-011 | proposed |
| state.mailbox.delete_failed | Couldn't delete the message. | app/queries/emails.ts | SCN-011 | proposed |
| state.mailbox.folder_create_failed | Couldn't create the folder. | app/queries/folders.ts | SCN-011 | proposed |
| state.load.message_failed | Couldn't open this message | app/components/EmailPanel.tsx | SCN-011 | proposed |
| state.load.search_failed | Search failed | app/routes/search-results.tsx | SCN-005 | proposed |
| state.load.failed | could not load. | app/components/settings/ui.tsx | SCN-012 | proposed |
| state.load.not_found | It may have been deleted or moved. | app/lib/load-error.ts | SCN-011 | proposed |
| action.load.retry | Retry | app/components/LoadError.tsx | SCN-011 | proposed |
| state.addresses.autocreate_failed | configured addresses could not be created | app/components/settings/sections/ConfiguredAddresses.tsx | SCN-002 | proposed |
| state.account.checking | Checking Gmail setup… | app/components/settings/sections/AccountsSection.tsx | SCN-002 | proposed |
| action.gmail_setup.save | Save and check | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| state.gmail_setup.saving | Checking with Google | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| action.gmail_setup.copy | Copy | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| state.gmail_setup.copy_blocked | Copying is blocked here: select the text and copy it. | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| hint.gmail_setup.not_testing | Why: Google ends a Testing app's access after 7 days, and the account would need connecting again every week | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| action.gmail_setup.check | Check the setup | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| action.gmail_setup.replace | Use another Google client… | app/components/settings/sections/GmailSetup.tsx | SCN-051 | proposed |
| state.gmail_connect.browser | Google's sign-in opens in your browser: Google does not allow it inside apps. | app/components/settings/sections/GmailSetup.tsx | SCN-002 | proposed |
| state.gmail_connect.second_sign_in | The first time, your browser asks you to sign in to your server | app/components/settings/sections/GmailSetup.tsx | SCN-002 | proposed |
| action.gmail.reconnect | Reconnect in browser ↗ | app/components/settings/sections/GmailSetup.tsx | SCN-003 | proposed |
| action.gmail.enable_api | Enable the Gmail API ↗ | app/components/settings/sections/GmailSetup.tsx | SCN-003 | proposed |
| state.gmail.testing_expiry | lost its Gmail access after 7 days | shared/mail/gmail-reasons.ts | SCN-003 | proposed |
| state.gmail.access_revoked | needs to be reconnected: Google no longer accepts its access | shared/mail/gmail-reasons.ts | SCN-003 | proposed |
| state.gmail.insufficient_scope | was connected without Gmail access | shared/mail/gmail-reasons.ts | SCN-003 | proposed |
| state.gmail.api_disabled | cannot be read: the Gmail API is off in your Google Cloud project | shared/mail/gmail-reasons.ts | SCN-003 | proposed |
| state.gmail.client_rejected | cannot be read: Google refused this server's OAuth client | shared/mail/gmail-reasons.ts | SCN-003 | proposed |
| state.gmail.credentials_unreadable | needs to be reconnected: its saved access cannot be opened | shared/mail/gmail-reasons.ts | SCN-003 | proposed |
| action.inbox.why | Why, and what to do | app/routes/unified-inbox.tsx | SCN-003 | proposed |
| title.gmail_result.connected | Gmail is connected | workers/gmail-setup/result-page.ts | SCN-002 | proposed |
| title.gmail_result.not_ticked | The Gmail box was not ticked | workers/gmail-setup/result-page.ts | SCN-002 | proposed |
| title.gmail_result.redirect | Google does not know this server's redirect URI | workers/gmail-setup/result-page.ts | SCN-002 | proposed |
| label.desktop.then_gmail | Then set up Gmail (optional) | desktop/setup.html | SCN-030 | proposed |
| label.provider.gmail_app_password | Gmail with an app password | app/components/settings/sections/providers.ts | SCN-052 | proposed |
| label.provider.outlook | Outlook | app/components/settings/sections/providers.ts | SCN-057 | proposed |
| hint.provider.outlook | Outlook.com, Hotmail and Microsoft 365 mail, read and sent through Microsoft. Each account is connected separately. | app/components/settings/sections/providers.ts | SCN-058 | proposed |
| state.outlook_setup.intro | Outlook is connected through an app registration of your own in Microsoft Entra, so your mail goes only between Microsoft and your server. | app/components/settings/sections/OutlookSetup.tsx | SCN-057 | proposed |
| hint.outlook_setup.secret_value | Fabric Inbox reminds you 30 days before it ends. | app/components/settings/sections/OutlookSetup.tsx | SCN-057 | proposed |
| action.outlook_setup.save | Save | app/components/settings/sections/OutlookSetup.tsx | SCN-057 | proposed |
| action.outlook_setup.replace | Use another client secret… | app/components/settings/sections/OutlookSetup.tsx | SCN-057 | proposed |
| state.outlook_setup.secret_soon | Outlook accounts stop syncing that day. | app/components/settings/sections/OutlookSetup.tsx | SCN-060 | proposed |
| action.account.connect_outlook | Connect Outlook in browser ↗ | app/components/settings/sections/OutlookSetup.tsx | SCN-058 | proposed |
| state.outlook_connect.browser | Microsoft's sign-in opens in your browser. | app/components/settings/sections/OutlookSetup.tsx | SCN-058 | proposed |
| label.outlook_connect.admin_link | Link for an administrator | app/components/settings/sections/OutlookSetup.tsx | SCN-059 | proposed |
| action.outlook.open_setup | Open the Outlook setup | app/components/settings/sections/OutlookSetup.tsx | SCN-060 | proposed |
| state.outlook.access_revoked | needs to be reconnected: Microsoft no longer accepts its access | shared/mail/gmail-reasons.ts | SCN-060 | proposed |
| state.outlook.signin_required | needs you to sign in to Microsoft again | shared/mail/gmail-reasons.ts | SCN-060 | proposed |
| state.outlook.secret_expired | cannot be read: the Microsoft client secret on your server has expired | shared/mail/gmail-reasons.ts | SCN-060 | proposed |
| state.outlook.client_rejected | cannot be read: Microsoft refused this server's app registration | shared/mail/gmail-reasons.ts | SCN-060 | proposed |
| state.outlook.disconnected | was removed here. Remove Fabric Inbox in your Microsoft account too | app/components/settings/sections/AccountsSection.tsx | SCN-058 | proposed |
| navigation.inbox.outlook_group | Every Outlook account | app/components/inbox/AccountSidebar.tsx | SCN-058 | proposed |
| title.outlook_result.connected | Outlook is connected | workers/microsoft-setup/result-page.ts | SCN-058 | proposed |
| title.outlook_result.admin_consent | Your organization's administrator must allow Fabric Inbox first | workers/microsoft-setup/result-page.ts | SCN-059 | proposed |
| title.outlook_result.admin_consented | Your organization allows Fabric Inbox now | workers/microsoft-setup/result-page.ts | SCN-059 | proposed |
| title.outlook_result.secret_expired | The client secret on your server has expired | workers/microsoft-setup/result-page.ts | SCN-060 | proposed |
| title.outlook_result.no_mailbox | This Microsoft account has no Outlook mailbox to read | workers/microsoft-setup/result-page.ts | SCN-058 | proposed |
| action.account.disconnect | Disconnect | app/components/settings/sections/AccountsSection.tsx | SCN-003 | proposed |
| label.agent.image_link | Image from | app/components/AgentMarkdown.tsx | SCN-013 | proposed |
| state.mailbox.update_failed | Couldn't update the message. | app/lib/mutation-errors.ts | SCN-011 | proposed |
| state.mailbox.folder_rename_failed | Couldn't rename the folder. | app/queries/folders.ts | SCN-011 | proposed |
| state.mailbox.folder_delete_failed | Couldn't delete the folder. | app/queries/folders.ts | SCN-011 | proposed |
| title.mailbox.trash_empty | Trash is empty | app/lib/delete-policy.ts | SCN-011 | proposed |
| state.load.refresh_failed | Couldn't refresh these results. | app/routes/search-results.tsx | SCN-005 | proposed |
| state.request.timeout | The request timed out. Try again. | app/lib/load-error.ts | SCN-011 | proposed |
| state.request.offline | Check your connection and try again. | app/lib/load-error.ts | SCN-011 | proposed |
| state.request.server | The server had a problem. Try again in a moment. | app/lib/load-error.ts | SCN-011 | proposed |
| state.request.forbidden | You don't have access to this. Sign in again and retry. | app/lib/load-error.ts | SCN-011 | proposed |
| navigation.agent_access | Agent access | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| state.agent_access.intro | Let an AI agent you run elsewhere work with Fabric Inbox | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| state.agent_access.not_reply_agents | These are not the reply agents that answer your addresses. | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| action.agent_key.make | Make key | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| state.agent_key.making | Making the key… | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| state.agent_key.secret_once | Copy the secret now: it is shown only once. | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| action.agent_key.saved | I saved it | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| label.agent_key.drafts_only | Drafts only | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| label.agent_key.can_send | Can send | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |
| action.agent_key.revoke_arm | Revoke… | app/components/settings/sections/AgentAccessSection.tsx | SCN-044 | proposed |
| action.agent_key.revoke | Revoke | app/components/settings/sections/AgentAccessSection.tsx | SCN-044 | proposed |
| state.agent_key.revoked | can no longer use Fabric Inbox. | app/components/settings/sections/AgentAccessSection.tsx | SCN-044 | proposed |
| title.agent_journal | What agents changed | app/components/settings/sections/AgentAccessSection.tsx | SCN-044 | proposed |
| state.agent_journal.empty | No agent has changed anything yet. | app/components/settings/sections/AgentAccessSection.tsx | SCN-044 | proposed |
| state.agent_key.empty | No agent has a key yet. | app/components/settings/sections/AgentAccessSection.tsx | SCN-043 | proposed |

## Settings (0.11)

One screen with a section list, a master list and a panel (SCR-02). Destructive actions sit behind the ⋯ menu and confirm in one shared dialog.

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| navigation.settings.back | Back to mail | app/routes/settings.tsx | SCN-012 | proposed |
| navigation.settings.addresses | Addresses | app/components/settings/paths.ts | SCN-032 | proposed |
| navigation.settings.domains | Domains | app/components/settings/paths.ts | SCN-031 | proposed |
| navigation.settings.accounts | Accounts | app/components/settings/paths.ts | SCN-002 | proposed |
| navigation.settings.destinations | Forwarding destinations | app/components/settings/paths.ts | SCN-033 | proposed |
| navigation.settings.app | App | app/components/settings/paths.ts | SCN-012 | proposed |
| action.settings.more | More actions for | app/components/settings/sections/AddressesSection.tsx | SCN-032 | proposed |
| action.settings.discard | Discard changes | app/components/settings/ui.tsx | SCN-012 | proposed |
| action.settings.keep_editing | Keep editing | app/components/settings/ui.tsx | SCN-012 | proposed |
| state.settings.choose_address | Choose an address | app/components/settings/sections/AddressesSection.tsx | SCN-032 | proposed |
| action.settings.retry | Retry | app/components/settings/ui.tsx | SCN-012 | proposed |
| action.address.remove | Remove and delete mail | app/components/settings/sections/AddressesSection.tsx | SCN-032 | proposed |
| label.address.who_answers | Who answers | app/components/settings/sections/AddressesSection.tsx | SCN-023 | proposed |
| action.settings.connect_account | Connect an account | app/components/settings/sections/AccountsSection.tsx | SCN-002 | proposed |
| action.desktop.settings | Settings… | desktop/main.cjs | SCN-012 | proposed |
| action.desktop.server_address | Server address… | desktop/main.cjs | SCN-001 | proposed |
| navigation.inbox.discarded | Discarded | app/components/inbox/triage-text.ts | SCN-073 | proposed |
| state.discarded.empty_title | Nothing discarded | app/components/inbox/triage-text.ts | SCN-072 | proposed |
| state.discarded.banner | Discarded mail is deleted after 30 days (in Gmail, IMAP and Outlook accounts it moves to their Trash). Nothing here reaches an agent, a rule or a category. | app/components/inbox/triage-text.ts | SCN-073 | proposed |
| label.inbox.discard_reason | Why discarded: | app/components/inbox/triage-text.ts | SCN-073 | proposed |
| state.discarded.auto_reason | Discarded automatically: you discarded | shared/mail/discard.ts | SCN-073 | proposed |
| action.message.discard | Discard message | app/components/inbox/triage-text.ts | SCN-072 | proposed |
| action.message.not_discarded | Not discarded | app/components/inbox/triage-text.ts | SCN-074 | proposed |
| action.discard.stop | Stop discarding mail like this | app/components/inbox/triage-text.ts | SCN-074 | proposed |
| state.discard.learned | will go to Discarded. | app/components/inbox/triage-text.ts | SCN-072 | proposed |
| action.discard.dont | Don't | app/components/inbox/triage-text.ts | SCN-072 | proposed |
| state.toast.archived | Archived | app/components/inbox/triage-text.ts | SCN-071 | proposed |
| state.toast.discarded | Discarded | app/components/inbox/triage-text.ts | SCN-071 | proposed |
| action.toast.undo | Undo | app/components/inbox/triage-text.ts | SCN-071 | proposed |
| state.toast.undone | Undone. | app/components/inbox/triage-text.ts | SCN-071 | proposed |
| state.selection.count | messages selected | app/components/inbox/triage-text.ts | SCN-071 | proposed |
| navigation.shortcuts | Keyboard shortcuts | app/lib/mail-keys.ts | SCN-071 | proposed |
| state.sync.updated | Updated | app/lib/sync-status.ts | SCN-070 | proposed |
| state.sync.live | Live | app/lib/sync-status.ts | SCN-070 | proposed |
| state.sync.updating | Updating… | app/lib/sync-status.ts | SCN-070 | proposed |
| state.sync.failed | needs to be connected again | app/lib/sync-status.ts | SCN-070 | proposed |
| navigation.settings.discard | Discard rules | app/components/settings/paths.ts | SCN-075 | proposed |
| label.discard.always_allow | Always allow | app/components/settings/sections/DiscardSection.tsx | SCN-075 | proposed |
| action.discard.remove_rule | Remove rule | app/components/settings/sections/DiscardSection.tsx | SCN-075 | proposed |

## Add address (0.12)

The one dialog that creates addresses (SCN-021, SCN-061…065): the live check, then the steps of what Create did, each with its one fix. Every word of the dialog, its steps, the panel's routing block and the entry points is in `add-address-text.ts`, one module to translate; the server's sentences (a domain's state, a name's check, a step's detail) come from `workers/lib/address-ops.ts` and `shared/address-name.ts`.

| Key | Text (primary) | Location | Scenario | Status |
|---|---|---|---|---|
| title.address.add | Add an address | app/components/settings/sections/add-address-text.ts | SCN-021 | proposed |
| action.address.add_on_domain | Add an address on | app/components/settings/sections/add-address-text.ts | SCN-032 | proposed |
| action.address.add_first | Add the first address | app/components/settings/sections/add-address-text.ts | SCN-032 | proposed |
| label.address.mode_one | One address | app/components/settings/sections/add-address-text.ts | SCN-021 | proposed |
| label.address.mode_several | Several | app/components/settings/sections/add-address-text.ts | SCN-064 | proposed |
| label.address.names | Names before @ | app/components/settings/sections/add-address-text.ts | SCN-064 | proposed |
| state.address.empty_name | Type the part before @, such as support. | shared/address-name.ts | SCN-061 | proposed |
| state.address.two_dots | Two dots in a row are not allowed. | shared/address-name.ts | SCN-061 | proposed |
| state.address.checking | Checking… | app/components/settings/sections/add-address-text.ts | SCN-061 | proposed |
| state.address.free | is free. | app/components/settings/sections/add-address-text.ts | SCN-061 | proposed |
| state.domain.receiving | Receiving here | app/components/settings/sections/add-address-text.ts | SCN-063 | proposed |
| state.domain.can_receive | Can receive here | app/components/settings/sections/add-address-text.ts | SCN-063 | proposed |
| state.domain.needs_fix | Needs fixing | app/components/settings/sections/add-address-text.ts | SCN-063 | proposed |
| state.domain.not_visible | Token cannot see it | app/components/settings/sections/add-address-text.ts | SCN-065 | proposed |
| label.address.rule | Make the Cloudflare rule that sends its mail here | app/components/settings/sections/add-address-text.ts | SCN-065 | proposed |
| label.address.send_test | Send a test message once it is created, and watch it arrive | app/components/settings/sections/add-address-text.ts | SCN-062 | proposed |
| step.address.create | Create the address | workers/lib/address-ops.ts | SCN-062 | proposed |
| step.address.rule | Send its mail here | workers/lib/address-ops.ts | SCN-062 | proposed |
| step.address.test | Send a test message | app/components/settings/sections/add-address-text.ts | SCN-062 | proposed |
| state.address.test_not_arrived | The test message has not arrived after 3 minutes. | workers/lib/address-ops.ts | SCN-062 | proposed |
| action.domain.replace_continue | Replace and continue | app/components/settings/sections/add-address-text.ts | SCN-063 | proposed |
| action.address.try_again | Change and try again | app/components/settings/sections/add-address-text.ts | SCN-062 | proposed |
| action.address.add_another | Add another | app/components/settings/sections/add-address-text.ts | SCN-062 | proposed |
| state.routing.missing | Not receiving yet | app/components/settings/sections/data.ts | SCN-065 | proposed |
| action.routing.fix | Fix it | app/components/settings/sections/add-address-text.ts | SCN-065 | proposed |
