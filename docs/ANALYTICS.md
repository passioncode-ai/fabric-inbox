# Usage analytics

**State:** built 2026-10-05 on the operator's request
([#27](https://github.com/passioncode-ai/fabric-inbox/issues/27)); first shipped in 0.10.0. Only
the disk image built by the release workflow sends anything. Source:
[`desktop/analytics.cjs`](../desktop/analytics.cjs), tests:
[`tests/desktop-analytics.test.ts`](../tests/desktop-analytics.test.ts).

Fabric Inbox counts starts, days of use, installs and how many accounts, mailboxes, agents and agent keys
a server has, so PassionCode.ai can see how its apps are used, and so one person using several
PassionCode apps (Fabric Switchboard, Fabric, Fabric Inbox) counts once. Events go to the
organization's self-hosted Aptabase at `https://analytics.owner.example` (`the analytics server`,
its `docs/client-contract.md`). The approach is the one Switchboard shipped first (its
`docs/ANALYTICS.md`); the organization's shared answer is roadmap track RM-13.

## On by default, off per product (B-200)

Since 0.87.0 (B-200; operator decision 2026-11-04, relayed by Fabric's session: anonymous usage and error data
on by default, for installs already out too, a notice at the first launch, off in the product's settings, per
product) the details go out from the first launch:

- **Details, on by default.** The shared installation id (`install_id`, `iid`) on every event, `app_installed`,
  `app_updated`, the server's counts on `app_active`, `account_added`, `account_removed` and `app_error` (a crash
  the app noticed: the main process's uncaught exception, watched with `uncaughtExceptionMonitor` so its default
  handling stays, or a renderer or helper process gone with a reason other than a clean exit; `where` and a
  `code` only, once per launch for each).
- **The notice.** The first time a window comes forward the app shows *Fabric Inbox shares anonymous usage and
  error data*, with what is sent and how to turn it off, and OK or Turn Off. It is shown once
  (`disclosedAt` in `<userData>/analytics-state.json`), after any hub connect dialog.
- **Off, per product.** The menu's **Share Usage Details** (the app menu on a Mac, Help on Windows and Linux)
  turns the details off or on for Fabric Inbox only, kept as `declined` in `analytics-state.json`; the shared
  `installation.json` keeps only the shared id, and another app's `analytics: false` no longer turns this one
  off. Off drops every event still waiting, and nothing more is sent, the baseline with no id included.
- **An earlier no stays a no.** A person who turned the details off before 0.87.0 keeps them off: `declined`
  from 0.84.0 on, or, from an answer before 0.84.0, the shared switch that answer wrote (read once and kept as
  `declined`). Reading the operator's "on for installs already out" as the default, not as overriding an
  explicit choice; the coordinator recorded this reading in the wave plan (2026-11-04).
- **Off is off.** With the switch off nothing is sent at all, the B-198 baseline included: the reading growth wrote
  into the consent contract on 2026-11-04 (board thread `b2e5df1f`, message `cbea0b76`). The baseline with no id
  (`app_started`, `app_active`, the connect events; nothing written on the Mac for them) remains only for a
  shared file that cannot be read, while the switch is on.

Tests: `B-200: …`, `B-198`'s in `tests/desktop-analytics.test.ts`.

## What is sent

Every event carries the app version, the OS name and version, the locale, the Electron version, an
SDK tag (`fabric-inbox-analytics@1`), an Aptabase session id and `props.environment`: `production`
for a release build, `sandbox` for a debug key or a pre-release version. With the details on, it also
carries `props.install_id`, the shared installation id below, repeated as `props.iid`. a growth agent
counts installs by `iid` and keeps only those two environments (operator decision 2026-10-05;
Switchboard did the same in fabric-switchboard#75). Nothing else identifies the Mac or the person.

This table is the app's event catalogue: a name keeps its meaning, a new meaning gets a new name, and a
retired event stays listed with its date.

| Event | Tier | When | Props (besides `environment`, and `install_id`/`iid` with the details on) |
|---|---|---|---|
| `app_started` | baseline | every start; a start whose install waits for the yes is not sent again after it | `launch`: `ordinary`, or `link` when a `fabric-inbox://connect` link opened the app |
| `app_active` | baseline | once per UTC day, when the app starts or its window comes forward (without the details: once per day of each launch, kept in memory) | `server` (with the details: whether counts were read, and `gmail`, `cloudflare` (mailboxes), `agents`, `agent_keys`, counts only; without them: whether a server window is open, no counts) |
| `server_connected` | baseline | a server address is saved | `method`: `created` (Create my server), `entered`, `setup_file` |
| `hub_connected` | baseline | a local hub was allowed through a connect link | none |
| `app_installed` | details | the first start of this app on this Mac with the details on (once; kept in `<userData>/analytics-state.json`) | `first_passioncode_app` (no PassionCode app had run here before: this app made the shared file, at launch or at the yes), `server_configured` |
| `app_updated` | details | the first start of a new version (an automatic update or a manual one) | `from`: the version this app last started as |
| `account_added` / `account_removed` | details | the day's counts differ from the last ones | `provider` (`gmail`, `cloudflare`), `added` or `removed`, `accounts` (total after) |
| `app_error` | details | a crash the app noticed, once per launch for each `where` and `code` (B-200) | `where`: `main`, `renderer` or the helper's type; `code`: the error's code or name, or the process's reason, letters, digits, `_.-` only |

The counts come from four reads with the mail window's own session, once a day, only with the details
on and only while the person is signed in: `/api/accounts`, `/api/v1/mailboxes`, `/api/agents`, `/api/agent-keys`. Only
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
- **`analytics: false` no longer turns Fabric Inbox off** (B-200: the switch is per product). Fabric Inbox
  writes nothing to it since 0.87.0, and reads it only once to keep an answer from before 0.84.0.
  **About Usage Counts…** in the menu says what is sent.

## Delivery

- Batches of at most 25 to `POST /api/v0/events` with the `App-Key` header, through Node's `fetch`
  in the main process (since 0.12). Chromium's network stack, used before, waits for the cookie key
  from the Keychain, so a pending Keychain prompt held every count back (seen on the owner's Mac with
  0.11.0). A send never blocks the window or a mail operation.
- Transport errors, `429` and `5xx` keep the batch; the next try waits 60 s, then 10 min. `400` and
  `404` drop it. At most 200 events wait in memory; anything older than 23 hours is dropped (the
  server refuses events older than a day). Nothing but the small state file is written to disk, and that only with the details on.
- **No timer** (lifecycle LC-08): sends happen when something is tracked, and a retry when the
  window comes forward after its wait is over. With no window open nothing is sent.
- A shared file that cannot be read stops the details only; the baseline with no id goes on.
- Each send is one `analytics_flush` line on stdout with its outcome and event count.

## Which builds send

`desktop/analytics.json` (`{"appKey": …, "host": …, "debug": …}`) is written by
[`desktop/dist-mac.mjs`](../desktop/dist-mac.mjs) into the app it builds, from the environment
variables `FABRIC_INBOX_ANALYTICS_APP_KEY` and `FABRIC_INBOX_ANALYTICS_HOST` (an https origin; the
build refuses a key without one), and the receipt says `analytics: App Key bundled` (never the
value). The source names no analytics host: the server's domain is also a deployment domain, which
`tests/no-owner-data.test.ts` keeps out of everything that ships. Only the release workflow's
`macos` job sets the two variables, from the `release` environment's variable
`FABRIC_INBOX_ANALYTICS_HOST` (`https://analytics.owner.example`) and its secret
`FABRIC_INBOX_ANALYTICS_APP_KEY`, which holds the App Key of the Aptabase app *Fabric Inbox*
(`XnZ1VzR5qEmaf7KF1nkUVU`; vault `the analytics vault slot APTABASE_APP_KEY_FABRIC_INBOX`, found with
`observatory_credentials the analytics server`). The file is git-ignored, and the builder refuses a
commit that contains it.

Source builds, forks, `npm run desktop`, a local `npm run desktop:dmg` without the variable and the
tests send nothing, and the menu shows the switch as unavailable. A key set by hand outside GitHub
Actions marks every event `isDebug: true`, so it lands under `<appId>_DEBUG`.

**The Mac App Store package carries no key** (`desktop/mas-package.mjs` never reads it). A
sandboxed app cannot reach the shared file outside its container, and sending usage data from the
store build needs the App Privacy answers in App Store Connect first; both are open on the board
(B-49).

## Reading the numbers

The Aptabase dashboard at `analytics.owner.example` (app *Fabric Inbox*). From a checkout of
`the analytics server`: `scripts/stats.sh 7 "Fabric Inbox"` prints release and debug counts separately.
The client was checked against the live server on 2026-10-05: one start sent through
`desktop/analytics.cjs` with a debug key was stored as 2 debug events in 1 session
(`stats.sh 1 "Fabric Inbox"`). Cross-app questions (one `install_id` across apps) go through
ClickHouse, which `a growth agent` queries; registering the app there is growth's task.
