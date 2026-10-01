# Cutting and publishing a release

How a version of Fabric Inbox reaches a teammate: one version across the server, the Mac app and
the skill, a signed and notarized disk image built from the commit on `main`, and a GitHub release
carrying the image and its checksum. The builder is `desktop/dist-mac.mjs`
(`npm run desktop:dmg`); what it checks is stated in its header and held by
`tests/dist-mac.test.ts`.

## Prerequisites (the release machine)

- The Developer ID Application identity: `security find-identity -v -p codesigning` lists exactly
  one `Developer ID Application: …` (or pass `--identity "<name>"`).
- A notarytool keychain profile: `xcrun notarytool history --keychain-profile fabric-notary` exits
  0. Storing it again is in the README ("Install on a Mac"). Keys stay outside Git.
- `gh auth status` with write access to `passioncode-ai/fabric-inbox`. Always pass
  `-R passioncode-ai/fabric-inbox`: a checkout that still has the `upstream` remote can make `gh`
  resolve another repository by default.
- `uvx` (from uv) for the Finder layout of the image; without it the image still installs by drag.

## Steps

1. **Version.** Bump `version` in `package.json`, `package-lock.json` (its two root entries),
   `desktop/package.json` and `plugins/fabric-inbox/.claude-plugin/plugin.json`, and add
   `## <version> — <date>` at the top of `CHANGELOG.md`. `tests/versions.test.ts` fails until all
   of them agree. A release tag that already exists is never moved: a mistake gets a new version.
2. **Gates.** `npm ci && npm test && npm run typecheck && npm run build`, then
   `python3 docs/ux/lint.py && python3 docs/ux/doctor.py && python3 docs/brand/lint.py` and
   `git diff --check`. Read each exit code. The local gate is the gate.
3. **Land.** A PR, squash-merged into `main` once its `ci` check (`.github/workflows/ci.yml`, the
   same gates on a hosted runner) is green.
4. **Build from `main`.** In a clean worktree at the merged commit:
   `npm ci && npm run desktop:dmg -- --notary-profile fabric-notary`. It writes, in `release/`:
   `Fabric-Inbox-<version>.dmg`, `Fabric-Inbox-<version>.dmg.sha256` and
   `Fabric-Inbox-<version>.receipt.json`. The build exits 1 unless Apple accepted the app and the
   image, both are stapled, and `spctl -a -vv` names `source=Notarized Developer ID` for each.
   Read the receipt: `revision` is the merged commit, `signing` names the Developer ID,
   `notarization` is `accepted and stapled`, and `checks.notarySubmission` is the image's
   submission id.
5. **Tag and publish.**

   ```sh
   git tag -a v<version> -m "Fabric Inbox <version>" <revision> && git push origin v<version>
   gh release create v<version> -R passioncode-ai/fabric-inbox --verify-tag \
     --title "Fabric Inbox <version>" --notes-file <the version's CHANGELOG section> \
     release/Fabric-Inbox-<version>.dmg release/Fabric-Inbox-<version>.dmg.sha256 \
     release/Fabric-Inbox-<version>.receipt.json
   ```

6. **Check from the download.** In an empty directory, do what the README tells a teammate
   (`gh release download …`, then `shasum -a 256 -c`). Install the copy into a temporary folder, not
   over `/Applications`, and assess it:
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
7. **Record.** Add the receipts (release URL, sha256, submission ids, Gatekeeper lines, the
   download check) to the [release entry](app-store/README.md) in a docs-only change.

A personal build (`--setup <name>`) is never attached to a release: it carries its owner's
domains and addresses.
