# Desktop Mail — brief

Status: approved for implementation, 2026-09-26. The operator approved macOS plus always-on cloud automation and then approved starting implementation. Owner confirmed: passioncode-ai/fabric-inbox; name Fabric Inbox. The scope was not reduced to a desktop shell or an AI chat.

## What the user gets

One desktop application for the user's own mail. A unified inbox and separate accounts, search and threads, attachments, drafts, sender selection, replies and forwarding. AI can explain a message, prepare a reply and execute rules: for example, an invoice from a supplier → extract the fields → pass them to the selected tool → forward to a specified recipient. The user sees the result, the error or the waiting state, and can stop the rule.

"All mailboxes" means provider connections, not changing MX or forwarding all mail into a single Cloudflare mailbox. Gmail/Google Workspace is connected separately; IMAP/SMTP serves the providers that support it; Outlook/Microsoft 365 is a separate adapter if such accounts exist. This is not a promise to support every mail service without checking its API.

## User, scenarios and boundaries

The primary user is the owner of their own accounts (from the request). macOS is the confirmed first platform (D04). Windows/Linux are not removed from the possible scope: the decision is due before packaging in T07. Team SaaS, billing, MX migration and automatic provider switching are not part of the original request.

Below are the original intake scenarios. The formal chain and the current partial implementation are described in [docs/ux](../ux/README.md).

| Scenario | Action and observable result | Error / recovery |
|---|---|---|
| Connect a mailbox | Choose a provider → sign in → see the account and the sync progress | A cancelled sign-in does not create a placeholder account; a revoked token offers reconnection |
| Triage the inbox | Open the unified list → select a message → see the thread, the account and the attachments | A failure in one account does not hide the others; an empty list is distinguishable from an unfinished sync |
| Send / reply | Choose the sender → write → send → see the provider's confirmation | Queued and failed are not called "sent"; an unknown result is not retried blindly |
| Forward a message | Choose the recipient and attachments → review → send from the correct account | An attachment failure keeps the draft; the sender does not change without the user's choice |
| Ask AI | Select a message/thread → get a summary or a draft with a link to the source | A model error is visible; manual mail keeps working |
| Configure a rule | Specify the condition, accounts, actions and permissions → view a dry run → enable | An undefined tool or recipient blocks activation; the rule can be edited and switched off |
| Automatic triage | An incoming message triggers a rule → classification/extraction → permitted action → journal entry | A repeated event does not repeat a completed action; the cost limit stops the run |
| External action | A permitted rule forwards a message or calls a specific tool | Going beyond the permissions waits for a decision; a message cannot grant the agent new authority by itself |
| Network loss / restart | The app shows the available cache and queue; after reconnecting it catches up on changes | The pending/failed/unknown states are distinct; drafts are restored |
| View history | Open a run → see the source, the rule version, the action, the result and the retry | A retry is available only when a previous successful send has been ruled out |

## Requirements — full acceptance remains open

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| REQ-001 | Installable desktop application | Launch the macOS artifact, sign in, restart, open mailto; platform agreed | open |
| REQ-002 | Receive Cloudflare mail | Test inbound message → stored message and attachment; repeated delivery without a duplicate | open |
| REQ-003 | Gmail/Workspace: read, sync, send | OAuth + controlled mailbox: initial/delta sync, revoke, send, expired history | open |
| REQ-004 | The user's other mailboxes | Provider inventory; IMAP/SMTP and additional adapters per the list; reconnect/UIDVALIDITY | open |
| REQ-005 | Unified list, reading, search, reply, forward, attachments | End-to-end scenarios with two accounts and identical provider IDs; correct From | open |
| REQ-006 | AI triage and drafts | A set of synthetic messages: classification, extraction, draft; links to sources | open |
| REQ-007 | Rules with automatic actions | Dry run, enable/pause, repeated event, restart, budget, unknown send result | open |
| REQ-008 | Calls to connected tools | One read tool and one write tool with schema, permissions, timeout, journal; negative cases | open |
| REQ-009 | Permission management and visible history | The same denial applies in the UI, chat, MCP and background jobs; a rejected action has no side effects | open |

## Proposed decisions that require approval of the brief

1. Keep the existing Cloudflare backend and React components; separate the new provider adapters from the UI. Fix the queue and its states before AI auto-send.
2. Electron is the candidate because it reuses TypeScript/React and the Node connectors. Tauri is the alternative if size/memory matters more than the cost of a native bridge. Memory load has not been measured yet; the choice is not declared as fact.
3. By default AI creates proposals; a rule the user has enabled may automatically forward and call permitted tools without a prompt on every run. Destination, parameters, accounts and limits are set in the rule's configuration.
4. Irreversible/unknown actions require separate permission. This is a proposed product policy, not a rejection of automation.
5. Cloud-first automation is recommended so that work continues with the Mac switched off. Local tools wait for the device to connect. If local-only is chosen, syncing of the other mailboxes and the rules run on the Mac; cloud mail keeps receiving inbound mail as it does now.

## Material questions

- D01: decided by the user — always-on in the cloud; local tools wait for the Mac.
- D02: which providers are behind "other"? Decide before T04; it does not block the shared contracts. Do not search the contents of personal mail to compile the list.
- D03: the first real tools/recipients for rules? Decide before T06 acceptance; the core runs on mock tools. Creating the client does not authorise sending real messages during development.
- D04: macOS confirmed; Windows/Linux and public distribution are not promised yet.

## Autonomy and environment

Implementation takes place in `passioncode-ai/fabric-inbox`; macOS/cloud are confirmed. Electron was chosen as the engineering path for reusing the web app; this is not a separate owner statement about the technology. Subagents were used at the explicit requirement of task-pipeline stage five: core, Gmail, UX, desktop, then an independent review and integration tests. The full UX/brand chain was created; no external Figma file was created. Pipeline loop off. Commit/push are permitted by a standing instruction; merge, live grants and production deploy were not performed.

A new runtime MCP is connected inside the product through a server-side allowlist, without changing any local MCP gateway configuration. The owner grants connections and permissions through the normal provider flows. Code that has been read, a message or a provider name does not grant such permissions.

Current checks, the skills actually used and the gaps: [implementation](implementation.md). The original `open` status of the REQs denotes full end-to-end acceptance, not the absence of written code. T00…T08 have partial statuses in [the tasks](tasks/README.md).

## Source ledger

| Source | What was established | Freshness / next action |
|---|---|---|
| Request + operator's answer, 2026-09-26 | Desktop, AI actions/tools, all mailboxes | Authoritative scope; change only by an explicit decision |
| Original Git commit | Actual routes and gaps | [Evidence](evidence.md), current origin/main on the clone |
| README, package.json, wrangler.jsonc | Stack, commands, domain, Access boundary | The README contains an inaccuracy about sending by the built-in agent; see evidence |
| Cloudflare API + browser | Worker deployed, Access login | The deployed version has not been matched to a Git SHA |
| Local docs/UX/ADR/retro/pipeline | Absent from the tracked baseline | We create this intake; we do not claim an existing UX base |
| Code graph/wiki | No code graph built; no wiki target specified by the repository | Not read/not changed; not counted as confirmation |
| Official docs | Gmail sync/push, Electron boundary, Workers TCP | Links in architecture; they confirm only the stated behaviour |

Baseline contradictions (original commit, not the current implementation): the README promises sending to the built-in agent, but createEmailTools does not provide send; MCP provides send separately. The API returns sent before the transport completes. The "all mailboxes" of the new request are not supported by the existing Cloudflare-only model.
