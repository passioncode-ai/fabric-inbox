# Set up Fabric Inbox as a coding agent

**State:** written 2026-10-11 for 0.14.1 (board B-79, B-81; the operator's agents-first decision of
2026-10-10, fabric-dashboards FD-39). Sources: [`scripts/onboard.mjs`](../../scripts/onboard.mjs) (the
server step), [`plugins/fabric-inbox/scripts/onboard.mjs`](../../plugins/fabric-inbox/scripts/onboard.mjs)
(every other step, no dependencies), [`plugins/fabric-inbox/scripts/headers.mjs`](../../plugins/fabric-inbox/scripts/headers.mjs)
(the headers helper). Tests: [`tests/onboard.test.ts`](../../tests/onboard.test.ts).

You, the coding agent, do every step you can. The person does three things only, and each is
theirs on purpose: **paste the Cloudflare token** into a hidden prompt (or have their secret runner
inject it), **sign in** to Fabric Inbox with the code Cloudflare emails them, and **choose Allow**
when the app asks whether to give you a key. Tell them exactly that, at the moment it is due —
every step prints the human part as `→ You:` (or `human` in `--json`).

Never ask for the token or a key in the chat, never put either on a command line, in a file, a URL
or a log. The tools below are built so that you never see them.

## 1. The server (once per person; skip it if they already have one)

From a checkout of this repository (`npm ci` first):

```sh
node scripts/onboard.mjs server --email <their sign-in address> --subdomain <name> --team <name>
```

It asks for the token in the terminal and shows nothing of what is pasted. A secret runner can give
it instead: `--token-env NAME` reads the variable `NAME` (for example under the Observatory's
`use_secret.py run … CLOUDFLARE_API_TOKEN -- node scripts/onboard.mjs server --token-env CLOUDFLARE_API_TOKEN`).
`--token` is refused: a token is never an argument. The token needs the permissions the Mac app
lists (`PERMISSIONS` in [`desktop/cloudflare-deploy.cjs`](../../desktop/cloudflare-deploy.cjs);
[setup → your own server](../desktop-mail/setup.md#your-own-server-created-by-the-mac-app-recommended)).

The step is the Mac app's **Create my server**, step by step and idempotent: the workers.dev name
(`--subdomain`, only if the account has none), the R2 storage, the Zero Trust team (`--team`, only
if none), sign-in by emailed code, an Access application that admits only `--email`, then the
server built from this checkout (`npm run desktop:server-bundle` runs when the bundle is missing or
older). A token that reaches several accounts needs `--account <id>`; the refusal lists them.
Running it again on an existing server updates the code and keeps the storage and the sign-in.

**Then the person:** installs the Fabric Inbox app (README → Quick start) and opens it. The step left
a setup beside its record (`setup.json`), so the welcome offers **Use the server your agent set up**
with its address; they confirm and sign in with the emailed code (SCN-077). Nobody types the address. That sign-in is the only way a key can
be made for you: the server makes keys for a signed-in person only.

## 2. Your key, with the person's consent

```sh
node <plugin>/scripts/onboard.mjs connect --level mail
```

(`<plugin>` is the installed `fabric-inbox` plugin, or `plugins/fabric-inbox` in a checkout;
`node scripts/onboard.mjs connect` does the same.) It opens a `fabric-inbox://connect` link: the app
comes forward, names you and the level, and **the person chooses Allow**. The key goes from the app
to a one-shot listener on `127.0.0.1` with a fresh request id and straight into the system's key
store — macOS Keychain, the Secret Service on Linux, the Windows Credential Locker — under the
service `fabric-inbox-agent-key` and the server's host. It is not printed and not written to any file.

Levels (Settings → Agent access says the same): `read` reads and searches and changes nothing;
`mail` also drafts, moves and marks mail (drafts only unless `--send`); `admin` is everything the
app does, can send, and makes the app ask for the person's explicit tick. Ask for the least that the
work needs. Deny, no answer within three minutes, or no server or sign-in in the app are each a
refusal that says which; nothing is kept then.

## 3. Register and prove

```sh
node <plugin>/scripts/onboard.mjs register      # Claude Code, user scope, name "fabric-inbox"
node <plugin>/scripts/onboard.mjs prove         # initialize, tools/list, list_accounts
```

`register` gives Claude Code the server's `/mcp` URL and a **headersHelper** — a copy of
`headers.mjs` kept beside the record, so an update of the plugin never moves it — that reads the key
from the key store on each connection and prints the two Cloudflare Access headers. Claude Code's
config holds no secret. An existing entry of that name for another address is not replaced unless
you pass `--replace` (or choose another `--name`). Another MCP client: an HTTP entry with the URL and
the same helper's output as its headers; the refusal of `register` prints the entry.

`prove` makes the calls an agent would, with the stored key, and says how many tools and accounts
it saw. Run it after every setup; a 401/403 or a redirect to the sign-in page means the key was
refused (revoked, expired, or never allowed) — run `connect` again.

## Where things are, and starting over

| What | Where |
|---|---|
| The record (server, MCP URL, key id and level, registration; no secret) | `<appData>/PassionCode/fabric-inbox/onboard.json` — macOS `~/Library/Application Support`, Linux `$XDG_CONFIG_HOME` or `~/.config`, Windows `%APPDATA%` |
| The headers helper Claude Code runs | `headers.mjs` beside the record |
| The server the app's welcome offers | `setup.json` beside the record (written by `server`) |
| The key | the system key store, service `fabric-inbox-agent-key`, account = the server's host |

`onboard.mjs forget` removes the stored key and the record; the key itself stays valid until it is
revoked in **Settings → Agent access**, where every key is listed with its agent and level.

## For a launcher (B-81)

Fabric Inbox is one step of a family setup; the launcher owns the order. Every command takes
`--json` and then prints one JSON object per line:
`{ "step", "outcome": "done" | "already" | "running" | "waiting" | "failed", "detail", "human"?, "code"? }`
(`human` is what to tell the person; `code` is set on a refusal). `status --json` answers where this
machine stands, without a secret:

```json
{ "record": "<path>", "steps": [ { "step": "server", "outcome": "done" | "todo", "detail": "<origin>" },
  { "step": "connect", "outcome": "done" | "todo", "detail": "<key id> (<level>)" },
  { "step": "register", "outcome": "done" | "todo", "detail": "<name>" } ] }
```

Run the steps in order: `server` (when there is none), the person's sign-in, `connect`, `register`,
`prove`; each exits non-zero on a refusal.
