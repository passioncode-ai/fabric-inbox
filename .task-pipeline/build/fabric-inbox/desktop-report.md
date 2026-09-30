# Fabric Inbox desktop host handoff

Objective and ownership: [bounded packet](desktop-brief.md). Entry: `desktop/main.cjs`; policy: `desktop/policy.cjs`; checks: `tests/desktop-policy.test.ts`. Root owns integration, UX/brand coverage updates, package scripts and release decisions.

Completed: isolated Electron runtime package, local server setup, mode-600 atomic server settings, persistent session partition per server, native menus, explicit offline/retry/configure states, Gmail server-start route in system browser, macOS packaging script. Local setup has a narrow bridge; remote windows have no preload/Node and enforce context isolation/sandbox. Setup IPC accepts only its exact local main frame (`desktop/policy.cjs:46`, `desktop/main.cjs:131`). Remote navigation allows the configured origin and optional exact Cloudflare Access team origin; safe external destinations require a native browser confirmation. Gmail from the native Account menu opens only the server's `/api/accounts/gmail/connect`, without copying a supplied OAuth query (`desktop/policy.cjs:44`). Device permissions denied; attachment downloads prompt a save location.

Commands from repository root after root dependency installation:

- `./node_modules/.bin/electron desktop`
- `node --test tests/desktop-policy.test.ts`
- `node desktop/package.mjs arm64` (or `x64`)
- Local output: `release/Fabric Inbox-darwin-arm64/Fabric Inbox.app`

Checks actually run, 2026-09-26:

| Check | Result | Boundary |
|---|---|---|
| `node --test tests/desktop-policy.test.ts` | 7 pass, 0 fail | Host URL/navigation/IPC/session policy and failed-load lifecycle regression |
| `node --check desktop/main.cjs` | exit 0 | Syntax |
| `node --check desktop/preload.cjs` | exit 0 | Syntax |
| `node --check desktop/setup.js` | exit 0 | Syntax |
| `node desktop/package.mjs arm64` | exit 0 | Electron 44.4.5, packager 20.3.0; unsigned macOS arm64 bundle |
| Native CUA setup walkthrough | observed | HTTP nonlocal address rejected with inline recovery text |
| Native CUA disconnected server | observed | Loopback port refusal shows retry/configure and explicit absence of offline mail |
| Native CUA local HTTP fixture | observed | Remote document reported `require`, `process`, `fabricSetup` all undefined |
| Packaged app launch after graceful quit | observed | Fabric Inbox window/menu; fixture cookie marker restored across restart |

The walkthrough caught Chromium finishing its error document after `did-fail-load`, which previously closed the recovery window. `loadFailed` now keeps recovery visible (`desktop/main.cjs:89`); the final test drives this event order. Screenshot inspection found setup controls readable and reachable. The synthetic loopback fixture was stopped and only its exact task-created server setting was removed. No real server account, mail, tool, cookie or credential was inspected. A persistent non-sensitive fixture cookie expires after five minutes.

Coverage limits: SCN-001 startup/config/session is partly observed; actual Cloudflare Access authentication is unverified. SCN-002 has the Gmail connection entry only, not a verified provider grant. SCN-019 has honest offline recovery, but no offline mailbox cache, local draft recovery or device tool runner. Do not mark these full scenarios implemented. The host loads the remote web app; this is narrower than the architecture's proposed bundled local renderer/cache. No mailto/default-mail-handler registration, signing, notarization, auto-update or production validation is included.

Cloudflare Access email-code login can remain on the explicitly configured team origin. An external IdP navigation goes to the system browser and cannot share its authentication cookies with Electron; full SSO handoff is still open. No arbitrary IdP allowlist or cookie-copy mechanism was added. Persistent Chromium session state was verified only with a synthetic expiring cookie, not a production Access token.

Prerequisites: root Electron and packager dependencies; a reachable configured Fabric Inbox origin; optional exact Access team origin. Real Gmail connection additionally needs the root server OAuth configuration. Build artifact is local-only/ignored. Source work has not been pushed.

Next task: root cherry-picks the commit, adds package scripts and exact desktop coverage/strings to UX/brand records in the integration change, then validates the authenticated mail app and provider flow with controlled accounts. Preserve the explicit cache/SSO/mailto gaps. Sources consulted: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) and [webContents navigation events](https://www.electronjs.org/docs/latest/api/web-contents). No certificate or permission protection was disabled.
