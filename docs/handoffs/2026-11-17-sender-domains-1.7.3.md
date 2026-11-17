# Handoff 2026-11-17: B-288, the sender's domains looked up, 1.7.3

Previous: [2026-11-15 B-246 cut-over, 1.7.1 and 1.7.2](2026-11-15-grants-cutover-1.7.1.md).

## Objective

The operator, 2026-11-17, over a forged-sender enquiry whose replies went to a stranger's domain: «надо еще уметь
ходить на домен и проверить домен отправителя и найти инфу если есть подозрение что может быть фишинг или вирус».

## Done

| What | Evidence |
|---|---|
| B-288: the Okolos panel looks up the sender's domains (RDAP, DNS, the site's main page); signals only raise the colour | [plan](../ux/plans/2026-11-17-sender-domains.md); PR #584 squash `a589c999`; `tests/safety-domains.test.ts` (18), `tests/safety-domains-panel.test.ts` (2), the two S03c cases of `tests/safety-workerd.test.ts`; gate `npm test` 2339 pass, typecheck, build, UX lint, `check_private` 0; copy checks of the new strings in en-US and ru-RU with no blocking finding |
| Live read of the operator's case | `rdap.org` answered 403 to a request with no User-Agent (fixed: a named User-Agent, then IANA's bootstrap); the Reply-To domain read as registered 2026-04 at Dynadot, mail at Zoho, no DMARC, a site titled with a car maker's name |
| Blind seam review, two rounds | Round 1: two blockers (a lookup's answer landing on another open message; the arrival write dropping the lookup), fixed with tests in `e70f296d`; round 2: pass |
| Okolos asked to add investment-scam brands to its watchlist | board thread `ea245852` (the brand-in-title signal fires once they are there) |
| 1.7.3 | PR #585 squash `8846d1b4`; CI on the PR green on every platform; deployed with `GRANTS_DECIDE=on` from a clean checkout of `8846d1b4`: versions `b189f4b7`, `f1a9cd29`, `a13aacae`, receipts `linked`, the Workers' vars read back `FABRIC_SERVER_VERSION=1.7.3`, `GRANTS_DECIDE=on` on all three (the owner's first upload failed on the network and was run again); tag `v1.7.3`, run 44017842034 success (signing, store package, update checks), published 2026-11-17 04:57 UTC with 20 assets |
| Proving call in production | On the owner's server over `/mcp`: `get_server` answers 1.7.3, `tools/list` 167 tools with `look_up_sender_domains`; the tool on the operator's message found the Reply-To domain registered 2026-04-26 at its registrar, mail hosts, SPF, no DMARC, and its site's title; no signal fired (older than 30 days, the brand not yet on the watchlist) |

## Open

- B-288's remaining risks are on its board row: one daily counter per server a member can spend with `refresh`; a
  redirect to the server's own `*.workers.dev` host is still requested; a site that is down is never cached; the two
  S03c workerd cases failed twice in 23 local runs under machine load.
- **Every deploy must pass `--var GRANTS_DECIDE:on`** (unchanged from the previous entry).

## Exact next task

1. After 2026-11-20: B-258, read one day of each server's logs as its row says.
2. When Okolos answers on thread `ea245852`: re-vendor its watchlist (`vendor/okolos/core-lookalike/watchlist.ts`,
   pinned in `vendor/okolos/manifest.json`).
3. Then by priority from the board: B-224, the rest of B-221.
