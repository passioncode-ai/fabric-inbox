# Handoff 2026-11-19: a coding session in Fabric from Inbox (B-305), 1.9.0

Previous: [2026-11-18 the mail window's fixes, 1.8.0](2026-11-18-ui-fixes-1.8.0.md).

## Objective

The owner's order of 2026-11-19 (board thread `3ca40854`, message `57445717`; Inbox's part in request `d3a49a11`): a new
coding session starts from Inbox (by an email), and the session Inbox is linked to opens in Fabric right from there,
through Fabric's one path (`fabric-session-links/1`, Fabric's message `b37c7dce`), never a launch of Inbox's own.

## Done

| What | Evidence |
|---|---|
| Links `fabric://session/new|open|continue` with `from=fabric-inbox`, ids only, Fabric's presence checked first | `desktop/session-links.cjs`; `tests/desktop-session-links.test.ts` |
| New session under an email: Fabric project (kept, newest first), agent, the email's reference copied | `app/components/inbox/FabricSessionButton.tsx`, `app/routes/unified-inbox.tsx`, `desktop/mail-preload.cjs`, `desktop/main.cjs` (`fabric:session-projects`, `fabric:session-new`) |
| The console's Claude Code session has an id (`--session-id`), resumed by it when its transcript is there; Open session and Open in Fabric in the console | `desktop/console.cjs` (`linkedSession`, `claudeTranscript`), `desktop/console-view.js`, `desktop/console.html`, `desktop/console-preload.cjs`, `fabric:console-session-link`; `tests/desktop-console.test.ts` |
| SCN-106, Russian strings, AGENTS.md lifecycle row, CHANGELOG 1.9.0, backlog B-305 | `docs/ux/scenarios.md`, `shared/i18n/ru/{desktop,inbox}.ts`, `desktop/locales/ru.json` |

Checks run: `npm test`, `npm run typecheck`, `npm run build`, `node scripts/check-locale.mjs`, `python3 docs/ux/lint.py`
(0 errors), `python3 docs/ux/doctor.py`, `python3 docs/brand/lint.py` (0 errors), `check_private.py` (0 findings), copy
checks of the new strings in en-US and ru-RU (no blocking finding).

## Decisions

- **The linked session is the console's session.** Fabric's `session/new` answers no session id to the app that opened
  it, so an email cannot be tied to the session it started; the console's own Claude Code session is the one Inbox knows.
- **The email travels by the clipboard.** DEC-0040 refuses words in a link; the reference (subject, sender, date, ids
  for `read_message`) is copied for the person to paste.
- **The project is typed as Fabric names it.** DEC-0040's `project` takes no path, and Inbox cannot read Fabric's
  projects; asked of Fabric on the thread (as Fabric Dashboards did).
- **Codex has no Fabric row**: it gives no session id.

## Open

- `session/open`, `session/continue` and `from` in Fabric's launch journal arrive with Fabric's release planned for
  2026-11-20; until then Fabric opens its home for them. Re-check the console's row then.
- Not built: «Подключить сюда» (no path in the contract), New session from the console without an email, a project read
  by folder.
- Not walked in a built app yet.

## Exact next task

1. When Fabric announces `session/open` and `session/continue` on thread `3ca40854`, walk SCN-106 in the built 1.9.0 app
   (New session under an email, Open session and Open in Fabric in the console) and record it in SCN-106's Today.

## Continued 2026-11-20 (after Fabric 0.3.26)

Fabric 0.3.26 shipped `session/open`, `session/continue` and `from` in its launch journal (2026-11-20 08:33 UTC, board
message `b518d8f7`), and takes a repository's folder name in `project=` (board message `27afb03c`).

| What | Evidence |
|---|---|
| A session id is taken only as a UUID and sent lower-case, as fabric-agent-contract DEC-0189 SL-2 defines it; any other shape is refused before Fabric opens | `desktop/session-links.cjs` `SESSION_ID`; `tests/desktop-session-links.test.ts` |
| The four link shapes Inbox builds (`new` with a name and a `urn:` id, `open`, `continue`) parsed by the contract's own `parseFabricLink` at `4c978495`: all `ok: true`, nothing ignored | a run of the contract's `src/fabric-links.ts` with `tsx` over `sessionLink` outputs |
| CHANGELOG Unreleased, B-305 row, SCN-106 Today | `CHANGELOG.md`, `docs/evidence/backlog.md`, `docs/ux/scenarios.md` |

Not done in this run: the walk in a built app. It needs a signed-in server in a fresh profile (a sign-in) and opening
Fabric on the operator's Mac, which an unattended run does not do.

### Exact next task

1. In a session with the person: build the app (`npm run desktop:package`), launch it with
   `--user-data-dir="$(mktemp -d)"`, sign in to a server, and walk SCN-106 against Fabric 0.3.26 (New session under an
   email; the console's Open session and Open in Fabric); record the result in SCN-106's Today and close B-305's walk.
2. The change above ships with the next release (CHANGELOG Unreleased).
