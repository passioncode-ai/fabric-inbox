# The mail window's fixes, the operator's note of 2026-11-18

- **Source:** the operator's note in this repository's session, 2026-11-18, with a screenshot of the docked agent
  console after its session ended (Russian as said): «В Inbox есть проблемы с UI, переключение аккаунтов иногда
  происходит. Так как я не понял, как выбрать сразу же все аккаунты были, если можно, если нельзя. Окей, типа, давай
  хотя бы, где шаренные аккаунты, которые поделятся мне, как вот это происходит делегация. плюс UI вот здесь в чате,
  видишь, нельзя его закрыть после того, как сессию закрыл, короче, плохо сделал UI, нужно баги поправить, типа, все,
  что найдется еще не доделано и новое прилетит, написать спеку, все это взять в доработку, по таск пайплайну, потом
  волнами довести до идеального результата и выкатить вместе со всеми остальными релизами, вместе, типа, большой
  апдейт».
- **Route:** `task-pipeline` full flow, in waves; `super-ux` scenarios (SCN rows named per spec), `copywriting` and the
  copy check for every string in both locales, `sheleg-design` for the look.
- **Recon:** read on `main` `c273d3dc`; every "Today" line cites `file:line` at that commit. The Mac app's own log on
  the operator's Mac (codes only) was read for the switches and the launch on 2026-11-18.
- **Status:** specs written (this file); W1 (U1 to U3) and W2 (U4, U5) built on `agent/ui-fixes-2026-11-18` with unit tests; W3 (the walk in the built app, the audit, the release) next.

## The asks and their specs

| # | What the operator said | Spec | Row |
|---|---|---|---|
| U1 | The console panel cannot be closed once its session ended | [U1](#u1-the-console-panel-closes) | B-290 |
| U2 | "Account switching sometimes happens" | [U2](#u2-all-stays-all-and-a-switch-stops-nothing) | B-291 |
| U3 | "I did not understand how to choose all the accounts at once" | [U3](#u3-all-inboxes-means-every-server) | B-292 |
| U4 | "Where are the accounts shared with me, how does delegation work" | [U4](#u4-shared-with-me) | B-293 |
| U5 | (found in the log while reading U2) a launch that cannot reach the server opens the setup window | [U5](#u5-a-server-not-reachable-at-launch-is-not-a-setup) | B-294 |
| U6 | "Everything that is found not finished, and what comes in" | [U6](#u6-the-audit-wave) | B-295 |

## Questions and the decisions taken

The operator's rule: an open question is a decision, taken by the recorded decisions, the project's goal, then the
safest reversible option, written where the work lives. Each is open to the operator's word; none blocks.

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Which "accounts" switch by themselves? | The servers (the operator's own and an organization's). The app's log shows `server_switched` several times a day; each comes from a choice in the list or the Account menu, and the page then shown opens in its own last state (often not All), and a running console is stopped in the same second (2026-11-17 00:53:54 and 01:24:23: `console` `ended` `stopped` code 129 beside `server_switched`) | The only switch the app makes on a click in the list (`openOnServer`); the console the operator closed by hand today was, on the 17th, ended by such a switch |
| Q2 | May a console keep running while another server is shown? | Yes: it stays on its own server with its own key, its panel hidden while another server is shown and shown again with its server; Quit, Forget Server and an update still stop it as today | The key is minted and revoked through that server's own session, which the app keeps for every server it holds (B-158); stopping it on a switch is what made the switch feel like it "happens to me" |
| Q3 | "Choose all accounts at once": a new control or the existing one? | The existing "All inboxes" row covers every server the app holds, and the Account menu gets "All Servers' Inboxes" | The row is where the operator looked; a second "All" in the list heading alone was not found |
| Q4 | "Shared with me": what does a person see? | On a server where they are a member, the sidebar names the mailboxes as shared with them and each one's level; Settings → Your Access names their role, mailboxes, levels and the grants given to them, by whom and when, and how to ask for more | Members already see only what they were given (B-149) but nothing says so, nor who gave it |
| Q5 | "How does delegation work": explained where? | In Settings → Your Access (for anyone) and in Settings → People above the list (for an administrator): two sentences each, with the route | The operator asked how, not to change how |
| Q6 | Ship when? | With the next release (1.8.0), together with what is merged since 1.7.3, after W3's audit | «выкатить вместе со всеми остальными релизами, вместе, большой апдейт» |

## U1. The console panel closes

**Asked:** «UI вот здесь в чате, видишь, нельзя его закрыть после того, как сессию закрыл».

**Today (`c273d3dc`):** the console's bar has its title, a status and Stop, shown only while a session runs
(`desktop/console.html:17-22`, `desktop/console-view.js:44-45`); nothing closes the panel. It hides only by View →
Agent Console again (⌃⌘T) or the inbox's console button (`desktop/main.cjs:1216-1236` `toggleDock`), neither shown
on the panel. The docked panel is laid out on the window's `resize` only (`desktop/main.cjs:611`): entering or
leaving full screen and Stage Manager's resizes leave it short of the window's right edge, with the mail page showing
past it (the operator's screenshot).

**Target:**

1. The bar ends with a close button (an ×, "Close the console" as its accessible name and tooltip), always shown.
   In the docked panel it hides the panel; in the console window it closes the window. A running session keeps
   running and its key stays live, as when the panel is hidden today; the status line said so before
   ("{agent} is connected to Fabric Inbox."), and the close button's tooltip while a session runs reads "Hide the
   console; the session keeps running".
2. Escape closes the panel when no session runs (the choice screen, an ended session, no agent found); while a session
   runs Escape belongs to the agent.
3. The docked panel is laid out again on `resized`, `maximize`, `unmaximize`, `enter-full-screen`,
   `leave-full-screen` and `restore`, and once more on the next frame after each, so it always ends at the window's
   right edge.

**Tests:** `tests/desktop-console-close.test.ts`: the bar carries the button and its handler, Escape's rule by phase,
the IPC is answered only to the console's own page, the layout events are bound.

**Out of scope:** resizing the panel by dragging (a board row if asked).

## U2. All stays All, and a switch stops nothing

**Asked:** «переключение аккаунтов иногда происходит».

**Today (`c273d3dc`):** opening another server's message in All calls `showServer(origin, link)`
(`app/components/inbox/TriagedList.tsx` `OtherMessageRow`), which saves that server as the shown one and loads the
link in its page (`desktop/main.cjs:455-467` `openOnServer`, `:291-300` `switchServer`). That page opens in its own
last choice of the switch, kept per server in its own storage (`app/routes/unified-inbox.tsx:311-319`
`fi-server-tab`), so the list is often that server's alone: the person chose a message and the window "switched
account". `switchServer` also stops a running console first (`desktop/main.cjs:296`). SCN-099 step 2 promises the
opposite: the message on its own server and Back returns to All where it was left.

**Target:**

1. A message of another server opened from All opens on its server's page **with All chosen there**: the link
   carries `servers=all`, which the page reads as it does for a notification (`unified-inbox.tsx:312`), keeps, and
   removes from the address. Choosing a server's own segment shows that server **with its own list**
   (`servers=own`), so the switch's choice, not the page's memory, decides what is shown.
2. A switch of the server shown never stops the console: the session stays with its server and its key; the panel
   hides while another server's page is shown and comes back with its server. The console's bar names its server
   ("{agent} is connected to {server}."). Settings' notice before a switch ("The agent console session will stop") is
   gone, since it no longer does. Quit, an update's restart and Forget Server still stop it and revoke its key, as
   today; a partition retired after a server is forgotten stops it first, as today.
3. The Account menu's servers keep their tick and their switch; choosing one shows its own list (as 1).

**Tests:** `tests/other-servers.test.ts` (the link a row opens carries `servers=all`), `tests/desktop-servers-switch.test.ts`
(a switch no longer calls the console's stop; Forget still does), the page's reading of `servers=own`.

**Out of scope:** opening another server's message inside the shown server's reading pane (it would need that
server's actions read through the bridge; SCN-099 keeps every action on its own server).

## U3. "All inboxes" means every server

**Asked:** «я не понял, как выбрать сразу же все аккаунты».

**Today (`c273d3dc`):** the sidebar's "All inboxes" row clears the address, domain and category of **this server**
(`app/routes/unified-inbox.tsx:1233-1245`); its count is this server's. Every server together is the list heading's
switch, shown only in the inbox with no search (`unified-inbox.tsx:326`, `:1514-1518`). The operator looked in the
sidebar and the Account menu and found no "all".

**Target:**

1. With two or more servers held, "All inboxes" chooses All in the switch as well (the merged list of every server),
   and its count is every server's unread (the switch's All count, "N+" when a server's count is a lower bound).
   Its tooltip reads "Every inbox of every server". Choosing one address, domain or provider shows this server's
   (as today); choosing this server's segment keeps "All inboxes" meaning this server's addresses.
2. The Account menu gets "All Servers' Inboxes" (⇧⌘0 on macOS, Ctrl+Shift+0 elsewhere; ⌘0 stays Actual Size) above the servers when two or more
   are held: it brings the mail window forward on the inbox with All chosen.
3. Folders other than the inbox are each server's own (only inboxes merge, SCN-099): with All chosen, the list
   heading of Sent, Drafts, Archive or Trash names the server it shows ("Sent · <server>").

**Tests:** `tests/inbox-all-servers.test.ts` (the row's choice and count), `tests/desktop-menu.test.ts` (the item, its
accelerator, present only with two servers).

## U4. Shared with me

**Asked:** «где шаренные аккаунты, которые поделятся мне, как вот это происходит делегация».

**Today (`c273d3dc`):** an administrator gives a person mailboxes and a level per mailbox in Settings → People
(`app/components/settings/sections/PeopleSection.tsx:170-183`, SCN-096), or capabilities per mailbox in Agent access
(`GrantsPanel.tsx`, SCN-101; the grants do not decide yet). The person adds that server to their app (Account → Add
Another Server, or a server link) and sees only those mailboxes (B-149): the sidebar lists them like their own, with
one line at its foot, "You see the mailboxes this server's administrator gave you." (`AccountSidebar.tsx:244-246`).
Nothing names the level, who gave the access, or how to ask for more; `GET /api/my-access` answers only an agent key
(`workers/routes/access-requests.ts:69-80`).

**Target:**

1. **The sidebar.** On a server where I am a member, the addresses' heading reads "SHARED WITH YOU" instead of
   "ADDRESSES", and each mailbox shows its level as a short tag when it is not full access: "read only", "agents".
   The foot line becomes a link, "What you can do here", to Settings → Your Access.
2. **Settings → Your Access** (a new section, every role): who I am on this server (my address, my role: owner,
   administrator, architect, member), the mailboxes I reach with each one's level, and the grants given to me as a
   person (mailboxes, capabilities, until when, by whom, when, why). Two sentences on how sharing works: "An
   administrator of this server shares mailboxes with you in Settings → People. Add this server to your Fabric Inbox
   app and the mailboxes appear here; ask the administrator for more." An administrator reads "You reach every mailbox
   of this server." with a link to People.
3. **Settings → People**, above the list (administrators): "Share mailboxes with a person: add their address, choose
   the mailboxes and the level. They add this server to their app (Account → Add Another Server) and sign in with that
   address." 
4. **The route and the tool.** `GET /api/my-access` answers a signed-in person too: `{ person: { email, role,
   mailboxes: [{ id, email, level }] }, grants, decides }`, the grants whose holder is that person; an agent key's
   answer is unchanged. The MCP tool `list_my_access` says so; `npm run mcp:docs` regenerates the reference.
5. **Scenario:** SCN-105 "See the mailboxes shared with me and who shared them".

**Tests:** `tests/my-access-person.test.ts` (the person's answer, an admin's, a member's levels, a key's unchanged),
`tests/sidebar-shared.test.ts` (heading, tags, link).

**Out of scope:** a person asking for access in the app (an access request today is an agent key's; a person asks
the administrator), and the grants deciding access (B-246 W2c cut-over).

## U5. A server not reachable at launch is not a setup

**Found:** the app's log on 2026-11-18 at 10:25:02 shows `window_shown setup` at launch with a server set up, then the
mail 42 s later: the first load failed (the network was not up after waking) and the app closed the mail window and
opened setup with its notice (`desktop/main.cjs:680-691` `failure`, B-11).

**Target:** a load that fails while a server is set up keeps the person's place: the setup window opens on its
**Retry** view only (the saved server named, "Fabric Inbox could not reach {server}." and Retry first, the address
form folded under "Change server…"), retries by itself every 30 s and at once when the computer wakes or comes back
online, and closes itself when the mail loads. A first setup, Account → Server address… and Add Another Server keep
the form as today.

**Tests:** `tests/desktop-setup-retry.test.ts` (the state the setup page receives says `retrying` with the server's
label; the retry timer starts on failure and stops on load).

## U6. The audit wave

A walk of the whole mail window in the built app (two servers, a member server, the console docked and in a window,
full screen, a narrow window), `/ux-audit` over SCN-078, SCN-099, SCN-101 and SCN-105, and the copy check of every
new string in English and Russian. Each finding that blocks a scenario is fixed in this wave; the rest become board
rows with their evidence. Then the release: 1.8.0, with everything merged since 1.7.3.

## Waves

| Wave | Specs | Why this order |
|---|---|---|
| W1 | U1, U2, U3 | The three things the operator hit today; desktop and the inbox page only, no server route |
| W2 | U4, U5 | A route and a tool (U4), the setup window (U5) |
| W3 | U6, then the release | The operator's order: fix, audit until nothing blocks, ship in one update |

Each wave lands as its own pull request with its tests, Russian strings in `shared/i18n/ru/` (and the console's and
the setup's own dictionaries in `desktop/locales/ru.json`), the SCN lines and a CHANGELOG line.
