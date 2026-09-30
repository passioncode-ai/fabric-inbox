# Run brief — agents on project addresses, triage, audit — 2026-09-28

Pipeline run (`task-pipeline`) continuing the [roadmap](2026-09-28-roadmap.md). Operator request,
2026-09-28 (request, paraphrased): connect addresses on project domains quickly, answer each
address with its own reusable agent (a support agent answers or calls a granted tool), turn the
pile of unread mail across accounts into a structure where important mail is highlighted and the
rest is collapsed and opened by filter; improve the product page and the product; then audit the
project for bugs and unfinished work, audit the documentation, and build local versions.

## Source ledger

| Source | Read | Used for |
|---|---|---|
| Code on `main` at `ba1077b` | workers/**, shared/**, app/routes, desktop/** | current behaviour |
| `docs/desktop-mail/*`, `docs/app-store/*`, `docs/ux/*`, `docs/brand/*` | yes | scenarios SCN-021…025, SCR-09/10, roadmap P1…P6, L1…L6, W1 |
| Retro / backlog / verification ledger (`docs/evidence/`) | none found | — |
| Code graph (`graphify-out/`) | none found; no code graph could be built in the working environment | — |
| Project wiki (outside the repository) | present; project page not consulted for code facts | stage 9 |
| Cloudflare Email Routing API | OpenAPI spec via the Cloudflare API MCP: `GET/POST /zones/{zone_id}/email/routing/rules`, `GET /zones/{zone_id}/email/routing/rules/catch_all`, `GET /zones/{zone_id}/email/routing` (`status` ∈ ready/unconfigured/misconfigured/…), rule body `{matchers:[{type:"literal",field:"to",value}],actions:[{type:"worker",value:[name]}],enabled,name}` | P5 contract |
| Website `passioncode-ai/passioncode-ai.github.io` `/inbox/` | the local checkout is on another task's branch with untracked files, so it is not edited in place | W1 |

## Grill — resolved without a stop

The roadmap's operator decision (2026-09-28) already answers delivery, order and scope. Defaults
taken for what it left open, each reversible and recorded here:

| Question | Answer taken | Why |
|---|---|---|
| Does an agent send on its own by default? | No. A new agent drafts; `auto` is a per-agent switch with allowed intents and a daily limit | REQ-P3 says the policy decides; the safe default loses nothing |
| Where do agents and their runs live? | A new SQLite Durable Object `AgentRegistryDO`, one per workspace (`getByName("workspace")`), like `GmailAccountsDO` | versions and runs need transactions; R2 JSON has none |
| Where does the address → agent assignment live? | `settings.agent` in the mailbox's R2 settings (`{ id }` or `"off"`) | the mailbox already owns its settings; resolution at read time makes a deleted agent mean Off |
| Triage before local IMAP (L1) exists? | Yes, over the Cloudflare and Gmail sources that exist, by header and label rules, no model | L1 needs app passwords (human step); the rules are the same for IMAP later |
| Product page | Rewritten on a branch of the website repository from a clean worktree; not deployed | publication is outward-facing and needs a specific authorization |
| Deploy / live acceptance (P6) | Not in this run | needs Cloudflare Access, Email sending and an outside mailbox — human steps in the roadmap |
| Figma | Off; text-only design on the existing Fabric tokens | no recorded Inbox file; the UX chain degrades without it |

## REQ table (frozen: adding is free, removing needs the operator)

| REQ | Requirement | Verified by |
|---|---|---|
| REQ-P2 | An agent is a named, versioned definition, assignable to many addresses or Off per address; a legacy mailbox prompt becomes an agent without behaviour change | `tests/agents-registry.test.ts` |
| REQ-P3 | Pre-filter skips no-reply, bulk, list, auto-submitted and already-answered mail before any model call; the policy decides send or draft with a reason; the send goes through the idempotent outbox once, within the agent's daily limit and the mailbox rate limit; a model failure never sends | `tests/agents-runner.test.ts`, `tests/agents-prefilter.test.ts` |
| REQ-P4 | An agent calls only tools granted to it, on allowed hosts; each call and a bounded result is in the run; a tool failure turns the answer into a draft | `tests/agents-runner.test.ts` |
| REQ-P5 | A project address is created from the app with its agent; routing status read from Cloudflare (verified / missing / unknown) and a routing rule created on request; unknown recipients listed with Create address | `tests/project-addresses.test.ts` |
| REQ-T1 | Every unified-inbox message carries a deterministic triage: importance and group with reasons, from headers and provider labels | `tests/triage.test.ts` |
| REQ-T2 | The unified inbox shows Important first; other groups collapsed with counts; filters by group, account and unread | `tests/inbox-ui.test.ts`, browser check |
| REQ-A | Critical and high findings of the code audit are fixed with a test each, the rest ruled on | audit table in this brief |
| REQ-D | Documentation has one entry point, resolvable links and no claim contradicted by the code | link check, ux/brand lint |
| REQ-W | The product page states what ships today and what is in progress | website `npm run check`; review |
| REQ-B | Local builds: web `npm run build` and the macOS arm64 app bundle, with hashes | build receipt |

## Carry-over ledger

| Item | State | Home |
|---|---|---|
| P6 live deploy and acceptance | open — human steps | roadmap P6 |
| L1 IMAP accounts on the Mac | open — app passwords needed | roadmap L1 |
| L5 bulk actions per group | open | roadmap L5 |

## Delivered

| REQ | Change | Commit on `agent/agents-triage-2026-09-28` |
|---|---|---|
| REQ-P2, P3, P4 | agents registry, runner, prefilter, policy, model, durable trigger | `bbc6857` |
| REQ-P5 | project addresses API, Email Routing client, mailbox store | `f1439a3` |
| REQ-T1 | triage rules, signals, unread filter | `78f1f73` |
| REQ-T2 | Focus view, groups, filters, read on open; safe mail links and sizing | `71c7f64` |
| REQ-P5, P2 (UI) | Project addresses and Agents screens; API client errors; honest failed scan | `a6f77a9` |
| REQ-A | backend audit fixes | `031d7c4` |
| REQ-D | documentation | `8f40884` |
| REQ-A (frontend) | trash-first delete with Undo, safe chat Markdown, load and mutation errors, two-step Disconnect, cid rewrite, keyboard row actions (worktree packet, cherry-picked) | `9d922fd` |
| ladder walk | agent replies carry the display name; the settings prompt is labelled as the chat assistant's | `ea07273`, `4e10410` |
| REQ-W | `/inbox/` page copy | website branch `agent/inbox-page-2026-09-28` at `550da57` (passioncode-ai/passioncode-ai.github.io), not deployed |

Audit with every finding and its ruling: [audit-2026-09-28.md](../audit-2026-09-28.md).

## Checks actually run

- `npm test`: 234 tests. `incoming replay repairs lost automation acknowledgement without a second
  event` (tests/outbox-integration.test.ts) failed in 3 of 12 full runs with `TypeError: Body is
  unusable: Body has already been read` at the `replay.json()` line: the test read a response body
  after issuing the next request. The test now reads (or cancels) each body before the next
  request; afterwards **8 of 8** consecutive full runs passed 234/234. A test-harness defect, not
  a product one.
- Planted defects, each failed its test and was restored: run claim, tool-failure count,
  unknown send, grounded check, list header, journal trigger, catch-all routing, star in triage,
  folder-id badge.
- `npm run typecheck` exit 0; `npm run build` exit 0 on the merged tree.
- `python3 docs/ux/lint.py` OK; `python3 docs/ux/doctor.py` OK (vision.md absent, as before);
  `python3 docs/brand/lint.py` 0 errors, 340 advisory warnings (B022 registry heuristic).
- Relative links: a script over `docs/**` and README — 246 links, 0 broken after this commit.
- Browser (managed Chrome): synthetic fixture — Focus sections, chips, group expand, read on
  open, dark theme, the rewritten mail link; local Worker — agent created, address created,
  three synthetic messages delivered through `/cdn-cgi/handler/email`; response headers by curl;
  legacy mailbox view — Delete moved a message to Trash with an Undo toast, Undo restored it
  (network log: one `move` each way), Trash offers "Delete permanently" behind a dialog.
- Desktop: `npm run desktop:package -- arm64` and `-- x64` built; the arm64 app launched and was
  stopped; `app.asar` SHA-256 `c7840f3eae05d8d8c5d1409d80b4cdd2120ed37355262540baf79dd1209d1953`
  in both; ad-hoc signature only.

NOT_RUN: a real Workers AI answer, a real tool call, a live Email Routing zone, real delivery,
deployment, hosted CI (none exists).

## Human steps

1. Before P6: Cloudflare Access for the Worker; Email sending enabled on one project domain; a
   Cloudflare API token limited to Email Routing on the project zones, stored with
   `wrangler secret put CLOUDFLARE_EMAIL_ROUTING_TOKEN`; an outside mailbox to send test mail.
2. Website: a go to publish `agent/inbox-page-2026-09-28` through its DEPLOYMENT.md.
3. Before L1: app passwords for the personal and Workspace accounts.
