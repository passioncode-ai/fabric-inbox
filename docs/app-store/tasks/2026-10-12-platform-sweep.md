# Run brief 2026-10-12: platform and feature sweep

The operator asked to go through every feature and check that Windows and macOS work correctly,
and also the agent protocol (MCP) and every service ("давай пробежимся по всем фичам и проверим что
и винда и макук корректно будут работать и агентский мсп и службы все"). It ran on 0.16.2 (`e50fd8f`)
as five read-only checks, then fixes. Findings are rows B-97…B-111 on the [board](../../evidence/backlog.md).

## What was checked and how

| Area | How | Result |
|---|---|---|
| Agent protocol, live | every one of the 35 read-only tools on the owner's server (90 calls, negative probes included); `tools/list` against `workers/mcp/tools.ts` and `docs/agents/mcp.md` | 90 tools, no list/doc mismatch, every read tool answers (≤ 284 ms), no secret in any output; 4 minor findings (B-98) |
| macOS build | the downloaded 0.16.2: `codesign --deep --strict`, entitlements, `spctl`, staples, Info.plist, Electron fuses (`verifyHardening`), node-pty files, `lipo`; `scripts/check-installed-app.mjs`; the release's update check | everything passes; the GUI was not launched (the lifecycle broker was unreachable); 6 risks (B-104, B-106, B-107) |
| Windows and Linux | release run 38262796185 and PR `platforms` run logs, receipts, feeds; platform code read; `tests/desktop-*.test.ts` (187 pass) | installs and starts on Windows x64/arm64; real defects in Linux sandboxing, Windows signing depth, localized netstat, ConPTY, glibc floor and CI coverage (B-99…B-105, B-108, B-111) |
| Services | Workers Observability 48 h, Worker settings API, agents/rules/knowledge over MCP, the signals server, the Acme data agent, update feeds, analytics | healthy: every invocation `ok`/`canceled`, no exception; timers kept Durable Objects open after their work (B-97); `NGDATA` stored without its host (fixed live, below); email wall time rose (B-109) |
| Interface | WebKit walkthrough of the main scenarios on a local server | interrupted by the session limit before it reported (B-110) |

## Fixed at once (live, no code)

- **Tool tokens bound to their hosts.** `AUTOMATION_TOOL_TOKENS` held `SIGNALS` and `NGDATA` as bare strings (`tool_token_unbound` at 09:57:59Z). The data agent issued a fresh token into the vault (`fabric-inbox/prod/NGDATA_TOOL_TOKEN`); the secret is now `{SIGNALS:{host,token}, NGDATA:{host,token}}` (2026-10-12 ~21:27Z, `wrangler secret put`), the old NGDATA token is revoked, and the `save_agent` handshake at 21:29:18Z passed (data agent log 21:29:21Z; 0 `tool_token` lines afterwards).
- **The Acme support agent answers from the data agent only** (B-85 FI-5): v8/v9 without the hand-loaded collections, which were deleted after the canary C-09.

## Fixed in code (this run)

| Row | Fix | Test |
|---|---|---|
| B-97 | `workers/lib/deadline.ts`: a time limit cleared when the work ends, in the category classifier, the agent model calls and the Cloudflare API client | `tests/deadline.test.ts` |
| B-98 | MCP: `destructiveHint` true for every changing tool unless `additive`; a bare error code reaches the agent as a sentence; `list_domains` `account` says what it does; the grant's `publicOnly` and `gaps` descriptions match the code; `docs/agents/mcp.md` names IMAP and Outlook | `tests/mcp-annotations.test.ts` |

The desktop and release fixes follow in their own changes (rows B-99…B-105).
