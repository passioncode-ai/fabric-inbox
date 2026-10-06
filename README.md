# Fabric Inbox

Fabric Inbox is Fabric's mail tool, and it also works on its own: a desktop mail client with
cloud email automation and tool integrations, in development preview. One triaged list across
Gmail and Cloudflare mailboxes with important mail first and the rest grouped; every domain of your
Cloudflare account manageable from the app; addresses answered by reusable agents under a reply
policy; a macOS app that creates its server in your own Cloudflare account. Every function of the
app is also an MCP tool, so an agent can drive it. It began as Cloudflare's
[Agentic Inbox](https://github.com/cloudflare/agentic-inbox) template (Apache-2.0; see
[third-party notices](THIRD_PARTY_NOTICES.md)). It is built by
[PassionCode.ai](https://passioncode.ai/), whose toolkit is for AI-native teams.

**Status:** a first deployment runs behind Cloudflare Access with its domains routed to it
([plan](docs/app-store/tasks/2026-09-28-cloudflare-complete.md)); no real model call or Gmail
account acceptance yet. The macOS disk image is signed and notarized.
**Continue here:** [release entry](docs/app-store/README.md) → [roadmap](docs/app-store/tasks/2026-09-28-roadmap.md).
**How it works:** [architecture as built](docs/architecture.md). **Configure:** [setup](docs/desktop-mail/setup.md)
and [your deployment](#configure-your-deployment).

## Quick start for a new teammate

1. **Install.** Download the signed, notarized disk image from the latest
   [GitHub release](https://github.com/passioncode-ai/fabric-inbox/releases) in the browser, or
   with the [GitHub CLI](https://cli.github.com/) (`gh auth login` once):

   ```sh
   gh release download -R passioncode-ai/fabric-inbox \
     --pattern 'Fabric-Inbox-*.dmg' --pattern 'SHA256SUMS*'
   shasum -a 256 -c SHA256SUMS --ignore-missing    # prints "Fabric-Inbox-<version>.dmg: OK"
   gh attestation verify Fabric-Inbox-*.dmg -R passioncode-ai/fabric-inbox   # built by this repository's release workflow
   open Fabric-Inbox-*.dmg                          # drag Fabric Inbox onto Applications
   spctl -a -vv "/Applications/Fabric Inbox.app"    # accepted, source=Notarized Developer ID
   ```

   `gpg --verify SHA256SUMS.asc SHA256SUMS` checks the sums against the organization's
   [release key](https://github.com/passioncode-ai/.github/blob/main/release-signing/passioncode-release-signing.asc).
   Add `v<version>` after `download` for a specific release; releases up to 0.8.2 carry
   `Fabric-Inbox-<version>.dmg.sha256` (`shasum -a 256 -c` it) instead of `SHA256SUMS`. Building
   it yourself is in [Install on a Mac](#install-on-a-mac).
2. **Configure.** On first open choose **Create my server on Cloudflare**. You need a Cloudflare
   account (the free plan works) and an API token you create in its dashboard with the permissions
   the app lists ([setup → your own server](docs/desktop-mail/setup.md#your-own-server-created-by-the-mac-app-recommended)).
   Gmail needs an OAuth client of your own in Google Cloud: **Settings → Accounts → Connect
   account → Gmail** walks through it step by step with the values to copy, checks the client with
   Google and saves it on your server itself (the Mac app offers it right after creating the
   server). Publish the Google Cloud app (or make it Internal for Workspace): one left in Testing
   loses Gmail access every 7 days ([setup → Gmail](docs/desktop-mail/setup.md#gmail)). For `npm run dev`, copy
   `.dev.vars.example` to `.dev.vars`; every setting is in the
   [configuration reference](docs/desktop-mail/setup.md#configuration-reference). Deploying by
   hand or making a personal build: [Configure your deployment](#configure-your-deployment).
3. **MCP.** The installed app listens on no port and serves no MCP of its own: it
   opens your server, and agents connect to that server at **`<your server>/mcp`**, where
   `<your server>` is the address in **Fabric Inbox → Server address…** — for a server made by
   **Create my server**, `https://fabric-inbox.<your-workers-subdomain>.workers.dev/mcp`. In the app,
   **Settings → Agent access** makes a key and prints the whole command,
   `claude mcp add --transport http fabric-inbox https://<your-server>/mcp --header …`
   ([agent protocol → Connect](docs/agents/mcp.md#connect)). To try it with no account at all, run
   `npm run dev -- --port 5174 --host 127.0.0.1` from a checkout (local development signs you in as
   the owner; this address exists only while it runs), then
   `claude mcp add --transport http fabric-inbox-local http://127.0.0.1:5174/mcp` and ask for
   `list_accounts`; a fresh server answers `{"accounts":[],"gmail":{"configuration":"not_configured",…}}`.
   The skill `working-with-fabric-inbox` is in `plugins/fabric-inbox/`; load it with
   `claude --plugin-dir plugins/fabric-inbox` until it ships in the PassionCode set. If the first
   page load after a fresh `npm ci` answers 500 ("Network connection lost"), restart `npm run dev`:
   Vite was still preparing dependencies.
4. **Develop.** Run it from source with [Run locally](#run-locally) and check a change with
   [Develop and test](#develop-and-test) (the gate: `npm test && npm run typecheck`). Start in
   [AGENTS.md](AGENTS.md) ("Where things live"):
   `app/` is the UI, `workers/app.ts` the Worker, and every route also gets its agent tool in
   `workers/mcp/tools.ts` in the same change.

## What it does today

- **All inboxes, triaged.** Cloudflare mailboxes and Gmail accounts in one list. Focus shows
  Important first (a person's unread mail, security and sign-in mail, monitoring alerts, app
  review rejections, failed payments, CI failures, starred); the rest sits in collapsed groups
  — people, security, alerts, app stores, billing, dev & CI, notifications, social,
  newsletters — with counts. Filters: unread only, one group, one account, search of cached
  mail. Placement is deterministic header and label rules, and each row says why.
- **Settings.** One screen (the gear in the sidebar, or **Settings…** ⌘, in the Mac app) with a
  section list, a searchable list and the chosen item beside it; choosing an item never moves the
  page. Sections: Addresses, Domains, Accounts, Forwarding destinations, Categories, Spam rules,
  Agents, Knowledge, Agent access and App. Every older page address redirects into its section.
- **Domains and addresses.** Every domain of your Cloudflare account in Settings → Domains. **Receive
  mail here** turns on Email Routing (asking before it replaces another provider's MX), brings
  in the addresses that already exist while each keeps forwarding a copy where it went before,
  points them here, and turns on sending with a DMARC record. Add and remove addresses, choose a
  catch-all, add forwarding destinations, or send a domain's mail back. Mail to an address
  without a mailbox is refused (or kept in the catch-all) and listed with its name — never
  dropped. The sidebar groups addresses by domain with unread counts.
- **Agents.** Named, versioned definitions (instructions, knowledge, remote MCP tools, reply
  policy) reused across addresses or Off per address. No-reply, bulk, list and automatic mail
  is skipped before any model call. An agent sends only a grounded answer with an allowed
  intent within its daily limit; everything else becomes a draft with the reason. Every run
  records the version, the decision and exactly what was sent.
- **Mail.** Read, reply, forward with attachments, To/Cc/Bcc, independent drafts with send
  recovery, star/archive/trash/restore, per-message external images, Gmail OAuth with cloud
  polling. Rules: archive, mark read, draft, forward or call an MCP tool, with dry-run,
  approval or automatic mode, pause and a daily cap.
- **Desktop.** A signed universal macOS app installed from a disk image. First run offers
  **Create my server on Cloudflare**: paste one API token and the app creates the server,
  storage and sign-in in your own account, then opens it. A setup file or an existing server's
  address also works (a personal build can carry its owner's setup);
  native menus, per-server session and connection recovery; a Mac App Store packaging path.
- **Setups.** One file brings a server up: domains, addresses, their agents, forwarding copies
  and catch-alls. Applying it is idempotent; the server can derive one from Cloudflare Email
  Routing so existing addresses keep forwarding to Gmail while their mail is collected here.

Not yet: IMAP/Outlook and local sync of personal accounts (roadmap L1), bulk actions per group
(L5), offline cache. See the [roadmap](docs/app-store/tasks/2026-09-28-roadmap.md).

## Run locally

```sh
npm ci
npm run dev            # the Worker and app on http://localhost:5173 with local bindings
npm run desktop        # in another terminal; enter the dev URL in setup (its own profile, not the installed app's)
npm run desktop:server-bundle   # once, so Create my server has a server to upload
```

Local bindings are Miniflare (no cloud) unless `FABRIC_REMOTE_BINDINGS=1`. Workers AI has no
local mode, so agent runs fail closed locally and say so. A synthetic workbench with
triage-relevant mail: `npm run dev -- --port 5174 --host 127.0.0.1`, then
`FIXTURE_PORT=5183 node scripts/preview-fixture.mjs` and open `http://127.0.0.1:5183`.
Deliver a test message to the local Worker:
`curl -X POST "http://127.0.0.1:5174/cdn-cgi/handler/email?from=a@example.org&to=support@<domain>" --data-binary @message.eml`
(the message needs a `Message-ID`).

## Develop and test

```sh
npm test                                   # all tests; Worker code runs in workerd (Miniflare), no network, ~30 s
node --import tsx --test tests/<name>.test.ts
npm run typecheck                          # generates Wrangler and React Router types, then tsc -b
npm run build
python3 docs/ux/lint.py && python3 docs/ux/doctor.py   # UX contract
python3 docs/brand/lint.py                 # brand strings (warnings are advisory)
```

The checks above are the gate, run before you push. [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs the same checks on every pull request and on `main` as a second opinion. Releases are
signed, notarized and published only by [`.github/workflows/release.yml`](.github/workflows/release.yml)
([Release](#release)).

## Install on a Mac

Install a released image (Quick start above). Open the `.dmg` and drag **Fabric Inbox** onto
**Applications**, like any Mac app. The image holds one universal app (Apple silicon and Intel),
built from the tagged commit, signed with the organization's Developer ID and the hardened
runtime, and notarized and stapled so Gatekeeper opens a downloaded copy without warnings; the
receipt published beside the image states its commit, signature, both notarization submissions
and the workflow run that built it.

### Updates and your data

From 0.10.1 a released copy in **Applications** updates itself: it checks the latest GitHub
release at launch (and when you come back to it, at most every six hours), downloads the new
signed version in the background and installs it when you quit, or at once with **Fabric Inbox →
Restart to Install Update**. **Install Updates Automatically** in the same menu turns it off.
Your accounts, addresses, agents, keys and mail live on your server, so removing or reinstalling
the app loses none of them; the server's address is also kept in
`~/Library/Application Support/PassionCode/backups/` and read back after an uninstaller removed
the app's own folder. What lives where and what an uninstall costs:
[docs/desktop-data-and-updates.md](docs/desktop-data-and-updates.md).

### Anonymous usage counts

A released disk image tells PassionCode.ai that it was installed and opened, once a day that it was
used, and how many Gmail accounts, Cloudflare mailboxes, agents and agent keys your server has:
counts only, never an address, a name, a domain or anything from your mail. **Fabric Inbox → Share
Anonymous Usage Counts** turns it off, for every PassionCode.ai app on the Mac at once. Builds from
source and the Mac App Store package send nothing. What is sent, where, and how it is tested:
[docs/ANALYTICS.md](docs/ANALYTICS.md).

### Release

A release is a tag: push `vX.Y.Z` on the reviewed release commit and
[`.github/workflows/release.yml`](.github/workflows/release.yml) starts. A member of
`release-approvers`, who may be whoever pushed the tag, approves its `release` environment (an
agent never approves); the workflow
then builds the image with the CI Developer ID, notarizes and staples the app and then the image
made from it, builds and signs the Mac App Store package, attests every file (Sigstore), signs
`SHA256SUMS` with the organization's GPG key, publishes the GitHub release and uploads the store
package to App Store Connect. A rehearsal on a `vX.Y.Z-rc.N` tag
(`gh workflow run release.yml --ref vX.Y.Z-rc.N -f publish=false`) does the same and publishes and
uploads nothing. Procedure, the store build number and the human steps:
[docs/release.md](docs/release.md).

### Building it yourself (debug builds)

```sh
npm run desktop:dmg                                   # release/Fabric-Inbox-<version>.dmg + .sha256 + .receipt.json
npm run desktop:dmg -- --notary-profile fabric-notary # also notarized by Apple and stapled
npm run desktop:dmg -- --unsigned                     # no identity needed
```

These sign with a Developer ID in your own keychain. They are for debugging the build and are
never published, attached to a release or uploaded; their receipt says so (`builtBy`). With
`--notary-profile` the build fails unless Apple accepted the app and the image and Gatekeeper
names both `Notarized Developer ID`. The notary profile is made once from an App Store Connect API
key with the Developer role (keep the key file outside Git): `xcrun notarytool store-credentials
fabric-notary --key <key.p8> --key-id <id> --issuer <issuer> --keychain
~/Library/Keychains/login.keychain-db`. Name the keychain: without `--keychain` the command can
validate the key and not save the profile, and `notarytool` later answers "No Keychain password
item found for profile".

On first open the app offers **Create my server on Cloudflare** ([setup → Your own server](docs/desktop-mail/setup.md#your-own-server-created-by-the-mac-app-recommended)),
a **setup** file (the server, its domains and addresses), or an existing server's address. The
public build carries no one's setup or domains; any installation exports its own from **Setup → Export**. A
personal build carries one: `npm run desktop:dmg -- --setup <name>` bundles your local
`deployments/<name>/setup.json` into `Fabric-Inbox-<version>-<name>.dmg`, which is for its owner
only ([Configure your deployment](#configure-your-deployment)). See [setup → Setups](docs/desktop-mail/setup.md#setups).

Other builds: `npm run desktop:package -- arm64` (unsigned folder build for development),
`npm run desktop:mas` (Mac App Store packaging, built for release by the workflow;
[docs/app-store/mas.md](docs/app-store/mas.md)).

## Deploy

From the app: **Create my server on Cloudflare** (new) or **Fabric Inbox → Connect Cloudflare
account…** (update). By hand: [setup → Deploying the server by hand](docs/desktop-mail/setup.md#deploying-the-server-by-hand).
`wrangler.jsonc` carries no account or deployment values; a deployment's own files live in
`deployments/<name>/` on its owner's machine ([Configure your deployment](#configure-your-deployment)).
The Worker is `fabric-inbox`; the original `agentic-inbox` Worker is separate.

## Configure your deployment

Your deployment's values — Cloudflare account id, server address, Access team and audience,
domains, addresses — are yours, so they never enter Git: `deployments/<name>/` is git-ignored,
and the repository carries only [the guide](deployments/README.md) and placeholder
`deployments/*.example.json` files. **Create my server** in the app needs none of this. To deploy
by hand, keep ops receipts or make a personal build:

```sh
mkdir -p deployments/owner
cp deployments/deployment.example.json deployments/owner/deployment.json   # replace every <placeholder>
npx tsx scripts/deployment-setup.ts owner      # setup.json from a saved Email Routing inventory (optional)
npm run desktop:dmg -- --setup owner           # a personal build that carries deployments/owner/setup.json
```

`npm test` then also checks that no committed app, server or desktop file names any value of
your deployment (`tests/no-owner-data.test.ts`). Back the directory up yourself: a fresh clone
does not have it. Every field is explained in [deployments/README.md](deployments/README.md).

## License

Open source under the [GNU AGPL-3.0](LICENSE). A [commercial license](COMMERCIAL-LICENSE.md) is
available for use that does not meet the AGPL's terms — [passioncode.ai/business](https://passioncode.ai/business/).
Versions up to and including 0.7.1 were released under the Apache License 2.0.
The code imported from Cloudflare's Agentic Inbox template stays under Apache-2.0 with its
copyright notices ([third-party notices](THIRD_PARTY_NOTICES.md)). Contributions are accepted
under the [CLA](CLA.md).
