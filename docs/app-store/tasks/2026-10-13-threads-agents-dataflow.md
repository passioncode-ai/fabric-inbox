# Run brief 2026-10-13: threads, agents in the mail, and where agent answers go

## The request

The operator, 2026-10-13: "чтобы я в почте видел треды … как в нормальной почте можно было полистать
тред, посмотреть, как он развивался, переслать, ответить … видеть, как работает агент … их ответы на
вопросы … настроить этого агента нашего, чтобы он работал … с [агентом данных клиента], и
оттуда получал все данные … репортинг … по вопросам, на которых нет [ответа] … продумана была система
… куда он может дальше пулять эти данные. Дальше мы построим агента, который собирает всю информацию …
Это уже будет другой агент" — the other agent is planned in its own private repository
(a voice-of-the-customer agent in the operator's private repository); this brief is the Fabric
Inbox side.

## What exists today (survey 2026-10-13, file:line in the survey notes)

- **Threads.** The main inbox (`app/routes/unified-inbox.tsx`) is a flat list, one row per message;
  opening a message shows that message only. Reply keeps the thread headers; Forward drops them. The
  server already has threads for Cloudflare mailboxes (`getThreadEmails`, `?threaded=true` with
  counts, `markThreadRead`), and the legacy mailbox view has a Cloudflare-only thread reader (newest
  first, replies only to the latest received). Gmail, IMAP and Outlook carry a `threadId` but have no
  thread route (only a cache filter `read_thread` uses, capped at 50). SCN-004/005/008 and SCR-04
  promise threads; their "Today" notes say they are not built.
- **Agents in the mail.** Only Settings → Agents → Recent answers shows runs (no `grounded`, no link
  to the message; "Open the draft" goes to the legacy view). The inbox shows nothing: no marker on a
  message an agent answered, no run in the reader, agent drafts unlabelled.
- **The data agent.** the customer's support agent (`acme-support`, v11) answers only from the data agent's `facts.query` (the
  hand-loaded collections were deleted, FI-5); abstained or ungrounded answers stay drafts and send
  one `gaps.submit` per run. Proof of a facts-only draft waits for a real mail (FI-7).
- **Data out.** Only the gap call leaves. The run does not keep the question; rules trigger only on
  incoming mail; `list_agent_runs` pages backwards only; there is no event feed.

## Modules (each its own change, in this order)

| M | What | REQ |
|---|---|---|
| M1 | **Threads in the main inbox.** A conversation endpoint for every provider (Cloudflare: existing; Gmail: threads API; IMAP/Outlook: by `threadId` over the cache and the provider); the reader shows the whole conversation oldest first, earlier messages collapsed, your sent replies and drafts included; Reply / Reply all / Forward on each message; mark the conversation read; the list shows a message count per conversation | REQ-1…REQ-4 |
| M2 | **Agents in the mail.** A run lookup by message; a marker on a message an agent answered or drafted; a run panel in the reader (what it did, why, grounded, sources, tool calls, the draft or sent reply); agent drafts labelled in Drafts; "Open the draft" opens the main inbox; an Agents activity view reachable from the inbox | REQ-5…REQ-7 |
| M3 | **The support agent on the data agent.** v11 is facts-only; close FI-7 on the first real mail (receipt to the data agent's owner); fix whatever the first real drafts show | REQ-8 |
| M4 | **Questions without an answer.** The run keeps the question (paraphrase, no personal data) and the thread; an "Unanswered questions" list in the inbox (by agent, address, period) with the gap report's state; a failed gap report is retried | REQ-9…REQ-10 |
| M5 | **Where answers go.** An agent-run event feed for other agents: `GET /fabric/v1/events` by cursor (the estate's existing feed shape), events `agent.answered` / `agent.drafted` / `agent.unanswered` / `agent.skipped` with question paraphrase, intent, grounded, sources and outcome — no personal data; `list_agent_runs` gains a forward cursor; a rule can trigger on a run. First consumer: the voice-of-the-customer agent | REQ-11…REQ-13 |

## REQ table

| REQ | Requirement | Verified by |
|---|---|---|
| REQ-1 | Opening a message in the main inbox shows its whole conversation, oldest first, earlier messages collapsed and expandable, sent replies and drafts included, for Cloudflare, Gmail, IMAP and Outlook | workerd + UI tests; WebKit walk |
| REQ-2 | Reply, Reply all and Forward act on the message chosen in the conversation, keeping the thread headers (Forward starts a new thread) | UI tests |
| REQ-3 | The list shows a conversation's message count and unread count; marking read covers the conversation | tests |
| REQ-4 | SCN-004/005/008 and SCR-04 describe what is built; the MCP `read_thread` matches the UI | ux lint; mcp tests |
| REQ-5 | A message an agent answered, drafted or skipped shows a marker; the reader shows the run (status, reason, intent, grounded, sources, tool calls, the draft or sent reply) | UI tests |
| REQ-6 | Agent drafts are labelled with their agent in Drafts; "Open the draft" opens it in the main inbox | UI tests |
| REQ-7 | An Agents activity view is one click from the inbox (filters by agent, outcome, address) | UI tests |
| REQ-8 | The first real mail to the customer's support address after v8 is answered from the data agent's `facts.query`, cited in the run's sources; receipt sent to the data agent's owner | live receipt |
| REQ-9 | The run keeps the question paraphrase (no personal data) and the thread id | runner tests |
| REQ-10 | An "Unanswered questions" list shows each question, its agent, address, time and gap-report state; a failed report is retried with the same request id | tests |
| REQ-11 | `GET /fabric/v1/events?cursor=` serves agent-run events in order, by cursor, with a consumer token; no personal data | workerd tests |
| REQ-12 | `list_agent_runs` takes `after` (forward cursor by update time) so status changes are seen | mcp tests |
| REQ-13 | Every new route has its MCP tool (or an exclusion with a reason), docs and the skill in the same change | `npm test` coverage tests |

## Decisions

- **Thread order:** oldest first (how a conversation is read), newest expanded — the legacy view's newest-first is not kept.
- **Events feed shape:** the estate's existing feed (`/fabric/v1/events`, cursor) rather than webhooks — consumers pull, nothing pushes to an unknown host; the voice-of-the-customer agent is local, and a local agent pulls from a remote one.
- **No personal data in events or in the stored question** — the same paraphrase rule the data agent enforces on `gaps.submit`.

## First task

M1: the conversation endpoint for all four providers and the reader's thread view.
