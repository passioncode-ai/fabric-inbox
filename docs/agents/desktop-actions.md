# Every action of the desktop app, and the agent's door to it

**State:** written 2026-11-08 for 1.2.0, from `desktop/menu.cjs` and the callbacks
`desktop/main.cjs` `installMenu()` passes to it (lines 1334 to 1367). It answers the board
announcement ea54cd39 (thread a5885efd): every action the app offers a person is an agent's action too,
or the reason it is not is written down. Fabric task 946bf8fb, backlog B-236.

The app has no port of its own and no MCP surface (AGENTS.md, "Lifecycle"). An agent reaches what the
app does through five kinds of door:

- **server**: the server's MCP tools ([mcp.md](mcp.md)), with an agent key;
- **link**: a `fabric-inbox://` link the app handles (today only `connect`, `desktop/connect.cjs`);
- **launch**: the app's own launch flags (`--background`) through the lifecycle broker (`inbox.desktop`);
- **profile**: a file in the app's profile that the app reads **at launch only**, so a change needs the
  broker's `lifecycle.restart`;
- **none**: no door yet; the gap is backlog B-236.

A step that needs the person on purpose (a sign-in with the code Cloudflare emails, a consent screen, a
typed secret) is a human gate, not a missing door; the row says so.

## The app menu (Fabric Inbox; File and Help on Windows and Linux)

| Action | Code | Door | How an agent does it |
|---|---|---|---|
| Check for Updates…, Update to {version}…, Restart to Install Update | `desktop/main.cjs:1338` (`checkForUpdates`, `restartToUpdate`), `desktop/updater.cjs` | partial | The app checks by itself 90 s after start and every 5 min; a staged update installs when the app quits, so the broker's `lifecycle.restart` of `inbox.desktop` installs it. Asking for a check now has no door. |
| Install Updates Automatically | `desktop/main.cjs:1350`, `desktop/updater.cjs:37` (`auto-update` file) | profile | Write `off` (or remove the file) in the profile, then `lifecycle.restart`. |
| Update Server (when the server is older) | `desktop/main.cjs:1353`, `desktop/server-update.cjs` | none, by design | The app updates the server by itself at sign-in when updates are automatic (B-44). The route is listed under "Routes no tool calls" in [mcp.md](mcp.md): replacing the server's code is the person's app's act. |
| Share Usage Details, About Usage Counts… | `desktop/main.cjs:1351`, `desktop/analytics.cjs:39` (`analytics-state.json`) | none | The switch is the person's privacy choice; a door would change it for them. Kept without a door unless the operator asks (B-236 names it). |
| Open at Login | `desktop/main.cjs:1352`, `desktop/autostart.cjs` | none | The system's login item (macOS, Windows) or the autostart entry (Linux). B-236. |
| Notify About New Mail | `desktop/main.cjs:1354`, `desktop/new-mail.cjs:12` (`new-mail-notifications` file) | profile | Write `on` in the profile, then `lifecycle.restart`. |
| Agent Console Skips Permission Prompts | `desktop/menu.cjs` (View), `desktop/console.cjs` (`SKIP_FILE`, `console-permissions` file) | profile | Write `ask` in the profile to turn it off (anything else, or no file, keeps it on); the next console session reads it at the app's start, so `lifecycle.restart` after writing. |
| Settings… (⌘,) | `desktop/main.cjs:1324` (`openSettings`) | server | Every setting of the Settings screen is a server tool (`tests/mcp-coverage.test.ts`). |
| Server address… | `desktop/main.cjs:1355` (`showSetup`) | partial | A new server: `node scripts/onboard.mjs server` ([onboard.md](onboard.md)). Putting its address in the app has no door; the person's sign-in after it is a human gate. |
| Connect Cloudflare account… | `desktop/main.cjs:1355` (`showSetup('', 'cloudflare')`) | server, human gate | `connect_account { provider: cloudflare }` answers with the step; the token itself is pasted by the person (`POST /api/cloudflare/accounts` under "Routes no tool calls"). |
| Quit, Hide, About | Electron roles | launch | `lifecycle.stop` and `lifecycle.ensure_running` of `inbox.desktop`; About has nothing to do. |

## Account

| Action | Code | Door | How an agent does it |
|---|---|---|---|
| A server in the list (switch the one shown) | `desktop/main.cjs:1357` (`switchServer`) | not needed | It changes what the window shows, nothing on a server; an agent works on each server with that server's key. |
| All Servers | `desktop/main.cjs:1359` (`showAllServers`), `desktop/all-servers.cjs` | server | The same read on each server: `list_mailbox_messages` with each server's key. |
| Add Another Server… | `desktop/main.cjs:1358` | partial | As Server address… above: the server by `onboard.mjs server`, its place in the app's list without a door, the sign-in a human gate. |
| Move an Address to Another Server… | `desktop/main.cjs:1360` (`showMove`), `desktop/move.cjs` | server | `export_mailbox` and `import_mailbox`, then `move_address` (`hold`, `route`) and `send_test_message` / `check_test_message`, as `desktop/move.cjs` does (SCN-094). |
| Forget Server | `desktop/main.cjs:1361` (`forgetServer`) | none | It removes a server from the app's list and its sign-in; nothing on the server changes. B-236. |
| Connect Gmail in browser… | `desktop/main.cjs:1363` | server, human gate | `gmail_connect_link` gives the address the person opens; Google's consent is theirs. |

## View

| Action | Code | Door | How an agent does it |
|---|---|---|---|
| Agent Console (⌃⌘T, Ctrl+Shift+T) | `desktop/main.cjs:1365` (`openConsole`), `desktop/console.cjs` | not needed | The console runs a coding agent for the person; an agent elsewhere connects with its own key (`create_agent_key`, or the `fabric-inbox://connect` link below). |
| Retry connection (⌘R) | `desktop/main.cjs:1364` (`retryMail`) | launch | `lifecycle.restart` reloads everything; the window alone has no door. |
| Zoom, Full Screen, Edit menu, Window menu | Electron roles | not needed | Presentation only. |

## Outside the menus

| Action | Code | Door | How an agent does it |
|---|---|---|---|
| Connect a hub (the Allow dialog) | `desktop/connect.cjs`, `desktop/main.cjs:960` (`queueLink`) | link, human gate | Open `fabric-inbox://connect?...` ([onboard.md](onboard.md), `onboard.mjs connect`); the person's Allow is the gate (ADR-0115). |
| Start without a window | `desktop/main.cjs:1478` (`--background`) | launch | The broker passes `--background` to a target enrolled with `backgroundLaunch: true`. |
| Move window: Wait Longer, Put It Back, Try Again, Cancel | `desktop/move.js`, `desktop/move.cjs` | server | `move_address` `unroute` and `release` are the way back; a move an agent runs with the tools has its own journal, not the app's `move.json`. |

## What is missing

B-236 collects the actions with no door: asking for an update check now, Open at Login, Forget Server,
putting a server's address in the app, and Share Usage Details (named, kept without a door unless the
operator asks). The profile doors work only across a restart. A door for the rest needs a design first:
a `fabric-inbox://` link reaches the app from any page a browser opens, so a link that changes a setting
must ask the person as `connect` does, and a watched profile file is reachable only by this OS account.
