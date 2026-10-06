Contract: brand-contract v1

# Terminology

## Product terms — always
| Our term | Never write | Applies to |
|---|---|---|
| Rule | Automation recipe | Saved bounded automation |
| Run | AI job | One recorded rule invocation |
| Dry-run | Trial send | Preview with no external side effects |
| Agent | Bot, AI assistant (for address agents) | Reusable versioned definition that answers mail on assigned addresses |
| Project address | Alias, forwarding address | An address on a served project domain, received by the Worker |
| Reply policy | Auto-reply settings | What an agent may send without the operator: mode, allowed intents, daily limit |
| Answer | AI response (in run history) | One agent run for one incoming message |
| Domains & addresses | Project addresses (screen name, since 0.3) | The screen managing the connected Cloudflare account's domains and their addresses |
| Receive mail here | Connect domain, Import domain | Moving a domain's mail to the server, keeping each old destination as a copy |
| Forwarding destination | Forward target, verified email | An outside address a copy may go to, confirmed through Cloudflare's link |
| Your server | Backend, instance, origin (to a user) | The Fabric Inbox Worker in the person's own Cloudflare account |
| Knowledge collection | Knowledge base, KB, vector store (for one set) | A named set of documents an agent may search when it is ticked on it |
| Passage | Chunk, snippet (to a user) | A part of a document found for a message and given to the agent with its source |
| Notes the agent always sees | Knowledge (for the inline field, since 0.4) | The short text sent with every message |
| Category | Filter, label, smart folder | A view of the mail that matters beside Focus: where it looks, and optionally what belongs, in words or plain conditions |
| Project | Workspace, group (for a set of domains) | A named set of domains and addresses one product uses, chosen as the place a category looks |
| Sort (a message into a category) | Classify, tag (to a user) | The conditions or the model placing a message in a category, with a reason |
| Your addresses | Internal, own mail | The triage group for mail sent from the domains this server serves |
| Spam | Junk, junk mail, bulk folder | The folder mail goes to when the filter or the operator says it is unwanted; deleted after 30 days |
| Report spam | Mark as junk, Block sender | Moving a message to Spam and putting its sender on the Always spam list |
| Not spam | Not junk, Unblock | Bringing a message back from Spam and putting its sender on the Never spam list |
| Spam rules | Spam settings, filters | The screen with what goes to Spam and the Always spam / Never spam lists |
| Agent access | API access, integrations, MCP settings | The screen where the owner gives outside agents their keys and sees what they changed |
| Agent key | API key, agent token, access token, credential (to a user) | One outside agent's way in: a Client ID and a Client Secret, with a level and a sending mode |
| Cloudflare API token | API key, Cloudflare key, credential (to a user) | What a person creates in Cloudflare (My Profile or Manage Account → API Tokens) and gives the server: one for the server's own account, one for each other account connected on Domains & addresses; "token" alone once the context has named it (operator, 2026-10-01) |
| Outside agent | Bot, integration, app (for a keyed agent) | An AI agent the owner runs elsewhere (Claude Code, Cursor, their own) that works with Fabric Inbox through its key; never an Agent that answers an address |
| Drafts only / Can send | Read-write, full access (for sending) | Whether an agent key's mail waits in Drafts for the owner or leaves, within its daily number |
| Revoke | Delete key, disable | Ending an agent key: it stops working at once |

## Entity and tier names — exact spelling
| Name | Wrong forms seen |
|---|---|
| Fabric Inbox | FabricInbox |
| Focus | focus (the view's name) |
| Important | important (the section's name) |
| Spam | spam (the folder's name) |
| Gmail | GMail |
| Google | google (provider name) |
| OAuth | Oauth |
| Cloudflare | CloudFlare |
| Mac | mac (device name) |
| Outlook | outlook (provider name) |
| Drafts | drafts (navigation label) |
| MiB | Mib, MB (when the bound is 1,048,576-byte units) |
| Claude | claude (the assistant's name) |
| Code | code (in Claude Code, the product's name) |
| Cursor | cursor (the editor's name) |

## Banned
| Word or phrase | Why | Use instead |
|---|---|---|
| seamless | Unmeasured promise | Name the actual result |
| leverage | Filler | use |

## Glossary
| Term | Meaning |
|---|---|
| Account | Connected provider identity and its capabilities |
| Mailbox | Existing Cloudflare mailbox; not proof of a separate provider connection |
| All inboxes | Combined cached-mail view retaining account identity; one account can be selected in place |
| Queued | Awaiting a delivery attempt |
| Sent | Provider confirmed acceptance, not recipient reading |
| Accepted | Provider took the message; recipient delivery is unconfirmed |
| Forward text | Legacy Gmail and automation text-only forwarding |
| Forward | Unified composer reviews original files and explicitly loads them before sending |
| Search cached mail | Query cached mail in the current account/folder scope; not full provider history or offline desktop mail |
| Outcome unknown | An attempt may have succeeded; do not retry blindly |
| Waiting for device | A permitted local action awaits the connected Mac |
| Paused | Rule does not start new runs; existing run history remains |
| Off | No agent answers the address; mail is kept for the operator |
| Draft waiting | The agent wrote an answer the policy did not allow it to send; the reason is shown |
| Skipped | The agent did not answer (automated mail, answered thread, flagged text); the reason is shown |
| Focus | List order with Important first and other groups collapsed |
| Important | Raised by triage rules (a person's unread mail, security, alerts, store rejections, failed payments, CI failures, starred); each row names why |
| Routing verified / missing / unknown | Email Routing sends the address to the Worker / does not / could not be read; unknown is never shown as working |

## Workbench action terms

| Term | Meaning |
|---|---|
| Continue draft | Reopen the selected saved workbench draft, retaining its sender and send recovery |
| Retry same attempt | Reconcile or retry the locked send with its existing recovery key and unchanged content |
| Check for new mail | Read Gmail's new mail and changes now for the Gmail accounts in view, then reload the combined list; it does not import a whole mailbox, and names any account it could not read |
| Light theme / Dark theme | Appearance preference; no change to message, account or send state |
