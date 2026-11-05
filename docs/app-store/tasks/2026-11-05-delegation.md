# Giving people mailboxes and issuing keys with no person clicking (B-215)

Status: step 1 built 2026-11-05 (0.99.0). Owner of the decision: the operator, 2026-11-05, in this repository's
session: "чтобы у нас были все это заскриптовано, автоматизировано и MCP, и по API ... без каких-то ручных
действий, типа выдавать имейлы, делегировать их сотрудникам ... администратор может подключенным фабрик-инбоксом
выдать другим участникам ... доступ с разными уровнем доступа"; and, relayed on the board the same day (thread
`721be382`, message `a950bab9`), "всеми ключами занимайся сам, мне больше ничего не надо делать".

## What was missing

1. A person added in Settings → People could not sign in until someone added their email in Zero Trust by hand:
   the list decided what a person reaches, Cloudflare Access whether they get in at all (`docs/desktop-mail/setup.md`,
   Organization servers, step 6).
2. `save_member`, `remove_member`, `create_agent_key` and `revoke_agent_key` always waited for the owner's click in
   Settings → Agent access (`ownerApproval`, B-154, DEC-0121), so an agent could not finish either act alone.
3. Nothing ran these acts from a script.

## Decisions

- **D1. Sign-in follows the list.** The server keeps one Access policy of its own on its application,
  `Fabric Inbox people <audience>`, with every listed email (administrators and members), rewritten from the whole
  list after each change and deleted when the list empties (`workers/lib/people-access.ts`). The organization's own
  policies (an Access group, an identity provider) are never edited: a group can be shared with other applications,
  and the server only adds what it owns, the way agent keys already work (`workers/mcp/access.ts`). The outcome is
  kept (`config/members-sign-in.json`) and shown per person.
- **D2. Standing permissions on a key.** An Admin key may hold `standing: ["people", "keys"]`. With `people`, a
  member's save or removal confirms with the key's own code; with `keys`, issuing a key and revoking one that holds
  no standing do. Making, unmaking or removing an administrator, and any act of a key set to Ask me to approve,
  still wait. A key never passes standing on (`create_agent_key` cannot set it; PATCH `/api/agent-keys/:id` is in
  `NOT_TOOLS`).
- **D3. Who may trust a key.** The owner in Settings → Agent access, or whoever holds the server account's
  Cloudflare token, through `scripts/agent-standing.mjs`: that token already owns the server (it deploys its code and
  reads its storage), so it adds no new authority. Both write the same record and a People line
  (`key_standing_set`; actor the person, or `account-token`).
- **D4. Scripts.** `scripts/members.mjs` calls the same tools over `/mcp` with a key from the vault: `list`,
  `grant`, `remove`, `sign-in`, and `key … --vault <project>/<env>`, which puts the new key's three values into
  Project Observatory's vault on stdin and prints only its id.

## Next steps

- **Step 2.** The member's own app finds the organization's server: an invitation link (`fabric-inbox://`) or the
  organization service's directory (B-158 M2/M3, waits on SOT-B5).
- **Step 3.** The organization service's join playbook gives the new member their mailboxes through `save_member`
  as one of its agent steps (a board ask to its owner).

## Checks

`tests/people-access.test.ts`, `tests/mcp-relayed.test.ts` (B-215), `tests/members.test.ts` (B-215),
`tests/members-script.test.ts`; scenarios SCN-081 (step 2a) and SCN-098.
