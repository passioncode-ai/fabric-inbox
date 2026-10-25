---
report:
  id: fabric-inbox/2026-10-25-consolidation
  title: "Consolidation audit and plan: debts, fixes, first organization, backlog"
  kind: audit
  project: fabric-inbox
  domains: [planning, release, organization, backlog]
  as_of: 2026-10-25
  status: active
  valid_until: 2026-11-25
  summary: >-
    One place for everything open in Fabric Inbox at 0.33.5. Branches, worktrees and the
    project board were cleaned (every branch was a merged pull request). The 154 task rows
    (146 B rows, 8 P/L/W rows) leave 33 not done, of which about ten are done in substance and
    only need their receipt. The remaining work splits into register fixes, five code fixes
    before an organization sees the product, the first-organization rollout (never deployed
    into an organization's account yet; blocked on two outside dependencies and a legal
    check), peer asks from the board, and a later backlog. Fourteen questions decide the
    rollout; the operator answered seven on 2026-10-25 (section 8), which turned the
    first-organization rollout into multi-organization support in Inbox.
  sources:
    - name: "Task board (B rows)"
      path: "docs/evidence/backlog.md"
      read_at: 2026-10-25
    - name: "Local backlog (P6, L, W rows)"
      path: "docs/backlog.md"
      read_at: 2026-10-25
    - name: "Current handoff"
      path: "docs/app-store/README.md"
      read_at: 2026-10-25
    - name: "Organization mode packet"
      path: "docs/app-store/tasks/2026-10-23-organization-mode.md"
      read_at: 2026-10-25
    - name: "Organization runbook"
      path: "docs/desktop-mail/setup.md"
      read_at: 2026-10-25
    - name: "Fabric project board, 276 messages 2026-10-19 to 2026-10-25"
      url: "fabric-project-comms/0.1 com.list"
      read_at: 2026-10-25
    - name: "PassionCode.ai knowledge base (roadmap, principles, lifecycle, platforms, licensing)"
      url: "https://wiki.passioncode.ai/knowledge"
      read_at: 2026-10-25
  produced_by:
    agent: "fabric-inbox coding agent (Claude Code)"
    task: "consolidation audit 2026-10-25"
  supersedes: []
  consumers: [fabric-inbox]
---

# Consolidation audit and plan (2026-10-25, release 0.33.5)

The operator asked for one place that holds what other sessions did, what is on the board, what
is owed, what sits in worktrees and branches; finished work removed; unfinished work gathered;
every task sorted into priority fixes, a product plan for the first organization, and the
backlog; then a grilling on what is missing. This page is that place. The task registers stay
canonical (`docs/evidence/backlog.md`, `docs/backlog.md`); this page links rows, it does not
copy their status.

## 1. What was cleaned today

| What | Found | Done | Evidence |
|---|---|---|---|
| Remote branches | 39, all ahead of `main` by ancestry | deleted | each head equals the head of a merged pull request (`gh pr list --state merged --json headRefName,headRefOid`, 0 mismatches); squash merges explain the ancestry |
| Local branches | 3 (`aq-handoff-0230`, two `agent/*`) | deleted | same check; local heads equal the remote heads |
| Worktrees | 2 (`_worktrees/fabric-inbox-aq` at a merged commit, a detached `fabric-inbox-winlinux` at `94cb4b1`, merged) | removed | `git status` showed only ignored build output; no process had a working directory there (`lsof`) |
| Stale lease refs | 2 local `refs/remotes/leases/*` from 2026-10-04 (TTL 2700 s) | deleted | `git ls-remote origin 'refs/agent-sync/*'` lists no live lease |
| Stash | none | | `git stash list` |
| Open pull requests | none | | `gh pr list --state open` |
| Fabric task "stop the agent console on Windows without a second app, then release" | in backlog | moved to review | shipped in 0.33.5 (B-102, PR #262) |
| Project board | 276 unread | read and marked | digest in section 5 |

Kept on purpose: the `upstream` remote (the Cloudflare template this project was imported from)
and the tag `archive/release-0.10.0-receipts`.

After cleaning, the repository has one branch, `main`, and no other worktree.

## 2. Health

- **Code and release:** 15 releases (0.30.3 to 0.33.5) in about 27 hours, all green from the
  download (GPG, sums, attestation, notarization, `check-installed-app.mjs`). Of the last 60 CI
  runs, one failure, on a pull request branch, fixed before merge. Nothing is red.
- **Server:** the owner's server runs 0.33.5 with 111 tools and is registered as a Fabric service.
- **Audit collector** (`project-audit`, 8 probes): secrets in tree and history, worktree,
  telemetry, CI, docs, gitignore all clean. One finding: tag `v0.33.5` and `main` differ in
  `docs/app-store/README.md` and `docs/evidence/backlog.md`. That is the handoff written after the
  release; no shipped file differs. Verdict: accepted limitation (handoffs land after their
  release), no action.
- **Not proven live:** organization deploy into another account, identity provider sign-in
  against a real provider, Gmail, Outlook and IMAP with real accounts, the relay between
  Cloudflare accounts.

## 3. The registers in numbers

154 rows: 121 done, 33 not done (16 open, 10 blocked, 2 in review, 1 with an invalid status,
4 open P/L rows). Of the 33:

- **Done in substance, need a receipt or a status fix (group A below):** B-85, B-116, B-66, B-70,
  B-65 text, B-108, L2, B-109, B-82.
- **Waiting on a person:** B-19, B-39, B-55, B-56, B-57, B-49, B-106, B-48, B-87 part 6.
- **Waiting on another project:** B-83 and B-87 part 3 (Fabric's delegation issuer), B-20
  (Fabric memory search), B-08 (Fabric registry under a grant), B-151 (contract CT-103), L6
  (a Fabric ADR).
- **Free to do now:** B-153, B-72, B-143, B-54, B-78, B-58, B-31, B-37, L3, L5.

## 4. Inconsistencies found

1. `docs/app-store/README.md` carries a dozen "Exact next task" lines; DOCMAP promises one. The
   current one is at line 194 (B-153, then B-72); line 242 (B-131) reads as current and is not.
2. The handoff still says no signed store package exists and a release waits for an approver;
   both stopped being true (store upload since 0.11.0; approval by a person retired 2026-10-11).
3. The handoff's requirements table lists IMAP, Outlook and notifications as missing; all shipped.
4. Human step 4 (purge private history) is still listed; the operator decided on 2026-10-13 not
   to rewrite history.
5. Human step 2 (the `MEMBERS_READ_TOKEN` secret) has no board row.
6. B-87's status says "in review" and "can start" at once; B-70 uses "merged", not a board status.
7. GitHub issues #181 and #26 are open while their rows are done.
8. The Russian copy pass's next task (a native reader, 10 missing terms) has no row.
9. P6 is "open" while its parts (B-55, B-56, B-57) are blocked on a person.
10. CI runs on every push and pull request, while the machine rule says hosted suites run nightly;
    the release guard depends on it, and the exception is not written down.
11. `docs/architecture.md:620` still says "there is no per-mailbox authorization"; B-149 made it
    false.
12. Outside this repository: the roadmap's RM-16 and RM-25 rows, `products.md` (names 0.33.3)
    and the org-index row (`depends_on: []`) are stale for Inbox.

## 5. What the board asks of Inbox

One formal request and six threads wait for an answer from Inbox. Thread ids are board ids.

| Ask | From | Deadline | Our answer today |
|---|---|---|---|
| Request `e1b2cc69`, `contract.adopt` DEC-0121: every button the app or a dashboard offers is an agent tool, and the operator's decision relayed in chat counts as the operator's act; pin after the adapter (CT-124) and the hub (CT-125) land | the contract project | 2026-11-21 | none; it conflicts with 11 entries of `NOT_TOOLS` (`workers/mcp/tools.ts:1746`), among them members, agent keys and the server update. The operator's own rule of 2026-10-24 says the same as DEC-0121 |
| R-43 finding, thread `8b49a35f`: a send that failed after dispatch looks like a refusal before dispatch, so a client may send a customer the same reply twice | a peer support client | none | none |
| Thread `c9a3cf06`: usage and cost per agent run | the same peer | none | none |
| Thread `50c55f3e`: who owns the mail quality daily once it moves to `/1` | the same peer | none | partly B-151 |
| Thread `90b33987`: publish mailbox knowledge changes as `knowledge.learned` and keep the data agent's grant on three mailboxes | a peer support agent | none | none |
| Thread `e68f363c`: emit `answer.cited` and `support.diagnosed` in the flat 2.10.1 shape | the same peer agent | none | B-153 covers the rest of the thread, not these two events |
| Thread `b8342c09`: may a single-mailbox Read key also read that address's agent runs and events | a peer bot | none | none |

Rules from announcements that now bind Inbox: agent pages open only in Fabric Dashboards
(2026-10-24); text on Fabric surfaces is in the interface language, Russian (2026-10-22); usage
reports carry `unmeasuredCalls` and mark subscription rows as estimates (DEC-0091).

## 6. The plan

### Group A. Register fixes (bookkeeping, no code)

One pull request, under the agent-sync lease on both registers:

- close with receipts: B-85, B-66 (duplicate of B-78's fix), B-70 (done, released 0.15.1), L2
  (built by B-01 and the IMAP sync, `docs/architecture.md:260`); fix B-65's text;
- B-116: attach the FI-7 receipt from live answers since 2026-10-15, then close;
- B-109 and B-82: close as "no defect found" and "not reproduced", reopen on new evidence;
- B-87: split into its parts so each has one status (see group C);
- add rows: human step 2, the Russian copy pass, the Access members group, every peer ask of
  section 5, the doc drift of section 4;
- handoff: keep one "Exact next task", remove stale statements (items 1 to 4 of section 4);
- `docs/architecture.md:620`: per-mailbox authorization exists for members (B-149);
- close GitHub issues #181 and #26 with their rows' receipts;
- write down the CI exception (every push runs `ci` because the release guard needs it) or bring
  CI in line with the nightly rule; this is question Q13.

### Group B. Priority fixes (code, before an organization sees the product)

| # | Fix | Why first | Source |
|---|---|---|---|
| B1 | A send that failed after dispatch says `outcome: unknown` (or a `phase`), never the same answer as a refusal before dispatch | a customer can get the same reply twice | R-43, thread `8b49a35f` |
| B2 | Adopt DEC-0121: tools for the members list, agent keys and the other buttons now in `NOT_TOOLS`, each act behind the owner approval B-38 already ships, so an agent can remove a leaver when the operator says so | the operator's rule of 2026-10-24 and the contract's request; a leaver keeps access today until a person clicks | request `e1b2cc69`; `workers/mcp/tools.ts:1746` |
| B3 | A durable audit record of people changes and of what members send | an organization asks "who changed what" on day one; today only log lines without who or whom | `workers/routes/members.ts:61,74` |
| B4 | Create my server takes an R2 jurisdiction (EU) | the runbook promises residency the deploy cannot set | `docs/desktop-mail/setup.md:433`; `desktop/cloudflare-deploy.cjs` |
| B5 | Access policy gets a members group beside administrators | B-149 gave members a role, Access still admits only the administrators' group | organization-mode packet |
| B6 | B-72: judge spam scoring and the AI panel checked on the deployed server | user-facing AI never verified live | `docs/evidence/backlog.md:96` |

### Group C. Organizations in Inbox (product plan)

Revised on 2026-10-25 by the operator's answers (section 8): Inbox does not grow a one-off
"organization deploy"; it supports **many organizations** the way every PassionCode.ai product
does. The organization model is the shared one (its sources are being collected; the design
packet cites them and Inbox follows them, it does not define its own). The first organization is
one already served by the existing server: its Cloudflare account is connected there as another
account (`deployments/` inventory: one server, three other accounts, 22 domains, 36 mailboxes).

The target flow, in the operator's words condensed: a person installs Inbox; activates an
organization in it; attaches one or several accounts (Cloudflare, providers) to that
organization; an administrator, a person or an administrator's agent, issues work addresses;
each person signs in to Inbox with their work address, which is added to the organization and
bound to their workplace as its primary address. One app holds a person's private space and
every organization they belong to.

| M | Milestone | Exit check | Depends on |
|---|---|---|---|
| M0 | Design packet | `docs/app-store/tasks/<date>-organizations.md`: entities and ids aligned with the shared organization model (person, organization, account, workplace, member, role, agent); scenarios in `docs/ux/scenarios.md` first | the shared model's sources |
| M1 | Organizations as objects | create and activate an organization; attach one or several Cloudflare accounts and provider accounts to it; today's "other accounts" become accounts of an organization, the owner's private space stays separate; migration of the existing server's data without loss | M0 |
| M2 | Inbox's own sign-in | a person signs in with a work address and no third-party identity provider (design choice in M0: invitation link, then a passkey or a one-time code; a code cannot go only to the address being activated, since its mailbox is not readable before sign-in); Google Workspace group as an option an administrator turns on | M0 |
| M3 | People and workplaces | an administrator (or an agent with owner approval, B2) issues addresses, adds and removes people; the address is bound to a workplace as primary; people changes and member sends audited (B3); a leaver loses access at once | M1, M2 |
| M4 | Access levels | per person and per mailbox: read; read and send; configure agents; administer. A member may have their own signature, their own Gmail, Outlook and IMAP accounts, their own agents and the console, each as the level allows | M3 |
| M5 | Delegated calls | B-83 accepted (required by the operator): calls by other members' agents carry the delegation chain | Fabric's delegation issuer |
| M6 | Operations | residency (B4), the organization's server in Fabric Dashboards, update policy for its Macs (Q10), an error log read after each deploy | M1 |
| M7 | Acceptance | the first organization walked end to end with receipts: activate, attach its account, issue addresses, people sign in, mail flows, agents answer, a leaver is removed | M1 to M6 |

The release that carries groups A, B and C is one integrated release (working name 0.40,
"organizations"): every branch merged into `main`, one changelog entry, one handoff, every
scenario it touches walked. That release is the project we integrate.

### Group D. Peer asks (after group B)

`knowledge.learned` events and the data agent's grant (thread `90b33987`); `answer.cited` and
`support.diagnosed` (thread `e68f363c`); usage per agent run (thread `c9a3cf06`); quality daily
ownership with B-151 (thread `50c55f3e`); agent runs for a single-mailbox key (thread
`b8342c09`). Each becomes a row with the thread's id and is answered on its thread with that id.

### Group E. Backlog (after the organization release)

B-153 (tier 5 of the learning loop), B-58 (push for Outlook and IMAP), B-31 (always-spam for
Gmail), B-37 (OAuth for header-less clients), L3 (cheap-model triage), L5 (bulk group actions),
B-143 (early relaunch after quit), B-54 (README screenshot), B-78 (a load flake), B-48 and B-49
(Mac App Store: Intel, usage counts), B-106 (macOS permissions for the console), App Review
submission. Waiting on others: B-20, B-08, B-151, L6, B-39.

## 7. Questions for the operator (grilling)

Each has a recommended default; the plan proceeds on the default until answered.

| Q | Question | Recommended default | Changes |
|---|---|---|---|
| Q1 | Which server does Acme start on: its own Cloudflare account, or the owner's server where Acme's support address already runs? | its own account; move Acme's addresses, agents and history there | M1, size of the migration |
| Q2 | What do Acme's people do: sign in to Inbox as members, or only receive forwards from work addresses? | both: role and support addresses on the server, members sign in for their own work addresses | M3, B5 |
| Q3 | Before the legal check, are personal mailboxes allowed? Which jurisdiction does the check cover? | no personal mailboxes until the check; role and support addresses only | M4 |
| Q4 | Does the pilot need delegated calls (B-83), or do Inbox's own keys suffice? | own keys for the pilot; B-83 when Fabric ships the issuer | M5, the critical path |
| Q5 | Residency: EU jurisdiction for Acme's storage, and which data class? | EU, the data class Acme declares | B4 |
| Q6 | Who owns membership: the identity provider group, the organization-edition project, or Inbox's People list? | the identity provider group; Inbox follows it | M3 |
| Q7 | Which identity provider, and who sets it up in Acme's Zero Trust? Is a 30-day session acceptable? | Google Workspace; the agent prepares it, Acme's administrator consents | M2 |
| Q8 | A custom domain for the server, or `workers.dev`? | a custom domain on Acme's zone | M1 |
| Q9 | Model credential: an OpenRouter key (whose account pays) or Workers AI in Acme's account (no checker runs then)? | an OpenRouter key in Acme's account; never send unchecked answers | M5 |
| Q10 | Updates on Acme's Macs: self-update every 5 minutes as today, or an administrator's version lock first? | self-update for the pilot; the lock in the backlog | M6 |
| Q11 | May a member use agents and the console on their own mailboxes, with their own signature and provider accounts? | not in the pilot; own signature yes | M3 |
| Q12 | Is an audit of people changes and member sends required, and where does it live? | yes, in Inbox (B3) | B3 |
| Q13 | CI: keep running `ci` on every push (the release guard depends on it) as a written exception, or move to nightly? | keep it and write the exception down | group A |
| Q14 | Licence and billing for Inbox in Acme's own cloud: AGPL as is, or a commercial licence; billed per member? | commercial licence, per member per month, agreed with Acme | M7 |

## 8. Decisions (operator, 2026-10-25)

| Q | Decision | Consequence |
|---|---|---|
| Q1 | Inbox supports many organizations: create and add organizations, attach one or several accounts to each, separated from the start, consistent with every PassionCode.ai product | group C rewritten as organizations in Inbox; the first organization is the one already served by the existing server |
| Q2 | People sign in as members | M2 to M4 |
| Q3 | The legal assessment (B-87 part 6) is done | personal mailboxes allowed; B-87 part 6 closes with the operator's statement as its receipt, the assessment's place and jurisdiction to be linked |
| Q4 | B-83 is required | M5 is on the critical path; the plan depends on Fabric's delegation issuer |
| Q6, Q7 | Inbox's own sign-in with work addresses, no dependency on a third party; a Google Workspace group connection as an option to turn on | M2 |
| Q11 | A member may have their own signature, their own provider accounts, their own agents and the console; levels: read, read and send, configure agents, administer, granted per person | M4 |
| DEC-0121 | Adopted: every button is an agent tool; acts that change people, keys or the server go through the owner approval B-38 ships | B2; answer request `e1b2cc69` with the row id |

Still open, proceeding on the defaults of section 7: Q5 (residency), Q8 (custom domain),
Q9 (model credential), Q10 (update policy), Q12 (audit location: Inbox), Q13 (CI exception),
Q14 (commercial terms; not needed while the first organization is the operator's own).

### Release train "Organization R1" (fabric-workspace, 2026-10-25)

The organization's integration is coordinated from one page
([knowledge/integration.md](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/integration.md)).
Inbox's part is in iteration I2: the first organization is the platform's own, then an internal
pilot organization. Rows filed on 2026-10-25 (`d60fd3e`): B-168 (their N-8, the support address
and its agent) and B-169 (their N-9, the deploy into the organization's account with a receipt),
both before wave W1 (earliest 2026-11-14); B-83 waits for Fabric's issuer (target 2026-11-21) and
gates wave W2 (end of November). Legal questions are handled by the organization's lawyers outside
the software; this backlog carries no legal row (operator, 2026-10-25). Inbox reported on board
thread `5f2358e3` and agreed to the coordination; the open point with the organization service
(sign-in without a required identity provider, several accounts per organization) is asked on
thread `1a429d8e`.

## 9. Next

1. Answers to section 7 (or the defaults) are written into the organization-mode packet.
2. Group A lands as one pull request.
3. Group B by its order, each through `task-pipeline`; group C starts with its design packet (M0).
4. The handoff's "Exact next task" is B-155, then B-154, then B-169 and B-168 before wave W1.
