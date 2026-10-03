# Cutting and publishing a release

How a version of Fabric Inbox reaches a teammate and the Mac App Store: one version across the
server, the Mac app and the skill, built and signed **only in GitHub Actions**
([`.github/workflows/release.yml`](../.github/workflows/release.yml)), in this repository's
protected `release` environment. This follows the organization's release signing
([passioncode-ai/.github `release-signing/README.md`](https://github.com/passioncode-ai/.github/blob/main/release-signing/README.md)):
a member of `release-approvers` approves the signing jobs, and that may be whoever pushed the
tag (operator decision, 2026-10-03); an agent never approves a release run, even when its account
could; admins cannot bypass it. Nobody's laptop holds a release key, and a build signed anywhere else is a debug
build that is never published, attached to a release or uploaded to App Store Connect.

## What a release is

| Job | Approval | What it does |
|---|---|---|
| `gate` | none | On the tagged commit: the tag names the version every manifest carries (`vX.Y.Z` or `vX.Y.Z-rc.N`), the store build number is derived from it, then `npm test` and `npm run typecheck` |
| `macos` | `release` | The Developer ID disk image (below) |
| `mas` | `release` | The Mac App Store package, and its upload when publishing (below) |
| `publish` | `release` (it holds the GPG key) | The organization's `release-publish.yml@v1`: attests every `release-*` file (Sigstore), writes `SHA256SUMS` and `SHA256SUMS.asc`, then creates the GitHub release with the notes of `## <version>` in [CHANGELOG.md](../CHANGELOG.md) |

`publish` waits for `gate` and `macos` only. The store job does not hold the disk image back: a
store upload Apple refuses fails the `mas` job alone.

### Disk image

The `macos` job. The identity is the one the organization's `apple-signing@v1` action imports
into a throwaway keychain (the CI Developer ID, team from the `APPLE_TEAM_ID` variable); the builder
[`desktop/dist-mac.mjs`](../desktop/dist-mac.mjs) is told its name and never picks one. The image
is made from the **stapled** app, so the builder runs in three stages around the shared
`notarize@v1` action, which notarizes with the App Store Connect API key, requires Accepted (and
prints Apple's log otherwise), staples, and assesses with `spctl`:

1. `--stage app --identity <name>`: the universal app, built from the committed tree (`git archive`
   of the tag's commit, with the server bundle from the same commit), signed with the hardened
   runtime, checked with `codesign --verify --deep --strict`, into `release/ci/`.
2. `notarize@v1` on `release/ci/Fabric Inbox.app`.
3. `--stage image --identity <name> --submission <id>`: refuses an app that is not stapled or that
   Gatekeeper does not name `Notarized Developer ID`, then makes the image and signs it.
4. `notarize@v1` on `release/Fabric-Inbox-<version>.dmg`.
5. `--stage finish --submission <id>`: the image's staple and Gatekeeper verdict
   (`context:primary-signature`, `source=Notarized Developer ID`), then
   `Fabric-Inbox-<version>.receipt.json` with both submission ids, the hashes and the run that
   built it.

The release files are the image and its receipt (artifact `release-macos`). The image's own
`.sha256` is not published any more: the GPG-signed `SHA256SUMS` covers every file, so a second,
unsigned checksum would add nothing. Releases up to 0.8.2 carry a `.sha256` instead.

### Mac App Store

The store package, built by the `mas` job:

1. **App record.** `node scripts/app-store-connect.mjs check-record` asks App Store Connect
   (`GET /v1/apps?filter[bundleId]=ai.passioncode.fabric-inbox`, with the same API key) whether
   the app record exists. When publishing, a missing record stops the job here, before the build,
   with a message that names the human step below. A rehearsal only reports it as a warning.
2. **Identities and profile.** `apple-signing@v1` also imports the CI-only Mac App Distribution
   and Mac Installer Distribution certificates (`APPLE_DISTRIBUTION_P12_B64`,
   `APPLE_INSTALLER_P12_B64`, `APPLE_MAS_P12_PASSWORD`) and names them (`mas-app-identity`,
   `mas-installer-identity`: "3rd Party Mac Developer Application/Installer: … (team)").
   `MAS_PROVISION_PROFILE_B64` is decoded into `$RUNNER_TEMP`, outside the repository, and removed
   at the end. The profile authorizes `ai.passioncode.fabric-inbox` and the CI Mac App
   Distribution certificate only.
3. **Build.** [`desktop/mas-package.mjs`](../desktop/mas-package.mjs)
   `--mode distribution --arch arm64` with the team, both identities, the profile, the build
   number and `--revision ${{ github.sha }}`, then `--build`: every check in
   [app-store/mas.md](app-store/mas.md), the signed package and `build-receipt.json`. Both are kept
   as the workflow artifact `mas-pkg-<version>-<build number>` for 14 days. The package is not a
   release file: only the store installs it.
4. **Upload, only when publishing.** `node scripts/app-store-connect.mjs upload <pkg>` checks the
   app record again, writes the API key to `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`
   (0600; one of the places `altool` reads) for the one call, runs
   `xcrun altool --upload-app -f <pkg> -t macos --apiKey <id> --apiIssuer <issuer>`, and removes
   the key file after success or failure. It refuses to run outside GitHub Actions. An upload is
   not a submission for review: Apple processes the build, then it appears under TestFlight.

**The store build number** (`CFBundleVersion`) has to grow with every upload, and App Store Connect
refuses one it has seen. It is derived from the tag, not from a counter:
`vM.m.p` → `(M·100+m).p.99` and `vM.m.p-rc.N` → `(M·100+m).p.N`, so 0.8.2-rc.1 is `8.2.1`, 0.8.2 is
`8.2.99`, and 0.8.3-rc.1 is `8.3.1`. An rc sorts below its release and every release below the
next version. Re-running a tag gives the same number, which Apple refuses as a second upload, the
same rule as GitHub's: a published release is never rebuilt; a fix is a new tag. The limits (major
and minor and patch up to 99, rc up to 98) and the ordering are held by
`tests/app-store-connect.test.ts`.

The store package is Apple silicon only (`--arch arm64`). `mas-package.mjs` builds one architecture
per package and has no checked universal path; Intel Macs install the universal disk image.

## Steps

1. **Version.** Bump `version` in `package.json`, `package-lock.json` (its two root entries),
   `desktop/package.json` and `plugins/fabric-inbox/.claude-plugin/plugin.json`, and turn
   `## Unreleased` in `CHANGELOG.md` into `## <version> — <date>` (under an agent-sync lease:
   [AGENT_SYNC.md](AGENT_SYNC.md)). `tests/versions.test.ts` fails until all of them agree.
2. **Gates.** `npm ci && npm test && npm run typecheck && npm run build`, then
   `python3 docs/ux/lint.py && python3 docs/ux/doctor.py && python3 docs/brand/lint.py` and
   `git diff --check`. Read each exit code. The local gate is the gate.
3. **Land.** A PR, merged into `main` once its `ci` check (`.github/workflows/ci.yml`) is green.
4. **Rehearse** (recommended before every release): an annotated `v<version>-rc.<n>` tag on the
   merge commit (never reuse or move a tag; `git ls-remote --tags origin` first), then

   ```sh
   git tag -a v<version>-rc.<n> -m "Fabric Inbox <version> rc <n>" <merge commit>
   git push origin v<version>-rc.<n>
   gh workflow run release.yml -R passioncode-ai/fabric-inbox --ref v<version>-rc.<n> -f publish=false
   ```

   The push trigger ignores `-rc` tags, so nothing starts until the dispatch. `gate` runs at once;
   `macos`, `mas` and `publish` wait for an approver. The signed, attested set (with
   `SHA256SUMS.asc` and the notes) is kept as the artifact `signed-release-<tag>` for 14 days, the
   store package as `mas-pkg-…`. No release is created and nothing is uploaded to App Store Connect.
5. **Tag.** `git tag -a v<version> -m "Fabric Inbox <version>" <merge commit> && git push origin v<version>`.
   A release tag that already exists is never moved: a mistake gets a new version.
6. **Approve.** A member of `release-approvers`, whoever pushed the tag included, opens the run and
   approves ("Review deployments") the `release` environment for the signing jobs, then again for
   `publish`.
7. **Check from the download.** In an empty directory, do what the README tells a teammate
   (`gh release download …`, `gpg --verify SHA256SUMS.asc SHA256SUMS`,
   `shasum -a 256 -c SHA256SUMS --ignore-missing`, `gh attestation verify`). Install the copy into
   a temporary folder, not over `/Applications`, and assess it:
   `spctl -a -vv -t execute "<folder>/Fabric Inbox.app"` (`source=Notarized Developer ID`) and
   `xcrun stapler validate` on the app and the image. Then check its agent protocol:
   `node scripts/check-installed-app.mjs "<folder>/Fabric Inbox.app"` takes the server the app
   carries out of its `app.asar`, runs it on `127.0.0.1` in workerd behind a local stand-in for
   Cloudflare Access with empty storage and no network, and calls `<origin>/mcp`: `initialize`,
   `tools/list`, `list_accounts`, and `initialize` without Access, which must answer 403. It exits
   0 only when all four answer as expected. With `--keep-serving` it stays up, so the installed
   app can be pointed at that origin.
   Launch the app with its own data folder
   (`"<folder>/Fabric Inbox.app/Contents/MacOS/Fabric Inbox" --user-data-dir=<temp>`), so it does
   not share an installed copy's settings or single-instance lock; a `server.json` of
   `{"origin":"<origin>","accessOrigin":""}` in that folder makes it open the check's server. Quit
   it by its process id (not by bundle id, which would also quit an installed copy), then run
   `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "<folder>/Fabric Inbox.app"`
   so Launch Services forgets the temporary copy.
8. **Record.** Add the receipts (run URL, release URL, sha256, both submission ids, Gatekeeper
   lines, the store build number and its App Store Connect state, the download check) to the
   [release entry](app-store/README.md) in a docs-only change.

## Human steps

- **Approving** the `release` environment (step 6): a person from `release-approvers`, who may be
  whoever pushed the tag; never an agent.
- **The App Store Connect app record** for `ai.passioncode.fabric-inbox` does not exist yet, and the
  App Store Connect API cannot create one. Until a person with the Account Holder, Admin or App
  Manager role creates it (App Store Connect → Apps → + → New App, platform macOS, bundle id
  `ai.passioncode.fabric-inbox`, a name and SKU), every publishing run's `mas` job stops at the
  record check with that message, and the disk image is released without it. Nothing else changes
  when it exists: the next release uploads.
- **Rotating** the CI certificates or renewing the profile (it expires 2027-10-03) is the
  organization's procedure (`release-signing/README.md` → Rotating), followed by syncing the
  `release` environment's secrets.

## A local build is for debugging

`npm run desktop:dmg` (optionally `--notary-profile <name>` with a notarytool keychain profile, or
`--unsigned`) and `node desktop/mas-package.mjs …` still work on a Mac with a Developer ID or store
identity, for debugging the build itself. Their receipts say `builtBy: this machine (a debug build:
never published)`. Never attach such a build to a release or upload it: the upload command refuses
to run outside GitHub Actions. A personal build (`--setup <name>`) carries its owner's domains and
addresses and is never published at all; the workflow refuses `--setup` in a CI stage.
