# Usage analytics

**State:** built 2026-10-05 on the operator's request
([#27](https://github.com/passioncode-ai/fabric-inbox/issues/27)); first shipped in 0.10.0. Only
the disk image built by the release workflow sends anything. Source:
[`desktop/analytics.cjs`](../desktop/analytics.cjs), tests:
[`tests/desktop-analytics.test.ts`](../tests/desktop-analytics.test.ts).

Fabric Inbox counts installs, days of use and how many accounts, mailboxes, agents and agent keys
a server has, so PassionCode.ai can see how its apps are used, and so one person using several
PassionCode apps (Fabric Switchboard, Fabric, Fabric Inbox) counts once. Events go to the
organization's self-hosted Aptabase at `https://analytics.sshlg.me` (`ssheleg/sshlg-analytics`,
its `docs/client-contract.md`). The approach is the one Switchboard shipped first (its
`docs/ANALYTICS.md`); the organization's shared answer is roadmap track RM-13.

## What is sent

Every event carries the app version, the OS name and version, the locale, the Electron version, an
SDK tag (`fabric-inbox-analytics@1`), an Aptabase session id and `props.install_id`, the shared
installation id below. Nothing else identifies the Mac or the person.

| Event | When | Props (besides `install_id`) |
|---|---|---|
| `app_installed` | the first start of this app on this Mac (once; kept in `<userData>/analytics-state.json`) | `first_passioncode_app` (no PassionCode app had run here before), `server_configured` |
| `app_started` | every start | `launch`: `ordinary`, or `link` when a `fabric-inbox://connect` link opened the app |
| `app_updated` | the first start of a new version (an automatic update or a manual one) | `from`: the version this app last started as |
| `app_active` | once per UTC day, when the app starts or its window comes forward | `server` (whether counts were read); with a signed-in server: `gmail`, `cloudflare` (mailboxes), `agents`, `agent_keys` — counts only |
| `account_added` / `account_removed` | the day's counts differ from the last ones | `provider` (`gmail`, `cloudflare`), `added` or `removed`, `accounts` (total after) |
| `server_connected` | a server address is saved | `method`: `created` (Create my server), `entered`, `setup_file` |
| `hub_connected` | a local hub was allowed through a connect link | none |

The counts come from four reads with the mail window's own session, once a day and only while the
person is signed in: `/api/accounts`, `/api/v1/mailboxes`, `/api/agents`, `/api/agent-keys`. Only
the lengths of those lists leave the function that reads them (`countsWith`).

**Never sent:** email addresses, names, domains, the server's address, account or key ids, agent
names, message content or metadata, file paths, tokens, errors from the server. The test
*events carry counts and the installation id, never a planted address, domain, name or key*
answers those reads with planted strings and fails if any of them reaches the synthetic server.

The first counts this app reads are a baseline and are not reported as added. Turning the switch
on again starts a new baseline, so nothing done while it was off is reported later.

## The shared installation id

All PassionCode apps share one file:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/PassionCode/installation.json` |

```json
{ "version": 1, "id": "<random UUID v4>", "analytics": true, "created_at": 1791165882 }
```

- **Created once** by whichever app starts first: written to a temporary file and hard-linked into
  place, which fails if another app created it at the same moment; that file is then read instead
  (*two apps creating the file at the same moment end with one id*).
- **Never repaired.** A file that does not parse, or whose `id` is not a UUID, is left as it is and
  analytics stays off (*a broken installation file is never repaired*).
- **Unknown fields are kept** when this app rewrites it.
- **`analytics: false` turns analytics off for every PassionCode app on the Mac.** The app menu's
  **Fabric Inbox → Share Anonymous Usage Counts** writes it; turning it off also drops events
  still waiting. **About Usage Counts…** in the same menu says what is sent.

## Delivery

- Batches of at most 25 to `POST /api/v0/events` with the `App-Key` header, through Electron's
  network stack. A send never blocks the window or a mail operation.
- Transport errors, `429` and `5xx` keep the batch; the next try waits 60 s, then 10 min. `400` and
  `404` drop it. At most 200 events wait in memory; anything older than 23 hours is dropped (the
  server refuses events older than a day). Nothing but the small state file is written to disk.
- **No timer** (lifecycle LC-08): sends happen when something is tracked, and a retry when the
  window comes forward after its wait is over. With no window open nothing is sent.
- Each send is one `analytics_flush` line on stdout with its outcome and event count.

## Which builds send

`desktop/analytics.json` (`{"appKey": …, "host": …, "debug": …}`) is written by
[`desktop/dist-mac.mjs`](../desktop/dist-mac.mjs) into the app it builds, from the environment
variables `FABRIC_INBOX_ANALYTICS_APP_KEY` and `FABRIC_INBOX_ANALYTICS_HOST` (an https origin; the
build refuses a key without one), and the receipt says `analytics: App Key bundled` (never the
value). The source names no analytics host: the server's domain is also a deployment domain, which
`tests/no-owner-data.test.ts` keeps out of everything that ships. Only the release workflow's
`macos` job sets the two variables, from the `release` environment's variable
`FABRIC_INBOX_ANALYTICS_HOST` (`https://analytics.sshlg.me`) and its secret
`FABRIC_INBOX_ANALYTICS_APP_KEY`, which holds the App Key of the Aptabase app *Fabric Inbox*
(`XnZ1VzR5qEmaf7KF1nkUVU`; vault `sshlg-analytics/prod/APTABASE_APP_KEY_FABRIC_INBOX`, found with
`observatory_credentials sshlg-analytics`). The file is git-ignored, and the builder refuses a
commit that contains it.

Source builds, forks, `npm run desktop`, a local `npm run desktop:dmg` without the variable and the
tests send nothing, and the menu shows the switch as unavailable. A key set by hand outside GitHub
Actions marks every event `isDebug: true`, so it lands under `<appId>_DEBUG`.

**The Mac App Store package carries no key** (`desktop/mas-package.mjs` never reads it). A
sandboxed app cannot reach the shared file outside its container, and sending usage data from the
store build needs the App Privacy answers in App Store Connect first; both are open on the board
(B-49).

## Reading the numbers

The Aptabase dashboard at `analytics.sshlg.me` (app *Fabric Inbox*). From a checkout of
`sshlg-analytics`: `scripts/stats.sh 7 "Fabric Inbox"` prints release and debug counts separately.
The client was checked against the live server on 2026-10-05: one start sent through
`desktop/analytics.cjs` with a debug key was stored as 2 debug events in 1 session
(`stats.sh 1 "Fabric Inbox"`). Cross-app questions (one `install_id` across apps) go through
ClickHouse, which `sshlg-growth` queries; registering the app there is growth's task.
