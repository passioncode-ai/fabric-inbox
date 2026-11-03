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

## Two tiers: counts with no id, and details after a yes

Since 0.84.0 (B-198; operator decision 2026-11-03, relayed on the board: counts without consent by
default, consent adds the details, so funnels always have data) the app follows the analytics server's
client contract, "Two tiers" (decision D-1):

- **Baseline, no consent needed.** `app_started`, `app_active` and the connect events go out from the
  first launch, before the question is answered and after a no. They carry `environment` and their
  own props, no `iid` or `install_id`, no counts of the server, and nothing is written on the Mac for
  them: the session number and the day already counted live in memory only, so a restart on the same
  day counts that day again. The analytics server counts them without an id (growth's `anonymous`,
  the daily visitor hash).
- **Details, after a yes.** The shared installation id (`install_id`, `iid`) on every event,
  `app_installed`, `app_updated`, the server's counts on `app_active`, `account_added` and
  `account_removed`. The shared file is made, and `analytics-state.json` written, only after the yes.

The first time a window comes forward the app asks: *Share usage details?* with what is always counted,
what the details add, *No usage details have been sent yet.*, the switch (on) and Continue, or Not now
(asked again at the next launch). The menu's Share Usage Details is the other way to answer. The answer
is kept per app as `disclosedAt` in `<userData>/analytics-state.json` with `declined` for a no (another
PassionCode app's answer does not answer for this one; the shared switch in `installation.json` stays
the one on/off for the details, and a no before any app made that file makes none). A start that waited
counts the install after the yes, without counting the start twice; an install that sent its id before
A7-012 is asked once, told so, and is not counted as a new install; an unreadable state file asks again
rather than sending an id. The question waits while a hub's connect dialog (Allow or Deny) is open and
is asked after it. The box comes ticked because the shared switch is on by default (ADR-0127 keeps that
default; the person sees it and answers before any id is sent). Every event carries the system it runs
on (`osName`: macOS, Windows or Linux). Tests: `A7-012 and B-198: …`, `A7-012: …` and `review
2026-10-21: …` in `tests/desktop-analytics.test.ts`.

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
- **`analytics: false` turns the details off for every PassionCode app on the Mac.** The app menu's
  **Fabric Inbox → Share Usage Details** writes it; turning it off also drops events still waiting
  with the id, and the counts with no id go on. **About Usage Counts…** in the same menu says what is
  sent in each tier.

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
