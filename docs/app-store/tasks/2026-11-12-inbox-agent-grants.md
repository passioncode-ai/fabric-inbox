# Inbox as an agent: grants per mailbox, access requests, an organization's outreach agent (B-246)

**Date:** 2026-11-12. **Asked by** the operator in this repository's session: «инбокс должен быть сам агентом чтобы он
был доступен другим агентам по запросу и с уровнем доступа к определенному ящику или нескольким и на чтение или
отправку а также на создание удаление и можно как агентам так и людям дать полномочия, дает полномочия к почте
администратор или овнер, сотрудники и архитектор получают уже готовые доступы, надо чтобы в [организации клиента] появился агент и
можно было например делать аутрич через него, доработай план и продумай спеку и волнами все до конца закрой».

**Architect first** (rule R29): the agents database's consult (2026-11-12) ranks `host-operations`,
`delivery-gateway` and `sales-leads` and names the patterns `client-keys` (keys per holder with scopes, one-time
plaintext, bounded delegated administration), `approval-outbox` (an act that waits for a person, single use),
`fail-closed-door` (a refusal names nothing of what was wrong) and `spend-ledger` (caps per day). The outreach agent
of step W5 is assembled from `sales-leads` through the base's assembly, never written here from scratch.

## What exists (read 2026-11-12 at `fcce80d`)

| Piece | Where | What it does |
| --- | --- | --- |
| Agent keys | `workers/mcp/keys.ts:26-56`, `workers/routes/agent-keys.ts:107-130` | one level (`read`, `mail`, `admin`), `send` or drafts, `dailySendLimit`, `accounts` (mailboxes or `domain:` entries), `approval: "owner"`, `standing` (`people`, `keys`) |
| Scope per mailbox | `workers/mcp/scope.ts:82-193`, `workers/mcp/handler.ts:107-128` | a key with `accounts` sees and reaches only those mailboxes; mailbox administration refused to any limited key |
| People | `workers/lib/members.ts:14-35`, `workers/lib/member-gate.ts:48` | roles admin and member; per mailbox levels `read`, `send`, `agents`; members are refused at `/mcp` |
| Approval of one act | `workers/mcp/protocol.ts:197-210`, `agent-keys.ts:206-225` | B-38: a tool that needs the owner answers `needsApproval` with a code; the owner approves in the app |
| Standing | B-215, SCN-098 | an admin key may add members and make keys with its own code |
| The service document | `workers/routes/fabric-service.ts:15-144` | `/.well-known/fabric-service`: MCP surface, actions, connections, usage |
| Campaigns | `workers/campaigns/`, `shared/mail/campaign.ts` (B-181) | up to 4 steps, daily cap 30 (max 50), ramp-up, bounce pause, do-not-write list, unsubscribe |
| Lead hand-off | `workers/agents/leads.ts`, `registry.ts:1495-1514` | a reply agent hands a lead to a sales agent; campaign replies are not handed off |

## Gaps

1. Nothing lets an agent **ask** for access: a key exists only if a person made it beforehand.
2. A key has **one level for all its mailboxes**; creating or removing an address needs `admin`, and an admin key
   cannot be limited to mailboxes. Deleting mail sits inside `mail`.
3. People and agents have **two models** (`members.json` levels, `agent-keys.json` level and accounts), and a
   member's agents cannot use the member's own levels (members are refused at `/mcp`; SCN-096 expects otherwise).
4. Every admin person is the MCP "owner"; owner, organization administrator and architect are not told apart (B-232,
   blocked on the architect role).
5. **No ready access** for employees or the architect: organization roles grant nothing (organizations plan D4).
6. No outreach agent on an organization's server; campaign replies reach no sales agent.

## Decisions

- **D-1. One grant model for agents and people.** A grant is `{ holder, mailboxes, can, expiresAt?, grantedBy, why }`.
  `holder` is an agent key or a person's address; `mailboxes` is a list of addresses or `domain:` entries, or `*`;
  `can` is a set of capabilities: `read`, `draft`, `send`, `organize` (move, mark, folders), `delete` (mail, with the
  two-call code kept), `create` (addresses on the listed domains), `remove` (those addresses), `agents` (the
  mailboxes' reply agents), `campaign` (prepare and queue campaigns), and `limits` (send mode, daily cap, owner
  approval; R-1). A holder may have several grants (another mailbox, other capabilities). Today's levels
  become named bundles (`read` = read; `mail` = read, draft, send or drafts, organize, delete; `admin` = everything on
  `*`), so every key and member keeps exactly what it can do now (migration with a test per old shape).
- **D-2. Who grants.** The owner and the organization's administrators grant anything; a holder with the `grants`
  standing may grant only what it holds itself (never more, never `grants` itself). Every grant and revocation is
  journaled with who, what, why. A grant above the person's own reach is refused, not narrowed silently.
- **D-3. Ready access by role.** The organization's attestation (B-159) gives each person a role; a role maps to a
  preset grant the owner can edit once per organization: `employee` gets `read`, `draft`, `send` on their own address
  and the shared addresses the owner lists; `architect` gets `read`, `organize`, `agents`, `create`, `remove` on `*`
  and the `grants` standing for agent keys, with every act journaled under the role (closes B-232 for Inbox: owner,
  administrator and architect commands run without a second approval; a user's still wait). A person's own agents get
  at most the person's grants (closes gap 3).
- **D-4. Inbox answers requests for access.** A new tool `request_access {mailboxes, can, why, until?}` (holder, expiry, repetition and single decision as R-3 says) works with any
  key, even one that holds nothing yet (a `requester` key the Fabric hub or the connect link can make with no mail
  reach). The request waits in Settings → Agent access and is announced to the owner and administrators (the app's
  notification, and their Telegram through our gateway when the organization has it); approve, narrow or refuse
  there, or by an administrator's agent with the tool `decide_access_request` (dashboard parity). Approving makes the
  grant (D-1), and the requester sees it on its next call (`list_my_access`). The same request comes over the Fabric
  board: capability `mail.access` on this project, handled by a session that calls the server with an administrator's
  key, so an agent with no key at all can ask.
- **D-5. Inbox is a Fabric agent.** The service document declares the capabilities `mail.read`, `mail.send`,
  `mail.access` with their tools (one name on both doors, R-8), and the MCP door keeps `auth: own`. Keys follow the `client-keys` pattern's
  guarantees already met by Access service tokens (one-time secret, revocable one by one); the refusal stays uniform
  (`fail-closed-door`).
- **D-6. An organization's outreach agent.** Assembled from the base's `sales-leads` template for the client
  organization (variant: outreach through Inbox campaigns), it holds one grant on the outreach addresses with `read`,
  `draft` and `campaign`, never `send` (R-6), under the campaign caps (30 a day, ramp-up, bounce pause, unsubscribe), and
  hands every human reply to the organization's sales agent (the lead hand-off of B-237 extended to campaign replies).
  The grant comes from a request the organization's access owner approves (DEC-0009); the first campaign runs as
  drafts until the organization's owner says send, since sending to people outside the estate needs that word.

## Design review (2026-11-12) and what changed

One reviewer of another model family (`moonshotai/kimi-k3.1-pro` through OpenRouter, the architect's design workflow)
read D-1 to D-6 and the waves. Its eight findings and the answers, now part of the decisions:

| # | Finding | Answer |
| --- | --- | --- |
| R-1 | The migration loses `dailySendLimit`, drafts-only, `approval: "owner"` and `standing` | A grant carries `limits` (send mode, daily cap, owner approval) beside `can`; standing stays its own field. W2 runs the new authorizer beside the old one first and logs every disagreement; the cut-over waits for three days with none. Members stay refused at `/mcp` until W4 |
| R-2 | No algebra for `*`, `domain:` and several grants; tenant crossing | One server is one tenant (the organizations plan, D1): `*` is every mailbox of this server, `domain:x` only a domain this server holds, addresses lower-cased and IDN in punycode. Effective access is the union of a holder's grants; a delegated grant is a subset in mailboxes, capabilities, expiry and limits, checked by the server. Grants never leave a server |
| R-3 | A request with no key has no holder and no safe credential path | The holder is always a key, immutable by its id: an agent with no reach gets a `requester` key (the connect link, or an administrator's agent through `agent-key-bootstrap.mjs`), and an approved request widens that key in place, so no secret travels. The board path records the asking project's board identity on the request and calls only `request_access` with this project's requester key; it holds no administrator key. Requests expire in 7 days, repeat by (holder, scope) without a second row, at most 10 wait per holder, and a decision is taken once (compare and set) |
| R-4 | Revocation and offboarding do not bound access | A delegated grant names its parent and every use checks the parent's reach; role access is read from the current attestation, never copied; an agent's grant ends within a year unless renewed; a campaign checks its grant again before every send and stops when it is gone |
| R-5 | The architect preset is too strong | Declined in part: the operator decided on 2026-11-06 (B-232, thread `eefa7959`) that the owner's, an administrator's and the architect's commands run without a second approval. Kept with guards: the architect's grants follow the role in the attestation and end with it, every act is journaled under the person's or key's immutable id with the role, removing an address keeps its mail restorable (SCN-097), deleting mail keeps its two-call code, and an agent the architect sets up runs with its own grant, never the architect's |
| R-6 | The outreach grant cannot be written; `send` bypasses campaign controls; a spoken "send" is not bound | A capability `campaign` (prepare and queue campaigns) joins D-1. The outreach key holds `read`, `draft`, `campaign` and not `send`: every message it sends goes through a campaign and its ledger (cap, ramp-up, bounce pause, do-not-write list) checked at send time. The owner's send is an approval bound to the campaign id, the hash of its content and of its recipients, its cap and an end date, used once (the `approval-outbox` pattern); a changed campaign or the next one needs a new one |
| R-7 | The reply hand-off can leak mail | The sales agent is a principal named in the server's settings; only campaign replies classified as a person's interest go, unsubscribes are handled first, and the hand-off is a lead record (sender, subject, an excerpt, a link to the thread) unless the setting says the whole message. No hand-off to another server |
| R-8 | Dependencies and proofs do not hold the schedule | W2b below settles the contracts first; W4 runs behind a flag until the attestation names roles (B-159, B-232); W6 releases a wave only with its proofs, and B-246 stays open for any wave without them. One capability name on both doors: `mail.access` |

## Waves

| Wave | What | Ships in | Proof | Target |
| --- | --- | --- | --- | --- |
| W1 | This packet, SCN-100 to SCN-103, the design review above | docs | `docs/ux/lint.py` 0 errors; every finding answered | 2026-11-12 |
| W2a | The grant store and the authorizer beside today's checks (shadow), the migration of keys and members, disagreements logged | every server | a test per old key and member shape; shadow logs with no disagreement for three days | 2026-11-15 |
| W2b | Contracts: the grant, the request and `mail.access` in the service document; the role source as a stub behind a flag | every server | contract tests; `npm run mcp:docs` | 2026-11-15 |
| W2c | The cut-over; tools `list_grants`, `grant_access`, `revoke_grant`; Settings by mailbox (SCN-101); delegation as a subset; revocation by parent | every server | tests of union, subset, cross-domain refusal, revocation; a walk | 2026-11-18 |
| W3 | `request_access`, `decide_access_request`, `list_my_access`, the requester key, the announcement, the board capability `mail.access` (SCN-100) | every server, this project's board | a request from an agent with a requester key, approved, used, refused when replayed | 2026-11-19 |
| W4 | Roles from the attestation behind a flag, a person's agents within the person's grants, B-232 for Inbox (SCN-102) | every server | tests per role; the flag on once B-159 names roles | 2026-11-21 |
| W5 | The client organization's outreach agent from the base's `sales-leads` template, its grant by request, campaign approvals bound to content and recipients, campaign replies handed to sales as leads (SCN-103) | the client organization's server and its agent | the assembly's checks; the request approved by the access owner; a campaign as drafts | 2026-11-24 |
| W6 | Release per wave with its proofs, the three servers updated, docs, B-246 closed only when every wave holds its proofs | release | `/api/server` version on each server | 2026-11-25 |

## Human gates

- The client organization's access owner approves the outreach agent's grant (DEC-0009); W5 waits for it and the
  request names exactly what it asks.
- Sending the first campaign to people outside the estate needs the organization owner's word for that campaign.

## Out of scope

Grants between servers (each server grants its own mailboxes), and a person's sign-in through an identity the
organization's directory provides (B-158 M3).
