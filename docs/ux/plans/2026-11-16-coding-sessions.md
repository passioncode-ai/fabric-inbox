# Coding sessions in Inbox (B-286)

Status: design, 2026-11-16. Not built. Board request `89857daa` (fabric-dashboards, thread `024e4c6a`), carrying the
operator's words of 2026-11-16 (fabric-dashboards session `9bdda12e`): «сессиям, короче, на каждом уровне нужно видеть
сессии, и в инбоксе, или тоже проверить, и дать задачу этим проектам делать это вопрос, и решить, типа, спроектировать
решение, выпустить апдейт». Fabric Dashboards, Switchboard, Fabric and Observatory got the same ask the same day.

Serves: North Star §5 Agents and §2 Places (the Mac app on a person's own machine); lifecycle SL-8 (one shared view of
every session on the machine); the board row B-282 (the console's sessions launched through Switchboard).

## 1. What Inbox shows of sessions today

| What | Where | Evidence |
|---|---|---|
| Its own agent console: one `claude` or `codex` session at a time, its state (`running`, `quiet` after 30 minutes with no output and no input) | the console panel on the mail window | `desktop/console.cjs` (B-70, B-261) |
| One agent key per console session, named `Agent console (<runtime>)`, revoked when it ends | Settings, Agent access | `desktop/console.cjs:184` |
| Who did an act, as `key:<id>` or a person's sign-in, for the acts the server's journal records (members, grants, keys, sends by members) | Agent access, the journal | `workers/lib/audit.ts:11-36` |
| Any other coding session on the machine (Switchboard's, Fabric's board runs, a person's terminal) | nowhere | no code reads Switchboard: `git grep -ni switchboard -- app workers desktop shared` finds only the shared installation id of usage data (`desktop/analytics.cjs:14`, its notice text) |
| Sessions that need the person (a sign-in, a session running twice, a stuck run) | nowhere | as above |

So Inbox knows its own console session and the key behind an act, and nothing of the machine's other sessions.

## 2. What the ask needs

1. Beside an item of the inbox (a thread, a draft, an access request, an approval code waiting), the coding session that
   raised it or waits on it: its state, its project and its account.
2. The sessions that need the operator (Switchboard's `attention`: `sign_in`, a session running twice, `session_stuck`)
   as items of their own, in the same triaged list.

## 3. Source of truth and where it is read

Switchboard owns live session data: `switchboard --json sessions --all` and `switchboard --json attention`, the same
reads Fabric Dashboards uses (its SCN-109 to SCN-112 and SCN-118, design `docs/design/2026-11-15-sessions-machines.md`
in fabric-dashboards). Inbox copies nothing of it into its server: sessions are facts of one Mac, and the server lives in
an organization's Cloudflare account that other members' Macs share.

- **Reader: the Mac app's main process** (`desktop/sessions.cjs`, new). It runs the two Switchboard reads with
  `execFile` (no shell, 5 s deadline, the login PATH the console already resolves), parses the JSON, keeps only the
  fields below and hands them to the mail window over IPC. No `switchboard` on the machine, a refusal or bad JSON: the
  view says «Sessions are unavailable on this Mac» once, with the reason code in the log, and the inbox works as before.
- **Fields kept per session:** `launch_id`, `provider`, `state`, `ended.kind`, `pool` (the group), `label` (the
  account's label as Switchboard shows it), `working_directory`'s last segment (the project), `launched_by.surface`,
  `launched_by.dispatch.request` and `.thread`, `continues` (a workflow id), `last_turn_at`. The transcript path, the
  home directory and the account id are not read into the renderer.
- **Fields kept per attention item:** `reason`, `detail`, `label`, `launch_id`, `since`, `action`.
- **Cadence (LC table):** read when the mail window becomes active and every 60 s while it stays active and focused,
  none while it is hidden or unfocused (the rule of `app/lib/window-activity.ts`); no timer with no window. A Mac with
  no window spends nothing.

## 4. Linking a session to an item

An item names its session through the agent key that made it; a key names its session through the place that minted it.

| Item | Its key | Key to session |
|---|---|---|
| A draft or a send an agent made over MCP | the request's actor `key:<id>` (`workers/lib/audit.ts:32`), written on the draft as `createdBy` (new field, server change) | console keys: `desktop/console.cjs` records `keyId` beside the Switchboard `launch_id` once B-282 launches through Switchboard |
| An access request (B-246) | `request.holder.id` | as above |
| An approval code waiting (B-38) | the key on the approval | as above |
| A key minted outside the console (`onboard.mjs`, a person's `claude mcp add`) | its key id | Switchboard's session whose `working_directory` and launch time match the key's first call, shown as «probably» and never acted on |

A link that cannot be made shows the key's name only, as today. Nothing is guessed silently: a match by time and folder
is labelled as a guess.

## 5. What the person sees

- **On an item** linked to a session: a chip «Claude · running · fabric-inbox · <account label>» (or «ended», «quiet
  30 min»). The chip opens the session in Fabric Dashboards through its `open_link`
  (`fabric-dashboards://service/...`, the key from `list_services`), never a browser; where Dashboards is not installed,
  the chip is plain text.
- **Attention items** at the top of the triaged list, one row each, under «Needs you»: «Sign-in needed for <account>»,
  «<project> runs twice», «A board run in <project> has been quiet for 30 minutes». The row's one action is the
  attention item's own (`action.tool` and `action.window`), opened in Switchboard or Dashboards; Inbox never stops,
  restarts or signs in a session itself. A row leaves the list when Switchboard no longer reports it.
- **The console** shows its own session's Switchboard state once B-282 lands, the same way.
- Every new string goes through the dictionary (`t("…")`, Russian in `shared/i18n/ru/`) and the brand lint (`python3 docs/brand/lint.py`).

## 6. Agent parity

A new MCP tool `list_coding_sessions` is not added: the sessions are read on the Mac, and the agent protocol is served by
the Worker (`AGENTS.md`, Lifecycle). An agent already reads the same data from Switchboard's own MCP. The exclusion goes
into `NOT_TOOLS` with that reason. The draft's new `createdBy` field is returned by the existing draft tools.

## 7. Steps

| Step | What | Gate |
|---|---|---|
| 1 | Server: write `createdBy: key:<id>` on drafts and sends made by a key; return it in the API and the MCP draft tools | `npm test && npm run typecheck`, `npm run mcp:docs` |
| 2 | `desktop/sessions.cjs`: the two reads, the field filter, the degraded answer; tests with recorded Switchboard JSON | `tests/desktop-sessions.test.ts` |
| 3 | B-282 first: the console launches through Switchboard and records its `launch_id` beside its key | B-282's own checks |
| 4 | The chip on drafts, access requests and approvals; the «Needs you» rows | UX lint and doctor, the scenario below, a walk in the built app with a temporary profile |
| 5 | Scenario SCN-1xx «See which coding session raised an item, and the sessions that need me» in `docs/ux/scenarios.md`; the Lifecycle table row in `AGENTS.md` | `python3 docs/ux/lint.py` |
| 6 | Release through the usual path (`docs/release.md`); reply on thread `024e4c6a` with the version | release receipt |

## 8. Out of scope and must not change

- No session data on the server or in another member's view; no session control from Inbox (stop, restart, sign-in).
- The console's key lifecycle (one key per session, revoked every way) stays as it is.
- Nothing runs on the Mac with no window; the idle budget in `AGENTS.md` stays 0 requests while hidden.
