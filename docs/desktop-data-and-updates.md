# Your data, removing the app, and updates

**State:** written 2026-10-05 for 0.10.1 (operator request: everything must survive removing and
reinstalling the app, and every downloaded copy must update itself by default). Sources:
[`desktop/backup.cjs`](../desktop/backup.cjs), [`desktop/updater.cjs`](../desktop/updater.cjs),
[`desktop/main.cjs`](../desktop/main.cjs), [`desktop/dist-mac.mjs`](../desktop/dist-mac.mjs). Tests:
[`tests/desktop-updates.test.ts`](../tests/desktop-updates.test.ts),
[`tests/desktop-profile.test.ts`](../tests/desktop-profile.test.ts).

## Where everything lives

| What | Where | Survives dragging the app to the Trash | Survives an uninstaller that also deletes `~/Library/Application Support/Fabric Inbox` |
|---|---|---|---|
| Mail, folders, categories, spam lists | your server: Durable Objects and R2 in your Cloudflare account | yes | yes |
| Gmail accounts (their refresh tokens) | your server (`GmailAccountsDO`; tokens encrypted with the server secret `MAIL_CREDENTIAL_KEY`, before 0.11 `GMAIL_TOKEN_ENCRYPTION_KEY`; `workers/providers/credentials.ts`) | yes | yes |
| IMAP accounts (iCloud, Yahoo, Fastmail…): their app passwords and server names | your server only (`GmailAccountsDO`; the app password encrypted with `MAIL_CREDENTIAL_KEY`, never in the Mac's Keychain or profile) | yes | yes |
| Cloudflare accounts and their tokens, domains, addresses, routing | your server and Cloudflare itself | yes | yes |
| Agents, knowledge, rules, agent keys, the audit journal | your server | yes | yes |
| The server's address | `~/Library/Application Support/Fabric Inbox/server.json`, **and a copy in** `~/Library/Application Support/PassionCode/backups/fabric-inbox.json` | yes | yes: the copy is read back at the next start (`settings_restored` in the log) |
| The sign-in (Cloudflare Access cookie) | the server's partition in the profile, encrypted under the Keychain item "Fabric Inbox Safe Storage" | yes | no: sign in again with the code sent by email (30 days at most anyway, B-43) |
| Unsent drafts and their attachments | the server's partition (local storage and IndexedDB) | yes | no: drafts are kept on the Mac only (REL-03; server draft sync is not built) |
| Usage counts state, update switch | `analytics-state.json`, `updates.json` in the profile | yes | no; both start fresh (counting resumes, updates are on) |
| Shared PassionCode installation id and analytics switch | `~/Library/Application Support/PassionCode/installation.json` | yes | yes |

Reinstalling the same app (same bundle id `ai.passioncode.fabric-inbox`, same Developer ID team)
uses the same profile and the same Keychain item, so it opens signed in with its drafts. Time
Machine backs up both folders. The Mac App Store copy keeps its profile in its own container
(`~/Library/Containers/ai.passioncode.fabric-inbox`): moving between the store copy and the disk
image means entering the server's address once.

**Nothing is lost when the profile is gone completely**: enter the server's address (or open the
setup file, or run **Create my server** again with the same Cloudflare account, which finds the
existing server, keeps its storage and its sign-in rules, and only updates the code), then sign
in. Every connection above is on the server.

What the app itself never deletes on its own: a start with no server known keeps every server
partition (it may be the one about to be entered again); a changed server address clears the old
server's storage only after the new server answers ([AGENTS.md → Lifecycle](../AGENTS.md#lifecycle)).

## Updates

**On by default** in every copy downloaded from GitHub or passioncode.ai, from 0.10.1 on. Copies
of 0.10.0 and earlier have no updater: they are updated once by hand, and from then on by
themselves.

1. At launch, and when a window comes forward if six hours have passed, the app reads
   `https://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-mac.json`, the
   feed the latest published release carries (Squirrel.Mac's static `serverType: 'json'` format).
   No timer runs and nothing is checked with no window open (lifecycle LC-08).
2. When the feed names a newer version, Squirrel.Mac (Electron's `autoUpdater`) downloads
   `Fabric-Inbox-<version>-mac.zip` in the background. Before unpacking, it checks the zip's
   sha256 and size from the feed. After unpacking, it checks that the new app is signed by the
   same Developer ID team as the running one, and refuses anything else.
3. The new version is installed when the person quits the app. The **Fabric Inbox** menu then
   reads **Restart to Install Update** for anyone who wants it at once.
4. **Fabric Inbox → Install Updates Automatically** turns the checks off (kept in
   `<profile>/updates.json`). **Check for Updates…** checks at once whatever the switch says, and
   says what happened: up to date, downloading, ready, or why not.

Copies that never check, with the reason the log and **Check for Updates…** give:

| Copy | Why |
|---|---|
| A build from source, `npm run desktop`, a local `npm run desktop:dmg` | `no_feed` / `development`: only the release workflow writes `desktop/updates.json` |
| The Mac App Store package | `app_store`: the store updates it |
| An app opened from the disk image or from Downloads | `not_in_applications`: macOS runs it from a read-only translocated copy that cannot be replaced; drag it to Applications |

The release publishes the update with the disk image ([release.md](release.md)). The `macos` job
zips the stapled app (`ditto -c -k --sequesterRsrc --keepParent`), unpacks the zip again and
checks the unpacked app's signature and staple, then writes `update-mac.json` with the zip's
sha256 and size. Both files are release assets, covered by the attestations and the GPG-signed
`SHA256SUMS` like every other. Only a published release (not an rc rehearsal) is "latest", so no
rehearsal is ever offered as an update. A release that is pulled back is replaced by publishing a newer
version; a published release is never rewritten.

The server is updated separately: **Create my server** uploads the server the app carries
(B-44 records that this still asks for a token each time).
