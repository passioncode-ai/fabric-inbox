# MAS packaging task — implementation complete, signed artifact blocked

Objective: [REL-08 and bounded task packet](tasks/mas.md), using the shared [release contract](README.md). Entry point and next commands: [MAS guide](mas.md). No MAS package, signing attempt, upload, legal acceptance, or approval occurred.

## Commits and ownership

- [f6f0814420f6e120b3734920e6d2d925a4a79a76](https://github.com/passioncode-ai/fabric-inbox/commit/f6f0814420f6e120b3734920e6d2d925a4a79a76): initial configuration, preflight, build verification, focused tests and guide.
- [6664d4b58bdb1452a2eb85335586a2d69333ae2f](https://github.com/passioncode-ai/fabric-inbox/commit/6664d4b58bdb1452a2eb85335586a2d69333ae2f): installed-API correction and executable dependency import test. Official Electron guide still shows `signAsync`/`flatAsync`, while installed 2.7.0 exports `sign`/`flat`; the import probe found the mismatch and the final test guards it.

Both commits were resolved with `git rev-parse` / commit output locally. They are on `codex/mas-release-build`, based on `ef6357f`; controller must integrate and push before the remote commit links are delivery evidence. Only desktop packaging, `tests/mas-release.test.ts`, and this task's two docs were edited. No UI, `desktop/main.cjs`, package/lock, shared release index, or scenario edits.

Controller dependency/script changes required: exact devDependency `"@electron/osx-sign": "2.7.0"` and `"desktop:mas": "node desktop/mas-package.mjs"`. Existing `@electron/packager` and Electron lock pins remain owned by controller. Node tests used a temporary `node_modules` symlink to the existing workbench dependencies, removed after testing; it was not committed or used to serve UI.

## Checks actually run

| Check | Result and scope |
|---|---|
| `node --import tsx --test tests/mas-release.test.ts` | 11 passed, 0 failed, 0 skipped. Rejected config, profile, identity, source and entitlement mutations; disk boundary; real missing-config CLI; actual installed dependency exports. |
| `node --check desktop/mas-package.mjs` and `node --check desktop/package.mjs` | Passed syntax checks. |
| `git diff --check` | Passed whitespace check. |
| Clean-checkout distribution preflight using exact HEAD and an unavailable MAS identity | Exit 1: `The exact signing identity must resolve to one valid certificate/private-key pair.` No `release/` directory created. |
| `security find-identity -v -p codesigning` and `security find-identity -v` | One valid identity, Developer ID Application; no valid MAS application or installer identity. Identity inventory is not program membership or confirmed team authorization. |
| `xcodebuild -version` | Xcode 27.0, build 27A266a. |
| `df -h . /tmp` | About 1.1 GiB available at check time; below the script's conservative 6 GiB floor. |
| Standard local macOS profile directory inspection | Zero `.provisionprofile` files in `~/Library/MobileDevice/Provisioning Profiles`; one in `~/Library/Developer/Xcode/UserData/Provisioning Profiles`. Decoded in memory with `security cms`: macOS, expires 2027-09-26, bundle of another, unrelated app, not Fabric Inbox. Other locations were not searched. |

The final 11-test run used the actual installed packages without invoking packaging or signing. Node 26 emitted the existing tsx `module.register()` deprecation warning; it did not fail tests. No full hosted suite was dispatched.

## Verified-by reads and side effects

- Read [desktop/main.cjs](../../desktop/main.cjs) `will-download` / `setSaveDialogOptions` at lines 81–83. Controller review prompted selected-file **read/write**, so Save attachment is covered as well as upload selection. No arbitrary filesystem entitlement was granted.
- Read installed `@electron/osx-sign` 2.7.0 `dist/index.js`, `types.d.ts`, `sign.js`, `flat.js`, `util-identities.js`, `util-entitlements.js`; read `@electron/packager` mac implementation/types. The [guide](mas.md#primary-references-and-api-evidence) lists official Electron/Apple sources. Apple TN3125 was read through its linked Markdown representation, including unrestricted macOS entitlements and explicit XML signature inspection.
- Read [build implementation](../../desktop/mas-package.mjs): preflight precedes build imports; `--build` is mandatory for packaging; committed archive is used; signing/profile failures stop; new output path is required; parent and nested entitlements are read back; receipt appears only after local checks. This source inspection is **not executed signing evidence**.
- Real preflight left `release/` absent. Dependencies were linked, not installed; no runtime download, private-key export, profile write, backend/UI change, external message, upload or agreement acceptance.
- Local policy checker existed and was run at task start; it returned no enrolled-repository notice here. No policy acknowledgement for another session is claimed.

## Open work, decisions and exact next task

Controller reviews and integrates the commit range plus its package/lock changes. Next: obtain the operator-confirmed Apple team, a Fabric Inbox explicit App ID/profile, valid MAS application and installer key pairs, and adequate free disk; run the documented development preflight on a clean exact revision. Do not use the unrelated profile or infer authorization from the Developer ID identity.

Then explicitly build the MAS development app and execute the sandbox acceptance in [MAS guide](mas.md#sandbox-policy-and-acceptance), including attachment Save/cancel, upload, login, reconnect and mail actions. Only afterward build the distribution package and preserve its receipt, source SHA and PKG hash. Production mail environment and App Store processing/review remain in the controller's shared release contract. Distribution-signed apps are not local launch acceptance; use Apple-distributed TestFlight/store builds for that stage.

Limitations: actual MAS runtime/signing/flattening/child-entitlement verification has not run; no build is submit-ready. Profile checks inspect the CMS plist fields and do not replace platform DER/profile validation. Legacy App ID prefixes different from the team are deliberately unsupported pending a reviewed configuration. Build-number monotonicity against App Store Connect history cannot be established offline. The 6 GiB floor is an estimate for temporary/build workspace. Read/write access remains scoped to files the user selects; any new device/tools requirements must be reviewed separately.
