# S01. The server switch above the mail list (B-267)

**Asked:** «Вот там, где сверху фильтры ... переключение между серверами надо типа поправить дизайн, чтобы оно было
лучше сделано, сейчас выглядит плохо».

## Today (`main` `1f988fc8`)

- `ServerTabs` (`app/components/inbox/ServerTabs.tsx:9-53`) renders pill chips between the list heading and the filter
  bar (`app/routes/unified-inbox.tsx:1311-1313`), only in the inbox folder, without a search, when the app holds two or
  more servers (`:311`).
- "All" is a bare word with no count; the shown server carries `ownUnread`; another server's chip switches the window
  (`ServerTabs.tsx:49-52`) but is never shown as pressed; a signed-out server is a dashed chip "name · Sign In"; an
  unreachable one is a `span` "name · Not reachable now" with a text "Retry" (`:34-47`).
- Style: `.fi-chip` pills, 11 px, about 26 px tall (`app/styles/workbench.css:1515-1540`); the row wraps
  (`:1804-1815`, B-263, B-266). Two different "All" chips sit one above the other (servers, then groups in the filter
  bar), with the same look and different meanings.
- Another server's unread count is counted in its last 50 inbox rows only (`desktop/all-servers.cjs:54`).

## Target

One control, "Server", that reads as a switch and not as a filter chip:

- **Placement:** in the list heading row (`.fi-list-heading`), to the right of the folder title, replacing the
  "Important first" / "Newest first" hint, which moves under the Focus/Newest control it explains (it repeats it today).
  The filter bar below keeps the filters only.
- **Two servers to four, and the list column at least 360 px wide:** a segmented control, one segment per choice: All,
  then each server by its name. Segments are 28 px tall, radius 6 px (the `--pc-radius-md` token), the chosen one
  raised; a count badge after the name (All shows the sum). A long name is cut at 160 px with the full name on pointing
  (the tooltip component of B-226, not `title`).
- **Five servers or more, or a narrower column:** a menu button "All servers ▾" / "<name> ▾" with the same rows in a
  menu: name, count, state.
- **States inside a segment or menu row:** signed out: a small "Sign in" link in place of the count; not reachable: a
  warning dot and "Retry" in place of the count, the reason on pointing. The segment stays the same size in every
  state, so the row never jumps.
- **Which is chosen:** the segment of the server whose mail the list shows; All when the merged list is shown.
  Choosing another server switches the window to it as today, and that server's segment is the chosen one there.
- **Counts:** "50+" when another server's unread fills its 50-row read (the count is a lower bound), so no number is
  shown as exact when it is not.
- The group chips' "All" in the filter bar is renamed "All groups" (Russian «Все группы»), so the two "All"s differ.

## States

loading (the other servers' counts not read yet: no count, no spinner per segment), one server failing (its segment
says so, the others work), all servers failing (the shown server still works; the others' segments say so), success.

## Words

| Key (English) | Russian |
|---|---|
| All servers | Все серверы |
| All groups | Все группы |
| Sign in | Войти |
| Not reachable now. Retry | Сейчас недоступен. Повторить |
| {n}+ unread | {n}+ непрочитанных |

The strings go through the copy check in both locales before they land.

## Acceptance

- Unit: `tests/server-tabs-layout.test.ts` extended: segmented below 5 servers and at 360 px or more, menu otherwise;
  a segment's height does not change with its state; "50+" when a server's read came back full.
- WebKit walk with `scripts/preview-fixture.mjs` at 1500, 1100 and 700 px with 2, 3 and 6 servers, one signed out and
  one unreachable; screenshots kept with the PR.
- SCN-099 steps 1 and the alt paths updated in the same change.

## Out of scope

What All merges (unchanged, SCN-099); where other servers' mail is read from (`desktop/all-servers.cjs`).
