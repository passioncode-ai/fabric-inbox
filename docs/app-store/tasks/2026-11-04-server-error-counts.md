# B-203: a server's errors, visible to us as counts

**State:** design 2026-11-04 (PR #396); built in 0.90.0 (2026-11-04). **Source:** the operator's request of 2026-11-04 about 12:25
UTC, relayed by the coordinator's session (every product logs its errors so customers' problems are visible to us),
Fabric's wave plan item C. Row: [B-203](../../evidence/backlog.md).

## The gap

A Fabric Inbox server runs in its owner's Cloudflare account. Its logs stay in that account (Workers Observability),
and the usage data the Mac app sends carries only the app's own crashes (`app_error`, B-200). docs/ANALYTICS.md says
"errors from the server" are never sent. So a customer's server can fail every night and we learn of it only when the
customer writes.

What the server knows today, by class (file:line as of `9753dfa`):

| Class | Where it is caught | Its codes |
|---|---|---|
| `http`: a request answered 5xx | each router logs its own (`workers/routes/agents.ts:44`, `inbox.ts:276`, ...); there is no `app.onError`, so a throw no router caught ends in Hono's plain 500 (`workers/app.ts:72`, `:267`) | the route group |
| `alarm`: a Durable Object's alarm step failed | `AgentRegistryDO.drain` (`workers/agents/registry.ts:465`), `GmailAccountsDO.alarm` (`workers/providers/accounts-do.ts:354`), `AutomationDO` (`workers/automation/index.ts:595`, `:686`), `CampaignsDO` (`workers/campaigns/store.ts:266`), `CategoriesDO` (`workers/categories/store.ts:409`) | the log event's name, such as `held_retry_failed` |
| `incoming`: a message could not be received | `handleIncomingEmail` (`workers/index.ts:913`) | the failure's code |
| `agent`: a reply agent's run failed before sending | `AgentRun.failure` (`workers/agents/run.ts:108`) | `model`, `safety`, `agent`, `read`, `answer`, `save` |
| `send`: a send ended failed or unknown | the outbox (`workers/actions/outbox-store.ts:4`) | its `error_code`, such as `TRANSPORT_OUTCOME_UNKNOWN` |
| `sync`: an account's mail could not be read | `workers/providers/accounts-do.ts:173`, `account-service.ts:684`, `routes/accounts.ts:282` | the log event's name |

## Design

1. **Counting on the server.** One table in the workspace ledger (`EmailMCP`, `workers/mcp/ledger.ts`; schema step
   `error_counts`): `(day, class, code, n)`, one row per UTC day, class and code, incremented with
   `ON CONFLICT DO UPDATE` as `mcp_send_counts` is (`ledger.ts:131`). The ledger is a singleton that already keeps
   counts that must be exact and has an idle alarm, which prunes rows older than 14 days. A failing object never
   counts its own failure in itself.
2. **What is recorded.** A helper `countError(env, class, code)` sends the count without waiting
   (`ctx.waitUntil` where a request has one) and never throws: a count that fails is one log line, never a second
   error. The code is checked against `^[a-z][a-z0-9_]{0,47}$` (after lowercasing a send's `error_code`), so a message,
   an address or a path can never be one; anything else is counted as `other`. Callers: a new `app.onError` (class
   `http`, code the first path segment after `/api/`, and it still answers 500 as today), the alarm and step catch
   blocks named above, `handleIncomingEmail`, the run's `failure` when a run ends failed, the outbox when a send ends
   `failed` or `unknown`, and the account sync failures.
3. **Reading.** `GET /api/server-errors?day=YYYY-MM-DD` (an administrator, default yesterday, at most the last 14
   days): `{ day, counts: { "<class>.<code>": n } }`, at most 50 keys. Its tool `get_server_errors` lets an agent read
   the same (the rule that every route is a tool).
4. **Sending.** The Mac app's daily read (`countsWith`, `desktop/analytics.cjs:389`) adds a fifth read, of yesterday's
   counts, and sends one event `server_error` per class and code (growth's answer of 2026-11-04 on thread `b2e5df1f`,
   message `891c4748`: its conditions read string properties only, so each pair is its own event): string properties
   `class`, `code` and `day` (`YYYY-MM-DD`, UTC), a number `count`, at most 30 events a day in the usual batches of 25;
   a day without errors sends nothing. Only with usage details on (the default since 0.87.0); with the switch off
   nothing is sent, as today. A server older than this release answers 404 and nothing is sent. No address, name,
   domain or id beyond the shared install id the details already carry.
5. **What a person sees.** The usage notice and Share Usage Details already say anonymous usage and error data; the
   detail line gains "and error counts from your server". docs/ANALYTICS.md: the `server_errors` row, and "errors from
   the server" leaves the "Never sent" list as "the server's error messages". SCN-048 is updated in the same change.

## Checks

- Unit: the code check (a message, an address, a path and a 49-character code become `other`); the event's keys and
  values (planted strings never reach the synthetic analytics server, as the existing test does for the counts).
- workerd: a throwing route counts `http.<group>` and still answers 500; an alarm step's failure counts once; the
  route answers yesterday's counts and refuses a day older than 14; the prune.
- The Mac app: a 404 sends nothing; the switch off sends nothing.

## Decided

- One event per class and code, not one event with 30 keys: growth's answer of 2026-11-04 (thread `b2e5df1f`,
  message `891c4748`). Growth reads the organization's analytics server after its access lands (PLAT-133, by 2026-11-06).

## Step 2: the server's hourly and daily digest (B-205)

Fabric's ADR-0188 asks every product for `ops.digest.hourly@1` and `ops.digest.daily@1` (the contract's draft
DEC-0153). The Mac app writes them since 0.92.0 (`desktop/ops-digest.cjs`). The server's design, decided 2026-11-04:

1. **What is counted.** The same six classes as above become operations named `<class>.<code>` for failures, plus an
   `ok` count for the operations whose volume is small and already passes through one object per event: a message
   received (`incoming`), a reply agent's run that ended (`agent`), a send that ended (`send`), an alarm step (`alarm`).
   A request answered below 500 is not counted: one ledger write per request would put the singleton ledger on every
   request's path. So `http.*` carries failures only, which the digest's form allows (an op with `ok` 0).
2. **Where.** The ledger's `error_counts` gains an hour and the two other outcomes: a new table
   `ops_hourly (hour, op, ok, failed, unknown)`, kept 14 days like the error counts; `countError` writes there too, and
   a new `countOk(env, class, code)` counts the successes named in 1. `error_counts` stays as it is, read by
   `get_server_errors` and the Mac app's `server_error` events (B-203), so nothing a release already sends changes.
3. **Folding.** On read, never by a timer: `GET /api/ops-digest?hour=` answers one closed hour as
   `ops.digest.hourly@1`, `?day=` one closed UTC day as `ops.digest.daily@1`, with Fabric's fold and rise rule (the
   same code as the app's, moved to `shared/`). The tool `get_ops_digest` reads the same.
4. **Checks.** The answers pass the contract's closed schemas and, once DEC-0153 is merged, `pnpm validate`
   (FAC-SEM-166, 167). Sending the daily digest anywhere waits for Observatory's intake (OBS-330, its proposal due
   2026-11-10) and is not part of this step.

**Built in 0.93.0.** As designed, with three differences. An alarm step's success is not counted: the alarm runs every
few minutes per mailbox, and its successes would outnumber everything else while saying nothing new. The fold lives in
`workers/lib/ops-digest.ts`, a typed copy of the app's rule (the app's is CommonJS in the Electron main process, which
the Worker's build does not read); both follow e1eecec0, and each has its own rise tests. An error
counted with a code such as `transport_outcome_unknown` is counted as `failed`, not `unknown`: the server has no third
outcome of its own yet. Code: `workers/mcp/ledger.ts` (step `5_ops_hourly`, `countOp`, `opsHours`),
`workers/lib/error-counts.ts (countOk)`, `workers/routes/server-errors.ts` (`GET /api/ops-digest`), tool
`get_ops_digest`; tests `tests/server-ops-digest.test.ts`.
