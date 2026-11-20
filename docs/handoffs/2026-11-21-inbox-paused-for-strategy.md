# Handoff 2026-11-21: Inbox repaired for agents (1.9.1); graph, notices and sleep paused for the strategy

**Objective.** The owner's two orders of 2026-11-20, relayed by CEO Fabric: (a) at 22:50, «с фабрик инбокс не
работает … подключение там доступа к агентам, вообще это все должно быть автоматически, не надо никакой подключать»,
with Inbox's notices on Fabric's home in «Нужны вы»; (b) the brief `2026-11-20-inbox-graph-and-brain-sleep-brief.md`
(a knowledge graph from the mail on Memory's engine, spam kept for a bounded time, «сон», stage logs). On 2026-11-21 at
00:30 the owner paused every new feature until the strategic plan (fabric-workspace session 2d03ce15): only the repair
and its live check go on. This file is the strategist's entry point for what is paused.

## Done (repair)

| What | Evidence |
|---|---|
| Cause found: Fabric's registry refused both Inbox descriptors (`unknown field runner`, `missing origin`) though the contract allows them, so `fabric-inbox` was missing from Fabric's agents and every hub call to it was refused before any ask | Fabric's `operations.jsonl` `registry.read` problems (13 reads on 2026-11-20); fabric-agent-contract `schemas/service-descriptor.schema.json` (`runner`, `peer`, `channels`; `lifecycle.manager: person` makes `origin` optional) |
| This Mac's server descriptor no longer carries `runner`: Fabric's read at 21:35 UTC accepts it | the same log after the change; backup of the file kept outside Git |
| Fabric's own reader fix and Fabric starting the connect by itself | board request `85e5af41` to Fabric (also sent to Fabric session 8343a070); four more descriptors of other agents fail the same way |
| A connect link from Fabric's own signed app is allowed with no dialog (B-307) | PR #602 (`f7b66260`), `tests/desktop-trusted-hub.test.ts`; checked against this Mac's real signatures |
| Live check: the server answers agents (MCP `initialize` 200, `list_accounts` 200 with the vault's agent key) and a test message sent through `send_test_message` arrived in 6 s | run on 2026-11-20 ~22:08 UTC |
| Release 1.9.1 carries B-307 and B-305 | this branch |

The owner's installed app was on 1.7.1 with 1.9.0 downloaded; the lifecycle broker refused a restart
(`not_started_by_broker`: the owner started it), so the update installs at the app's next quit.

## Paused (do not resume without the strategic plan)

| Row | State | Where |
|---|---|---|
| B-308 notices in «Нужны вы» (`notice/1`, agreed with Fabric session 8343a070: `from.kind` system/agent/service/person, `level`, `kind` question/approval/failure/network/notice, `dedupKey`, `resolved`; transport `GET /api/notices` + MCP `list_notices`, Fabric reads every 60 s; network failures are Fabric's own) | draft, untested | branch `feat/notices` at `d6279fa4`: `workers/notices/notices.ts` (sources: account states `workers/providers/provider.ts:54`, reply-agent outcomes `workers/agents/ticket-outcome.ts:26`, access requests `workers/mcp/access-requests.ts:24`, safety holds `workers/categories/store.ts:935`), `workers/routes/notices.ts` (not mounted). Left: mount, narrowing, the MCP tool and docs, Russian strings, schema, tests |
| B-309 graph on Memory (`memory-bundle/1` lines into Fabric's `estate-index/sources/fabric-inbox/*.jsonl`, ids `mail:` only, no spam or junk, `retain_until` for Memory's sleep; format from Memory session 0daa75f1, fabric `aec48f8d`) | draft, untested | branch `feat/mail-graph` at `225c06e4`: `workers/memory/redact.ts`, `bundle.ts`, `model.ts` (off by default, Kimi/GLM/DeepSeek only), migration `23_memory_changes` (SQLite triggers: unproven in Durable Object SQLite, test first). Left: route and MCP tool, the Mac exporter, tests, docs |
| B-310 spam retention | mostly existed | spam and discarded mail were already deleted after 30 days (`workers/durableObject/index.ts:137`, `shared/mail/discard.ts:62`); the branch makes it configurable (`SPAM_RETENTION_DAYS`, `SPAM_MAX_MESSAGES`), untested |
| B-311 sleep, B-312 stage logs | not started beyond `retain_until` | as above |
| B-313 Hermes in the reply agents (agents base request `3dcfbea5`) | open, date given on the board 2026-11-24 | |

## How Inbox stores mail today (measured in code, not on production)

Each address is one `MailboxDO` SQLite database (`workers/durableObject/migrations.ts`); a body over 400,000 characters
goes to R2 under `bodies/<id>.html` (`workers/durableObject/index.ts:150`) and attachments are R2 files. Cloudflare stops
writes to one object at 10 GB on Workers Paid, 1 GB on Free (`workers/lib/storage-usage.ts:7`). Inbox, Archive and Sent
are never deleted, so they grow to that limit; Spam and Discarded are kept 30 days, deleted 200 per pass
(`index.ts:137-139`); incoming receipts 90 days (`workers/actions/incoming.ts:19`); agent runs the last 2000
(`workers/agents/registry.ts:106`), their text cleared after 30 days (`registry.ts:84`). Real sizes were not read: that
needs the signed-in `GET /api/storage` on the running server.

## Next task

Release 1.9.1 (tag, watch the run, check the download), then follow board request `85e5af41` until Fabric's reader
accepts every Inbox descriptor and Fabric connects by itself; then prove an agent call through Fabric's hub reaches
Inbox. The paused rows wait for the strategic plan.
