# Changelog

One section per version, newest first. The server, the Mac app and the skill plugin carry one
version (`tests/versions.test.ts`), and a release's notes are its section here: the disk-image
builder refuses a version without one (`desktop/dist-mac.mjs`, `changelogSection`). How a release
is cut and published: [docs/release.md](docs/release.md).

## 0.14.0 — 2026-10-10

- **Fabric Inbox for Windows and Linux.** The same app, for x64 and ARM64. Windows has an installer
  for your account only, with no administrator rights; it adds `fabric-inbox://` links and removes
  them when you uninstall. Linux has an AppImage and a `.deb` for Debian and Ubuntu, which adds a
  `fabric-inbox` command. Windows and Linux menus are File, Edit, Account, View, Window and Help, and
  a hub's Allow/Deny prompt flashes the taskbar entry.
- **Windows installers are not Authenticode-signed yet.** SmartScreen warns once on first run.
  Verify the installer with the signed `SHA256SUMS`, as the app does for every update.
- **Updates on Windows and Linux.** The Windows app checks, downloads and verifies a new version,
  then installs it when you quit, or at once with **Help → Restart to Install Update**. The AppImage
  replaces itself with the verified new file. A copy installed from the `.deb` does not update
  itself: install the next `.deb`, or use the AppImage.
- **Your sign-in stays encrypted on Linux.** The app keeps it in the Secret Service (GNOME Keyring
  or KWallet). Without one it does not start, rather than store your sign-in as plain text. On a
  desktop other than GNOME or KDE, start it with `--password-store=gnome-libsecret`.
- **Search finds long phrases.** A search longer than about 48 characters found nothing; it now
  matches, and so does the address test that looks for its own message.
- **A refused send says why.** When the provider refuses a message, the outbox and the address test
  show the provider's reason instead of a code, with addresses and keys masked.
- **Usage counts from a pre-release build are counted as test builds**, apart from releases.

## 0.13.0 — 2026-10-08

- **Forwarding copies work again.** Since 0.8.2 no Cloudflare address had sent its copy to a
  forwarding destination, and mail to an unknown address could fail instead of being refused: the
  step that retries a delivery dropped the message's own forward and refuse actions. Both are kept
  now, and a test sends a message shaped like Cloudflare's own through the whole path.
- **Senders have names.** Cloudflare mail shows "Maya Chen <maya@…>" instead of a bare address; the
  name is kept on arrival, and older mail reads it from its stored header. Search finds Cyrillic in
  any case ("привет" finds "Привет").
- **The reader says more, and only what applies.** Cc is shown; Reply all appears when it reaches
  someone besides the sender and fills To and Cc from everyone on the message; the "external images
  are blocked" line appears only on mail that has remote content.
- **Ask AI from the inbox.** The AI panel opens from the inbox header — a column on wide windows, a
  sheet on narrow ones. A failed answer says so with Retry; the messages an answer read are links
  that open them.
- **Rules you can enable from the app.** Enable waits for a dry-run of the current values; the
  dry-run offers the account's newest mail by sender and subject instead of a message id, and says
  in a sentence what the rule would do. Rule cards show the version and attempts; a run whose result
  is unknown has Check status (agents: `check_rule_run`). Cloud-tool arguments may use
  `{{email.preview}}`, the first 300 characters as plain text.
- **New addresses show up at once.** An address made in the last 7 days is listed in the sidebar
  even with no mail yet (agents: `list_accounts` returns `createdAt`).
- **Connecting a hub brings the app forward.** The Allow/Deny prompt comes to the front with a Dock
  bounce, and closes by itself when the hub stops waiting or after 2 minutes.
- **Smaller fixes.** Unsaved signature edits ask before leaving; an agent's tool is checked when the
  agent is saved; the IMAP form asks before discarding what you typed; the Outlook secret warning
  opens the secret setup; a failed refresh keeps the list with Retry; Esc cancels inbox
  confirmations; downloads name the file and show progress.

## 0.12.0 — 2026-10-07

- **Fabric Inbox in Russian.** The app opens in Russian when the Mac's first language is Russian,
  and **Settings → App → Language** chooses System, English or Русский on this device. Everything a
  person reads is translated — the mail list, the reader and composer, Settings, the setup and
  connect pages, the Mac app's menus and dialogs, and the server's messages where they are shown —
  with real Russian plurals and dates. Agent tools and logs stay English. A check fails the build
  on any English sentence without a Russian entry.
- **Connecting a hub names the app that will get the key.** The `fabric-inbox://connect` dialog
  shows the process listening for the key, not only the name the link gives itself; it refuses
  when nothing listens or another process took the port, and an Admin key needs your own tick.
- **Refresh sits on the left, with how fresh the mail is.** Beside it: "Updated 3 min ago" (the
  server's last successful read of the Gmail, IMAP and Outlook accounts in view), "Live" for
  Cloudflare addresses, "Updating…" while it runs, and the account that failed with its fix. A click
  shows every account's state. ⌘⇧N refreshes (⌘R stays Retry connection).
- **Delete or Backspace archives and marks read; ⌘⌫ (Ctrl+Backspace) discards.** Both work on
  several selected messages, open the next one and offer Undo (also ⌘Z). Arrows and j/k move;
  ? lists the shortcuts. Keys never fire while typing or with a dialog open.
- **Discarded: deleted, but recoverable.** A discarded message goes to its account's Discarded
  folder (a Cloudflare folder, a Gmail label, an IMAP folder, an Outlook folder), out of the inbox,
  counts and categories, and is removed after 30 days. Each discard records why and teaches a rule
  (the mailing list, else the sender), so mail like it goes straight to Discarded on arrival — never
  mail from someone you wrote to, replies in your conversations, your own domains or senders on the
  Always allow list. "Not discarded" brings a message back and can drop the rule. Settings →
  Discard rules lists them. Agents: `discard_messages`, `restore_discarded`, `list_discard_rules`,
  `remove_discard_rule`, `update_discard_allow_list`.
- **Adding an address is one worked-out dialog.** A live check as you type (allowed characters,
  role names, already here, already routed elsewhere in Cloudflare, the catch-all), a domain picker
  with each domain's state, a display name and signature, who answers, a forwarding copy, then the
  steps in place: receive the domain if needed, create the address, make the Cloudflare rule (or say
  why not with its fix), and a test message watched until it arrives. "Add several" creates many at
  once. A rule Cloudflare refuses no longer costs the address: it shows "Not receiving yet" with
  Fix it. Agents: `check_address`, `create_addresses`, `check_test_message`; `create_address`
  takes a signature.
- **Usage counts no longer wait for the Keychain.** They are sent with Node's `fetch` in the main
  process instead of Chromium's network stack, which waits for the cookie key; a pending Keychain
  prompt held every count back on the owner's Mac (0.11.0).
- **A development run is "Fabric Inbox Development"** to macOS, with its own Keychain item for its
  cookie key, so it can never leave the installed app an item it has to ask for.
- **Automatic updates behave as in every PassionCode.ai product (LC-16).** The first check runs
  90 s after start, then every 6 h while the app runs, window or not; a failed check is retried
  once within the hour. The switch is the file `auto-update` in the profile (absent = on, `off` =
  off); the 0.10.1–0.11.0 `updates.json` choice is carried over.
- **An update is verified by the app before anything can replace it.** The release's
  `SHA256SUMS` must carry the organization's pinned GPG signature and list the feed itself; the
  zip must have the signed digest and size; the app inside must be signed by a Developer ID of team
  `KJ35UYYL22` and carry the announced version. Only then is Squirrel.Mac handed the verified zip.
  Before, Squirrel.Mac checked only the signing team, and the docs wrongly said it checked the
  digest.
- **An update is never a downgrade or a reinstall**: only a strictly newer release is offered, and
  the release build sets `ElectronSquirrelPreventDowngrades`.
- **A release can be held for a step a person takes** (`migration` in its feed): it is downloaded
  and verified, not installed, and Check for Updates… names its runbook.
- **The app keeps a log**, `~/Library/Logs/Fabric Inbox/fabric-inbox.log` (codes only, about 2 MB
  at most), with the shared update events.
- **An update never loops or waits forever.** A version macOS refuses, or that Squirrel.Mac does not
  take within 15 minutes, is not downloaded again for a day; a held release is downloaded once; a
  copy this Mac account cannot replace says so and downloads nothing. Turning automatic updates off
  stops a check that is running from handing anything over (an update already downloaded still
  installs at quit). A failed Restart to Install Update can be chosen again.
- **The release refuses a bad update before publishing it.** A new `update-precheck` job runs the
  app's own checks on the built feed and zip, and `publish` waits for it; the signed set is checked
  again after publishing.
- **Creating a server never puts a prerelease over its release**, and `npm run deploy` records the
  server's version as the app's own deploy does.
- **A `DevToolsActivePort` left by a debugging run is removed** from the profile at the next start.
- **Corrected:** the first published release that updates itself is 0.11.0; 0.10.1 was never
  published.

## 0.11.0 — 2026-10-06

- **Settings is one screen, and nothing jumps.** Addresses, Domains, Accounts, Forwarding
  destinations, Agents, Knowledge, Categories, Spam rules, Agent access and App live under
  **Settings** (⌘, in the Mac app), each as a searchable list with the chosen item's panel beside
  it. Choosing a row no longer scrolls the page or folds another domain (the old screen navigated
  and reset the scroll to the top); results show where you acted; destructive actions sit in one
  menu with one confirmation; a narrow window shows the panel with Back. Old addresses redirect.
- **Mail refresh works.** Gmail brings new mail during a first import, imports recent inbox mail
  first, syncs as soon as an account connects, and no longer drops out of the inbox when its cache
  passes about 10,000 messages (a date index and stored counts replace full scans; the cache is
  migrated in place). **Refresh** reads Gmail now and says per account what happened; the inbox
  keeps updating after Load older, refreshes when the window comes back or the Mac wakes, applies
  archive, delete and read at once, and offers a reload after a server update. One bad message no
  longer stops an account, a manual sync no longer delays the others, and only a revoked grant
  asks for a reconnect.
- **Agents can do everything the interface does.** New tools send, edit and delete drafts
  (`send_draft`, `list_drafts`, `read_draft`, `delete_draft`), send files, Cc, Bcc and a subject on
  replies and forwards, keep the signature and quote in HTML, read raw headers, list agent keys
  (without secrets) and providers, and refresh mail. Saving a rule or a project changes only what
  is given. A test now fails when a route accepts a field its tool does not.
- **Drafts live on the server.** The main window saves drafts to the account's server drafts
  (Cloudflare and Gmail), so an agent's draft appears in Drafts for a person to review and send,
  and a person's draft is safe if the Mac is lost; conflicting edits ask which version to keep.
  Drafts that were only on this Mac are moved to the server on first start.
- **Gmail setup in the app.** A seven-step guide with links and copy buttons; the server checks
  the Google client, creates its own credential key and saves its settings itself. Connecting ends
  on a page that says what happened, and an account that stops working says why (for example the
  7-day expiry of a Google app left in Testing) with the one action that fixes it.
- **Outlook and Microsoft 365.** Connect through Microsoft Graph (OAuth with PKCE) after the owner
  registers an app in Microsoft Entra, guided in Settings → Accounts → Outlook with every value to
  copy; the server keeps the client secret and warns 30 days before it expires. Mail is read with
  delta queries per folder (Inbox first), sent with files, Cc and Bcc, and drafts are editable; an
  organization that needs its administrator gets the approval link to forward.
- **More mail accounts: iCloud Mail, Yahoo, AOL, Fastmail, Zoho, Yandex, Mail.ru, GMX, Gmail with
  an app password, or any IMAP server.** Added in Settings → Accounts with an app password, checked
  before it is stored, kept encrypted on your server, and read and sent by the server, so they work
  with the Mac closed. Credentials use a versioned envelope with a rotatable key
  (`MAIL_CREDENTIAL_KEY`); a server that has none makes its own from Settings (**Make the key**).
- **The local dev server runs again with IMAP support** (`npm run dev`): imapflow's unused default
  logger no longer stops the Worker in workerd.
- **Usage counts carry `iid` and `environment`.** Every event repeats the shared installation id as
  `props.iid` and says `props.environment`: `production` for a release build, `sandbox` for a debug
  key or a pre-release version, the two values sshlg-growth counts (operator decision 2026-10-05).
- **The Mac App Store package is readable by every user.** App Store Connect refused the first
  store upload (0.10.1, ITMS-90255: files only root can read): the embedded provisioning profile
  kept the 0600 of its private temporary file. The bundle is made readable after signing, and the
  build now stops before Apple does if any file or folder is not.

## 0.10.1 — 2026-10-05

The Mac app now keeps itself up to date, and removing or reinstalling it loses nothing.

- **Automatic updates, on by default.** A released copy in Applications checks the latest GitHub
  release at launch (and when you come back to it, at most every six hours), downloads the new
  signed version in the background and installs it when you quit, or at once with **Fabric Inbox →
  Restart to Install Update**. Squirrel.Mac checks the download's sha256 and size and that it is
  signed by the same team. **Install Updates Automatically** turns it off; **Check for Updates…**
  checks at once and says what happened. Each release now also publishes `Fabric-Inbox-<version>-mac.zip`
  and `update-mac.json`. Builds from source and the Mac App Store copy never check. 0.10.0 and
  earlier have no updater: update them once by hand.
- **The server's address survives an uninstaller.** It is also kept in
  `~/Library/Application Support/PassionCode/backups/fabric-inbox.json` and read back when the app's
  own folder is gone, so a reinstall opens your server instead of the welcome screen. Your
  accounts, addresses, agents, keys and mail were always on your server; what lives where is in
  [docs/desktop-data-and-updates.md](docs/desktop-data-and-updates.md).
- **A start with no server known keeps every sign-in.** The profile sweep no longer removes server
  partitions (sign-in and unsent drafts) when no server address is saved: that partition may be
  the server you are about to enter again.
- **Usage counts show updates** (`app_updated`, with the version it came from).

## 0.10.0 — 2026-10-05

Agents that work with mail get the right recipients and the exact bytes; a message is answered
once; the Mac app is hardened and counts its use anonymously. Every fix has a test that fails
without it.

- **A reply goes where the sender asked.** `reply` answers the Reply-To address on both providers,
  and `read_message` shows it. A Gmail reply-all keeps everyone on Cc and leaves your own address
  out (Gmail messages cached before 0.10 are read again from Gmail once to learn their Cc).
- **Attachments reach an agent byte for byte.** `get_attachment` and `forward` no longer re-encode
  text and JSON attachments (an invalid `.json` came back as `"null"`).
- **Moving archived Gmail mail to the inbox puts it in the inbox** (a new route adds the Inbox
  label; before, the tool reported success and the message stayed archived).
- **Gmail search applies each field on its own** — from, to (Cc included), subject, dates, unread,
  starred, attachments, folder — and refuses a filter it cannot apply instead of ignoring it.
- **Agents are told the truth about failures.** A batch where nothing was done is an error and is
  journalled as failed; a failed send keeps the outbox id and status so `get_send_status` can follow
  it; `update_messages` refuses to mark a whole conversation unread instead of marking it read; a
  conversation listed by `threadId` spans every folder, your replies included; a mailbox-limited
  key is no longer promised spam reporting it does not have.
- **One answer per message (B-22).** A message sent to several agent addresses of one workspace
  (To and Cc, or two in To) is answered once, from the first agent address in To; the other copies
  are recorded as skipped with the address that answered. The claim is atomic in the workspace's
  agent registry and expires after seven days.
- **Anonymous usage counts** (#27, [docs/ANALYTICS.md](docs/ANALYTICS.md)). The released disk image
  counts installs, days of use and how many Gmail accounts, Cloudflare mailboxes, agents and agent
  keys your server has, with the installation id every PassionCode app on the Mac shares — never an
  address, a name, a domain or anything from your mail. **Fabric Inbox → Share Anonymous Usage
  Counts** turns it off for every PassionCode app at once. Builds from source and the Mac App
  Store package send nothing.
- **A mistyped server address costs nothing.** Changing the server clears the old server's
  storage only after the new one answers; before, a wrong address deleted the old server's unsent
  drafts and sign-in, and switching back within one run broke its storage.
- **Local release folders keep what matters.** A development store build never removes the
  uploaded distribution package; a removed store folder leaves its receipt; a failed removal no
  longer fails a finished build.
- **The Mac app is hardened** (lifecycle contract LC-13, LC-07, PR #12). Session cookies are
  encrypted at rest under a login-Keychain key, "Fabric Inbox Safe Storage"; the app cannot be run
  as a plain Node process or opened with an inspector; it loads only from its own integrity-checked
  archive; and it no longer carries Electron's camera, microphone and Bluetooth purpose strings.
  Every build reads the fuses and purpose strings back from the built app and fails otherwise.
  Profiles written by 0.9.0 and earlier keep working; going back to such a version means signing in
  again.
- **Old servers leave nothing behind** (LC-12). Changing the server clears the previous server's
  cookies, storage and cache, so returning to it means signing in again; each launch removes what
  servers no longer configured left in the profile.
- **Automation polls less** (LC-08): every 30 s instead of 5 s, and only while the window is
  visible and focused; returning to the window refreshes at once.
- **A development run uses its own profile** (`Fabric Inbox Development`), never the installed
  app's (LC-14). A local build keeps only the current and the previous release in `release/`, and
  `npm run clean` removes build caches (LC-15).

## 0.9.0 — 2026-10-03

- **Agent keys can be limited to mailboxes** (AP-11). A Read or Mail key may name its accounts and
  then reaches those mailboxes only: it sees only tools that stay inside a mailbox, every route it
  calls is checked against its accounts, the feed is narrowed in the request and in the answer, and
  a category filter is refused. Agent access gains a Mailboxes choice and shows each key's scope.
- **A hub narrows its key per call with `X-Fabric-Accounts`**: the call reaches only the named
  mailboxes; the header intersects with the key's own limit and never widens it.
- **A hub on this Mac connects by your consent, with nothing copied.** A `fabric-inbox://connect`
  link opens a native Allow/Deny prompt; Allow makes the key with your own signed-in session and
  hands it once to the hub's loopback address, and revokes it if the hub did not take it (SCN-047).
- **Releases are signed in GitHub Actions only.** A `vX.Y.Z` tag starts `.github/workflows/release.yml`;
  after a member of `release-approvers` approves (whoever pushed the tag may; an agent never
  does), it builds the disk image
  with the organization's CI Developer ID, notarizes and staples the app and then the image made
  from it, attests every file, signs `SHA256SUMS` and publishes the release. A rehearsal on a
  `-rc` tag does all of that and publishes nothing. A build signed on a laptop is a debug build.
- **The Mac App Store package is built by the same workflow**, signed with the CI-only store
  identities and the Fabric Inbox profile, and uploaded to App Store Connect when the release
  publishes. The upload stops with a clear message while the App Store Connect app record does not
  exist; creating it is a person's step ([docs/release.md](docs/release.md#mac-app-store)).
- `desktop/dist-mac.mjs` gains `--stage app|image|finish` for the workflow;
  `scripts/app-store-connect.mjs` derives the store build number from the tag, checks the app
  record and uploads. The release no longer carries a separate `.sha256`: the signed `SHA256SUMS`
  covers the image.

## 0.8.2 — 2026-10-01

A second pass: the live server's own error log, the 0.8.1 changes read again, and the core mail
paths. Every fix has a test that fails without it.

- **Mail is not lost to a Durable Object reset.** A message that arrived a minute after a deploy
  failed with "storage operation exceeded timeout" and was never delivered again (seen in the live
  log, 2026-09-28). A delivery now retries once after such a reset; it is still stored only once.
- **A forgery is spam even from a sender you allowed.** Mail that fails its domain's DMARC (reject or
  quarantine), or claims one of your domains without passing its checks, no longer passes because
  the domain is on Never spam. Never spam still wins over everything else. When the spam check
  itself cannot run, the message is screened by the model instead of being treated as clean.
- **A long attachment name no longer makes a message impossible to receive** (names are cut to 200
  bytes, keeping the extension).
- **A long message reads whole in its conversation**, as it already did on its own.
- **The same email is not shown twice** when its copy in another inbox falls on the next page.
- **Gmail mail with only an HTML part** is sorted into categories by its text, not its subject alone.
- **"You have written to this sender"** now means the whole address (it matched a part of another).
- **Replying to mail with no Message-ID** no longer puts an internal id into the reply's headers.
- **Relays:** the sign-in a relay was moved off is revoked an hour later without waiting for another
  connect; an upgrade cut off half-way is tried again; the hourly limit on upgrades is per account;
  the relay status shows the current relay; a refusal while another sign-in change runs answers 409.

## 0.8.1 — 2026-10-01

A review of 0.8.0's several-accounts work, every finding fixed with a test
([brief](docs/app-store/tasks/2026-09-30-cloudflare-accounts.md#review-2026-10-01)).

- **No guessing which account is the server's.** When it cannot be told (no `CLOUDFLARE_ACCOUNT_ID`
  and a token that sees several accounts), the screen says so and nothing is connected or released;
  before, every domain looked like another account's and **Stop receiving here** could drop mail.
- **Only active domains count.** A pending copy of a domain in another account can no longer take
  its mail, its relay deliveries or where it sends from.
- **An account whose token stopped working** stays listed with the reason; **Remove…** works, and
  **Connect another account** with a new token replaces the old one.
- **Relays:** installed and removed one at a time (with agent keys, which share the sign-in policy);
  a relay's own settings say which sign-in it runs with, so a lost or unconfirmed step is put right
  by running it again; a reinstall keeps the old sign-in working while it drains; a failure never
  removes a relay that works; relays upgrade themselves to the server's version; a refused sign-in
  no longer follows Access's login redirect.
- **Sending from another account:** works with one token that reaches several accounts; a domain
  that moved is sent from where it is now; an inline image without a Content-ID goes as an
  attachment; mail suppressed for every recipient is a failure, not "sent".
- **Clearer refusals:** an error names which token it is about, and Email Sending's own refusals are
  no longer reported as a missing permission.
- Smaller: connecting several accounts at once reports each one; `list_domains` keeps a domain's own
  account when it also lists destinations; empty and error states on the accounts list; focus after
  Remove.

## 0.8.0 — 2026-09-30

- **Several Cloudflare accounts.** Domains & addresses lists every Cloudflare account the server has
  a token for, with whether it has mail, how many domains and how many receive here. The server's
  account and every account with mail are shown; **Show**, **Hide** and **Default** change that.
  **Connect another account** takes a token made in that account (the window lists the permissions it
  needs); the server keeps it as its own secret and never shows it again. **Remove…** takes
  it away again.
- **Receive mail for a domain in another account.** Cloudflare sends a domain's mail only to a
  Worker in the same account, so **Receive mail here** on such a domain first installs a small relay
  there (`fabric-inbox-relay`), which hands every message to your server unchanged. Copies,
  unknown addresses and duplicates behave as for any other domain. Replies from those addresses are
  sent through that account's Email Sending.
- **Fix: Receive mail here on a domain whose Email Routing was off.** Cloudflare refused it with
  "Invalid Input: must be a subdomains of …"; the request no longer names the domain.
- **Agent protocol:** `list_cloudflare_accounts`, `show_cloudflare_account` and
  `remove_cloudflare_account` (two steps). `list_domains` and `add_forward_destination` take an
  `account`. Connecting a token stays in the app: a token is a secret and never passes through an
  agent.
- **New licence.** Fabric Inbox's own code is now open source under the GNU AGPL-3.0, with a
  commercial licence available from PassionCode.ai (`AGPL-3.0-only OR
  LicenseRef-PassionCode-Commercial`; Fabric ADR-0092). Versions up to and including 0.7.1 stay
  under Apache-2.0. The code imported from Cloudflare's Agentic Inbox template keeps its
  Apache-2.0 licence and notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
  [LICENSES/](LICENSES/). Contributions are accepted under [CLA.md](CLA.md). No behaviour changed.

## 0.7.1 — 2026-09-30

The first release published on GitHub, with a signed, notarized disk image and its checksum.

- **One version across the release.** The `v0.7.0` tag names `c37dee0`, whose Mac app still
  carried 0.6.2; the fix (`d84ee43`) came after the tag, and release tags are never moved. 0.7.1 is
  the first version whose tag, Mac app, server and skill agree.
- **Release builds prove what they claim.** With `--notary-profile` the build fails unless Apple
  accepted both the app and the disk image, both are stapled, and Gatekeeper names the source
  `Notarized Developer ID` for each (`spctl -a -vv`). The receipt records the notarization
  submission, and `Fabric-Inbox-<version>.dmg.sha256` beside the image is what
  `shasum -a 256 -c` reads. A build that stops without writing its receipt exits 1.
- **Install and connect from the release.** The README says how an organisation member downloads
  the image from this private repository (`gh release download`), and what the MCP address is when
  the installed app runs: the server's own `/mcp`, since the app itself serves nothing locally.
- **The installed app's agent protocol is checked from the installed copy.**
  `scripts/check-installed-app.mjs` runs the server an installed app carries, locally behind an
  Access stand-in, and calls `initialize`, `tools/list` and `list_accounts` on its `/mcp`.
- The server, the app's behaviour and the agent protocol are unchanged since 0.7.0.

## 0.7.0 — 2026-09-29

The agent protocol: every function of the app over MCP at `/mcp`, agent keys as Cloudflare Access
service tokens (read / mail / admin), two steps for irreversible actions, a journal, the Agent
access screen, and the skill `working-with-fabric-inbox`
([brief](docs/app-store/tasks/2026-09-29-agent-protocol.md)). Built and installed on the owner's
Mac from `d84ee43`; not published as a GitHub release.

## 0.6.3 — 2026-09-29

Numbered schema steps for the agent registry, knowledge and categories objects (B-32).

## 0.6.2 — 2026-09-29

A stranger's message waits for its spam check before its agent answers (B-30).

## 0.6.1 — 2026-09-29

The sidebar filter (With mail / All, hidden addresses); the reliability and update audits; the
spam retention clock counts from the move into Spam
([brief](docs/app-store/tasks/2026-09-29-reliability-and-updates.md)).

## 0.6.0 — 2026-09-29

A spam filter and one path to create and remove a mailbox
([brief](docs/app-store/tasks/2026-09-29-spam-and-mailboxes.md)).

## 0.5.0 — 2026-09-29

Categories ([brief](docs/app-store/tasks/2026-09-29-categories.md)).

## 0.4.0 — 2026-09-29

Knowledge collections an agent searches, only the ones granted to it
([brief](docs/app-store/tasks/2026-09-29-knowledge.md)).

## 0.3.0 — 2026-09-28

Domains & addresses, the Mac app creating the server in your own Cloudflare account, and no
owner data in the public build ([plan](docs/app-store/tasks/2026-09-28-cloudflare-complete.md)).
