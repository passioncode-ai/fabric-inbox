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
| Outlook accounts (Outlook.com, Microsoft 365): their Microsoft access and refresh tokens, and where each folder's sync stands | your server only (`GmailAccountsDO`; tokens encrypted with `MAIL_CREDENTIAL_KEY`, a rotated refresh token sealed the moment Microsoft returns it; never on the Mac) | yes | yes |
| The Outlook app registration's client secret | your server only (Worker secret `MICROSOFT_CLIENT_SECRET`; its end date in the var `MICROSOFT_CLIENT_SECRET_EXPIRES`) | yes | yes |
| IMAP accounts (iCloud, Yahoo, Fastmail…): their app passwords and server names | your server only (`GmailAccountsDO`; the app password encrypted with `MAIL_CREDENTIAL_KEY`, never in the Mac's Keychain or profile) | yes | yes |
| Cloudflare accounts and their tokens, domains, addresses, routing | your server and Cloudflare itself | yes | yes |
| Agents, knowledge, rules, agent keys, the audit journal | your server | yes | yes |
| The server's address | `~/Library/Application Support/Fabric Inbox/server.json`, **and a copy in** `~/Library/Application Support/PassionCode/backups/fabric-inbox.json` | yes | yes: the copy is read back at the next start (`settings_restored` in the log) |
| The sign-in (Cloudflare Access cookie) | the server's partition in the profile, encrypted under the Keychain item "Fabric Inbox Safe Storage" | yes | no: sign in again with the code sent by email (30 days at most anyway, B-43) |
| Unsent drafts and their attachments | the server's partition (local storage and IndexedDB) | yes | no: drafts are kept on the Mac only (REL-03; server draft sync is not built) |
| Usage counts state, update switch, the last install | `analytics-state.json`, `auto-update` (only when updates were turned off), `update-install.json` (between an install and the next start) in the profile | yes | no; both start fresh (counting resumes, updates are on) |
| The app's log | `~/Library/Logs/Fabric Inbox/fabric-inbox.log` (and `.1.log`, about 2 MB at most) | yes | no |
| A verified update waiting for Squirrel.Mac | `~/Library/Caches/Fabric Inbox/updates/` (removed once Squirrel.Mac has its copy, or after a failure) | yes | no |
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

**On by default** in every copy downloaded from GitHub or passioncode.ai. The first published
release that updates itself is **0.11.0**: 0.10.1 carried the updater but was never published (its
release run was cancelled), so copies of 0.10.0 and earlier are updated once by hand, and from then
on by themselves. 0.11.0 hands the feed to Squirrel.Mac directly; from 0.12.0 every step below
applies.

Fabric Inbox follows the organization's one update behaviour for every product (LC-16 in
fabric-workspace `knowledge/lifecycle.md`): the same switch, cadence, verification and log codes
as Fabric Switchboard, Fabric and Fabric Dashboards.

1. **Cadence.** The first check runs 90 s after the app starts, then every 6 h while it runs,
   with or without a window (one timer, which never holds the app open; `desktop/updater.cjs`).
   After a failed check one retry follows within the hour, then the 6-hour rhythm again. Each
   check reads `https://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-mac.json`,
   the feed the latest published release carries. No environment variable can point a released
   copy at another feed: the address is written into the app by the release workflow.
2. **Only newer.** The feed's `currentRelease` is compared with the app's version, numerically.
   An older or equal release is logged (`update_check current`) and nothing is downloaded; a feed
   that names no `X.Y.Z` version is a failed check. The release build also sets
   `ElectronSquirrelPreventDowngrades`, so Squirrel.Mac itself refuses an older bundle.
3. **Verified by the app before anything can replace it** (`desktop/update-verify.cjs`). Squirrel.Mac
   checks only that a new bundle satisfies the running app's designated requirement; it does not
   check the zip's sha256 or size. So the app does the rest itself, and the first failure stops the
   update (`update_check signature_failed`, nothing installed, the app keeps running):
   - the release's `SHA256SUMS` must carry a valid signature by the organization's release key,
     pinned in the app (`desktop/release-key.asc`, fingerprint
     `63B3 0DC3 24BD 6974 87AA 3194 4FAF B8AE C803 B6A7`, checked with Node's own Ed25519 in
     `desktop/pgp-verify.cjs`; no OpenPGP library is bundled);
   - the feed itself must be listed in that `SHA256SUMS` with its own digest, so the version, the
     file it names and a held-for-migration mark are all covered by the signature;
   - the zip must be this product's file of that same release, and the downloaded bytes must have
     the signed digest and size;
   - the app inside, unpacked with `ditto` into a scratch folder, must pass
     `codesign --verify --deep --strict` against a Developer ID requirement of the pinned team
     `KJ35UYYL22` (never "whoever signed this copy"), its `CFBundleShortVersionString` must be the
     announced version and its bundle id this app's (`plutil`).
4. **Handed over, then installed at a safe point.** Only the verified zip reaches Squirrel.Mac,
   through a local feed (`file://`) in `~/Library/Caches/Fabric Inbox/updates/`, so it installs
   the very bytes that were checked. Squirrel.Mac's `ShipIt` installs it when the person quits;
   the menu reads **Restart to Install Update** for anyone who wants it at once. A running session
   is never stopped for an update. The next start logs whether the install happened
   (`update_install installed` or `failed`, from `update-install.json`).
5. **Held releases.** A release whose feed marks `migration` (a runbook URL; `feedFor` in
   `desktop/updater.cjs`) is downloaded and verified once but not installed: **Check for Updates…**
   names the step and its runbook, and the log says `update_check needs_migration`. Later checks
   do not download it again while the feed still offers it. The desktop app keeps no data that
   needs a migration today, so no Inbox release has used it.
   **Refused by Squirrel.Mac.** A verified version Squirrel.Mac refuses (`install_failed`), or that
   it does not answer within 15 minutes, is not downloaded again for 24 hours. A copy this Mac
   account cannot replace (installed by another account, a read-only folder) never downloads and
   says why (`not_replaceable`).
6. **The switch** is the file `auto-update` in the profile: absent means on, only the word `off`
   turns checks and downloads off, and a check already running hands nothing to Squirrel.Mac.
   **Fabric Inbox → Install Updates Automatically** writes `off` or removes the file; an update or
   a reinstall never touches it. The `updates.json` of 0.11.0 is carried over once and removed.
   One exception, recorded in `AGENTS.md` → Lifecycle as LC-16 asks: an update Squirrel.Mac
   already downloaded before the switch went off still installs when the app quits, because
   Squirrel.Mac offers no way to withdraw a staged update. **Check for Updates…** checks at once
   whatever the switch says, and says what happened: up to date, downloading, ready, held,
   refused by verification, or why not.
7. **The log** is `~/Library/Logs/Fabric Inbox/fabric-inbox.log` (`desktop/log.cjs`), JSON lines
   with codes only: `update_check` (`current`, `ready`, `check_failed`, `download_failed`,
   `signature_failed`, `install_failed`, `needs_migration`, with a short `reason` code such as
   `zip_sha256` or `codesign`), `update_download` (`started`, `done`), `update_install`
   (`started`, `installed`, `failed`, `timeout`), `update_restart` (`requested`, `refused`),
   `auto_update` (`on`, `off`).

Copies that never check, with the reason the log and **Check for Updates…** give:

| Copy | Why |
|---|---|
| A build from source, `npm run desktop`, a local `npm run desktop:dmg` | `no_feed` / `development`: only the release workflow writes `desktop/updates.json` |
| The Mac App Store package | `app_store`: the store updates it |
| An app opened from the disk image or from Downloads | `not_in_applications`: macOS runs it from a read-only translocated copy that cannot be replaced; drag it to Applications |

The release publishes the update with the disk image ([release.md](release.md)). The `macos` job
zips the stapled app (`ditto -c -k --sequesterRsrc --keepParent`), unpacks the zip again and
checks the unpacked app's signature and staple, then writes `update-mac.json` with the zip's
sha256 and size. Both are listed in the GPG-signed `SHA256SUMS`, which is what the app checks. Both files are release assets, covered by the attestations and the GPG-signed
`SHA256SUMS` like every other. Only a published release (not an rc rehearsal) is "latest", so no
rehearsal is ever offered as an update. A release that is pulled back is replaced by publishing a newer
version; a published release is never rewritten.

The server is updated separately: **Create my server** uploads the server the app carries
(B-44 records that this still asks for a token each time).


## Windows and Linux

The same app and the same rules, per the organization's platform decisions (fabric-workspace
`knowledge/platforms.md`, PL-01…PL-08). Builder: [`desktop/dist-platform.mjs`](../desktop/dist-platform.mjs);
installer step of an update: [`desktop/platform-installer.cjs`](../desktop/platform-installer.cjs);
tests: [`tests/desktop-update-platform.test.ts`](../tests/desktop-update-platform.test.ts),
[`tests/desktop-platform-build.test.ts`](../tests/desktop-platform-build.test.ts); CI:
[`.github/workflows/platforms.yml`](../.github/workflows/platforms.yml).

### Where everything lives

Everything on the server is the same as on the Mac (the table above). On the computer, Electron's
own folders are used (`app.getPath` in `desktop/main.cjs`):

| What | Windows | Linux |
|---|---|---|
| The app | `%LOCALAPPDATA%\Programs\Fabric Inbox\` (per-user NSIS install, no administrator rights, PL-01) | the AppImage wherever you keep it; or `/opt/Fabric Inbox/` with `/usr/bin/fabric-inbox` from the `.deb` |
| Profile (`server.json`, partitions, `auto-update`, `update-install.json`, `analytics-state.json`) | `%APPDATA%\Fabric Inbox\` | `~/.config/Fabric Inbox/` (or under `XDG_CONFIG_HOME`) |
| The server address's copy | `%APPDATA%\PassionCode\backups\fabric-inbox.json` | `~/.config/PassionCode/backups/fabric-inbox.json` |
| The app's log | `logs\fabric-inbox.log` inside the profile | `logs/fabric-inbox.log` inside the profile |
| The sign-in cookie's key (PL-05) | DPAPI, bound to the Windows account | the Secret Service (GNOME Keyring, KWallet); without one the app **refuses to start** rather than keep the sign-in in plain text (`key_store_refused` in the log) |
| `fabric-inbox://` links (PL-04) | `HKCU\Software\Classes\fabric-inbox`, written by the installer and removed by its uninstaller | `MimeType=x-scheme-handler/fabric-inbox` in the `.desktop` entry of the `.deb`; an AppImage gets it when an AppImage integrator installs its entry |

Uninstalling on Windows (Settings → Apps, or `Uninstall Fabric Inbox.exe`) removes the program
and the link registration and leaves the profile, as on the Mac; removing `%APPDATA%\Fabric Inbox`
too costs the sign-in and unsent drafts, and the server's address comes back from the PassionCode
copy. `apt remove fabric-inbox` leaves `~/.config/Fabric Inbox` the same way.

### Updates

The steps above (cadence, only newer, the switch, held releases, the log codes) are the same; what
differs is the feed, the file and who installs it (PL-03):

| Copy | Feed | Checked before install | Installed by |
|---|---|---|---|
| Windows, installed by the released installer | `update-win32-<arch>.json` | the signed `SHA256SUMS`, the feed, the installer's digest and size; the installer's `ProductVersion` is the announced version (PowerShell); once the running copy is Authenticode-signed, the update must be too, by PassionCode (PL-02) | the verified installer, copied to the cache's `pending-update` folder and run silently in update mode (`/S --updated`) as the app quits, or with `--force-run` on **Restart to Install Update** (Help menu) |
| Linux AppImage | `update-linux-<arch>.json` | the signed `SHA256SUMS`, the feed, the AppImage's digest and size, and that it is an AppImage (ELF with the type-2 magic) | the app itself: the verified AppImage is copied beside the running AppImage file and renamed over it, so the running copy keeps its old file and the next start is the new version; **Restart to Install Update** starts the new file |
| Linux `.deb` | none | — | never checks (`package_manager`): download the next `.deb`, or use the AppImage |
| A build from source, `npm run desktop:win` / `desktop:linux` outside the release workflow | none | — | never checks (`no_feed`) |

A Windows copy started from somewhere other than its install folder (no `Uninstall Fabric
Inbox.exe` beside it) does not update itself (`not_in_applications`; **Check for Updates…** says to
install it with the installer). A copy whose folder this account cannot write is `not_replaceable`.

**Authenticode (PL-02).** Windows installers are signed with Azure Artifact Signing in the release
workflow once the organization's identity validation is complete and the release environment's
`AZURE_SIGNING_ENABLED` is `true`; until then they are **unsigned** (SmartScreen warns on first
run), their receipt says `windows_authenticode: NOT_SIGNED`, and the GPG-signed `SHA256SUMS` is
what an installed copy trusts.
