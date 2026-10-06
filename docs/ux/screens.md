# UI Screen Registry

<!-- Managed with super-ux (ux-contract v4). Update affected layers in the same change as behavior. -->

## Index

| ID | Screen | Used by | Figma | Status | Coverage |
|---|---|---|---|---|---|
| SCR-01 | Startup and session | FLW-07 | deferred | built | desktop/main.cjs, desktop/setup.html, desktop/setup.js, desktop/cloudflare-deploy.cjs |
| SCR-02 | Settings | FLW-01, FLW-07, FLW-08 | deferred | built | app/routes/settings.tsx, app/components/settings/, workers/routes/domains.ts, workers/routes/accounts.ts, desktop/main.cjs |
| SCR-03 | Inbox and search | FLW-01, FLW-02, FLW-07 | deferred | built | app/routes/unified-inbox.tsx, app/components/inbox/TriagedList.tsx |
| SCR-04 | Thread and AI | FLW-02, FLW-03, FLW-04 | deferred | designed | app/routes/gmail-inbox.tsx:428, app/components/EmailPanel.tsx:32, app/components/AgentPanel.tsx:296 |
| SCR-05 | Compose and draft | FLW-03, FLW-04, FLW-07 | deferred | designed | app/routes/gmail-inbox.tsx:41, app/routes/gmail-inbox.tsx:141, app/routes/gmail-inbox.tsx:292 |
| SCR-06 | Settings (mailbox page) | — | deferred | retired | merged into SCR-02 |
| SCR-07 | Rules | FLW-05 | deferred | designed | app/routes/automation.tsx:121, app/routes/automation.tsx:168, app/routes/automation.tsx:390 |
| SCR-08 | Run history and approval | FLW-03, FLW-06 | deferred | designed | app/routes/automation.tsx:433, workers/automation/engine.ts:20 |
| SCR-09 | Domains & addresses | — | deferred | retired | merged into SCR-02 |
| SCR-10 | Settings → Agents | FLW-08 | deferred | built | app/components/settings/sections/AgentsSection.tsx, workers/agents/registry.ts |
| SCR-11 | Settings → Setup | FLW-07, FLW-08 | deferred | built | app/components/settings/sections/AppSection.tsx, workers/routes/setup.ts |
| SCR-12 | Settings → Knowledge | FLW-08 | deferred | built | app/components/settings/sections/KnowledgeSection.tsx, workers/routes/knowledge.ts |
| SCR-13 | Settings → Categories | FLW-02 | deferred | built | app/components/settings/sections/CategoriesSection.tsx, workers/categories/store.ts |
| SCR-14 | Settings → Spam rules | FLW-02 | deferred | built | app/components/settings/sections/SpamSection.tsx, workers/routes/spam.ts |
| SCR-15 | Settings → Agent access | FLW-07 | deferred | built | app/components/settings/sections/AgentAccessSection.tsx, workers/routes/agent-keys.ts |
| SCR-16 | Settings → Discard rules | FLW-02 | deferred | built | app/components/settings/sections/DiscardSection.tsx, workers/routes/discard.ts |

## Design system
- **Style pack:** canonical Fabric tokens (Kumo and Tailwind retained); see [brand provenance](../desktop-mail/brand-source.json).
- **Figma library:** none recorded; owner choice pending.
- **Tokens in code:** app/styles/fabric-tokens.css, app/styles/workbench.css, app/index.css
- **Component source:** app/components/
- **Assets:** existing icon imports in components; no new assets.

## Web surfaces
- **Web surfaces:** no
The existing app is behind an authentication boundary; this specification covers the desktop/private mail surface. It creates no public landing page or crawlable mail content.

## Coverage boundary
Records retain designed status because their complete target state sets have not passed an implementation audit. Coverage now includes integrated source with per-screen Today limits. Native setup/isolation/restart has scoped synthetic observation (RE-004); Accounts not_configured and local disabled-rule creation have root CUA browser observations (RE-006). The unified workbench also has scoped synthetic observation (RE-009). No live OAuth/mail/provider/tool acceptance or full accessibility walkthrough is claimed. See [integration receipt](implementation-receipt.md).

## Screens

### SCR-01: Startup and session
- **Used by:** FLW-07
- **Purpose:** Open a trusted desktop session; on first run, explain the server and create it in the person's Cloudflare account or start from a setup.
- **Elements:** Welcome with what the server is; Create my server on Cloudflare (primary: token with its permission list and Open Cloudflare API Tokens, account, email, workers.dev and sign-in names when missing, step list, Continue); Use my setup (bundled setups); Open a setup file; I already have a server; What is the server?; setup review (server, sign-in, domains, addresses, not served); Connect; Back; Sign in (when needed); connection state; menu Connect Cloudflare account….
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Open a trusted desktop session; show confirmed state. |
| empty | No relevant data | deferred | Account connection prompt. |
| loading | Pending operation | deferred | Startup/session check; no fabricated percentage. |
| error | Operation cannot complete | deferred | Sign-in recovery or labeled offline cache. |

- **Coverage:** desktop/main.cjs (showSetup, loadMail, fabric:cf-* handlers); desktop/setup.html; desktop/setup.js; desktop/cloudflare-deploy.cjs (deploy)
- **Scenarios:** SCN-001, SCN-019, SCN-028, SCN-030
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** built
- **Today:** Welcome, setup review and Create my server run in the app (token and error paths checked in a clean profile on 2026-09-28); a full first run on a new Cloudflare account has not been observed; no offline mailbox cache.

### SCR-02: Settings
- **Used by:** FLW-01, FLW-07, FLW-08
- **Purpose:** One place for everything that is set up rather than read: addresses, domains, accounts, forwarding destinations, categories, spam rules, agents, knowledge, agent access and the app itself. Choosing an item never moves the page.
- **Elements:** Section list on the left, always the same (Back to mail; Mail: Addresses, Domains, Accounts, Forwarding destinations, Categories, Spam rules; Agents: Agents, Knowledge, Agent access; This app: App). Each section: its name and one line, a search, its primary action, a list grouped and kept in place (a row keeps its group while the section is open; its badge says what changed), and the chosen item's panel beside it (Esc or Close goes back to the list; the focus moves into the panel and back to the row). Destructive actions only behind ⋯ (More actions for …), always confirmed in one shared dialog where Cancel takes the focus. Results stay inline in the panel under the action that ran, and are also a toast. Each row shows when its own work is running; nothing else is disabled. Skeletons the size of the rows. Below 930 px the panel takes the list's place with Back, and the list keeps its scroll position. Leaving an editor with unsaved changes asks first (Discard changes / Keep editing).
  - **Addresses:** grouped by domain; each row: name, who answers, its copy, Copy failing / routing (Arriving here, Not receiving yet, Routing unknown) / Not received badges, unread. Add address opens the Add address dialog (below). Panel: Who answers (with the chosen agent's one line: what it does and its reply policy); tabs Routing & test (Check again, Fix it, Send a test message with its arrival watched), Copy (Forward a copy to, Save), Name & signature (display name, signature, chat assistant prompt, Save changes), Rules & history (Open rules and history); ⋯ Open its mail, Remove … (refused for the catch-all, with the reason). An empty list names the domains and offers Add the first address. The addresses in the server's configuration are created here once, with Retry for any that failed.
  - **Add address dialog** (one dialog for every entry point: Add address, Add an address on <domain>, the sidebar's Add address, Add the first address, Add this address): One address / Several; Domain (a searchable choice: Receiving here, then Can receive here, each with its state, Needs fixing once checked; a line under it says what choosing it does); Address (the part before @, focused on open, with the full address previewed, the live check announced in words, and the names of recent mail to missing addresses as buttons) — or, for Several, a names box with one checked row per name; Display name (filled from the name until edited); Signature (optional, with its preview); Who answers (Off, or an agent with its one line); Forward a copy to (confirmed destinations of the domain's account, or Add a forwarding destination); Cloudflare rule (shown when a rule can be made, or why it cannot); Send a test message once it is created; Cancel, Create <address> (Enter submits when valid, Esc closes). After Create the form gives way to the steps (Receive mail for the domain here, Create the address, Send its mail here, Send a test message — each Done, Already so, Nothing to do, Not done or Waiting, with its one fix), or one row of steps per address for Several; Add another, Done (closes on the new address, selected with its panel open). Below 930 px the dialog takes the window's width.
  - **Domains:** Receiving here, then Other domains on Cloudflare, with a search; Connect Cloudflare first in the list while there is no token (its permissions and where to save it). Panel: Receive mail here (MX confirmation), or In Cloudflare (receiving with Fix it, addresses still elsewhere with Bring them here, sending with Turn on sending, DMARC, problems), its addresses with Add an address on <domain> (and, with none yet, Add the first address on <domain>), the catch-all choice with Apply, recent mail for missing addresses with Add this address, and the step list of the last action, kept when the domain changes state; ⋯ Stop receiving … (and a second confirmation when the token cannot see it).
  - **Accounts:** Cloudflare (Show / Hide / Default, ⋯ Remove … for one connected with its own token), Gmail, Outlook and Other mail (sync, the reason it stopped with its one fix, Open its mail, Rules and history, ⋯ Disconnect …). Connect account opens a card per provider (providers.ts): Cloudflare (the permissions, a token field, Connect), Gmail (its setup, then Connect Gmail in browser), Gmail with an app password, Other mail (IMAP), and Outlook (the Microsoft Entra setup with the client secret's end date, then Connect Outlook in browser; SCN-057, SCN-058).
  - **Forwarding destinations:** per Cloudflare account; Confirmed / Waiting; Add (a dialog that sends Cloudflare's confirmation); the panel lists the addresses that copy there.
  - **App:** Appearance (Light theme / Dark theme), Your server (its address and configured domains), Setup (SCR-11), Mac app (what lives in the app menu: Check for Updates…, Install Updates Automatically, Share Anonymous Usage Counts, Server address…, Connect Cloudflare account…, Settings… ⌘,).
  - **Agents, Knowledge, Categories, Spam rules, Agent access:** SCR-10, SCR-12, SCR-13, SCR-14 and SCR-15, each a section of this screen.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | The section's list with the chosen item's panel; an action's result inline under it and as a toast. |
| empty | No relevant data | deferred | Each list says what is missing and offers the one action that fills it (Add the first address, Go to Domains, Connect an account, Add a destination, Create the first one). With nothing chosen the panel says what opens there. |
| loading | Pending operation | deferred | Skeleton rows and panels the size of the content; a running action names itself on its row and its button. |
| error | Operation cannot complete | deferred | A failed load says what could not load and why, with Retry; a refused action keeps the input and says why under the action; an item that no longer exists says so with a link back to the list. |

- **Coverage:** app/routes/settings.tsx (Settings); app/components/settings/ui.tsx (SelectableList, Panel, ActionMenu, ConfirmProvider, WorkProvider, useDirtyGuard); app/components/settings/list-model.ts; app/components/settings/paths.ts (legacyTarget); app/routes/settings-redirect.tsx; app/components/settings/sections/AddressesSection.tsx; app/components/settings/sections/DomainsSection.tsx; app/components/settings/sections/AccountsSection.tsx; app/components/settings/sections/providers.ts; app/components/settings/sections/DestinationsSection.tsx; app/components/settings/sections/AppSection.tsx; app/components/settings/sections/SignatureForm.tsx; app/styles/settings.css; workers/routes/domains.ts; workers/routes/agents.ts (/api/project-addresses); workers/routes/accounts.ts; desktop/main.cjs (openSettings)
- **Scenarios:** SCN-002, SCN-003, SCN-012, SCN-021, SCN-023, SCN-025, SCN-031, SCN-032, SCN-033, SCN-045, SCN-046, SCN-051, SCN-052, SCN-053, SCN-054, SCN-055, SCN-056
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** built
- **Today:** Built in 0.11 (WS1). Every old address (/projects, /mailboxes, /accounts, /ai-agents, /knowledge, /categories, /spam, /agent-access, /setup, /mailbox/:id/settings) redirects into its section (`tests/settings-ui.test.ts`). Choosing a row deep in a 66-address list at 1360 px and 800 px left window.scrollY at 0, the list's scrollTop and the row's position unchanged, and Back at 800 px returned to the same scroll position with the focus on the row (`scripts/settings-scroll-check.mjs`, 25 checks, against a local dev server with 22 domains). No live Gmail or Cloudflare account was used; IMAP and Outlook cards are placeholders for another workstream.

### SCR-03: Inbox and search
- **Used by:** FLW-01, FLW-02, FLW-07
- **Purpose:** Find source-labeled conversations.
- **Elements:** Compose (primary); Drafts list with sender, subject and saved/uncertain status; All inboxes / domain / one address / every Gmail account scope; CATEGORIES in the sidebar with counts and +; a category's view (eyebrow CATEGORY, its description, Change, sorting progress, Why: on each row); search; Focus / Newest order (a described category reads newest first); Unread only; group chips with counts (All stays while a group is chosen); Important section; group headings the operator opens (kept for the session); a Spam folder (newest first, no triage marks, Why in Spam, a banner with Spam rules and Delete all now…); row reason tag, category chips, "+N" for a message in several inboxes; message list; unread/archive/delete (the next message is selected); account health (collapsed "N inboxes unavailable"); a folder select on a phone; addresses With mail / All with Hide on each, "Hide them…" for those without mail and a Hidden list; a banner when mail did not reach its rules, agents or categories, with Retry; one Settings entry in the sidebar (Add address and Connect Gmail open their sections; choosing a domain selects it and folds no other group); under the title, Refresh and its status (Updated 3 min ago, Live, Updating…, which account failed) with each account's details; a Discarded folder (Why discarded on each row, a banner with Discard rules) and Not discarded with Stop discarding mail like this; the keyboard (Delete/Backspace archive and mark read, ⌘⌫ discard, ⌘Z undo, ↓/J ↑/K, Shift and ⌘/Ctrl-click to choose several with "N messages selected", Esc, ? for Keyboard shortcuts, ⌘⇧N refresh); the Undo toast with the once-only "Future mail from X will go to Discarded · Don't"; Keyboard shortcuts in the sidebar.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Find source-labeled conversations; show confirmed state. |
| empty | No relevant data | deferred | No mail versus no matches versus no completed sync. |
| loading | Pending operation | deferred | Retain current list and mark refresh or initial loading. |
| error | Operation cannot complete | deferred | Partial account failure with retry; unaffected accounts remain readable. |

- **Coverage:** app/routes/unified-inbox.tsx (`UnifiedInbox`, `scope`, list query); app/components/inbox/TriagedList.tsx; app/components/inbox/SyncStatus.tsx; app/components/inbox/UndoToast.tsx; app/components/inbox/ShortcutsDialog.tsx; workers/routes/inbox.ts
- **Scenarios:** SCN-004, SCN-005, SCN-011, SCN-019, SCN-026, SCN-027, SCN-036, SCN-037, SCN-038, SCN-039, SCN-042, SCN-070, SCN-071, SCN-072, SCN-073, SCN-074
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** built
- **Today:** The workbench combines all-account cached mail, keeps accounts visible and filters one account in place. Source identity is shown per row. Search/folder/account scope is URL-addressable; loading, no matches and partial provider failure have distinct states. Synthetic all-account and one-account views were observed (RE-009); live completeness and full threads remain open.

### SCR-04: Thread and AI
- **Used by:** FLW-02, FLW-03, FLW-04
- **Purpose:** Read context and review a response.
- **Elements:** Reply (primary); reply all; forward; attachments; per-message external-image permission; source identity; AI action; source links; archive/delete; Report spam (Not spam in Spam).
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Read context and review a response; show confirmed state. |
| empty | No relevant data | deferred | No selected message: return to list. |
| loading | Pending operation | deferred | Thread/attachment/AI loading are separate. |
| error | Operation cannot complete | deferred | Unavailable message or AI result; manual mail stays reachable. |

- **Coverage:** app/routes/unified-inbox.tsx (detail query, reader toolbar, `download`); app/components/inbox/model.ts (`messagePath`); app/components/AgentPanel.tsx:296
- **Scenarios:** SCN-004, SCN-008, SCN-009, SCN-010, SCN-011, SCN-013, SCN-040
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** designed
- **Today:** The unified reader shows individual messages with account/provider identity, text or an isolated HTML body, attachments, reply and text-forward actions. Back to messages supports the narrow layout. Existing Cloudflare AI remains separate; interactive AI in this reader and complete threads remain open.

### SCR-05: Compose and draft
- **Used by:** FLW-03, FLW-04, FLW-07
- **Purpose:** Prepare mail and understand its delivery state.
- **Elements:** Send (primary); independently saved draft; explicit storage/conflict status; From; To; Cc/Bcc; subject; body; attachments; save state; close/cancel.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Prepare mail and understand its delivery state; show confirmed state. |
| empty | No relevant data | deferred | Empty draft with labeled fields. |
| loading | Pending operation | deferred | Draft saving, attachment preparation and sending are distinct. |
| error | Operation cannot complete | deferred | Inline validation, preserved input, failed and unknown transport states. |

- **Coverage:** app/components/inbox/Composer.tsx (`Composer`, `send`); app/components/inbox/send-state.ts (`sendRecovery`, `replyRecipient`); app/routes/unified-inbox.tsx (`compose`)
- **Scenarios:** SCN-006, SCN-007, SCN-008, SCN-009, SCN-019, SCN-020
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** designed
- **Today:** The workbench composer selects a sender for new mail, fixes the reply account and reopens one existing local draft. Closing/Escape retains input; a save failure overrides the saved-state claim. Unknown sends keep their fields and recovery key locked for Retry same attempt. Reply all, Cc/Bcc, attachment compose and live provider sending remain open.

### SCR-06: Settings (mailbox page)
- **Status:** retired
- **Today:** Merged into SCR-02 Settings in 0.11: the display name, signature and chat assistant prompt are an address's Name & signature tab, and the theme is App → Appearance. /mailbox/:id/settings redirects there.

### SCR-07: Rules
- **Used by:** FLW-05
- **Purpose:** Authorize bounded repeatable work.
- **Elements:** Dry-run (primary while editing); name; accounts; condition; actions; recipients; tools; limits; enable/pause; version.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Authorize bounded repeatable work; show confirmed state. |
| empty | No relevant data | deferred | No rules: create a rule without delaying inbox access. |
| loading | Pending operation | deferred | Dry-run or save in progress with input retained. |
| error | Operation cannot complete | deferred | Missing tool/grant/destination prevents enabling; last confirmed enabled state stays visible. |

- **Coverage:** app/routes/automation.tsx:121, app/routes/automation.tsx:168, app/routes/automation.tsx:390
- **Scenarios:** SCN-014, SCN-015
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** designed
- **Today:** Rule edit, enable/pause and dry-run UI exist. Dry-run before enable is not enforced; local integration fixtures validate effect boundaries, not production cloud behavior.

### SCR-08: Run history and approval
- **Used by:** FLW-03, FLW-06
- **Purpose:** Understand external effects and resolve waiting work.
- **Elements:** Open run (primary in list); filters; source; rule version; actions; result; attempts; cost availability; approve/reject when waiting.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Understand external effects and resolve waiting work; show confirmed state. |
| empty | No relevant data | deferred | No runs: explains rule history will appear here. |
| loading | Pending operation | deferred | History loading or reconciliation in progress. |
| error | Operation cannot complete | deferred | Waiting approval/device, denied, failed and unknown each carry their own next step. |

- **Coverage:** app/routes/automation.tsx:433, workers/automation/engine.ts:20
- **Scenarios:** SCN-016, SCN-017, SCN-018, SCN-020
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** designed
- **Today:** Recent run approval/cancel and Cloudflare outbox are wired. Local workerd effects/restart tests exist. Detailed version/attempt/cost/source display and real external-tool acceptance remain incomplete.

### SCR-09: Domains & addresses
- **Status:** retired
- **Today:** Merged into SCR-02 Settings in 0.11 as the Addresses, Domains, Accounts and Forwarding destinations sections. /projects (and ?domain=) redirects there.

### SCR-10: Settings → Agents
- **Part of:** SCR-02 Settings (Agents section); the list, panel, ⋯ menu and confirmation follow SCR-02.
- **Used by:** FLW-08
- **Purpose:** Define reusable agents and their limits once, use them on many addresses.
- **Elements:** New agent (primary); templates; name; instructions; knowledge collections it may search; notes the agent always sees; tool grants with destinations; reply policy (what may be sent, daily limit, skip rules); version (a conflict offers Load the newest version; one form open at a time); addresses served; collections searched; recent answers with the passages each was answered from, filtered by what happened (Everything, Sent or drafted, Needs a look, Left alone) and by agent, Show older, Retry, and Open the draft opening that draft.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Agents listed with version, policy summary and addresses served. |
| empty | No relevant data | deferred | No agents: start from a template. |
| loading | Pending operation | deferred | Saving a new version with input retained. |
| error | Operation cannot complete | deferred | Disallowed tool host or unreadable schema blocks saving with the reason. |

- **Coverage:** app/components/settings/sections/AgentsSection.tsx (AgentsSection, AgentEditor, RunsHistory); workers/routes/agents.ts (/api/agents, /api/agent-runs); workers/agents/registry.ts
- **Scenarios:** SCN-022, SCN-024, SCN-034, SCN-035
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Absent. Each mailbox has an implicit agent configured by one system-prompt field in Settings.

### SCR-11: Settings → Setup
- **Part of:** SCR-02 Settings (App → Setup section); the list, panel, ⋯ menu and confirmation follow SCR-02.
- **Used by:** FLW-07, FLW-08
- **Purpose:** Apply, import and export a setup on the server.
- **Elements:** Apply (primary); setup source (from the app, a file, Read from Cloudflare); review of domains, addresses, forwarding copies and catch-alls; results per address; Export setup; Go to Domains.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Each address listed as created, updated, unchanged or refused with the reason. |
| empty | No relevant data | deferred | No setup loaded: open a file or read from Cloudflare. |
| loading | Pending operation | deferred | Applying or reading Cloudflare, with the setup kept. |
| error | Operation cannot complete | deferred | Invalid file lists its problems; a failed apply says applying again is safe. |

- **Coverage:** app/components/settings/sections/AppSection.tsx (SetupPanel); workers/routes/setup.ts
- **Scenarios:** SCN-028, SCN-029
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built

### SCR-12: Settings → Knowledge
- **Part of:** SCR-02 Settings (Knowledge section); the list, panel, ⋯ menu and confirmation follow SCR-02.
- **Used by:** FLW-08
- **Purpose:** Keep the documents agents search, in collections granted to agents one by one.
- **Elements:** New collection (primary); collection cards with document count, source and the agents that search it; documents with source and size; Upload .md or .txt files; paste a document; Try a search; Delete this collection (refused while an agent uses it).
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Collections listed; an open one shows its documents, upload and search. |
| empty | No relevant data | deferred | No collection: create the first one. A collection with no document says so. |
| loading | Pending operation | deferred | Uploading, searching or deleting, with inputs retained. |
| error | Operation cannot complete | deferred | Each refused document is named with its reason; a failed load offers Retry. |

- **Coverage:** app/components/settings/sections/KnowledgeSection.tsx (KnowledgeSection, CollectionPanel); workers/routes/knowledge.ts; workers/knowledge/store.ts (KnowledgeDO)
- **Scenarios:** SCN-034
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built and used live on 2026-09-29; a collection filled from Fabric memory waits for ADR-0069 MEM-P2.

### SCR-13: Settings → Categories
- **Part of:** SCR-02 Settings (Categories section); the list, panel, ⋯ menu and confirmation follow SCR-02.
- **Used by:** FLW-02
- **Purpose:** Define the views of the mail that matters: a project's mail, or only what the operator describes, from chosen or all inboxes.
- **Elements:** New category (primary); New project; category cards with where it looks, what selects it, how many sorted messages belong, sorting progress, Open, Edit, Delete… with confirmation; category editor (Name, Where to look: all inboxes or projects, domains and single inboxes with Find a domain or inbox and a chosen count; What belongs here, in your words; Plain conditions: From, Subject has, Text mentions; Also raise its messages to Important in Focus; Active; a line saying how it will be sorted); project form (Name, Domains, Addresses); Projects list with Edit and Delete; the model limits.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Categories and projects listed; a saved category says what happens next. |
| empty | No relevant data | deferred | No category: an example to start from. No project: what a project is. |
| loading | Pending operation | deferred | Loading categories; Saving…; sorting progress on each card. |
| error | Operation cannot complete | deferred | A failed load offers Retry; a refused save or delete names the reason (a project in use). |

- **Coverage:** app/components/settings/sections/CategoriesSection.tsx (CategoriesSection, CategoryEditor); app/services/categories.ts; workers/routes/categories.ts; workers/categories/store.ts (CategoriesDO)
- **Scenarios:** SCN-036, SCN-037, SCN-038
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built and used live on 2026-09-29 in the installed app at desktop and phone width ("Refund requests" over all inboxes).

### SCR-14: Settings → Spam rules
- **Part of:** SCR-02 Settings (Spam rules section); the list, panel, ⋯ menu and confirmation follow SCR-02.
- **Used by:** FLW-02
- **Purpose:** Say what goes to Spam and keep the operator's lists.
- **Elements:** What goes to Spam (four rules and what wins); today's checks, spam found and the model's allowance; Always spam: senders, Always spam: domains, Never spam: senders, Never spam: domains, each with Add and Remove and Show all past 20; Open Spam; Categories.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Rules and lists shown; a change says what was added or removed. |
| empty | No relevant data | deferred | A list with no entry says Empty. |
| loading | Pending operation | deferred | Loading spam rules; buttons disabled while a change is saved. |
| error | Operation cannot complete | deferred | A failed load offers Retry; a refused entry names why; the model's count unreadable is said. |

- **Coverage:** app/components/settings/sections/SpamSection.tsx (SpamSection, ListPanel); workers/routes/spam.ts; workers/spam/lists.ts
- **Scenarios:** SCN-041
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built and seen in the installed app on 2026-09-29.

### SCR-15: Settings → Agent access
- **Part of:** SCR-02 Settings (Agent access section); the list, panel, ⋯ menu and confirmation follow SCR-02.
- **Used by:** FLW-07
- **Purpose:** Give outside agents their own keys to the agent protocol, show what they changed, and revoke a key.
- **Elements:** What it is (not the reply agents); Keys (name, level, sending, made, expires, Revoke… with Revoke and Keep); New key (Agent's name, Level: Read, Mail, Admin with what each may do; Sending: Drafts only, Can send with messages a day; Expires after; Make key); the one-time panel (Server, Client ID, Client Secret, Claude Code command, JSON, Copy, I saved it); What agents changed (When, Key, Action, On, Result; Show older, Newer).
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Keys and the journal listed; a new key's secret shown once; a revoke says the key stopped working. |
| empty | No relevant data | deferred | No agent has a key yet; no agent has changed anything yet. |
| loading | Pending operation | deferred | Loading agent keys; Making the key… with the button disabled. |
| error | Operation cannot complete | deferred | A failed load offers Retry; a refused key names the missing permission; a partial revoke names where to finish it. |

### SCR-16: Settings → Discard rules
- **Part of:** SCR-02 Settings (Discard rules section); the list and panel follow SCR-02.
- **Used by:** FLW-02
- **Purpose:** Show what each discard taught, and undo any of it.
- **Elements:** How Discarded works (what is learned, what is never discarded, 30 days, where Discarded lives per provider); Always allow (Add, Remove, Find); one row per rule (Newsletter or Sender, discarded by you · on arrival); a rule's panel: Why (list, newsletter, sender and bulk domain, category, the model's guess), What it did (counts, learned, last discard, last applied), Remove rule, Always allow <sender>; Open Discarded.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Rules and the list shown; a change says what was done. |
| empty | No relevant data | deferred | No rules yet; Always allow Empty. |
| loading | Pending operation | deferred | Loading discard rules; buttons disabled while a change is saved. |
| error | Operation cannot complete | deferred | A failed load offers Retry; a refused entry names why; a removed rule says it is gone. |

- **Coverage:** app/components/settings/sections/DiscardSection.tsx (DiscardSection, RulePanel, AllowedPanel); workers/routes/discard.ts; workers/discard/store.ts
- **Scenarios:** SCN-075
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built in 0.12 (WS8); seen in the local Worker on 2026-10-06.
