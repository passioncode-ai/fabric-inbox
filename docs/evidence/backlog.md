# Board

Open work outside the roadmap packets, highest priority first. Source names where the row came
from; the roadmap stays the plan for P6, L1–L6 and W1. Close a row by deleting it in the change
that fixes it.

| ID | Item | Source | Priority |
|---|---|---|---|
| B-40 | Tell the owner when a delivery fails: an email event ending `internalError` (or a relay delivery refused) shows on the server and reaches the owner, instead of being found only by querying Workers Observability (the 2026-09-28 lost message was found that way on 2026-10-01) | second review pass, 2026-10-01 | high |
| B-39 | Accept 0.8.0 live on the owner's server: the Cloudflare accounts section shows all three accounts, Receive mail here on the domain that failed with "must be a subdomains" completes, and one domain of another account (the operator picks it: its routing changes) receives a real message through the relay and sends a reply from there | 0.8.0, 2026-09-30 (brief "Not run") | high |
| B-20 | Fill knowledge collections from Fabric's project memory once ADR-0069 MEM-P2 (bounded search) ships: a sync that calls `POST /api/knowledge/collections/<id>/documents` with `prune: true` for collections whose source is `fabric`, scoped by the Fabric project's grants | KN-6, operator 2026-09-29 | high |
| B-21 | Search the same text for both providers: a plain-text search column and the From display name at receive time for Cloudflare (today raw HTML, first 2000 characters, bare address); say in the UI which fields are searched | audit feed F8, 2026-09-29 | high |
| B-22 | One message sent to two agent addresses (To and Cc) is answered once from each; answer it once per workspace, from the address it was sent To | audit agents A4, 2026-09-29 | medium |
| B-24 | Gmail reads in one batched call (page and counts for all accounts) and a per-account date index instead of full cache scans | audit feed F14, 2026-09-29 | medium |
| B-26 | A message restored from Trash returns to the described categories it was in (today its verdict is forgotten when the view finds it gone, until the category changes) | categories, 2026-09-29 | medium |
| B-23 | Narrow screens keep the list's scroll position while a message is read (the list is `display:none` there) | audit feed F7, 2026-09-29 | low |
| B-25 | Keyboard navigation in the message list (arrows or j/k) | audit feed F20, 2026-09-29 | low |
| B-27 | Rename or move an address keeping its mail, and pause an address without deleting it (today only create and remove) | mailbox audit, 2026-09-29 | medium |
| B-28 | Point an address whose rule sends mail elsewhere at this server from the app, one address at a time (today: the dashboard, or Connect for the whole domain) | mailbox audit, 2026-09-29 | medium |
| B-29 | Races around a re-created address: an assignment written after a delete, and a delivery resolved before `purge()` landing in the rebuilt mailbox (suspected, not reproduced) | mailbox audit finding 18, 2026-09-29 | low |
| B-31 | The Always spam lists apply to Cloudflare addresses only; offer them for Gmail too (a Gmail filter per entry) | spam, 2026-09-29 | low |
| B-33 | An app window open across a server update loses the old hashed chunks (reload on a chunk error); older code rewriting `config/spam.json` drops fields a newer version added | update audit L3, L4, 2026-09-29 | low |
| B-34 | Inbound robustness left: cap and parallelise attachment writes (subrequest limit), an atomic unknown-recipient counter, pruning `incoming_receipts` and Gmail delivered events | reliability audit L2, L4, L5, 2026-09-29 | low |
| B-35 | Agent protocol, Gmail parity: a Gmail conversation read at once (`read_thread` is Cloudflare only), and Gmail's own folders/labels beyond inbox, archive and trash | agent protocol, 2026-09-29 | medium |
| B-36 | Agent keys scoped to some addresses or domains (today a key's level covers the whole workspace, as the owner's sign-in does) | agent protocol, 2026-09-29 | medium |
| B-37 | Agent protocol for clients that cannot send headers (claude.ai connectors): OAuth through Access for SaaS instead of a service token | agent protocol, 2026-09-29 | low |
| B-38 | Owner approval for an agent key's irreversible actions: the second step approved in Agent access instead of by the same caller (today the code stops mistakes, not a determined agent) | agent protocol security review 4, 2026-09-29 | medium |
| B-19 | Observe a full first run of Create my server on a new Cloudflare account (Zero Trust organization, R2 bucket and workers.dev name created by the app, sign-in, Receive mail here) | CF-5, 2026-09-28 | high |
| B-01 | Gmail scale: timestamp index for inbox reads outside the workspace lock; metadata-first initial sync; history paging | audit backend 4, 5, 18 → roadmap L2 | high |
| B-02 | Desktop sign-in through an external Access identity provider (in-app login window on the same session) | audit frontend 2 | high |
| B-05 | Rule daily limit counted before the AI condition | audit backend 12 | medium |
| B-06 | Gmail send rate limit | audit backend 16 | medium |
| B-07 | AutomationDO run/event/count pruning; drain without listing every run | audit backend 13 | medium |
| B-08 | Project labels from Fabric's `registry/domains.yaml` on Project addresses | roadmap P5 | medium |
| B-09 | Agent drafts reachable from the unified inbox (today: "Open the draft" on Agents opens it in its mailbox's Drafts) | ladder walk 2026-09-28 | medium |
| B-10 | Unknown-recipient storage cap and atomic counter | audit backend 25 | low |
| B-11 | Desktop: Retry connection keeps the leave warning; no dead hidden window after a failed load | audit frontend 18, 19 | low |
| B-12 | Unified reader inline `cid:` images; rule dry-run message picker; empty draft on Compose | audit frontend 23, 26, 27 | low |
| B-13 | Remove or implement `forwarding` / `autoReply` mailbox settings | audit backend 26 | low |
| B-14 | `.task-pipeline/` is ignored while 8 files under it are tracked | audit docs 26 | low |
| B-15 | Remaining low items: subject-thread spoofing, MCP delete orphans, Gmail write outcomes, cache orphans, rule unknown/failed labels, menu/tab roles, MCP Copy in desktop, agent panel below `lg`, second Gmail interface | audit | low |
