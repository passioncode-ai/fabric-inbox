# Several Cloudflare accounts — 2026-09-30

Operator request (from Russian): "I have other Cloudflare accounts, but only my personal one was
pulled in; let me choose which accounts to pull from. Also, I tried to turn on a domain and it
failed: `<domain> — Receive mail here — Not done — Turn on Email Routing. Cloudflare: Invalid
Input: must be a subdomains of <domain>`." Follow-up, same day: "every account there is must be
visible by default where it has mail; the ones that are missing are connected from the connection
window."

Run: `task-pipeline`, branch `agent/cloudflare-accounts`. This brief is the entry point.

## What was there (stage 0 harvest)

| Source | What it says about this task |
|---|---|
| `workers/routing/cloudflare-api.ts` | one token (`CLOUDFLARE_API_TOKEN`); `accountIdFor` refuses when the token sees several accounts and `CLOUDFLARE_ACCOUNT_ID` is unset |
| `workers/routing/domains.ts (DomainManager)` | zones listed with `/zones?status=active` — only what the one token sees; rules point at one Worker name (`EMAIL_ROUTING_WORKER`, default `fabric-inbox`); enabling routing POSTs `{name: <apex>}` |
| The owner's deployment (local, git-ignored `deployments/owner/`) | the owner's server token was issued by the Observatory door for **one** account |
| The Observatory door (`tools/cloudflare.py`) | mints **account-owned** tokens (`/accounts/{id}/tokens`); the owner's stash reaches three accounts: the server's and two others |
| The owner's Cloudflare inventory (local) | domains with mail exist in the other two accounts |
| Cloudflare OpenAPI (read 2026-09-30) | `POST /zones/{z}/email/routing/dns` body `{name}` is optional (nullable); a rule's `worker` action names a script only, so it resolves in the zone's own account; `POST /accounts/{a}/email/sending/send` sends for an account over REST; `GET /accounts/{a}/email/routing/rules?enabled=true` lists an account's rules in one call; `PUT/DELETE /accounts/{a}/workers/scripts/{s}/secrets` changes one secret by creating a new version; Access service tokens take `duration: "forever"` |
| `docs/ux/scenarios.md` | SCN-031…033 on SCR-09 assume "the connected Cloudflare account" (singular) |
| `docs/evidence/retro.md` | binding here: 5 (read every Miniflare body), 7 (gate = suite exit code), 8 (route ⇒ tool + docs + skill); recent log: test an external API's refusal with the body it sends; a fake of an external store holds a value the code does not know |
| Board | 31 open rows; none covers several accounts |
| Wiki / code graph | projects wiki has no page on this; no `graphify-out/` in this repository |

## Decisions

| Question | Answer | By |
|---|---|---|
| How mail for a domain in another account reaches the server | **A relay Worker** (`fabric-inbox-relay`) installed by the server in that account; it hands the raw message to the server over an Access service token and applies the answer (store / refuse / forward a copy) | operator, 2026-09-30 |
| Which accounts show by default | **Every account the server has a token for and that has mail** (an enabled routing rule, or a domain served here); an account without mail is listed and can be shown with one switch; the operator's choice is kept | operator, 2026-09-30 |
| An account no token can see | **Connected from the connection window**: paste a token for it; the server keeps it as its own Worker secret `CLOUDFLARE_API_TOKEN_<account id>` | operator, 2026-09-30 |
| One token for several accounts, or one per account | One per account, because the door's tokens are account-owned. A user token that sees several accounts also works: every account it sees is available | follows from the door (stage 0) |
| Where extra tokens live | Worker secrets set by the server through the Cloudflare API with its own token (Workers Scripts: Edit on its account); never R2, never a log. Removing an account deletes the secret | run, recorded as ADR below |
| Sending from a domain in another account | That account's Email Sending REST API (`/accounts/{a}/email/sending/send`) with that account's token; domains in the server's account keep the `send_email` binding | run |
| The apex error | `POST …/email/routing/dns` without a body; `name` is for subdomains only | Cloudflare's own answer, 2026-09-30 |
| Token re-issue for the owner | All three accounts: a door preset per extra account, delivered into the server Worker as `CLOUDFLARE_API_TOKEN_<id>` | operator, 2026-09-30 ("все аккаунты что есть") |
| Release | Server deploy plus the full release (0.8.0: image, notarization, install, tag, skill) | run default; the operator's reply did not pick one |

### ADR — extra Cloudflare tokens are Worker secrets named by account

A token pasted in the app is verified (it must see the account it is saved for), then written with
`PUT /accounts/{server}/workers/scripts/{script}/secrets` as `CLOUDFLARE_API_TOKEN_<account id>`.
The server finds its tokens by scanning its environment for that name, so there is no second
registry to drift from what Cloudflare holds, and an app update (`keep_bindings` includes
`secret_text`) keeps them. The cost: a new secret is a new Worker version; the request after the
save may still run the old one, so the connection window reads the account list again until the
account appears (bounded, with the reason shown if it does not).

## Requirements (frozen; adding is free)

| REQ | Requirement | Verified by |
|---|---|---|
| MA-1 | Turning on Email Routing on a zone's own domain sends no `name`; Cloudflare's "must be a subdomains" answer is reproduced by the fake and passes | `tests/domains.test.ts`; live on the domain that failed |
| MA-2 | The server's accounts are the union of what each token sees (primary + every `CLOUDFLARE_API_TOKEN_<id>`), each with its name, whether it is the server's, which token reaches it, and whether it has mail | `tests/cloudflare-accounts.test.ts` |
| MA-3 | By default an account is shown when it has mail; the operator can show or hide any account and the choice is kept; hiding an account with a domain served here is refused with the reason | `tests/cloudflare-accounts.test.ts` |
| MA-4 | Domains & addresses lists the domains of every shown account, each with its account; a domain's detail, connect, release, catch-all, addresses and destinations use that account's token | `tests/cloudflare-accounts.test.ts`, `tests/domains.test.ts` |
| MA-5 | Connect another account: a pasted token is verified, saved as a Worker secret for each account it sees that has no token yet, never echoed or logged; Remove deletes the secret and is refused while one of its domains is served here | `tests/cloudflare-accounts.test.ts` |
| MA-6 | Receive mail here on a domain in another account installs the relay there first (script, Access service token, registry), then points the rules at the relay; again changes nothing | `tests/cloudflare-relay.test.ts` |
| MA-7 | The relay delivers through `/relay/incoming`: only a registered relay's service token is accepted, only for domains of its own account; the answer is stored / duplicate / refused (with the reason, which the relay turns into a bounce) / forward a copy (reported back with `/relay/forwarded`); a server that cannot be reached makes the relay throw so Cloudflare retries | `tests/cloudflare-relay.test.ts` (server side and the relay script in workerd) |
| MA-8 | Mail sent from an address on a domain in another account goes through that account's Email Sending REST API; failure outcomes keep the outbox's accepted / failed / unknown meaning | `tests/cloudflare-relay.test.ts` |
| MA-9 | Stop receiving here on a domain in another account sends its rules back as for any domain; the relay stays for the account's other domains | `tests/cloudflare-relay.test.ts` |
| MA-10 | Every new route has its agent tool (or an exclusion with its reason), `docs/agents/mcp.md` is regenerated and the skill names the workflow | `tests/mcp-coverage.test.ts`, `mcp-docs`, `mcp-skill` |
| MA-11 | SCR-09 shows an Accounts section (name, has mail, shown, how it is reached, relay) and a Connect another account window; strings pass the brand lint; UX scenarios and screens describe it | `python3 docs/ux/lint.py`, `docs/brand/lint.py`; the installed app |
| MA-12 | The door issues a token for an extra account and delivers it into the server Worker as `CLOUDFLARE_API_TOKEN_<id>` | project-observatory test; live `cloudflare.py list` |
| MA-13 | Live: the owner's server sees all three accounts, the domain that failed receives here, and one domain in another account receives a real message through the relay | receipt in the owner's local `deployments/owner/ops/`, summarised here without identifiers |


## Design and contracts (stages 2–3)

Modules, walking skeleton first (M1 → M2 give the operator the list; M3 → M4 carry mail):

| Module | Files | Contract |
|---|---|---|
| M1 Accounts | `workers/routing/accounts.ts` (new) | `tokensOf(env)`: the primary token (`CLOUDFLARE_API_TOKEN`, then the pre-0.3 name) and every `CLOUDFLARE_API_TOKEN_<32 hex>`; `CloudflareAccounts.list()`: `GET /accounts` per token, an account-named token winning over the primary; `serverAccountId()`: `CLOUDFLARE_ACCOUNT_ID`, else the only account, else the account whose Workers hold the server's script; `apiFor(account)`; `zone(domain)`: the zone and its account from the first token that sees it, remembered in R2 `config/domain-accounts.json`; `workerFor(account)`: the server's script in its own account, `fabric-inbox-relay` elsewhere. `hasMail(account)`: `GET /accounts/{a}/email/routing/rules?enabled=true` returns a rule, or a domain of the account is served here; a read that fails counts as having mail (showing is harmless) and is reported |
| M1 Visibility | R2 `config/cloudflare-accounts.json` `{ choices: { <id>: "shown" \| "hidden" } }` | shown = the operator's choice, else the server's account, else has mail; hiding an account with a served domain → 409 with the domains named |
| M1 Connect | `POST /api/cloudflare/accounts` `{ token }`, `DELETE /api/cloudflare/accounts/:id` | the token is checked (`GET /accounts` with it; it must see at least one account); for each account it sees that has no token of its own it is written with `PUT /accounts/{server}/workers/scripts/{script}/secrets` `{ name: CLOUDFLARE_API_TOKEN_<id>, type: secret_text }`; the answer names the accounts and never contains the token; Remove refuses the server's account and an account with a served domain, deletes the relay (script, service token, registry row) if there is one, then the secret |
| M2 Domains | `workers/routing/domains.ts`, `workers/routes/domains.ts`, `workers/routing/email-routing.ts`, `workers/lib/address-ops.ts` | `/api/domains` → `{ accounts: [{ id, name, server, shown, hasMail, via: "server token" \| "own token", relay }], domains: [{ …, account: { id, name } }] }` over shown accounts; every per-domain call resolves the zone's account and uses its token and Worker name; destinations are per account (`GET/POST /api/domains/destinations?account=`), and a copy is checked against the destinations of the address's own account |
| M3 Relay | `workers/relay/script.ts` (the relay's source, a string), `workers/relay/install.ts`, `workers/relay/ingress.ts`, R2 `config/relays.json` | connect on a domain outside the server's account adds step `relay` before the rules: an Access service token (`duration: forever`, through the same reusable policy agent keys use), the script uploaded to that account with `SERVER_URL`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, the registry row; a failed upload revokes the new token. `POST /relay/incoming` (body = the raw message; `X-Fabric-Envelope-From`, `X-Fabric-Envelope-To`): Access admits service tokens there; the caller's `common_name` must be a registered relay and the recipient's domain must be in that relay's account, else 403; answers `{ outcome: "stored" \| "duplicate" \| "rejected", reject?, forwardTo?, mailboxId?, emailId? }`; a copy owed is not settled until `POST /relay/forwarded` `{ mailboxId, emailId, target, ok, error? }` |
| M4 Sending | `workers/email-sender.ts`, `workers/durableObject/index.ts` | the From domain's account decides: the server's → the `send_email` binding; another → `POST /accounts/{a}/email/sending/send` with that account's token; an HTTP 4xx answer is `E_REST_REFUSED` (a pre-acceptance refusal, outcome failed); 5xx, timeout or an unreadable answer stays unknown and is never retried |
| M5 Screen | `app/routes/project-addresses.tsx`, `app/components/domains/Accounts.tsx` (new), `ConnectCloudflare.tsx`, `DomainCard.tsx`, `Destinations.tsx` | an Accounts section: each account with mail / no mail, Shown switch, how it is reached, relay installed; Connect another account (paste a token, the permissions for an extra account); each domain row names its account |
| M6 Agent protocol | `workers/mcp/tools.ts`, `docs/agents/mcp.md`, `plugins/fabric-inbox/` | `list_cloudflare_accounts`, `show_cloudflare_account`, `connect_cloudflare_account`, `remove_cloudflare_account` (admin; remove is two-step); `/relay/*` excluded (machine ingress with its own identity) |
| M7 Door | The Observatory door (`tools/cloudflare.py`) | mints **account-owned** tokens (`/accounts/{id}/tokens`); the owner's stash reaches three accounts: the server's and two others |

Failure behaviour, stated once: a token that cannot be read is listed with its problem and its
accounts are not guessed; an account whose domains cannot be listed shows the reason and the other
accounts still list; a relay install that fails stops connect at the `relay` step with what was
done, and running it again continues; the relay never drops a message on a server error (it
throws, as the server's own email handler does, so the platform records a failure rather than a
delivery).

Permissions for an extra account's token (the server's own token keeps the full list):
Account — Workers Scripts: Edit (the relay), Account Settings: Read, Email Routing Addresses: Edit,
Email Sending: Edit; Zone — Zone: Read, Email Routing Rules: Edit, Zone Settings: Edit, DNS: Edit.

## Built, released and checked (2026-09-30)

Code: the 0.8.0 tree, `a9f9516` in the public history (landed before the republication as two squashed PRs of the private history; the second adds the account-level rules permission).
Door: passioncode-ai/project-observatory-dashboard#93 (presets `fabric-inbox-server` and
`fabric-inbox-account` into a vault slot; open, used from its branch).

| REQ | Evidence | State |
|---|---|---|
| MA-1 | `tests/domains.test.ts` and `tests/cloudflare-accounts.test.ts` ("Email Routing is turned on … without a name"): the fake answers Cloudflare's own `1004 must be a subdomains` to a `name`; both failed before the fix (watched), pass after | tested; live click not observed |
| MA-2 | `tests/cloudflare-accounts.test.ts` (three tokens, three accounts, names, `via`, `server`); live: each of the owner's three tokens probed with its own rights (`/accounts` → its one account) | tested; live tokens probed |
| MA-3 | same file ("showing and hiding is kept …"); planted defect "every account shown" caught | tested |
| MA-4 | `tests/cloudflare-relay.test.ts` (detail, routing status, destinations of the domain's account); `tests/domains.test.ts` 18/18 unchanged | tested |
| MA-5 | `tests/cloudflare-accounts.test.ts` (connect: checked, saved per new account, the server's skipped, never echoed; remove: secret deleted, refused while served, refused for the server's account) | tested |
| MA-6 | `tests/cloudflare-relay.test.ts` (install: script, `forever` sign-in through the agents' policy, registry without secrets, rules to the relay; again: no write; a failed upload revokes the sign-in and moves no rule) | tested; not live |
| MA-7 | same file, the relay's own source in workerd behind an Access stand-in: stored once, copy settled by the report, a lost report leaves it owed, unknown address bounces, another account's domain 403 → the relay fails the delivery, an unreachable server fails it; planted defects on the account check and the deferred copy caught | tested; not live |
| MA-8 | same file: REST send for the other account; 400 → `E_REST_REFUSED` failed; 503 → unknown; planted defect caught | tested; not live |
| MA-9 | same file ("stopping a domain in another account …") | tested |
| MA-10 | `tests/mcp-coverage.test.ts`, `mcp-docs`, `mcp-skill` (7/7) | tested |
| MA-11 | `app/components/domains/Accounts.tsx`; UX lint and doctor exit 0; brand lint 0 errors; SCN-045, SCN-046 | built; not seen in the app |
| MA-12 | the door's tests (`test_cf_fabric_account_preset_…`, zone policy removal caught); live: three tokens issued and delivered | done, PR open |
| MA-13 | server `1d8af191` runs 0.8.0 with the three tokens; unauthenticated relay and API paths → Access login | partly: the screen, the failed domain and a relay delivery await the operator |

Gates on the 0.8.0 tree: `npm test` 431 pass / 0 fail (exit 0), `npm run typecheck` 0, `npm run build`
0, UX lint 0, doctor 0, brand lint 0 errors, `git diff --check` 0, relative links resolve.

**Not run, and why.** The owner's app window kept the page it had loaded before the deploy and
could not be driven from here (its web content takes no synthetic clicks), so the Domains screen,
**Receive mail here** on the domain that failed and a relay delivery on a real domain of another
account were not observed. Whether Cloudflare retries a message when an Email Worker throws was
not measured; the relay follows the server's own handler, which already relies on it.

Found live and fixed in the same run: the account-level rules list needs **Email Routing Account
Rules: Read** (403 with the zone-level group); added to both token lists and both door presets.

## Carry-over ledger (closed)

| Item | Status | Home |
|---|---|---|
| Which foreign domain is used for the live relay check | open — the operator picks it | board B-39 |
| The live Domains screen and the failed domain turned on | open — needs the operator's app | board B-39 |
