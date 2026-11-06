# Inbox on a shared Mac, a new Mac and an organization's members (Studio plan gaps)

Status: specs, 2026-11-06; G3 (B-219) built the same day: `servers.json` in the backup (`desktop/backup.cjs`, `desktop/main.cjs` `backUp`), the moving section in `docs/desktop-data-and-updates.md`. The operator's instruction relayed on the board (thread `1fe66e6e`, message `7a1507fc`, said
2026-11-05 in session `456ad510`): each project reads the Workspace plan for the Studio move and for connecting an
organization, compares it with its code, writes a detailed spec per gap and closes them in waves. Read: fabric-workspace
`docs/plans/2026-11-04-studio-spaces/` (README, runbook, placement) and `knowledge/plans.md`, `knowledge/integration.md`
at `6cb6cbb6`; the contract's draft norm on loopback ports (thread `1fe66e6e`, messages `0cf39dc7`, `14b4dc86`,
`d6035cae`).

## What the plan asks of Inbox

- README:123 and :171: a port per macOS user is not needed. The Mac app has no listening port and keeps its profile,
  log, Keychain item and `fabric-inbox://` handler per user (`AGENTS.md`, Lifecycle).
- runbook 2.7: apps per user in `~/Applications`; runbook 4.2: a clean install of Inbox in a macOS VM that opens and
  updates.
- placement.md:16 and :30: Inbox builds and full gates on Studio; the operator's Inbox app stays with the operator.
- The servers run in each owner's Cloudflare account and do not move.

## G1. A key reaches a loopback listener of another macOS user (B-217, P1)

**Now.** `connect` (`desktop/connect.cjs:318`) hands a new agent key to the hub's one-shot callback on `127.0.0.1`. It
looks up the listener (`listenerWith`, `desktop/connect.cjs:81`) and refuses its own process, and revokes the key when
another process took the port. What each system shows:
- **macOS.** Unprivileged `lsof` lists only this user's sockets (`connect.cjs:86`), so another user's listener reads
  as "nothing listens" and the key is not made. That is safe, but the reason is wrong.
- **Linux.** `ss -p` and `/proc/<pid>/fd` name only this user's processes, so the outcome is the same.
- **Windows.** `netstat -ano` and `tasklist` name every user's process (`connect.cjs:105`), so a listener of another
  account on the port gets the key.

**Needed** (the contract's norm, point 2(a), state `foreign-user`):
1. Before a key leaves, the app tells "nobody listens" apart from "someone else listens":
   - macOS: `netstat -anv -p tcp` gives the pid even for a foreign socket, then the pid's uid;
   - Linux: the uid column of `/proc/net/tcp{,6}`;
   - Windows: the owner of the listening pid against the app's own user (a PowerShell
     `Get-Process -IncludeUserName`, or `tasklist /V`).
2. A listener whose user is not the app's, or whose user cannot be told, is `foreign-user`: no key is made, the hub
   hears `foreign_user`, and the log says so.

**Acceptance.** Tests with injected `exec` per platform: own listener → key; foreign uid → `foreign-user`, no key;
unknown owner → refusal; empty port → as today. The contract's DEC adds the row "no listening port; a key goes to a
loopback callback only when its listener is this user's".

**Depends on.** The contract's DEC on ports (due 2026-11-07), for the state's final name.

## G2. The first Admin key on an organization's server needs a person (B-218, P1)

**Now.** Every agent key is made in Settings → Agent access by a person signed in through Access
(`workers/routes/agent-keys.ts`). An agent with no key cannot make one. The organization server's support mailbox
(B-168) has waited on the operator's sign-in since 2026-10-26. B-215 lets the account's Cloudflare token trust a key
that already exists (`scripts/agent-standing.mjs`), but cannot make the first one.

**Needed.** `scripts/agent-key-bootstrap.mjs`, run with the server account's token from the vault, does what
`POST /api/agent-keys` does, and nothing more:
1. Makes the Access service token.
2. Adds it to the server's agents policy (the same `attachPolicy`, keeping the owner's policies).
3. Writes the key into `config/agent-keys.json` in the server's bucket (with `createdBy: account-token`, the given
   level and standing).
4. Puts its three values into Project Observatory's vault on stdin (`vault.py put`), printing only the key's id.
5. Writes a `key_standing_set` line when the key gets standing.

A key Cloudflare made but the record could not take is deleted again.

**Acceptance.**
- Tests with a fake Cloudflare and bucket.
- On the organization's server: one Admin key with standing `people,keys`, the PassionCode support mailbox moved
  (B-168), with no person signing in.

**Depends on.** The deploy of 0.99.0 to both servers (waits for the operator).

## G3. Moving the app to another Mac or another macOS user (B-219, P2)

**Now.** `desktop/backup.cjs:12` keeps only the server's address (`<appData>/PassionCode/backups/fabric-inbox.json`),
and a missing `server.json` is read back from it. Everything else belongs to this Mac and this user:
- the sign-in cookie, encrypted under this user's Keychain item;
- unsent drafts (local storage);
- the list of other servers (`servers.json`);
- the agent's key from `onboard.mjs connect` (the system key store);
- the digests and their `open-hour.json`;
- the Fabric descriptor;
- the analytics state.

There is no written list of this.

**Needed.**
1. A section in `docs/desktop-data-and-updates.md`, "Moving to another Mac or another macOS user". For each item it
   says whether it moves or is made again, with the person's steps (sign in to each server again) and the agent's
   (`onboard.mjs connect` again; the old key revoked by `revoke_agent_key`).
2. `servers.json` is kept in the same backup as the address, so the list of servers comes back too (it holds no
   secret).
3. The usage counts' installation id is the shared PassionCode file's (`desktop/analytics.cjs:38`), which the launcher
   owns (its PC-153: a new id on every installation): Inbox follows it and copies nothing itself.

**Acceptance.**
- A test that a restored backup brings back every listed server.
- The section, checked against the files the app writes (`AGENTS.md`, Profile).

## G4. A member's own app finds the organization's server (B-215 step 2, P2)

**Now.** A person given mailboxes (B-215) can sign in once their email is listed, but must type the server's address
in setup.

**Needed.**
- A link `fabric-inbox://join?server=<https origin>&org=<name>` that an administrator, or the organization service's join playbook (J8,
  board thread `3ff3fb1d`), sends to the member. The app adds the server to `servers.json` beside the person's own,
  opens its sign-in, and names the organization.
- The link is refused for a non-https origin, a host that is not `*.workers.dev` or a custom domain answering
  `/api/server`, and a server that does not say `org:<id>` in `/api/server`.
- The scenario first (SCN-092 and SCN-093 update), then code.

**Depends on.** the organization service's design note for its join step (due 2026-11-08); B-158 M2 sign-in by attestation stays separate.

## G5. Two macOS users and a copy in `~/Applications` (B-220, P3)

**Built 2026-11-06:** `installedOnMac` (`desktop/platform-installer.cjs`) accepts `/Applications` and this user's `~/Applications` beside Electron's answer; the launcher installs Inbox at `<home>/Applications/Fabric Inbox.app` (its PC-145).

**Was.** Automatic updates and Open at Login run only when the app is in the Applications folder
(`desktop/main.cjs:588`, `desktop/autostart.cjs:31`; Electron's `app.isInApplicationsFolder`). Whether that answer
covers `~/Applications` is not yet checked in this repository.

**Needed.**
1. Prove it on Studio under each user (runbook 2.7 and 4.2), or accept `~/Applications` explicitly beside
   `/Applications`.
2. Keep refusing a copy that is not this user's to replace: Squirrel needs to write the bundle and its folder
   (`desktop/platform-installer.cjs:115`).

**Acceptance.**
- A test for both folders.
- The clean-install check in the VM (runbook 4.2) opens and updates.

## Waves

1. **Now.** G3 (doc and `servers.json` in the backup), G5 test.
2. **After the contract's DEC (2026-11-07).** G1.
3. **After the deploy of 0.99.0.** G2, then B-168 with it.
4. **After the organization service's join-step note (2026-11-08).** G4.
