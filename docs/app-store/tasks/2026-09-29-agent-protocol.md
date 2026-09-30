# The agent protocol (MCP) — 2026-09-29

Request (paraphrased): design our MCP, the protocol by which agents work with
Fabric Inbox — receive, read, search and send mail — and an administrator level at which agents
create and manage mailboxes on the addresses connected to Cloudflare and configure the whole of
Fabric: mailboxes, forwarding, filters, blocks, how the agents work. Every function the app has must
be available to an agent, documented clearly, and every change to the app's functions must come with
a check that the MCP and its documentation were updated. Write a skill agents work by, add it to the
PassionCode family npm package so it updates from GitHub, and keep it current.

## Decisions (operator, 2026-09-29)

| Question | Answer |
|---|---|
| How an agent signs in | **A Cloudflare Access service token per agent** (`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers). Access checks it at the edge before any of our code; the server maps the token's Client ID (`common_name` in the Access JWT) to that agent's level. Revoking deletes the token in Cloudflare |
| How an agent sends | **Chosen per key**: *Drafts only* (the agent writes, a person sends) or *Can send* (an idempotency key, a daily limit per key) |
| Irreversible administrator actions | **Two steps**: the first call returns what will happen and a one-time code; the action runs only on a second call with that code within 5 minutes; every change an agent makes is journalled |

## What was there

`/mcp` served upstream's `EmailMCP` (13 tools, Cloudflare mailboxes only — no Gmail, spam,
addresses, domains, agents, categories, knowledge or settings), behind the same Access policy as the
app, which admits only the owner's email: no agent could reach it without a person's browser login.
`send_email` and `send_reply` sent without approval (board B-04).

## Design

- **One gate, then a level.** Access admits a request with a registered service token or the owner's
  login. The server reads the verified JWT: an email is the owner (level `admin`, can send); a
  `common_name` must be a key in `config/agent-keys.json`, or the request is refused — a service
  token made for another app in the same account gets nothing here.
- **Three levels.** `read` (mail, feed, search, addresses, settings, agents, categories,
  knowledge — reading only); `mail` (read, plus drafts, sending by the key's mode, replies,
  forwarding, moving, marking, spam reports); `admin` (everything: addresses, catch-alls, forwarding
  copies, domains, sending, spam lists, hidden addresses, agents, categories, projects, knowledge,
  rules, folders, mailbox settings, setup). Keys are issued by a person in the app; no tool issues
  keys.
- **One logic.** A tool calls the same HTTP route the app calls, in-process (`workers/api.ts`); the
  route's validation and behaviour are the tool's. A tool never reimplements a route.
- **The rule, as a test.** `tests/mcp-coverage.test.ts` lists every route the Worker declares and
  fails when one is neither behind a tool nor excluded with its reason (`workers/mcp/coverage.ts`).
  `docs/agents/mcp.md` is generated from the tool definitions (`npm run mcp:docs`) and a test fails
  when it is stale. The skill names tools only through that document.
- **Stateless transport.** Each request builds a server with only the tools the caller's level and
  sending mode allow (`createMcpHandler`, Streamable HTTP). The `EmailMCP` Durable Object class stays
  (removing a class is a destructive storage step the deploy refuses) and becomes the protocol's
  ledger: one-time confirmations, the daily send counters per key, and the journal of agent changes.

## Requirements (frozen; adding is free)

| REQ | Requirement | Verified by |
|---|---|---|
| AP-1 | An agent reaches `/mcp` with its service token only; an unregistered token, a revoked key and a request with no Access identity are refused; the owner's login works | `tests/mcp-auth.test.ts`; live with a real key |
| AP-2 | Levels `read` / `mail` / `admin`: a tool outside the key's level is neither listed nor callable | `tests/mcp-server.test.ts` |
| AP-3 | Sending by the key's mode: *Drafts only* keys see no sending tool; *Can send* keys send with an idempotency key within a daily limit | `tests/mcp-server.test.ts` |
| AP-4 | Irreversible actions take two calls: a summary and a one-time code, then the action with the code within 5 minutes; a code works once, for the same key, tool and arguments | `tests/mcp-server.test.ts` |
| AP-5 | Every route of the app is behind a tool or excluded with a reason; mail across Cloudflare and Gmail | `tests/mcp-coverage.test.ts` |
| AP-6 | Every change an agent makes is journalled (key, tool, target, outcome) and shown in the app | `tests/mcp-server.test.ts`; installed app |
| AP-7 | Keys are created, listed and revoked in the app: Cloudflare service token, the Service Auth policy on the server's Access app, the key registry; the secret is shown once, with ready configs for MCP clients | `tests/agent-keys.test.ts`; installed app |
| AP-8 | `docs/agents/mcp.md` documents every tool (level, what it does, inputs, confirmation, sending) and is generated; a stale document fails the tests | `tests/mcp-docs.test.ts` |
| AP-9 | The rule is written where contributors and agents read it: `AGENTS.md`, `CONTRIBUTING`-level docs, the retro's standing instructions | files |
| AP-10 | A skill for agents working with Fabric Inbox, shipped as a plugin from this repository and a member of `@passioncode-ai/passioncode`; a test fails when the skill names a tool that does not exist | `tests/mcp-skill.test.ts`; passioncode release |
| AP-11 | UX: scenarios and the screen for agent access; strings through the brand pack | `docs/ux/` lint and doctor |
| DOC | Architecture, setup, board (B-04 closed), handoff, release receipts | receipts |

## Built (0.7.0)

| REQ | Where | Evidence |
|---|---|---|
| AP-1 | `workers/mcp/keys.ts (principalFor, identityMayUse)`, `workers/app.ts` (Access middleware), `workers/mcp/handler.ts` | `tests/mcp-auth.test.ts` (owner, registered/expired/foreign token, the path rule); `tests/mcp-workerd.test.ts` "an unknown service token, an expired key and no identity are refused" |
| AP-2, AP-3 | `workers/mcp/protocol.ts (toolsFor, runTool)`, `workers/mcp/ledger.ts (reserveSend, refundSend)` | `tests/mcp-workerd.test.ts` "each level sees only its tools…", "an agent drafts, sends once per key per day…", "a refused send gives its allowance back" — each watched failing with the level filter, the refund removed |
| AP-4 | `runTool` + `EmailMCP.issueConfirmation / consumeConfirmation` | `tests/mcp-workerd.test.ts` "an irreversible action takes two calls…" (watched failing with the code not bound to its key); `tests/mcp-coverage.test.ts` "every irreversible route is behind a two-step tool" |
| AP-5 | `workers/mcp/tools.ts` (62 tools, 6 exclusions with reasons) | `tests/mcp-coverage.test.ts` against the running app's `api.routes` (watched failing with one route dropped) |
| AP-6 | `EmailMCP.record / journal`, `GET /api/agent-keys/journal` | `tests/mcp-workerd.test.ts` (journal rows per key; reads not journalled) |
| AP-7 | `workers/routes/agent-keys.ts`, `workers/mcp/access.ts (AgentAccess)`, `app/routes/agent-access.tsx` | `tests/mcp-auth.test.ts` (one policy, the app's other policies and settings kept, revoke, rollback); `tests/agent-access-ui.test.ts` |
| AP-8 | `scripts/mcp-docs.ts`, `docs/agents/mcp.md` | `tests/mcp-docs.test.ts` (watched failing with one description changed) |
| AP-9 | `AGENTS.md` (Rules), `docs/evidence/retro.md` standing instruction 8, `docs/agents/mcp.md` "For contributors" | files |
| AP-10 | `plugins/fabric-inbox/` (skill `working-with-fabric-inbox` + `references/admin-workflows.md`) | `tests/mcp-skill.test.ts` (watched failing with a made-up tool); `claude plugin validate plugins/fabric-inbox --strict` passed; make-skill audit 0 GAP, 14 PASS |
| AP-11 | SCN-043, SCN-044, SCR-15; brand terms and strings | `python3 docs/ux/lint.py` OK; `python3 docs/brand/lint.py` 0 errors |

## Security review (independent, before the first commit)

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | Any page the owner visits could POST a tool call to `/mcp` with their Access cookie (stateless handler, lenient content type) — high | `refuseUnsafe`: POST only, no foreign `Origin` or `Sec-Fetch-Site: cross-site`, exactly `application/json` | `tests/mcp-workerd.test.ts` "a web page the owner visits cannot use their sign-in…" (watched failing with the Origin check removed) |
| 2 | An admin key marked Drafts only could still send through automatic rules and reply agents — high | admin keys always send (`sendFor`, `principalFor`); the UI and docs say what the limit does not count | `tests/mcp-auth.test.ts` "an admin key always sends…" |
| 3 | `mark_spam` took the sender from the caller: a mail key could put any domain on a list — medium | the sender is read from the message | `tests/mcp-workerd.test.ts` "…mark_spam remembers the message's own sender" |
| 4 | The two-step code returns to the same caller — medium | stated as a stop against mistakes, not an approval (instructions, docs, UI); an owner approval for agent keys is board B-38 | docs |
| 5 | Updating the Access app from a list item could drop the owner's policy — medium | the app is read whole first, refused without a policy of its own, checked after the update and put back | `tests/mcp-auth.test.ts` "changing the Access app is refused…", "if Cloudflare drops the owner's policy…" |
| 6 | A key that failed after its policy was written left a dead token in the policy — medium | the rollback revokes (policy and token) | same test (watched failing: the rollback hit the same guard; fixed by checking the no-op first) |
| 7 | Two key changes at once could lose one — low | one key change at a time (a lease in the ledger, `2_locks`) | code |
| 8 | A verified identity with neither email nor service token had the owner's rights — low (older) | only a person opens anything but `/mcp` | `tests/mcp-auth.test.ts` "anything Access admits without a person…" |
| 9 | `.`/`..` in an id is collapsed by the URL parser — low | refused; account ids must be an address or a Gmail id | `tests/mcp-workerd.test.ts` "an id with . or .." |
| 10 | Mail text shaped the confirmation summary — low | quoted and cut to 120 characters | code |
| 11 | `dry_run_rule` spent the model unrecorded; journal failures were swallowed — low | journalled; a failed journal write is said in the result | `tests/mcp-protocol.test.ts` |
| 12 | The `claude mcp add` command keeps the secret in shell history and config — low | also a JSON that reads it from `FABRIC_INBOX_CLIENT_SECRET` | UI, docs |
| 13 | `GET /mcp` held a stream open forever — low | 405 | the same CSRF test |
| — | Old McpAgent alarms on the reused class | a no-op `alarm()` | code |

Not run: an outcome evaluation of the skill against a baseline agent with no skill (make-skill's evals); the protocol's own server instructions carry its conventions, and the skill was checked against the tools, not measured on agents.

## Release 0.7.0 (2026-09-29)

| What | Receipt |
|---|---|
| Server | deployed, version `b06434a5` (from c37dee0; `fa1b6877` and `aae06337` before the two live fixes) |
| `Fabric-Inbox-0.7.0.dmg` (public, from d84ee43) | notarized, stapled, Gatekeeper accepted; sha256 `82665fab7bd6b6be…`; 0 of 63 owner identifiers in `app.asar` |
| `Fabric-Inbox-0.7.0-owner.dmg` (from d84ee43) | notarized, stapled, Gatekeeper accepted (`source=Notarized Developer ID`); sha256 `9d55ee2d143d1437…`; installed in /Applications, `CFBundleShortVersionString` 0.7.0 |
| Skill | tag `v0.7.0` (4f060c6 → c37dee0; the skill there is final, the Mac app's version fix came after); `passioncode` branch `agent/fabric-inbox-member` 8c0e449 vendors it, validates `--strict`, 48 tests pass |
| A first image | built as 0.6.2 with a 0.7.0 server inside (the Mac app's version had not been bumped); discarded, fixed in d84ee43 with `tests/versions.test.ts` |

Checked live on the owner's server (2026-09-29):

- The owner's own MCP session from the installed app: `initialize` → `fabric-inbox@0.7.0`, 62 tools; `list_accounts` 36 addresses; `list_messages`; `read_message` (a 40 KB HTML message as 16.8k characters of text); `delete_message` on an unknown message refused with "Not found"; on a real one the first call returned a summary with quoted text and a 10-character code, nothing was deleted and the code was left to expire; `list_agent_activity` showed both.
- **Agent access** in the installed app: the screen, its sections and the empty states as SCR-15 says.
- **The first agent key was refused by Cloudflare**: the server's token lacks **Access: Service Tokens — Edit** (code 1010). The app now names that permission. Keys, the agent path through Access and the skill against a live server remain to be accepted — the next task.
