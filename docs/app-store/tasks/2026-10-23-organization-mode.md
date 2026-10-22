# Organization mode: B-87 parts 1, 2 and 5 (2026-10-23)

Board row: B-87 in [docs/evidence/backlog.md](../../evidence/backlog.md). Contract: fabric-agent-contract
DEC-0061 (`335e736`), contained in the schemas this repository vendors at `4a29fcb`
(`tests/fixtures/fabric-contract/`; `git merge-base --is-ancestor 335e736 4a29fcb` exits 0).

## Objective

An organization runs Fabric Inbox in its own Cloudflare account, its administrators sign in through
the organization's Access group, and its Fabric shows the server as a remote service offered to
others, with the kind of credential its model calls use.

## Facts the design rests on

| Fact | Where |
|---|---|
| The reply agents' writer, fallback and checker run on OpenRouter when the server has `OPENROUTER_API_KEY`, else on Workers AI under the deployment's account; the injection scan is Workers AI either way | `workers/agents/deps.ts:89-99` |
| Every person Access lets in is the owner, at level `admin` | `workers/mcp/keys.ts:103-104` (`principalFor`) |
| Create my server makes one Access application with one `allow` policy for one email | `desktop/cloudflare-deploy.cjs` (step 5, `include`) |
| The usage report's rows already carry `route`: `platform-metered` for Workers AI, `key` for OpenRouter | `workers/routes/fabric-service.ts` (`providerOf`) |
| A descriptor with `peer` must carry `runner`, never `subscription`; `peer` is `endpoint`, `custody`, `residency`, `maxDataClass` | `tests/fixtures/fabric-contract/service-descriptor.schema.json` |
| The well-known document is closed, with `extensions` keyed by URI; `configuration.resolved.route` admits only `subscription` and `key` | `tests/fixtures/fabric-contract/service-well-known.schema.json` |

## Decisions

1. **Part 5, the runner.** The descriptor carries `runner: {credentialKind}`: `key` with an OpenRouter
   key, else `platform-metered`; no `kind`, since Inbox is not a shared runner kind. The server states
   it in its well-known document under the extension `https://passioncode.ai/fabric-inbox/runner`
   (`runnerOf`): `configuration.resolved.route` cannot say `platform-metered`, and the person's
   computer cannot know which credential the server holds. `register-fabric-service.mjs` reads it with
   the key it registers (`readWellKnown`, the one `Authorization` header, never a query string). A
   server before 0.29.2 names none and its descriptor stays as before; such a server cannot be offered.
   The `degraded` sentence for a missing OpenRouter key said agents "cannot write answers"; they write on
   Workers AI, unchecked (`deps.ts:90-91`), and the sentence now says so.
2. **Part 5, the offer.** `--offer --custody --residency --max-data-class` adds `peer` with
   `endpoint: <origin>/mcp` (others call the MCP surface with keys of their own). Custody, residency and
   the class are the organization's statements, checked for shape only (`peerFor`: the contract's enums,
   upper-case ISO 3166-1 codes with `EU`, the user-assigned codes refused). Residency is where the
   organization keeps the server's storage; Workers run on Cloudflare's network everywhere.
3. **Part 2, the IdP group, for administrators only.** `deploy({ accessGroup })` and
   `onboard.mjs server --access-group <id>` make the Access application's one policy, `Administrators`,
   include `{ group: { id } }` instead of an email; the group is read first (`GET access/groups/<id>`), so
   a missing one is refused before an application exists. Because every signed-in person is the owner
   (`principalFor`), the group must hold the server's administrators, never all members: letting
   ordinary members in needs per-person roles first (new row B-149). An existing application keeps its
   policies, as before. The desktop's Create my server screen gains nothing: an organization deploys
   from the agent route, and an in-app login through an external identity provider is B-02.
4. **Part 1, the runbook and receipt.** No new code: Create my server already deploys into any account
   the token reaches, and `npm run deploy:receipt` already links the deployment to its commit. The
   runbook is `docs/desktop-mail/setup.md` → For an organization; the receipt stays with the
   organization's own records, never in this public repository.

## Not in this unit

Part 3 (delegated calls) waits on B-83; part 6 is a legal decision for a person; per-person roles are
B-149. A live deploy into an organization's account needs that organization's token and group, which
no account here holds.

## Checks

`tests/fabric-service.test.ts` (B-87 part 5: the descriptor validates with `runner` and `peer`; the
refusals; the header), `tests/desktop-deploy.test.ts` (B-87 part 2: the `Administrators` policy with
the group; an unknown or malformed group refused before an application is made), and the gate.
