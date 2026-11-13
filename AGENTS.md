# Working in fabric-inbox

## Read first

1. The organization's
   [roadmap](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/roadmap.md) —
   every major feature and release across PassionCode.ai as `RM-*` tracks with owner, phase and
   state. It is the entry point: a task here that serves a track names it, and the track's status
   is edited only in the roadmap.
1a. **The course check, before every change** ([rules §0](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/rules.md#0-the-course-check-the-plan-and-the-north-star-before-every-change)):
   the [North Star](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/north-star.md) metric and
   gaps, and the [one plan in waves](https://github.com/passioncode-ai/fabric-workspace/blob/main/docs/plans/2026-11-11-unified/README.md).
   Name the track, plan row or gap the change serves; work that serves none goes to the board first.
2. The PassionCode.ai knowledge base — `fabric-workspace/knowledge/` in your clone (org-index
   `scripts/clone_all.sh` makes it) or https://wiki.passioncode.ai/knowledge — at least its
   [README](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/README.md),
   vision, principles and how-to-work (private; readable by every org member).
3. This file, then the organization's
   [CONTRIBUTING.md](https://github.com/passioncode-ai/.github/blob/main/CONTRIBUTING.md).

That guide holds the names, how a change lands, the code region markers and the security contact;
this file adds the rules of this repository and wins where the two differ.

## What this repository is

Fabric Inbox: a desktop mail client with cloud email automation and tool integrations, in
development preview. Fabric's mail tool; also works on its own. It shows one triaged list across
Gmail and Cloudflare mailboxes, and every domain of your Cloudflare account can be managed from
the app. Addresses are answered by versioned agents under a reply policy. The macOS app creates
its server in your own Cloudflare account. It began as Cloudflare's
[Agentic Inbox](https://github.com/cloudflare/agentic-inbox) template (Apache-2.0), imported in
`93b86c6`; what came from it and its notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Commands

| What | Command |
|---|---|
| Install | `npm ci` |
| Test (the gate) | `npm test && npm run typecheck` |
| Build | `npm run build` (disk image: `npm run desktop:dmg`; Windows/Linux: `npm run desktop:win` / `desktop:linux`) |
| MCP (register + proving call) | `npm run dev -- --port 5174 --host 127.0.0.1`, then `claude mcp add --transport http fabric-inbox-local http://127.0.0.1:5174/mcp` and call `list_accounts` (README → Quick start) |
| A person's real server, set up by the agent | `node scripts/onboard.mjs server` → the person signs in → `connect` (they Allow) → `register` → `prove` ([docs/agents/onboard.md](docs/agents/onboard.md)) |

All the checks, from `README.md` ("Run locally", "Develop and test"):

```sh
npm ci
npm test                 # all tests; Worker code runs in workerd (Miniflare), no network
npm run typecheck        # Wrangler and React Router types, then tsc -b
npm run build
python3 docs/ux/lint.py && python3 docs/ux/doctor.py   # UX contract
python3 docs/brand/lint.py                             # brand strings (warnings are advisory)
npm run mcp:docs                                       # the agent protocol's tool reference
```

`npm run dev` serves the Worker and app on `http://localhost:5173` with local Miniflare bindings.
`npm run desktop` opens the desktop shell, and `npm run desktop:server-bundle` (run it once) gives
**Create my server** a server to upload. The checks above are the gate, run before you push;
`.github/workflows/ci.yml` runs them again on every pull request and on `main`. A documentation change also runs `git diff --check` and resolves every relative link
(see "Checks for documentation" in `docs/DOCMAP.md`).

## Local rules

### Where things live

- [docs/DOCMAP.md](docs/DOCMAP.md) gives one home per question. It separates current documents
  from history, and history is not to be followed as instructions.
- The next task is in [docs/app-store/README.md](docs/app-store/README.md) ("Exact next task").
  The P6/L/W status authority is [docs/backlog.md](docs/backlog.md); the roadmap preserves packet descriptions.
- How it works: [docs/architecture.md](docs/architecture.md), the architecture as built.
  Configuration and deployment order are in [docs/desktop-mail/setup.md](docs/desktop-mail/setup.md).
- UX scenarios, flows and screens are in [docs/ux/](docs/ux/scenarios.md), and the brand pack is
  in [docs/brand/](docs/brand/README.md).
- The open board is [docs/evidence/backlog.md](docs/evidence/backlog.md). Lessons are in
  [docs/evidence/retro.md](docs/evidence/retro.md).
- Code: `app/` is the React Router UI, `workers/app.ts` is the Worker entry (`wrangler.jsonc`),
  `desktop/` is the Electron shell, and `shared/` and `tests/` hold shared code and tests.

### Rules in this repository

- **Only add, only improve (R28)** (operator, 2026-11-11, relayed by the agent template database, board request
  `b72b3d85`). What the app shipped is never changed or deleted: the agent templates and prompts in
  `workers/agents/definition.ts` are locked by digest in `workers/agents/shipped.lock.json`
  (`tests/agents-add-only.test.ts` fails on a changed or missing one); a changed template ships beside the old one under
  a new name with its own lock line, and one leaves only by a `retired` mark with its date and reason in the lock. On a
  server, every save of a reply agent is a new immutable version and a deleted agent's versions stay readable
  (`workers/agents/registry.ts` `insertVersion`, `getAgent`). A change is accepted only with a test, an acceptance or a
  before/after measurement showing it is no worse (a reply agent's eval tickets run against each new version, B-199);
  a regression is rolled back first. Every change, by an agent or a person, gets its board row and a line in
  `CHANGELOG.md` with its reason and basis.
- **Every function of the app is an agent tool, in the same change** (operator, 2026-09-29). A new
  or changed route gets its tool in `workers/mcp/tools.ts` (or an exclusion with its reason in
  `NOT_TOOLS`), then `npm run mcp:docs` regenerates [docs/agents/mcp.md](docs/agents/mcp.md), and
  the skill in `plugins/fabric-inbox/` is updated when a workflow changes. `npm test` fails until
  all three agree (`tests/mcp-coverage.test.ts`, `tests/mcp-docs.test.ts`, `tests/mcp-skill.test.ts`).
  The plugin's version is the app's version; a release ships both.
- **Every word a person reads goes through the dictionary, in the same change** (operator, 2026-10-06;
  fabric-workspace knowledge/localization.md). Write English inside `t("…")` (React: `useT()`), counts
  with `t.plural`, server sentences with `msg("…", { value })` shown through `t.text()`, and add the
  Russian to its file in `shared/i18n/ru/` following `docs/brand/locales/ru.md` and the Russian terms in
  `docs/brand/terminology.md`. `node scripts/check-locale.mjs` (run by `npm test`) fails on a missing or
  mismatched entry and on an English literal left in JSX; `--write` refreshes the Mac app's copy
  (`desktop/locales/ru.json`). MCP tool texts, logs and code stay English.
- The local backlog is the P6/L/W status authority; the audit board owns B-series rows. The T, REQ and R tables in older packets are frozen
  (`docs/DOCMAP.md`).
- Signing and notarization keys stay outside Git (`README.md`, "Install on a Mac").
- A deployment's own files (`deployments/<name>/`: account, domains, addresses, ops receipts) are
  local and git-ignored; only `deployments/README.md` and `deployments/*.example.json` are
  committed, and `tests/no-owner-data.test.ts` fails otherwise. A personal build
  (`npm run desktop:dmg -- --setup <name>`) bundles the local `deployments/<name>/setup.json` and is
  for its owner only. The public build carries no one's setup or domains.
- **No private data in this public repository** (operator, 2026-10-13). Code, tests, docs, commit
  messages and PR text use neutral names: a client is `Acme`, the operator's domain `owner.example`,
  hosts `*.example` / `*.example.invalid`; never a client, the operator's own agents, private
  repositories, real addresses or home paths. Before every push org-index's
  `scripts/check_private.py .` must report 0 findings (this machine's `.git/hooks/pre-push` runs it
  with the operator's local term list). `.check-private-allow` lists only made-up fixtures; a private
  term (P1) can never be allowed — replace it. History is kept as it is (operator, 2026-10-13: no
  rewrite).
- Licence: `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial` for this project's own code
  (`README.md` → License). The code imported from Cloudflare's Agentic Inbox template stays
  Apache-2.0: never remove or reword a `Copyright (c) 2026 Cloudflare, Inc.` header, and keep
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) true when such a file is moved, split or deleted.
- **Shared registers are edited under a lease.** [docs/AGENT_SYNC.md](docs/AGENT_SYNC.md)
  (generated from `.claude/agent-sync.json` by `agent_sync.py setup`; never edited by hand) lists
  the guarded files and the gate. Run `agent_sync.py acquire <file>` before editing one and
  `agent_sync.py release <file>` after, on every path including failure. The lease is a ref under
  `refs/agent-sync/leases/` on `origin`, so another contributor's agent sees it
  (`git ls-remote origin 'refs/agent-sync/leases/*'`); the record plane is local (`fs`), and
  `.agent-sync/` is git-ignored. No register here carries a "Next free ID" line, so nothing is
  reserved yet; a register that gains one is declared under `idRegisters` and taken with
  `agent_sync.py reserve <REG>`.

## North Star, step 0, questions and sessions (operator, 2026-11-13)

Inbox's answers to fabric-workspace's board thread `16093ded`; the rules live in fabric-workspace `knowledge/`.

- **North Star sections served** ([north-star.md](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/north-star.md)):
  §2 Places (the Mac app on a person's own machine, the server in the organization's own Cloudflare account); §3 People:
  roles and access (owner, administrator, architect and employee levels, B-232, B-246); §4 Administration (the *Inbox*
  row: the organization's mailboxes and grants to members, B-158, B-215); §5 Agents (the support inbox: reply agents on
  addresses under a reply policy, B-199, B-256); §11 Security and isolation (one server per organization, attachment
  checks B-222); gaps G2 (levels, B-232), G3 (a leaving person's mailbox grants), G16 (support mailboxes still on the
  owner's personal accounts) and G31. When Inbox's state changes against them (a release, a gap closed or opened, a
  «where we stand» fact), write fabric-workspace a board message naming the section and the evidence.
- **The architect.** Before an agent template or a reply agent's shape is built or changed, consult the architect (skill
  `fabric-agents:fabric-agents`, or `python3 tools/audit.py consult "<need>"` in the agents database). At each release
  run `audit.py scan <checkout>` and keep the result in [docs/evidence/architect/](docs/evidence/architect/); the judged
  half writes into the base's repository, so it is asked of the base (G30). First scan, 2026-11-13 on `3d5fcf40`:
  `agent-host` 21.572, `support-answerer` 16.29 ([scan](docs/evidence/architect/2026-11-13-scan.json)); no judged
  verdict yet, so no blocking gap is named.
- **Step 0 before every change** (fabric-workspace `knowledge/rules.md` §0, North Star principle 12): the workstation
  first: `npx --yes sshlg-skills@latest update`, `npx @passioncode-ai/passioncode doctor` with no `fail`, the board
  (`com.status`), Dashboards, Switchboard and Observatory answering. Without them, no change. Every change goes through
  `task-pipeline` inside an Observatory workflow (a checkpoint after each step); a changed agent template, prompt or
  workflow is a new version beside the old one (R28 above). Keys come by name from Observatory's vault, per project
  where possible.
- **Agents close questions themselves, by access level** (fabric-workspace `knowledge/authority.md`). Decide by the
  access levels, the operator's recorded decisions, this project's goal, then the safest reversible option; write the
  decision and its reason where the work lives and go on. Trust comes from checks (the gate, readback, a second model
  for a choice), not from a person. Ask only at a human gate (a sign-in, a one-time code, a consent screen, a typed
  secret, a payment, spend above the limit, a send outside the estate, access wider than the act needs), once, naming
  it. A request on this project's board is answered here (`com.reply`) without waiting for a service responder. The coordinator's rule
  (announcement `35556d27`, 2026-11-13): an operator's decision relayed on the board with his words verbatim, the date,
  where he said it and its scope is his approval, acted on and cited, never asked again; a question left for a person
  goes only to `fabric_question_ask` or to Fabric's coordinator on the board, never stays in a chat's text; a run whose
  `fabric` MCP dropped says so in its summary.
- **Coding-agent sessions, SL-1 to SL-8** (fabric-workspace `knowledge/lifecycle.md`). Sessions on this repository are
  the operator's own and those Fabric starts for unread board messages (a workflow and handoff id, an Observatory
  checkpoint at least every 10 minutes, a final checkpoint that closes the workflow). The app's agent console (B-70,
  `desktop/console.cjs`) starts the person's `claude` or `codex` only on their command, logs `started`, `ended` and
  `leftovers` with codes, makes one agent key per session and revokes it on every end (a key a crash left, before the
  next start). What it does not do yet is row B-261.

## Lifecycle

How the product starts, idles, asks and stops, against the organization's
[lifecycle contract](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/lifecycle.md)
(LC-01…LC-15). The audit behind this section is `docs/reports/2026-10-03-lifecycle-audit/raw/fabric-inbox.md`
in fabric-workspace.

**Nothing runs on the Mac when the window is closed; the server does the work.** The desktop app has
no mail engine: Cloudflare-domain mail arrives at the Worker by push, Gmail is polled by the
server's Durable Object alarm (`GMAIL_POLL_SECONDS`, default 300 s), and agents run in the Worker.
Closing the window destroys it and its renderer; the app keeps running with no window (the Dock icon on macOS, a tray icon on Windows and Linux) and ends only by Quit or a signal (the organization's lifecycle rule of 2026-10-16). An installed copy opens at login: the first launch turns Open at Login on once, and after that only the person's choice changes it (`desktop/autostart.cjs`; macOS and Windows use the system's login item, Linux an entry in `$XDG_CONFIG_HOME/autostart`).

| What | Who starts it | Cadence | With no window | Who stops it | Idle budget |
|---|---|---|---|---|---|
| `Fabric Inbox` main process and its Chromium helpers (GPU, network, one renderer per open window) | the person (Dock, Finder) | — | main process only; its one update timer (below); the tray icon on Windows and Linux | the person (⌘Q, Dock, the tray's Quit); Electron's default handling of `SIGTERM`/logout | 1 request per 5 min, 1 timer |
| Mail window and its pages, one per server shown since it opened (`persist:fabric-<sha256(origin)[:24]>` each, B-244, `desktop/mail-views.cjs`), and their pollers (`refetchInterval` in `app/routes/`) | launch, Dock click, Retry; a server's page the first time it is shown | Automation 30 s (`app/lib/window-activity.ts`), others 15–60 s; all pause while the page is hidden (a server not shown is hidden), Automation also while the window is unfocused | nothing (destroyed with the window) | closing the window (every page); Forget Server (its page) | 0 requests while hidden |
| Agent-chat WebSocket | opening the Agent panel | one connection | — | closing the panel or window | 0 |
| Cloudflare API calls of **Create my server** | the person, in setup | one deploy, 60 s per call, ≤2 retries | — | the deploy's end; ⌘Q cuts it and a re-run resumes | 0 |
| Profile sweep (`desktop/profile.cjs`) | each launch, before any window | once | — | itself | — |
| Usage counts (`desktop/analytics.cjs`, [docs/ANALYTICS.md](docs/ANALYTICS.md)); only a release image that carries an App Key | launch; the window coming forward; a crash the app notices | the details with the shared id on by default from launch (B-200): `app_installed`, `app_started`, `app_updated`, `app_error` (once per launch for each crash code), and with `app_active` five count reads through the mail window's session, the fifth the server's error counts of the day before, sent as `server_error` events (B-203); a notice once when a window first comes forward (after any hub connect dialog), OK or Turn Off; with the switch off (per product) nothing at all; with an unreadable shared file the baseline with no id (`app_started`, `app_active` once a UTC day kept in memory, connects; B-198); a refused send retried at the next focus after 60 s, then 10 min | nothing (no timer) | ⌘Q drops what waits | 0 requests, 0 timers |
| Automatic updates (`desktop/updater.cjs`, `desktop/update-verify.cjs`, [docs/desktop-data-and-updates.md](docs/desktop-data-and-updates.md), LC-16); only a release image in /Applications | launch | one GET of the latest release's static `update-mac.json` 90 s after start, then every 5 min while the app runs (one unref'd timer; the organization's cadence, 2026-10-17), a failed check retried after 5 min too; the same answer or failure is logged once; a newer release's `SHA256SUMS` + `.asc` and zip are downloaded and verified (`ditto`, `codesign`, `plutil` run once each), then Squirrel.Mac's `ShipIt` installs it when the app quits (or on Restart to Install Update, or by clicking the «Restart to finish updating» notification shown once per ready version and again each day it waits, B-231); while it waits, `plutil` reads ShipIt's state file once per check and the feed is read for a newer release, which replaces it (B-231), and a staged update macOS purged runs `launchctl remove` once on ShipIt's job (B-51) | the same timer | the person (`auto-update` file = `off`, the app-menu switch) | 1 request per 5 min, 1 timer |
| New-mail notifications (`desktop/new-mail.cjs`, B-41); off until the person turns on Notify About New Mail in the app menu (the `new-mail-notifications` profile file = `on`) | launch, when on; the menu switch | one GET of the inbox's unread mail (`/api/inbox?folder=inbox&unread=1&limit=20`) per server the app holds, each through that server's own signed-in session (B-233 part 2), 60 s after start, then every 5 min (one unref'd timer); the first read of each server only learns what is there; a message is new when its Message-ID and row were not seen before (the last 500 kept), so mail that syncs late is announced and one email in two inboxes once, and a read still out when the switch goes off shows nothing; one system notification per new message (naming its server when the app holds several), one summary for more than 3 (which opens that server's inbox, or the inbox with All chosen when they are on several), none for the server the focused mail window shows; a click opens that message on its own server | the same timer | the person (the menu switch) | 0 when off; 1 request per server per 5 min, 1 timer when on |
| The server's update (`desktop/server-update.cjs`, B-44) | the person signing in (the mail window reaching the server) | once per launch and server: one GET of `/api/server` through the mail window's session; when the server is older than the app's own server and updates are automatic, one POST of the bundle (about 13 MB) to `/api/server/self-update`; otherwise the app menu's Update Server | nothing | itself | 0 |
| A `fabric-inbox://server` link (`desktop/server-link.cjs`, B-236) | an agent on this Mac opens it | per link, one at a time: a server already held is shown; a new one gets one Add Server/Deny dialog on a window brought forward, then is shown at its sign-in | the mail window opens to carry the dialog | the person's answer | 0 |
| A `fabric-inbox://connect` link (`desktop/connect.cjs`, ADR-0115) | a hub on this Mac opens the link; Launch Services starts the app if needed | per link, one at a time: one Allow/Deny dialog on a window brought forward (the Dock bounces until it is answered), with the listener looked up (`lsof`) every 3 s while it is open; the port's owner read once before the dialog and once on the open socket before the key is written (`netstat` and `ps`, or `lsof` of this account's own sockets when the table is restricted; B-217, `desktop/loopback-owner.cjs`); one key request to the server, one POST to the hub's loopback callback (10 s deadline) | the mail window opens to carry the dialog; a sign-in opens it too | the link's end; the dialog closes itself when the listener is gone (two missed looks) or after 2 min unanswered | 0 |
| Moving an address between two servers (`desktop/move.cjs`, `desktop/move.js`, B-158 M1 step 3d, SCN-094); only while the app holds two or more servers | the person (Account → Move an Address to Another Server…) | one move at a time, through each server's own signed-in session: rows and files copied 100 rows at a time, then the setup and labels, the counts checked, the sending copy held; while sends are still out, one GET every 5 s for at most 10 min; the test message checked every 5 s for at most 3 min; the state written to `move.json` in the profile after every step | the window may close: a running move goes on until its next stop, and the window continues it from `move.json` when opened again | its end (Done, Put It Back, Cancel before the hold), quitting the app | 0 when no move runs |
| The inbox's other servers (`desktop/all-servers.cjs` `readAll`, B-244 D-2, SCN-099); only while the app holds two or more servers and the mail window shows the inbox | the inbox page (its tabs and All) | one GET of `/api/inbox?folder=inbox&limit=50` per other server held, each through that server's own signed-in session, every 60 s while the window is active, none while it is hidden or unfocused | nothing (the page goes with its window) | closing the window | 0 while hidden |
| Rename Server (`desktop/rename-server.*`, B-244 D-4, SCN-099) | the person (Account → Rename Server) | none: the name is saved in `servers.json` on this Mac | nothing | closing its window | 0 |
| The agent console (`desktop/console.cjs`, B-70, SCN-078): the person's own `claude` or `codex` in a PTY (node-pty), not in the Mac App Store package | the person (View → Agent Console, ⌃⌘T / Ctrl+Shift+T, the inbox's console button) | one session at a time: one agent key made for it (`POST /api/agent-keys` through the signed-in session), the login shell's PATH read once (5 s at most) | the panel on the mail window's right (or a window, for an older server's page) shows it; hidden, the session runs on until stopped | Stop (hang-up to the process group, kill 2 s later), the agent exiting, or quitting the app (asked first while one runs); the key is revoked every way, and a key a crash left is revoked before the next session | 0 when no session runs |

The app owns **one login item (Open at Login, the person can turn it off), one more timer only while new-mail notifications are on, one watcher on its own profile folder for the switch files (B-236, `desktop/profile-watch.cjs`; no timer), no launchd label, no listening port, no long-lived child process but the agent console's own CLI while the person runs a session (Squirrel.Mac's `ShipIt` installs a downloaded update as the app quits; `ditto`, `codesign` and `plutil` run once while an update is verified), no
per-session server and no Keychain item read on a timer**. The agent protocol (`/mcp`) is served by
the Worker, not the Mac. Cookie encryption (an Electron fuse, `desktop/hardening.mjs`) creates one
Keychain item, "Fabric Inbox Safe Storage", on first launch; Chromium reads it in-process, and a
signed release must create it without a prompt (`docs/release.md`, upgrade check).

- **The lifecycle broker (LC-09).** On the operator's Mac the broker manages the app as `inbox.desktop`, `on_demand`,
  stopped after 15 minutes idle. Since 0.89.0 the app supports **`--background`** (fabric-workspace
  knowledge/lifecycle.md "Background launch", fabric-workspace#27): with a server set up it starts with no window
  and logs `background_launch`; the first activate (a Dock click, Cmd+Tab) or opening it again shows the mail
  window. A first run with no server still shows setup. The broker passes the flag only to a target enrolled with
  `backgroundLaunch: true`, which its owner sets. Checks: `tests/desktop-background.test.ts`, and the macOS job of
  `.github/workflows/platforms.yml` launches the built app with it (`scripts/smoke-desktop.mjs --background`).
- **Builds are hardened (LC-13, LC-07).** Every Mac builder applies `hardenTemplateHook` and gates on
  `verifyHardening`: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and
  `EnableNodeCliInspectArguments` off; `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`
  and `EnableCookieEncryption` on; no `NS*UsageDescription` key outside `DECLARED_USAGE_DESCRIPTIONS`
  (empty). The receipt records both.
- **Profile (LC-12).** The app holds several servers (B-158: a person's own and each organization's), listed
  in `servers.json` and in the Account menu; changing the server keeps the old one, signed in, for a switch back.
  **Forget Server** clears that server's storage and cache; its `Partitions/` directory stays under the live
  session until the next launch. Each launch removes the partitions of servers no longer listed and
  `server.json.*` / `servers.json.*` / `pending-setup.json.*` leftovers, **except when no server is known at
  all**: then every partition is kept, since it may be the server about to be entered again. The log is `~/Library/Logs/Fabric Inbox/fabric-inbox.log`, JSON lines with codes only, capped near
  2 MB (`desktop/log.cjs`), folded by the hour and the UTC day into `digests/` in the profile, counts by event and
  outcome only, an hour written when the next hour's first event comes and a closed day when it closes or at the next
  start, never by a timer (B-205, B-212, `desktop/ops-digest.cjs`); the hour open at quit waits in
  `digests/open-hour.json` until the next start writes it (B-213). An installed copy on its own profile writes its own
  Fabric descriptor, `fabric-inbox.desktop.json` in Fabric's services directory when that directory exists, naming its
  `digests` folder for a collector, with the token file the protocol requires (`fabric-service.token`, 0600, unused
  by any port); only at a first start, an update or a move (B-210, `desktop/fabric-descriptor.cjs`);
  `analytics-state.json`, `auto-update` and `update-install.json` are the
  only profile files usage counts and updates add (a move between servers adds `move.json` while it runs, removed when it ends), and a verified update waits in
  `~/Library/Caches/Fabric Inbox/updates/` until Squirrel.Mac copies it.
- **LC-16 exception: an update already downloaded installs at quit even after the switch goes off.**
  `off` stops every download and install (the feed is still read to tell the person of a newer version, B-204),
  and a check running at that moment hands nothing over; but
  Squirrel.Mac offers no way to withdraw an update it has already staged, so that one still
  installs when the app quits (`docs/desktop-data-and-updates.md`, Updates §6). The server's address is also kept
  in `<appData>/PassionCode/backups/fabric-inbox.json` and restored from there when `server.json` is
  missing (`desktop/backup.cjs`).
- **Tests, walks and checks never use the real profile (LC-14).** Launch a built app with
  `--user-data-dir="$(mktemp -d)"` (and `--remote-debugging-port` only with it). A
  `DevToolsActivePort` a debugging run left in a profile is removed at the next start
  (`desktop/profile.cjs`), unless that start is itself debugged. An unpackaged run
  (`npm run desktop`) uses `~/Library/Application Support/Fabric Inbox Development`, never the
  installed app's folder, and the app name "Fabric Inbox Development", so its cookie key is its own
  Keychain item. A local packaged debug build still shares "Fabric Inbox Safe Storage" with the
  installed app: launching one on the owner's Mac makes the signed app ask once (`docs/release.md`).
- **Build retention (LC-15).** Output directories: `release/` (disk images, receipts, store builds,
  `desktop:package` folders), `build/` (the Worker and app, rebuilt every time),
  `desktop/server-bundle/`. `npm run desktop:dmg` and `npm run desktop:mas` keep only the current and
  the previous release in `release/` (`desktop/release-retention.mjs`; receipts stay). Caches that
  are not releases — `build/`, `desktop/server-bundle/`, `.wrangler/tmp/`, `node_modules/.cache` —
  are capped at 2 GB together; `npm run clean` (`scripts/clean.mjs`) removes them and keeps local
  Miniflare data (`.wrangler/state`), and an agent that built runs it before ending its run when
  they pass the cap (`du -shc build desktop/server-bundle .wrangler/tmp node_modules/.cache`).
- **Windows and Linux (fabric-workspace knowledge/platforms.md PL-01…PL-08).** The same processes,
  timers and budgets as the table above; what differs
  ([docs/desktop-data-and-updates.md → Windows and Linux](docs/desktop-data-and-updates.md#windows-and-linux)):
  the profile is `%APPDATA%\Fabric Inbox` / `~/.config/Fabric Inbox` with its log under `logs` (on Windows against
  PL-06's `%LOCALAPPDATA%`: Electron's own profile folder, and moving it would sign every Windows user out; a
  downloaded update waits under `%LOCALAPPDATA%\Fabric Inbox`, B-108); no
  Keychain item — the cookie key is DPAPI on Windows and the Secret Service on Linux, where the app
  refuses to start without one (PL-05, `key_store_refused`); without Chromium's sandbox (an AppImage where user namespaces are off) it warns once per launch until the person dismisses it (B-99, profile file `sandbox-warning`); the connect dialog flashes the taskbar
  entry instead of bouncing the Dock, and the listener is looked up with `netstat` + `tasklist`
  (Windows) or `ss`, else `/proc` (Linux), instead of `lsof`, and the port's owner is read from `netstat -ano` + `tasklist /V` (Windows) or `/proc/net/tcp*` (Linux); an update is the verified NSIS
  installer run once, detached, as the app quits (`/S --updated`: the one child that outlives the
  app, by design) or the verified AppImage renamed over the running one; a `.deb` never checks.
  `fabric-inbox://` is registered under `HKCU\Software\Classes` by the installer, and by the
  `.desktop` entry on Linux. Menus: File, Edit, Account, View, Window, Help (`desktop/menu.cjs`).
- **Where Inbox differs from Fabric Switchboard's reference port** (told to its owner): Electron
  with electron-builder wrapping a prepackaged, fuse-hardened app, not Tauri; both Windows
  installers are built on `windows-latest` because workerd has no Windows ARM64 binary, and the
  arm64 one is installed and launched on `windows-11-arm`; the Windows runner runs every desktop
  test (the two that drive `main.cjs` against "/fixture/…" paths load it through
  `tests/posix-require.ts`; Linux runs the whole suite); the verified installer is copied out of the verifier's cache
  into `pending-update` because that cache is cleaned once an update is handed over; checkouts are
  LF on every OS (`.gitattributes`), since signed fixtures and source-reading tests compare bytes;
  the arm64 installer's payload is packed with the BCJ filter (`installerFilter` in
  `desktop/dist-platform.mjs`), because NSIS's unpacker skips files under 7-Zip's own ARM64 filter;
  the `.deb` installs to `/opt/fabric-inbox`, since Chromium's zygote cannot start from a path with a space;
  the agent console's PTY runs on node-pty's own conpty.dll (`useConptyDll`), because node-pty's default
  ConPTY stop forks a helper, which with the `RunAsNode` fuse off starts a second app (B-102).
- **Notifications (F2), decided 2026-10-22 (B-41): yes, off by default.** The person turns on Notify
  About New Mail in the app menu; then the main process reads the unread inbox every 5 min, with or
  without a window, and shows system notifications (the row above). Web pages still get no permission
  (`desktop/main.cjs` `rejectPermissions`) but one: the mail window's own server may write to the
  clipboard, so its Copy buttons work (B-15; `policy.permissionAllowed`); notifications come from the
  main process only.

## Organisation

This repository is one of the `passioncode-ai` repositories. **The org map and onboarding live in
[passioncode-ai/org-index](https://github.com/passioncode-ai/org-index)** (private; readable by
every org member); the shared rules live in the knowledge base:

- [README](https://github.com/passioncode-ai/org-index#repositories): which repository owns what, and how they connect
- [rules](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/rules.md): branches, commits, CI, leases, secrets, handoffs
- [ONBOARDING.md](https://github.com/passioncode-ai/org-index/blob/main/ONBOARDING.md): setting up a new contributor's machine

Where this file is stricter than the rules, this file wins. A change to this repository's
role, dependencies or test command updates its row in `org-index/repositories.json` in the same change.

## Shared backlog

[docs/backlog-sources.json](docs/backlog-sources.json) declares this repository's canonical
local task sources and their vision goals. The [common backlog contract](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/backlog.md)
owns aggregation; [the workspace backlog](https://wiki.passioncode.ai/backlog) is a derived view.
Edit a task only in its canonical source under an agent-sync lease, retain stable IDs and
closure receipts, and declare any new source in the manifest. Do not edit generated task
status in the workspace or copy another repository's task into a second editable row.
Land the source change, then run `node scripts/workspace.mjs sync` from a Fabric checkout
(or use the scheduled sync); check the published source commit before calling it current.

## After work

In the same run: update this repository's docs with the change; if a cross-repository fact changed
(a product, a version, a plan row, a principle), update the page in `fabric-workspace/knowledge/`
that owns it; land both; publish (`node scripts/workspace.mjs sync` from a Fabric checkout) or
leave it to the scheduled sync. Leave a handoff with the exact next task.
<!-- SSHLG:PROJECT:BEGIN managed by npx sshlg-skills enroll. To opt out, replace the whole block with one SSHLG:PROJECT:OPTOUT comment line. -->
## Family routes in this project

Surface: `app-text` (detected).
Signals:
- string catalogue: `desktop/locales/ru.json`

Routes that apply here (the global routing block says what each one owns):

| Router | Answers | Setup here |
|---|---|---|
| `super-ux` | what the interface must do | scenarios and their linter: present |
| `sheleg-design` | how it looks and moves | nothing to seed |
| `copywriting` | how it sounds | brand pack: present |
| `evidence-docs` | what proves it | nothing to seed |
| `task-pipeline` | how the change reaches the repository | DOCMAP: present |

Remaining setup: none.
<!-- SSHLG:PROJECT:END -->
