# Changelog

One section per version, newest first. The server, the Mac app and the skill plugin carry one
version (`tests/versions.test.ts`), and a release's notes are its section here: the disk-image
builder refuses a version without one (`desktop/dist-mac.mjs`, `changelogSection`). How a release
is cut and published: [docs/release.md](docs/release.md).

## Unreleased

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
