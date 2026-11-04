# B-203: a server's errors, visible to us as counts

**State:** design (2026-11-04); release by 2026-11-11. **Source:** the operator's request of 2026-11-04 about 12:25
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
   counts, and sends them once per UTC day as one event `server_errors` with each `<class>.<code>` as a number (at most
   30 keys, the largest first). Only with usage details on (the default since 0.87.0); with the switch off nothing is
   sent, as today. A server older than this release answers 404 and nothing is sent. The event carries no address,
   name, domain or id beyond the shared install id the details already carry.
5. **What a person sees.** The usage notice and Share Usage Details already say anonymous usage and error data; the
   detail line gains "and error counts from your server". docs/ANALYTICS.md: the `server_errors` row, and "errors from
   the server" leaves the "Never sent" list as "the server's error messages". SCN-048 is updated in the same change.

## Checks

- Unit: the code check (a message, an address, a path and a 49-character code become `other`); the event's keys and
  values (planted strings never reach the synthetic analytics server, as the existing test does for the counts).
- workerd: a throwing route counts `http.<group>` and still answers 500; an alarm step's failure counts once; the
  route answers yesterday's counts and refuses a day older than 14; the prune.
- The Mac app: a 404 sends nothing; the switch off sends nothing.

## Open

- Whether the Fabric analytics owner wants the counts as one event or one event per class (asked on the analytics
  thread with this note; the design takes one event, the cheaper read).
