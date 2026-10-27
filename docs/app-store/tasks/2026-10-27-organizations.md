# B-158 M0: organizations in Inbox

Status: design, 2026-10-27. Row: [B-158](../../evidence/backlog.md) (epic; milestones M0 to M7 of
[the consolidation report, group C](../../reports/2026-10-25-consolidation/README.md)). Nothing here is built; the
scenarios it adds are SCN-092 to SCN-096 in [docs/ux/scenarios.md](../../ux/scenarios.md), status `draft`.

Inbox does not define its own organization model. It reads the shared one, and this packet maps it onto Inbox.
Sources, read on 2026-10-27:

| Source | What it settles |
|---|---|
| fabric-agent-contract `docs/DECISIONS.md` DEC-0082 (in force 2026-10-13), `docs/specification/contexts.md` | the context id: `personal` or `org:<orgId>`, `orgId` matching `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`, compared exactly (`contexts.md:22-46`); a grant's level is its own fields, a named level is a host's preset (`contexts.md:57-63`); which context a session runs in is the host's decision (`contexts.md:292-293`) |
| the same contract, `docs/specification/membership.md` (DEC-0127, `org-membership/1`) | how a product reads a person's organization: an attestation with `issuer`, `org`, `audience`, a pairwise `subject`, `role` (`owner`, `admin`, `member`), `status`, `revision`, a validity of at most 24 hours (`membership.md:44-56`); a role is for display and routing and grants nothing (OL-6, DEC-0133, `membership.md:326-329`) |
| the organization service's design note "organization source of truth" (2026-10-26, path (a) accepted as MD-9) | SOT-01 to SOT-08: it is the source of truth for organizations, people, roles and provider accounts of an organization that runs it; provider accounts are held as name, provider, the provider's account id, owner and environments, never a key (SOT-04); sign-in modes `passkey`, `idp-required`, `idp-for-admins` (SOT-05); what Inbox reads: the per-person attestation through an app client `inbox`, and a separate directory grant an administrator creates (its section 4); its plan SOT-B5 builds both, after 2026-11-07 |
| fabric-workspace `knowledge/integration.md`, Organization R1 (I2, MD-11) | the first organization runs on a separate server in the same Cloudflare account (option A, deployed 2026-10-26 as B-169); Inbox owes B-168, B-169, B-83, B-158 to B-160 |
| the consolidation report, sections 6 to 8 | the target flow and the operator's decisions of 2026-10-25 (Q1 many organizations, Q2 members sign in, Q4 B-83 required, Q6 and Q7 Inbox's own sign-in with Google Workspace as an option, Q11 levels per person and mailbox) |

## The entities

| Entity | Shared model | In Inbox | Id Inbox keeps |
|---|---|---|---|
| Person | the organization service's member; a product sees only a pairwise `subject` for its own audience (SOT-03) | who signs in; today an email Cloudflare Access proves (`workers/lib/members.ts`) | the attestation's `subject` for the server's audience, plus the sign-in email; never a subject from another audience |
| Organization | context `org:<orgId>`; the first ids are `org_<base32>` | a server bound to that context | the context id, as the attestation names it, compared exactly |
| Personal space | context `personal` | the person's own server, as today | `personal` |
| Account | a provider account the organization service records (SOT-04: provider, the provider's account id, label, owner, environments; no key) | a connected Cloudflare account, Gmail, Outlook or IMAP account; today "other accounts" (`deployments/` inventory: one server, three other accounts) | the provider and the provider's account id; the organization service's account key when it records one. The credential Inbox needs to act stays where it is today (the server's secret store), never in the organization service |
| Workplace | not in the shared model (found nowhere as an entity, 2026-10-27) | a member's place in an organization: their primary work address and the mailboxes they reach | a local record keyed by (context, subject); proposed to the organization service as a shared name, question O-1 below |
| Member | (`org`, `subject`) with a role, from the attestation | a row of Settings → People (B-149), today keyed by email | (context, subject), with the email kept for display and for Access |
| Role | `owner`, `admin`, `member` (the organization service's `finance` and `employee` map onto these) | shown, never used as a permission | as the attestation names it |
| Access level | a grant's fields; named levels are a host's presets | B-160's presets per person and mailbox: read; read and send; configure agents; administer | the preset name and the mailbox, per (context, subject) |
| Agent | a caller with a grant in one context; delegated calls carry their chain (B-83, ADR-0144) | an agent key (`workers/mcp/keys.ts`) | the key's id and the context of the server that made it |

## Decisions

**D1. One server per context; the Mac app holds several.** An organization is a server bound to one context, and the
person's own server is `personal`. The app keeps a list of servers, each with its context and name, and switches
between them. Why: separation from the start without partitioning every Durable Object, R2 prefix and Access
application inside one Worker; it is how the first organization already runs (MD-11, B-169); a leak between
organizations would need a wrong server address, not a missing filter. What it costs: one Cloudflare Worker per
organization (a person in three organizations has four servers in the app). A shared multi-tenant server is not
planned; if one is ever needed, it is a new decision with its own packet.

**D2. A server knows its context and refuses any other.** The server holds its context as a setting
(`FABRIC_CONTEXT`, `personal` when absent, so today's servers keep working). An attestation whose `org` is not that
context is refused; so is a key, a share or an event naming another context. The context appears in
`/api/server`, the well-known document and every event the server emits for Fabric.

**D3. The organization service owns organizations, people, roles and its account list; Inbox keeps mail.** Inbox does
not create organizations or people of its own; an organization appears in Inbox when a server is bound to it, and a
person appears when they sign in with an attestation for it or an administrator lists them. Inbox keeps what only it
has: mailboxes, mail, agents, keys, the audit record (B-156), and the credentials to act on its accounts.

**D4. A role is not a level.** The attestation's role is shown and used to route (who is offered the People screen);
what a person may do is the level an administrator gave them per mailbox (B-160). Defaults, so a new organization works
before anyone sets levels: `owner` and `admin` get administer on every mailbox of the server; `member` gets nothing
until an administrator gives a level. This follows OL-6 (a role grants nothing in a reader) and keeps today's rule that
nobody listed means administrators only (SCN-081).

**D5. Sign-in keeps Cloudflare Access as the outer gate until the organization's mode says otherwise.** In
`idp-required` mode (today's organizations) Access with the organization's identity provider
lets people in and the attestation adds who they are in the organization. In `passkey` mode Access lets the
organization service's sign-in through and the attestation is the proof (B-159, blocked on SOT-B5). A code sent only to
the work address being activated is not a sign-in: its mailbox cannot be read before sign-in (report, M2).

**D6. Levels are Inbox's presets over the tool classes Inbox already has.** read: the tools marked read-only on the
person's mailboxes; read and send: plus the tools marked `sends`; configure agents: plus the agent, knowledge and rule
tools of those mailboxes; administer: everything on the server, People included. The scale is posted on the board for
the other products to align with; the contract leaves presets to the host (`contexts.md:57-63`), so it needs no
contract change.

**D7. Today's data moves without loss.** The owner's server becomes `personal`; its other accounts stay in the personal
space until the owner attaches one to an organization, which moves that account's mailboxes, agents and history to the
organization's server by an export and import with a count check and a way back. The first organization's server
(B-169) is bound to its context once the organization service issues the id.

## Questions for other projects

Asked on the board with this packet's path; each has the default Inbox proceeds on.

| # | To | Question | Default |
|---|---|---|---|
| O-1 | the organization service | Is "workplace" (a member's primary work address and the mailboxes they reach) a shared entity, or Inbox's own? | Inbox's own record until the shared model names it |
| O-2 | the organization service | The app client `inbox` (SOT-B5): its audience is each server's origin, so a person has one pairwise subject per server; confirm | one audience per server origin |
| O-3 | the organization service | The directory grant (section 4): members' work addresses, roles, state, and the organization's Cloudflare account ids; Inbox also needs a change feed, or a revision to poll, to remove a leaver at once | poll the revision every 5 minutes; a removed member's sessions and keys are revoked on the next read |
| O-4 | the contract | Context on Inbox's events for Fabric: carried by the server's descriptor, not by each event (`contexts.md`: events never carry the session's context) | the descriptor names the context |

## Milestones, as Inbox rows

| M | What | Row | Depends on |
|---|---|---|---|
| M0 | this packet, SCN-092 to SCN-096 | B-158 | none |
| M1 | the app holds several servers, each with its context; `FABRIC_CONTEXT` on the server and in `/api/server`; attach an account to an organization (D7) | B-158 | M0 |
| M2 | sign-in with an attestation (D5) | B-159 | SOT-B5 |
| M3 | people from the attestation and the directory grant; issue addresses; a leaver loses access at once | B-158 | M1, M2, O-3 |
| M4 | levels per person and mailbox (D6) | B-160 | M3 |
| M5 | delegated calls | B-83 | Fabric's delegation issuer (2026-11-21) |
| M6 | residency (B-157, done in 0.62.0), the organization's server in Fabric Dashboards, update policy (Q10) | B-157, B-193 | M1 |
| M7 | the first organization walked end to end with receipts | B-158 | M1 to M6 |

## What is not part of this

- A multi-tenant server (D1).
- Inbox holding organizations or people the organization service does not know (D3).
- Keys in the organization service: credentials stay in the server's secret store (SOT-04).
