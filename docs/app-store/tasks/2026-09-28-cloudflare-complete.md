# Cloudflare, complete — 2026-09-28

Request (2026-09-28, paraphrased): finish the owner's current Cloudflare
domains so receiving, updating and sending work perfectly; check the interfaces, design and UX;
make the first run of a new user clean — no owner files — so that anyone installing the app
connects their own Cloudflare, manages all their domains and creates new addresses from it.

## Done in this run (owner's domains)

- All 19 domains of the owner's Cloudflare account route to `fabric-inbox`; each address keeps
  forwarding a copy to its old Gmail (the rollback record is kept with the owner's deployment
  record, outside the repository; see [deployments](../../../deployments/README.md)).
- Email Sending on all 19 (Cloudflare adds `cf-bounce` MX/SPF/DKIM; a monitoring-only DMARC
  `p=none` was added where none existed; two domains kept their own).
- The owner's personal Gmail address added as an Email Routing destination: the Worker's forward was
  refused ("destination address not verified") until it was one.
- Receive: 17 test messages, one per domain incl. catch-alls, all stored in the right mailbox, no
  forwarding failure. Send: a message from the app (from one of the owner's addresses) left
  through Cloudflare and came back into the catch-all of another of the owner's domains.
- Regression found in the real app and fixed: `frame-ancestors 'none'` blanked every message body.

## Done in this run (product, 0.3.0)

| REQ | Result | Evidence |
|---|---|---|
| CF-1 | Sidebar grouped by domain, unread per address, domain and total; a whole domain selectable; selection kept in view | `tests/inbox-integration.test.ts`, `tests/inbox-ui.test.ts`; installed app via CDP (19 domains, counts visible, `?domain=<an owner domain>` → 2 messages) |
| CF-2 | Domains & addresses: zones, receive a domain (MX confirmation), bring addresses in with copies, rules to the Worker, sending + DMARC, release, add/remove address, catch-all, destinations | `tests/domains.test.ts` (9, stateful fake Cloudflare; MX test seen failing with the check removed) |
| CF-3 | `CLOUDFLARE_API_TOKEN` secret (old name still read); without it the screen lists the 11 permissions and where to save it; refusals name the permission; an invalid token is told apart | `tests/domains.test.ts`, `tests/desktop-deploy.test.ts` (lists equal); live 403/9109 probe |
| CF-4 | Generic `wrangler.jsonc` (`keep_vars`), owner files in `deployments/owner/` | `tests/no-owner-data.test.ts`; owner Worker's three vars unchanged after a deploy (API read) |
| CF-5 | Create/update the server from the app | `tests/desktop-deploy.test.ts` (8); live: asset hashes, upload + update of a throwaway Worker (deleted), Access app body (deleted) |
| CF-6 | Docs: setup guide, architecture, README, SCN-030..033, SCR-01/SCR-09, brand terms and strings | `python3 docs/ux/lint.py`, `python3 docs/brand/lint.py` (0 errors) |

Found and fixed on the way: both Cloudflare clients called a bare stored `fetch` (workerd
"Illegal invocation" — every routing check with a token would have read unknown); a 403 with
its own code was read as a permission problem; 782d1a2 was committed with one test failing
(the gate read grep's exit code; fixed in 85868c9, gates now read the suite's).

## Release 0.3.0 (2026-09-28)

| Image | Receipt | sha256 |
|---|---|---|
| `Fabric-Inbox-0.3.0.dmg` (public: no setup, no owner identifier — scanned in `app.asar`) | notarized, stapled, Gatekeeper accepted, server bundle 0.3.0 | `d2ea6d4d6afd9378639551e4c1756635f32772a948bc8ff1d0c4aa4cf9c5c0d3` |
| `Fabric-Inbox-0.3.0-owner.dmg` (installed in /Applications) | notarized, stapled, Gatekeeper accepted, setup `owner` | `13a0e8194795c93ec9d68ae662b8409fa6d50df9739b8296ac21498ecef3d6c8` |

Server 0.3.0 deployed (version `03d9f518`). The installed app loads it with 19 domains in the
sidebar; its debug port is closed. Two build interruptions, both outside the code: the notary
keychain profile vanished between builds (restored with `--keychain`, README), and files vanished
from the system temp directory mid-build (the builder now keeps its temp in `release/.build-tmp`).

## 2026-09-29: the owner's token through a credential tool

The token was not created by hand: the owner's own credential tool, which holds an admin token for
the Cloudflare account and lives outside this repository, gained a preset `fabric-inbox-server` and
a delivery mode — mint with the 11 groups by API name and level, check the new token with its own
rights, put it into the Worker's `CLOUDFLARE_API_TOKEN` by one PUT, keep only a record (no value).
Issued 2026-09-28 22:2x UTC (the tool's record), sees 54 zones.

Checked through the installed app: connected, 54 zones, 19 served; a served domain shows routing
ready, its rule to the Worker, sending on, DMARC, no problem; an unserved domain shows Namecheap's
five MX hosts; 3 of 3 destinations confirmed; routing 36/36 verified after one fix — a disabled
literal rule was read as "sends somewhere else" while the catch-all delivered here (a `contact@`
address on two of the owner's domains). Also corrected: Email Sending is an account-level permission, not
zone.

## Open

- A full first run on a brand-new Cloudflare account (Zero Trust org, R2 bucket and workers.dev
  name created by the app) has not been observed.

## Requirements (frozen; adding is free)

| REQ | Requirement | Verified by |
|---|---|---|
| CF-1 | The sidebar groups addresses by domain with unread counts; a whole domain can be selected | inbox tests; real app |
| CF-2 | Domains & addresses: every zone of the connected Cloudflare account with its Email Routing, sending and routing-to-this-server state; serve a domain, enable routing, import its addresses, move them here with their forwarding copy, create and remove addresses, catch-all, enable sending — from the app | route tests with Cloudflare fakes; owner server |
| CF-3 | The server holds a Cloudflare API token as a secret; without one the screen says what to create and where | route tests |
| CF-4 | Nothing of the owner ships: generic `wrangler.jsonc`; the owner's deployment values, setup and receipts live in `deployments/owner/` | test over tracked files |
| CF-5 | New user, from the installed app: connect Cloudflare with a token → choose an account → the app creates the server (Worker, storage, Access sign-in) → the server opens on its domains | desktop tests with API fakes; a clean account run when available |
| CF-6 | Docs, scenarios, code notes and the disk image updated in the same change | lints, link check, receipt |

## Order

CF-1 → CF-2/CF-3 → CF-4 → CF-5 → CF-6, each committed and deployed when green.
