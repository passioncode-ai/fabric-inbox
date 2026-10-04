# Fabric Inbox — explicit Mac App Store packaging

Status: packaging and preflight implementation; since 2026-10-03 the release workflow builds and signs the distribution package in CI ([below](#release-builds-in-ci)). **No signed MAS package observed yet**: the first rehearsal waits for an approver. REL-08 remains open until a real signed candidate and sandbox acceptance exist. The [release entry](README.md) owns the wider release requirements; [task packet](tasks/mas.md) owns this bounded scope; [check report](mas-report.md) records actual evidence.

## Release builds in CI

The store identities exist only in this repository's protected `release` environment: a Mac App
Distribution and a Mac Installer Distribution certificate issued for CI (team from the
`APPLE_TEAM_ID` variable; in a keychain they are named "3rd Party Mac Developer
Application/Installer: … (team)"), and the Fabric Inbox Mac App Store profile, which authorizes
`ai.passioncode.fabric-inbox` and that application certificate only (expires 2027-10-03). No
machine holds them. The `mas` job of [`release.yml`](../../.github/workflows/release.yml) imports
them with the organization's `apple-signing@v1` action, decodes the profile into `$RUNNER_TEMP`, and
runs the distribution command below with `--arch arm64`, the action's identity names, the build
number derived from the tag and `--revision` set to the tagged commit, then `--build`. The package
and `build-receipt.json` are kept as a workflow artifact; when the release publishes,
`scripts/app-store-connect.mjs upload` sends the package to App Store Connect after checking that
the app record exists (it does since 2026-10-03, Apple id `6818818207`). Build number, upload and the record check:
[release procedure → Mac App Store](../release.md#mac-app-store).

## Commands and prerequisites (local, for debugging)

A package built on a machine is a debug build: it is never uploaded (`scripts/app-store-connect.mjs
upload` refuses to run outside GitHub Actions).

The existing `npm run desktop:package -- arm64` / `x64` commands retain unsigned `darwin` packaging. Those bundles cannot demonstrate MAS sandbox behavior. The new entry point is [desktop/mas-package.mjs](../../desktop/mas-package.mjs). It requires macOS, Xcode, Python 3, Node compatible with installed Electron tooling, and project dependencies (`@electron/packager`, `@electron/osx-sign` 2.7.0). Dependency installation is separate; running the preflight does not install anything.

Provide the Apple team the operator confirmed, the complete certificate names from the local keychain, an absolute profile path **outside the repository**, and a monotonically increased numeric build version. Identity names are public certificate metadata, not key material. Never commit/export private signing keys or provisioning profiles. This implementation requires the profile App ID prefix to equal the team; legacy prefixes need a reviewed adaptation. Only explicit bundle ID `ai.passioncode.fabric-inbox` is accepted.

Set these shell variables locally before running either command: `MAS_TEAM`, `MAS_APP_IDENTITY`, `MAS_INSTALLER_IDENTITY` (distribution only), `MAS_PROFILE`, and `MAS_BUILD_NUMBER`. Values below are supplied by the operator, not selected by the script. Keep the checkout clean; the SHA must be HEAD.

Development preflight (no download, signing or output package):

```sh
node desktop/mas-package.mjs \
  --mode development --arch arm64 \
  --team "$MAS_TEAM" --identity "$MAS_APP_IDENTITY" \
  --profile "$MAS_PROFILE" --build-number "$MAS_BUILD_NUMBER" \
  --revision "$(git rev-parse HEAD)"
```

Distribution preflight:

```sh
node desktop/mas-package.mjs \
  --mode distribution --arch arm64 \
  --team "$MAS_TEAM" --identity "$MAS_APP_IDENTITY" \
  --installer-identity "$MAS_INSTALLER_IDENTITY" \
  --profile "$MAS_PROFILE" --build-number "$MAS_BUILD_NUMBER" \
  --revision "$(git rev-parse HEAD)"
```

A successful preflight prints `preflight-passed-not-built` and `submissionReady: false`. Append `--build` to the applicable command only when ready to download a MAS runtime and use the signing key. `--arch x64` makes a separate Intel build; there is no unverified universal shortcut. The script conservatively requires 6 GiB free on both repository and temporary volumes; this is a working-space budget, not a measured package size. It never uploads, notarizes, accepts agreements or answers legal questions; uploading is the release workflow's separate step.

## What the implementation checks

`validateConfig`, `preflight`, `validateProfile` and `validateSource` reject incomplete configuration, Developer ID identities, wrong team or bundle, wildcard App IDs, wrong profile platform, expired profiles, certificates absent from the profile, distribution profiles with device/debug provisioning, nonregistered development Macs, ambiguous keychain identities, dirty sources and insufficient disk. A development profile must list this Mac, and its application certificate must be Apple Development or Mac Developer. Distribution requires Apple Distribution / 3rd Party Mac Developer Application / Mac App Distribution plus a Mac installer distribution identity. The selected identities resolve to valid private-key/certificate pairs; actual signing may still require keychain access.

The profile is decoded with `security cms`; dates and certificate fingerprints are checked in memory. Profile data and certificate blobs are not printed. Explicitly conflicting app-group authorization is rejected; absent group authorization is valid on macOS, per Apple's TN3125. These local checks are not App Store validation or a replacement for macOS signature verification.

`build` archives committed `desktop/` and `package-lock.json` into a temporary directory, pins Electron to the committed lockfile, requests `platform: mas`, and embeds the exact source SHA in Info.plist. Ignored local files in the checkout never enter this archive. Root documentation and backend changes are still represented by the exact revision; the remote workspace remains separately deployed. Output is under ignored `release/mas-MODE-ARCH-BUILD-SHA/`; an existing destination is refused. Failed outputs have no successful build receipt and must not be used.

After signing, the implementation verifies nested signatures, reads main and child entitlements back, checks architecture and bundle metadata, compares the embedded profile hash, and checks the installer signature for distribution. Only then does it write `build-receipt.json` with source revision and the distribution PKG SHA-256. Receipt status describes local checks only and always retains `submissionReady: false`. The build path has not yet been executed against real MAS credentials; its first run is the CI rehearsal awaiting approval.

## Sandbox policy and acceptance

`mainEntitlements` grants sandbox, outbound network access for the remote mail workspace, and **user-selected read/write** access: attachments can be selected for upload, and the existing `will-download` handler in [desktop/main.cjs](../../desktop/main.cjs) uses `setSaveDialogOptions` to save a selected attachment. This does not grant arbitrary filesystem access. Child code receives exactly sandbox plus inheritance (`childEntitlements`). The self application group supports Electron's sandboxed process communication; identifiers come from the confirmed team and fixed bundle ID. Only development gets `get-task-allow`. No inbound server, arbitrary file paths, JIT exceptions, disabled library validation or blanket entitlement grants are added.

Before upload, execute real launch, login/reconnect, mail reading/sending, attachment selection and Save dialog acceptance on the development-signed **MAS runtime**, including cancellation and denied access. Existing normal Electron/darwin testing is insufficient. A distribution-signed app is not a local launch test; obtain the Apple-distributed build for TestFlight/store acceptance. Neither these commands nor passing local checks imply eligibility, approval, or a live store release.

## Focused checks

```sh
node --import tsx --test tests/mas-release.test.ts tests/app-store-connect.test.ts
node --check desktop/mas-package.mjs
git diff --check
```

[tests/mas-release.test.ts](../../tests/mas-release.test.ts) exercises rejected configuration/profile/source/entitlement mutations, identity ambiguity, missing configuration through the real CLI, and the disk boundary. It does not download Electron, sign a bundle, access a private key, launch MAS, validate Apple processing, or test live mail.

## Primary references and API evidence

- [Electron MAS guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide): MAS-specific runtime, separate development/distribution signing, sandbox parent/child policy, selected-file access and distribution testing limits.
- [Apple: create an App Store Connect provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/): explicit App ID and Mac distribution profile workflow.
- [Apple TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles): profile checks, macOS unrestricted entitlements, and `codesign --display --entitlements - --xml` inspection.
- [Apple CFBundleVersion](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion): incremented numeric build versions. App Store Connect version history remains an operator verification.
- Installed `@electron/osx-sign` 2.7.0 `dist/types.d.ts`, `sign.js`, `flat.js`, `util-identities.js`, and `util-entitlements.js` were read: `sign`, `optionsForFile`, `preAutoEntitlements: false`, profile embedding, certificate-hash identity selection, and `flat` native MAS `productbuild` flow. Installed `@electron/packager` `dist/mac.js` and types were read for `platform`, `osxSign: false`, and `buildVersion`.
