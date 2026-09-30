# UI Screen Registry

<!-- Managed with super-ux (ux-contract v4). Update affected layers in the same change as behavior. -->

## Index

| ID | Screen | Used by | Figma | Status | Coverage |
|---|---|---|---|---|---|
| SCR-01 | Startup and session | FLW-07 | deferred | built | desktop/main.cjs, desktop/setup.html, desktop/setup.js, desktop/cloudflare-deploy.cjs |
| SCR-02 | Accounts | FLW-01, FLW-07 | deferred | designed | app/routes/fabric-accounts.tsx:61, workers/routes/accounts.ts:83, desktop/main.cjs:151 |
| SCR-03 | Inbox and search | FLW-01, FLW-02, FLW-07 | deferred | built | app/routes/unified-inbox.tsx, app/components/inbox/TriagedList.tsx |
| SCR-04 | Thread and AI | FLW-02, FLW-03, FLW-04 | deferred | designed | app/routes/gmail-inbox.tsx:428, app/components/EmailPanel.tsx:32, app/components/AgentPanel.tsx:296 |
| SCR-05 | Compose and draft | FLW-03, FLW-04, FLW-07 | deferred | designed | app/routes/gmail-inbox.tsx:41, app/routes/gmail-inbox.tsx:141, app/routes/gmail-inbox.tsx:292 |
| SCR-06 | Settings | FLW-07 | deferred | designed | app/routes/settings.tsx:15, desktop/main.cjs:145 |
| SCR-07 | Rules | FLW-05 | deferred | designed | app/routes/automation.tsx:121, app/routes/automation.tsx:168, app/routes/automation.tsx:390 |
| SCR-08 | Run history and approval | FLW-03, FLW-06 | deferred | designed | app/routes/automation.tsx:433, workers/automation/engine.ts:20 |
| SCR-09 | Domains & addresses | FLW-08 | deferred | built | app/routes/project-addresses.tsx, app/components/domains/, workers/routes/domains.ts, workers/routes/agents.ts |
| SCR-10 | Agents | FLW-08 | deferred | built | app/routes/agents.tsx, workers/agents/registry.ts |
| SCR-11 | Setup | FLW-07, FLW-08 | deferred | built | app/routes/setup.tsx, workers/routes/setup.ts |
| SCR-12 | Knowledge | FLW-08 | deferred | built | app/routes/knowledge.tsx, workers/routes/knowledge.ts |
| SCR-13 | Categories | FLW-02 | deferred | built | app/routes/categories.tsx, workers/categories/store.ts |
| SCR-14 | Spam rules | FLW-02 | deferred | built | app/routes/spam.tsx, workers/routes/spam.ts |
| SCR-15 | Agent access | FLW-07 | deferred | built | app/routes/agent-access.tsx, workers/routes/agent-keys.ts |

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

### SCR-02: Accounts
- **Used by:** FLW-01, FLW-07
- **Purpose:** Connect and recover provider access.
- **Elements:** Connect account (primary); provider; address; capability summary; cloud-processing notice; reconnect; cancel.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Connect and recover provider access; show confirmed state. |
| empty | No relevant data | deferred | No accounts: explain supported connections and offer connect. |
| loading | Pending operation | deferred | Authorization pending or initial sync progress. |
| error | Operation cannot complete | deferred | Provider/configuration failure stays scoped to account. |

- **Coverage:** app/routes/fabric-accounts.tsx:61, workers/routes/accounts.ts:83, desktop/main.cjs:151
- **Scenarios:** SCN-002, SCN-003
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** designed
- **Today:** Account directory and Gmail server-configuration state exist. Outlook/IMAP are unavailable; no live OAuth acceptance. Disconnect has no confirmation step in this build.

### SCR-03: Inbox and search
- **Used by:** FLW-01, FLW-02, FLW-07
- **Purpose:** Find source-labeled conversations.
- **Elements:** Compose (primary); Drafts list with sender, subject and saved/uncertain status; All inboxes / domain / one address / every Gmail account scope; CATEGORIES in the sidebar with counts and +; a category's view (eyebrow CATEGORY, its description, Change, sorting progress, Why: on each row); search; Focus / Newest order (a described category reads newest first); Unread only; group chips with counts (All stays while a group is chosen); Important section; group headings the operator opens (kept for the session); a Spam folder (newest first, no triage marks, Why in Spam, a banner with Spam rules and Delete all now…); row reason tag, category chips, "+N" for a message in several inboxes; message list; unread/archive/delete (the next message is selected); account health (collapsed "N inboxes unavailable"); a folder select on a phone; addresses With mail / All with Hide on each, "Hide them…" for those without mail and a Hidden list; a banner when mail did not reach its rules, agents or categories, with Retry; Domains & addresses, Agents and Knowledge in the sidebar.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Find source-labeled conversations; show confirmed state. |
| empty | No relevant data | deferred | No mail versus no matches versus no completed sync. |
| loading | Pending operation | deferred | Retain current list and mark refresh or initial loading. |
| error | Operation cannot complete | deferred | Partial account failure with retry; unaffected accounts remain readable. |

- **Coverage:** app/routes/unified-inbox.tsx (`UnifiedInbox`, `scope`, list query); app/components/inbox/TriagedList.tsx; workers/routes/inbox.ts
- **Scenarios:** SCN-004, SCN-005, SCN-011, SCN-019, SCN-026, SCN-027, SCN-036, SCN-037, SCN-038, SCN-039, SCN-042
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

### SCR-06: Settings
- **Used by:** FLW-07
- **Purpose:** Review saved preferences.
- **Elements:** Save changes (primary for settings form); display name (required); signature with its switch (added to mail written here and to an agent's answers); chat assistant prompt; validation; account connection link; return to inbox; workbench light/dark switch. Saving changes only these, so an agent or a copy set elsewhere is kept.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Review saved preferences; show confirmed state. |
| empty | No relevant data | deferred | Defaults shown explicitly when no saved preferences. |
| loading | Pending operation | deferred | Loading saved values; saving changes. |
| error | Operation cannot complete | deferred | Retain edits and display retry on failed save. |

- **Coverage:** app/routes/unified-inbox.tsx (`toggleTheme`); app/root.tsx (theme bootstrap); app/routes/settings.tsx:15; desktop/setup.js (theme control)
- **Scenarios:** SCN-012
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md); provider capability and action status contracts in [architecture](../desktop-mail/architecture.md).
- **Status:** designed
- **Today:** White/light and dark themes are available from the workbench, with persistence when local storage succeeds. Root observed toggle and reload persistence (RE-009). Existing mailbox settings and native server setup remain separate; full settings acceptance is not re-run.

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
- **Used by:** FLW-08
- **Purpose:** See every domain of the owner's Cloudflare accounts, receive the chosen ones here, and manage their addresses.
- **Elements:** Connect Cloudflare (without a token: the permissions and where to save it); Cloudflare accounts (each account with mail / no mail, domains and receiving here, reached by the server's token or its own, relay; Show / Hide / Default; Remove… for one connected with its own token; Connect another account: the permissions for it, a token field, Connect); each domain named with its account; Receiving here (a card per domain: receiving, addresses still elsewhere, sending, DMARC, problems; addresses with who answers, their copy with Change, routing, test, Remove…; add form; catch-all choice with Apply (a deployment's catch-all shown, not changeable); unknown recipients; Stop receiving here); Your other domains on Cloudflare (Receive mail here, MX confirmation, find); Forwarding destinations; Other mailboxes; a step list after each action, kept when the domain moves between the lists; a confirmation before stopping a domain the token cannot see.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Domains listed, served ones first; an open domain shows its Cloudflare state and addresses; every action lists its steps. |
| empty | No relevant data | deferred | No token: how to connect. No domain received here: choose one below. A domain with no address: add the first one. |
| loading | Pending operation | deferred | Reading Cloudflare or running steps, with inputs retained and buttons disabled. |
| error | Operation cannot complete | deferred | A missing permission is named; a failed step says what was done and that running again continues; a refused address keeps nothing half-made. |

- **Coverage:** app/routes/project-addresses.tsx (ProjectAddressesPage); app/components/domains/ (ConnectCloudflare, DomainCard, AddressRow, Destinations, StepList); workers/routes/domains.ts; workers/routes/agents.ts (/api/project-addresses); workers/routing/domains.ts (DomainManager)
- **Scenarios:** SCN-021, SCN-023, SCN-025, SCN-031, SCN-032, SCN-033
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built and tested against a fake Cloudflare; on the owner's server it shows the connect step until the token is saved there.

### SCR-10: Agents
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

- **Coverage:** app/routes/agents.tsx (Agents, AgentEditor); workers/routes/agents.ts (/api/agents, /api/agent-runs); workers/agents/registry.ts
- **Scenarios:** SCN-022, SCN-024, SCN-034, SCN-035
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Absent. Each mailbox has an implicit agent configured by one system-prompt field in Settings.

### SCR-11: Setup
- **Used by:** FLW-07, FLW-08
- **Purpose:** Apply, import and export a setup on the server.
- **Elements:** Apply (primary); setup source (from the app, a file, Read from Cloudflare); review of domains, addresses, forwarding copies and catch-alls; results per address; Export setup; Go to Project addresses.
- **States:**

| State | Trigger | Figma frame | Behavior |
|---|---|---|---|
| success | Available result | deferred | Each address listed as created, updated, unchanged or refused with the reason. |
| empty | No relevant data | deferred | No setup loaded: open a file or read from Cloudflare. |
| loading | Pending operation | deferred | Applying or reading Cloudflare, with the setup kept. |
| error | Operation cannot complete | deferred | Invalid file lists its problems; a failed apply says applying again is safe. |

- **Coverage:** app/routes/setup.tsx; workers/routes/setup.ts
- **Scenarios:** SCN-028, SCN-029
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built

### SCR-12: Knowledge
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

- **Coverage:** app/routes/knowledge.tsx (KnowledgePage, CollectionCard); workers/routes/knowledge.ts; workers/knowledge/store.ts (KnowledgeDO)
- **Scenarios:** SCN-034
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built and used live on 2026-09-29; a collection filled from Fabric memory waits for ADR-0069 MEM-P2.

### SCR-13: Categories
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

- **Coverage:** app/routes/categories.tsx (CategoriesPage, CategoryEditor); app/services/categories.ts; workers/routes/categories.ts; workers/categories/store.ts (CategoriesDO)
- **Scenarios:** SCN-036, SCN-037, SCN-038
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built and used live on 2026-09-29 in the installed app at desktop and phone width ("Refund requests" over all inboxes).

### SCR-14: Spam rules
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

- **Coverage:** app/routes/spam.tsx (SpamRules, ListCard); workers/routes/spam.ts; workers/spam/lists.ts
- **Scenarios:** SCN-041
- **Resources:** [Flow specification](flows.md), [shared interaction requirements](scenarios.md).
- **Status:** built
- **Today:** Built and seen in the installed app on 2026-09-29.

### SCR-15: Agent access
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
