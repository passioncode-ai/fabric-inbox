# Every organization in the one mail window (B-244)

**Date:** 2026-11-11. **Asked by** the operator in this repository's session: «есть несколько организаций, чтобы
они все показывались внутри одного окна, я бы не переключался между ними, не щелкал этими окнами». It repeats the
word of 2026-11-07 that started B-233 («хочу все аккаунты в одном окне как были»).

## Why B-233 did not answer it

B-233 part 1 (1.1.0) put the merged list in a **second window** (Account → All Servers), and a message opened from
it **replaces** the mail window: `switchServer` (`desktop/main.cjs:278`) saves the other server and calls `loadMail`
(`desktop/main.cjs:515`), which destroys the window (`mailWindow.destroy()`, line 517) and builds a new one on the
other server's session. So the person still clicks between windows, and every switch reloads the page. Before the
organizations' addresses moved to their own servers (B-158, B-169, B-234), every address was on one server and its
inbox listed them all: that is the "как были" the operator means.

Decision D1 of the organizations plan stays: one server per context, nothing copied between servers, each server
read through its own sign-in.

## Decisions

- **D-1. One window holds a page per server.** The mail window keeps one `WebContentsView` per held server, each on
  its own partition (`policy.partitionFor`), created on first use and kept alive. Showing another server swaps the
  visible view: no window is destroyed, nothing reloads, each server stays signed in and keeps polling only while it
  is visible (the page's own pause while it is not visible, `app/lib/window-activity.ts`). The agent console's dock lays
  out against the visible view; a console still stops before another server shows (its key is that server's).
- **D-2. The page learns of the other servers through the narrow bridge.** `mail-preload.cjs` gains three calls,
  answered only to a held server's view (`policy.isMailSender` widened from "the configured origin" to "a view of a
  held server"): `servers()` (origin, label, context, state, unread), `otherInbox()` (the other servers' inbox rows,
  `desktop/all-servers.cjs` `readAll` without the server shown) and `show(origin, link)` (that server's view at a
  message link, `new-mail.cjs` `messageLink`, checked to be a path of that server). No row of one server is sent to
  another server's backend; the merge happens in the page of the window only.
- **D-3. The inbox shows organizations as a row of tabs and one merged list.** Above the unified inbox: All, then
  each server by its name with its unread count and state (signed out, not answering). All interleaves the other
  servers' rows, newest first, each with its organization's pill; they are read in place and opened on their own
  server in the same window (D-1). Triage on another server's row (archive, mark, discard) shows that server first;
  it never acts across servers. A tab of one organization shows that server's view.
- **D-4. A server's name is the person's.** `/api/server` has no name; the app keeps one per server in
  `servers.json` (`label`), default the host as today (`desktop/servers.cjs` `labelFor`), renamed from the Account
  menu. The organization service's name replaces it once Inbox reads organizations (B-158 M2).
- **D-5. All Servers goes once D-3 ships.** The separate window (`desktop/all-servers.*`) is removed in the release
  that ships D-3 on every server, with its menu item; `readAll` stays as D-2's reader.

## Steps

| Step | What | Ships in | Proof |
| --- | --- | --- | --- |
| 1 | SCN-099 rewritten for D-1 to D-3, SCN-093's expected result ("one window at a time shows one server") changed; `python3 docs/ux/lint.py` | docs | lint exit 0 |
| 2 | D-1: views per server in one window, the dock and the console against the visible view | the Mac app | `tests/desktop-servers.test.ts` (switch keeps both views, no reload), a walk |
| 3 | D-2: the bridge calls and their sender check | the Mac app | a new test of the sender check, `tests/desktop-all-servers.test.ts` |
| 4 | D-3: the tabs and the merged list; strings through `t()` and the copy check | every server (UI only; agents and their answers unchanged) | `npm test`, a walk with two servers |
| 5 | D-4 rename, D-5 removal | the Mac app | tests, the menu |
| 6 | Release; the three servers updated; the Mac app by its own update | release | `/api/server` version on each server |

The page's half (step 4) degrades on its own: a page with no bridge (a browser, an older app) shows the inbox as
today, and an app with the bridge but a server not yet updated shows that server as today.

## Out of scope

Copying mail between servers, one search across servers (each server searches its own), and a member's app that
finds the organization's server by itself (B-215 step 2).
