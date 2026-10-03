# Fabric Inbox runtime setup

This is an operator runbook, not evidence that these production steps ran. Source of configuration: `workers/types.ts`, `wrangler.jsonc`, `workers/routing/cloudflare-api.ts`, `desktop/cloudflare-deploy.cjs`, `workers/providers/google-oauth.ts:42`, `desktop/policy.cjs`.

## Local application

From the repository root, run `npm ci`, `npm run dev`, then `npm run desktop` in another terminal. Enter the dev server's printed loopback URL. Vite sets `remoteBindings: false` unless `FABRIC_REMOTE_BINDINGS=1` (`vite.config.ts`). Local email transport acceptance is a simulator result. The app may be opened directly from the packaged arm64 output after `npm run desktop:package -- arm64`.

Application server settings live in Electron's per-user application data, written atomically with mode 600; an unpackaged run (`npm run desktop`) uses its own folder, `Fabric Inbox Development`, so it never touches the installed app's settings or session (`desktop/main.cjs`). Chromium sessions are partitioned by server origin (`desktop/main.cjs`, `desktop/policy.cjs`). Changing the server clears the previous server's partition, so returning to it means signing in again; each launch removes partitions of servers no longer configured and leftovers of the settings files (`desktop/profile.cjs`). Release builds encrypt cookies at rest with a Keychain key, "Fabric Inbox Safe Storage" (`desktop/hardening.mjs`); a profile written by an earlier version keeps working, but going back to a version without cookie encryption means signing in again. Gmail composer drafts and recovery keys are browser-local storage under that origin (`app/routes/gmail-inbox.tsx:41`); this is not an offline mail cache or a separate encrypted draft vault.

## Your own server, created by the Mac app (recommended)

A new user needs nothing but a Cloudflare account (the free plan works) and the app
(`desktop/cloudflare-deploy.cjs`, SCN-030):

1. Install the app from the disk image and open it. Choose **Create my server on Cloudflare**.
2. **Open Cloudflare API Tokens** → **Create Token** → **Create Custom Token**, name it "Fabric
   Inbox", add the eleven permissions the app lists (the same list is on the server's Domains &
   addresses screen, `TOKEN_PERMISSIONS` in `workers/routing/cloudflare-api.ts`; a test keeps the
   two equal), Account Resources = your account, Zone Resources = All zones. Create it and paste
   it into the app.
3. Enter the email you will sign in with; the first time, also a name for the account's
   `workers.dev` address and for the sign-in page (`<name>.cloudflareaccess.com`).
4. **Create my server.** The app runs, and reports, eight idempotent steps: workers.dev address,
   R2 bucket `fabric-inbox`, Zero Trust organization, one-time PIN sign-in, an Access application
   for `fabric-inbox.<name>.workers.dev` that lets only that email in, the static files, the Worker
   (bindings, Durable Object migrations, `POLICY_AUD`, `TEAM_DOMAIN`, `CLOUDFLARE_ACCOUNT_ID`, the
   token as the secret `CLOUDFLARE_API_TOKEN`), then publishing it on workers.dev. A failure names
   what to do; **Continue** runs the rest again, and what is done stays done.
5. The app opens the server; sign in with the code Cloudflare emails. **Domains & addresses**
   opens next: choose **Receive mail here** on a domain.

The same flow updates an existing server in place (menu **Fabric Inbox → Connect Cloudflare
account…**): only the storage migrations it lacks (a step that would delete or move a class is
never sent); every setting on the Worker kept — secrets and plain vars such as
`UNKNOWN_ADDRESS_POLICY` or `GOOGLE_CLIENT_ID` alike, with the values the app sets winning; its
Access rules left alone, and a server signed in on its own domain keeps that sign-in. The server
records its version (`FABRIC_SERVER_VERSION`); a server newer than the app — by that version or by
its storage tag — is refused. The app only uploads the server built with it (the same version). The
token is held in the app's memory until the server has it and is never written on the Mac or into a
log. Mailbox data moves forward by migrations that only add (`workers/durableObject/migrations.ts`,
each in one transaction); nothing is rolled back.

Three first-time account switches are made in the dashboard, not the API, and the app says so when
it meets them: turning on R2, choosing the Zero Trust Free plan, and (rarely) a taken
`workers.dev` name. Verified on 2026-09-28 against a live account: asset hashes, the Worker upload
with all bindings and migrations, an update, and the Access application body; creating an
organization, a bucket and a workers.dev name could not be exercised on an account that has them.

## Deploying the server by hand

1. `npm ci && npm test && npm run build`, then `CLOUDFLARE_ACCOUNT_ID=<account> npx wrangler deploy`
   (applies Durable Object migrations up to `fabric-v4`). `wrangler.jsonc` names no account and no
   deployment's values; `keep_vars` keeps what is set on the Worker.
2. Create a Cloudflare Access application for the Worker's hostname and set `POLICY_AUD` and
   `TEAM_DOMAIN` on the Worker once (dashboard, or `wrangler deploy --var POLICY_AUD:… --var
   TEAM_DOMAIN:…`). Production requests fail closed without them (`workers/app.ts`). Access users
   share the whole workspace; this is not a per-user multitenant boundary.
3. Give the Worker its Cloudflare token, so **Domains & addresses** can manage your domains: the 13
   permissions in `TOKEN_PERMISSIONS` (`workers/routing/cloudflare-api.ts`, listed on the screen
   and in the app's Create my server). On this machine the Observatory credential door issues it
   from the stashed admin token into a vault slot, and it goes into the Worker's secret on stdin —
   never into a file, an argument or a chat (door presets `fabric-inbox-server` and
   `fabric-inbox-account`, passioncode-ai/project-observatory-dashboard#93):

   ```sh
   E=$(project-observatory full-path)   # the engine; its tools/ hold the door and the vault
   $E/tools/cloudflare.py issue --preset fabric-inbox-server --account <account slug> --vault fabric-inbox/prod/CLOUDFLARE_API_TOKEN
   $E/tools/use_secret.py run --env prod fabric-inbox CLOUDFLARE_API_TOKEN -- \
     sh -c 'printf %s "$CLOUDFLARE_API_TOKEN" | CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler secret put CLOUDFLARE_API_TOKEN --name fabric-inbox'
   ```

   A second issue rolls the same token (its name follows the slot). Elsewhere:
   `npx wrangler secret put CLOUDFLARE_API_TOKEN` with a token holding those permissions, or the
   app's **Connect Cloudflare account…**.

   **More Cloudflare accounts (0.8).** The server lists the domains of every account it has a
   token for. Its own token covers its own account (and, when it is a token made under My Profile,
   every account it was given). For any other account, Domains & addresses → **Connect another
   account** takes a token made in that account with the 9 permissions in
   `ACCOUNT_TOKEN_PERMISSIONS` (the window lists them). The server keeps it as its own Worker
   secret `CLOUDFLARE_API_TOKEN_<account id>`, written with its own token's Workers Scripts
   permission. On this machine the door issues it the same way:

   ```sh
   $E/tools/cloudflare.py issue --preset fabric-inbox-account --account <extra account slug> --vault fabric-inbox/prod/CLOUDFLARE_API_TOKEN_<account id>
   $E/tools/use_secret.py run --env prod fabric-inbox CLOUDFLARE_API_TOKEN_<account id> -- \
     sh -c 'printf %s "$CLOUDFLARE_API_TOKEN_<account id>" | CLOUDFLARE_ACCOUNT_ID=<server account id> npx wrangler secret put CLOUDFLARE_API_TOKEN_<account id> --name fabric-inbox'
   ```

   A domain of such an account receives here through a **relay**: Email Routing sends a zone's mail
   only to a Worker in the zone's own account, so the server installs `fabric-inbox-relay` there on
   the first **Receive mail here**, gives it an Access service token (`forever`), and the relay hands
   each message to `/relay/incoming` unchanged. Sending from such a domain goes through that
   account's Email Sending API.
4. Unknown addresses: mail to an address on a served domain without a mailbox is refused with
   "Address not found" unless the domain has a catch-all mailbox (chosen on Domains & addresses,
   stored in R2 `config/catch-all.json`, or `UNKNOWN_ADDRESS_POLICY`). Every unknown address is
   recorded (address, first and last time, count; never the sender or body) under
   `unknown-recipients/` for the Create address list.
5. Gmail settings as below. Never commit secrets or paste them into a chat.
6. Check Access denial/allow, an incoming message, a reply, and rule pause before directing
   regular traffic to it. Rollback: `wrangler rollback`; Durable Object data and migrations are not
   rolled back.

## Configuration reference

Every name the Worker reads (`workers/types.ts`). None is in `wrangler.jsonc` (CF-4): vars are set on the Worker. *Secret* means `wrangler secret put <NAME>`; never a `vars` entry, a commit or a chat message.

| Name | Kind | Needed when | Default | Meaning |
|---|---|---|---|---|
| `POLICY_AUD`, `TEAM_DOMAIN` | var on the Worker | always in production | — | Cloudflare Access audience and team URL; requests fail closed without them |
| `DOMAINS` | var on the Worker | optional | empty | domains always served, commas and/or spaces; domains received from **Domains & addresses** or a setup live in R2 `config/domains.json` |
| `EMAIL_ADDRESSES` | var | optional | `[]` | when non-empty, the only addresses that may have a mailbox; an address outside it is treated as unknown on inbound. A JSON array, a JSON string of one, or a comma-separated list |
| `UNKNOWN_ADDRESS_POLICY` | var | optional | reject | JSON `{"<domain>":"catch_all:<address>"}`; invalid JSON fails the delivery |
| `CLOUDFLARE_API_TOKEN` | secret | managing domains and addresses | none → the screen explains how to connect | the permissions above; `CLOUDFLARE_EMAIL_ROUTING_TOKEN` (before 0.3) is still read when this is absent |
| `CLOUDFLARE_API_TOKEN_<account id>` | secret, one per extra account | domains in another Cloudflare account | none | written by the server when a token is connected on Domains & addresses (or by the door); removed with the account |
| `CLOUDFLARE_ACCOUNT_ID` | var | optional | the only account the server's token sees, else the one whose Workers hold `EMAIL_ROUTING_WORKER` | the account the server runs in (its Access app, agent keys and relays' sign-ins live there) |
| `EMAIL_ROUTING_WORKER` | var | routing | `fabric-inbox` | the Worker routing rules point at |
| `AGENT_MODEL` | var | optional | `@cf/moonshotai/kimi-k2.5` | Workers AI model for address agents and the chat |
| `AUTOMATION_MODEL` | var | optional | `@cf/meta/llama-4-scout-17b-16e-instruct` | model for rule conditions and rule drafts |
| `CATEGORY_MODEL` | var | optional | `@cf/meta/llama-4-scout-17b-16e-instruct` | model that reads a new message against the categories described in words |
| `CATEGORY_DAILY_LIMIT` | var | optional | `500` | messages the category model reads per UTC day; the rest wait for the next day |
| `SPAM_DAILY_LIMIT` | var | optional | `300` | strangers' messages the model reads for spam per UTC day on its own; a check made in the same call as a category does not count; beyond it new mail is not judged by the model |
| `AUTOMATION_MCP_HOSTS` | var | agent or rule tools | empty → no tools | exact HTTPS hosts tools may call |
| `AUTOMATION_TOOL_TOKENS` | secret | tools with credentials | `{}` | JSON map credential name → bearer token; agents and rules store only the name |
| `GOOGLE_CLIENT_ID`, `PUBLIC_APP_URL`, `GMAIL_POLL_SECONDS` | var | Gmail | — / — / 300 | see Gmail below |
| `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY` | secret | Gmail | — | see Gmail below |

Bindings in `wrangler.jsonc`: `BUCKET` (R2), `AI` (Workers AI), `EMAIL` (send_email), Durable Objects `MAILBOX`, `AUTOMATIONS`, `GMAIL_ACCOUNTS`, `AGENT_REGISTRY`, `KNOWLEDGE`, `CATEGORIES`, `EMAIL_AGENT`, `EMAIL_MCP`. Migrations: `fabric-v2` adds `AgentRegistryDO`, `fabric-v3` `KnowledgeDO`, `fabric-v4` `CategoriesDO`.

Local only: `FABRIC_REMOTE_BINDINGS=1` (use cloud bindings from `npm run dev`); the preview fixture reads `FIXTURE_PORT` (default 5175), `PREVIEW_TARGET_PORT` (default 5174), `PREVIEW_ACTIONS=1`, `PREVIEW_HTML=1`; MAS packaging reads the `MAS_*` variables in [mas.md](../app-store/mas.md). Workers AI has no local mode: from `npm run dev` an agent run fails closed with "The safety check could not run".

## Setups

A setup (`shared/setup.ts`, format `fabric-inbox-setup/1`) is a JSON file with no secrets: the
server's address and Access sign-in, the served domains, the mailboxes (address, name, agent,
`forwardTo`) and per-domain catch-all mailboxes. `notServed` lists domains seen but left alone.

- **In the app, first run:** open a setup file (or, in a personal build made with
  `npm run desktop:dmg -- --setup <name>`, choose the setup bundled from `deployments/<name>/setup.json`) →
  review → **Connect and apply**. The app connects, you sign in on the server, and the server's
  **Setup** page (`/setup`) applies it and lists each address as created, updated, already there
  or not created (with the reason). The app keeps the chosen setup in
  `~/Library/Application Support/Fabric Inbox/pending-setup.json` (mode 600) until it is applied.
- **On the server:** `/setup` also opens a file, reads Cloudflare (**Read from Cloudflare Email
  Routing**, needs `CLOUDFLARE_API_TOKEN`) and exports the current setup.
  API: `POST /api/setup/apply`, `GET /api/setup/export`, `GET /api/setup/from-cloudflare[?domains=a,b]`.
- **Applying** adds the domains (R2 `config/domains.json`, next to `DOMAINS`) and catch-alls
  (R2 `config/catch-all.json`, after `UNKNOWN_ADDRESS_POLICY`), creates missing mailboxes with no
  agent, sets forwarding copies, and never deletes or renames. Applying twice changes nothing.
- **Forwarding copy:** a mailbox with `forwarding: {enabled, email}` keeps the message and then
  forwards the original through Email Routing. The destination must be a verified destination
  address in the same Cloudflare account. A refused forward keeps the mail and is written to
  `delivery-issues/<address>.json`.
- **Routing is not changed by applying a setup.** Mail reaches the mailboxes only when each
  address's (or the catch-all's) Email Routing rule sends to the Worker; until then it keeps
  going where it went. **Receive mail here** / **Bring them here** on Domains & addresses changes
  them, keeping each copy.

No deployment's own data ships or is committed (CF-4): a deployment's values, setup, Email
Routing inventory and ops receipts live in `deployments/<name>/` on its owner's machine only —
the directory is git-ignored, and the repository carries only [its guide](../../deployments/README.md)
and the placeholder `deployments/*.example.json`. `tests/no-owner-data.test.ts` reads each local
`deployment.json` and `setup.json` and fails if one of their identifiers appears in `app/`,
`workers/`, `shared/`, `desktop/` or the build configuration, and fails if anything under
`deployments/` other than the guide and the examples is tracked. A setup is packaged only when
named with `--setup`, from the local file, with its SHA-256 in the image receipt. A deployment's
setup can be generated offline from a Cloudflare inventory with
`npx tsx scripts/deployment-setup.ts <name>` ([deployments guide](../../deployments/README.md#a-setup-file-from-cloudflare-email-routing)).

## Domains & addresses

**Domains & addresses** (`/projects`, `workers/routes/domains.ts`, `workers/routing/domains.ts`)
lists every domain of the connected account. Receiving here first:

- **Receive mail here** on a domain runs, and reports, idempotent steps that stop at the first
  failure: Email Routing on (if another provider's MX records are on the domain, the app names them
  and asks before replacing them), the domain served, one address per active routing rule keeping
  its old destination as a forwarded copy, each rule pointed at this server (addresses first, so
  nothing is refused in between), then Email sending (Cloudflare adds its `cf-bounce` records) and
  a monitoring-only DMARC record where none exists. Running it again finishes what an error
  interrupted and otherwise changes nothing: each address keeps its agent, the catch-all you chose
  stays chosen. Rules that send mail to another Worker are left as they are and named.
- An open domain shows receiving, addresses that still go elsewhere (**Bring them here, keeping a
  copy**), sending (**Turn on sending**), DMARC, and anything Cloudflare would not let the token
  read, in words.
- **Add** an address: the name before @, who answers, and optionally a copy to a confirmed
  forwarding destination. Everything is checked first, then the routing rule is created (a disabled
  rule that points here is switched back on); if the mailbox cannot be saved, a rule made for it is
  removed again. On a served domain the token cannot see, the address is made without a rule and
  the screen says so. **Change** next to the copy picks another destination or none. **Send test
  message** sends from the address to itself.
- **Remove…** deletes the address's rule, then the mailbox and its mail, after a confirmation, and
  says what Cloudflare now does with its mail. The domain's catch-all mailbox — chosen here or set by
  `UNKNOWN_ADDRESS_POLICY` — cannot be removed until another one (or none) is chosen. The
  **Mailboxes** screen creates and removes through the same steps.
- **Mail for an address that does not exist**: refuse it (the sender is told; each one is listed
  with **Use this name**) or keep it in one of the domain's addresses, then **Apply** (Cloudflare's
  catch-all is pointed here; if it forwarded somewhere, that destination becomes the mailbox's copy;
  a catch-all that sends to another Worker is left alone). A catch-all set by the deployment is
  shown and cannot be changed here.
- **Forwarding destinations**: the outside addresses a copy may go to. Cloudflare sends each new one
  a confirmation link and delivers copies only after it is opened.
- **Stop receiving … here** sends each address back to its forwarded copy (or removes its rule)
  and stops serving the domain; the mail already here stays, listed under Other mailboxes. If
  Cloudflare cannot be read the domain stays served; if the token cannot see the domain the screen
  asks before stopping anyway.

- **Cloudflare accounts**: every account the server has a token for, with whether it has mail (an
  enabled routing rule, or a domain received here), how many domains, how it is reached and whether
  its relay is installed. The server's account and every account with mail are shown by default;
  **Show**, **Hide** and **Default** change that (kept in R2 `config/cloudflare-accounts.json`). An
  account whose domain receives here cannot be hidden or removed.

Without `CLOUDFLARE_API_TOKEN` the screen explains how to connect; addresses still receive whatever
Cloudflare routes to the Worker.

## Agents

Create agents on **Agents** (`/ai-agents`): from the Support, Sales or Billing template or blank. A new agent drafts every answer. **Send answers it is allowed to send** turns on sending for the intents listed (empty = any grounded answer), within the daily limit per address; everything else becomes a draft with its reason. Skipped before any model call: mail with `List-*`, `Precedence: bulk|list` or `Auto-Submitted`, no-reply senders, bounces, calendar invitations and replies, mail from any address on a domain this server serves (so two agent addresses never answer each other), and a message you already replied to yourself. When a message has `Reply-To`, that is the address answered and checked. Answers carry `Auto-Submitted: auto-replied`, the address's display name and its signature. The daily send limit counts per UTC day. **Recent answers** filters by what happened (sent or drafted, needs a look, left alone) and by agent, and pages with **Show older**; **Open the draft** opens that draft. Tools are remote MCP tools on `AUTOMATION_MCP_HOSTS`; a failed tool call turns the answer into a draft. Every run, with the version that answered, the passages it was given and exactly what was sent, is listed under **Recent answers**.

## Knowledge for agents

**Knowledge** (`/knowledge`) holds collections of documents; an agent searches only the collections
ticked on it (**Knowledge collections it may search** in the editor), so a customer-facing agent
never reads a collection meant for the team.

1. **New collection** → a name and what is in it.
2. Add documents: **Upload .md or .txt files** (several at once; a file with the same name replaces
   the one there) or paste a title and text. Up to 200,000 characters per document, 5,000
   documents per collection, 50 collections.
3. **Try a search, as an agent would** shows the passages an agent would get.
4. Tick the collection on an agent. Each incoming message is searched (subject plus the start of
   the text); the five best passages go to the model with their source, and the model may call
   `search_knowledge` with other words. The run lists the passages under **Answered from**.
   **Notes the agent always sees** stays for a few lines sent with every message.

If the collections cannot be searched in a run, the answer is kept as a draft with that reason, even
for an agent allowed to send. A collection an agent uses cannot be deleted until it is unticked.

The single knowledge base meant to feed collections is Fabric's project memory (ADR-0069). It is not
delivered yet; a collection created with source `fabric` is read-only on the screen and is filled by
a sync through `POST /api/knowledge/collections/<id>/documents` (`{documents: [{sourceUri,
revision, title, text}], prune: true}`), which is the endpoint that sync will call.
## Spam

Every message arriving at a Cloudflare address gets a verdict before it is stored (**Spam rules**,
`/spam`, lists what decides it):

- **Always spam** and **Never spam** lists of senders and domains; Report spam and Not spam in the
  reader add to them. Never spam wins over everything but a forgery: mail that claims one of your
  domains without passing its checks, or fails DMARC where its domain asks to reject or quarantine
  it, is spam even from an allowed sender (0.8.2).
- A message that claims one of your domains but fails its authenticity checks, fails DMARC where
  the sender's domain asks to reject or quarantine, or fails SPF with no valid signature goes to
  Spam. Only the result Cloudflare's MX writes (`Authentication-Results: mx.cloudflare.net`) counts.
- A message from someone none of your addresses has written to is read by the model once
  (`SPAM_DAILY_LIMIT`), in the same call as its categories when there are any. A message with almost
  no text and no link is not judged.

Spam sits in the **Spam** folder of the unified inbox with its reason; no agent, rule or category
acts on it and no forwarding copy is sent. An agent answers a stranger's message only after its
spam check (at most 15 minutes later if the model does not answer). Spam older than 30 days is deleted with its attachments;
**Delete all now** empties it at once. Gmail keeps its own spam; Report spam and Not spam on a Gmail
message use Gmail's own label. Mail that arrived before 0.6.0 is not re-checked.

## Addresses in the sidebar

The sidebar lists, by default, addresses with mail in their inbox, catch-all mailboxes and the one
open (**With mail**; **All** lists every address, remembered on the device). "N without mail not
listed" offers **Show** and **Hide them…**. The eye next to an address hides it: it leaves the
sidebar, All inboxes, its domain's view and the unread totals, and keeps receiving; agents and
categories treat it as before. Hidden addresses wait under **Hidden (N)**, where one opens on its own
or is shown again. The list lives on the server (`config/hidden-accounts.json`), so every device
sees the same.

When mail reached an address but not its rules, agents or categories (a consumer kept failing), the
feed says so with the last error and **Retry**; each such event is retried with a backoff and set
aside after 10 attempts.

## Agent access (outside agents over MCP)

**Agent access** (`/agent-access`, in the sidebar) gives an AI agent you run elsewhere its own key
to `https://<server>/mcp`. Choose a level — **Read** (reads and searches, changes nothing),
**Mail** (also drafts, moves, marks, reports spam) or **Admin** (everything the app does) — and for
Mail or Admin **Drafts only** or **Can send** with a number a day; the key expires after 30 days,
90 days or a year. The Client Secret is shown once with a ready `claude mcp add` command and a JSON
entry for other clients. **Revoke…** stops a key at once. **What agents changed** lists every change
made through the protocol.

The server's Cloudflare token needs **Access: Service Tokens — Edit** and **Access: Apps and
Policies — Edit** for this (both are in the token list the app shows). A key is a Cloudflare Access
service token let through by one Service Auth policy named `Fabric Inbox agents <aud>` on the
server's own Access application; the application's other policies are left as they are. What
agents can do, and the rule that keeps it complete: [docs/agents/mcp.md](../agents/mcp.md).

## Categories

**Categories** (`/categories`, or **+** beside CATEGORIES in the sidebar) are views of the mail
that matters, beside Focus.

1. Optional: **New project** → a name, its domains (a domain covers its subdomains) and single
   addresses elsewhere (a Gmail account the product uses).
2. **New category** → a name and **Where to look**: all inboxes, or projects, domains and single
   inboxes (search them by name; what is ticked stays visible).
3. Leave the rest empty to see every message there (a live view, nothing is sorted). Or say what
   belongs in words (**What belongs here**) and/or give **Plain conditions**: From, Subject has,
   Text mentions. Each filled line must match, any entry in a line is enough; conditions alone
   use no model.
4. **Also raise its messages to Important in Focus** puts them in Important with "Category: X".

On save, a described category sorts the last 200 messages in its scope in the background (progress
on the screen and on the category's view), then every new message as it arrives: plain conditions
first, then one model call per message for all described categories in scope, each verdict with a
one-line reason shown as **Why:** on the row. At most `CATEGORY_DAILY_LIMIT` messages a day are
read by the model; the rest wait for the next UTC day and say so. Changing where it looks, the
description or the conditions sorts again from scratch; a rename does not. A project a category
uses cannot be deleted. A message moved to Trash leaves the view; restored, it comes back only when
the category is next changed (board B-26).

## Gmail

`workers/providers/google-oauth.ts` validates:

| Setting | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth web application client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret, server only |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Base64url-encoded 32-byte AES-GCM key; back up safely before using accounts |
| `PUBLIC_APP_URL` | Exact HTTPS application origin; no path/query/credentials |
| `GMAIL_POLL_SECONDS` | Optional poll interval, default 300 seconds; clamped to 60–3600 |

Register `PUBLIC_APP_URL` plus `/api/accounts/gmail/callback` as the OAuth redirect URI. Enable Gmail API and configure consent/test users for the requested `gmail.modify` scope. These are provider administration steps, not a guarantee that Google will grant the app production access.

Use **Connect Gmail in browser** or the native Account menu. The browser first opens the application's `/api/accounts/gmail/connect` route, which binds state to that browser before redirecting to Google. Opening only a Google authorization URL copied from another browser is insufficient. Return to the app after completion; Accounts refreshes periodically.

Tokens are encrypted server-side and omitted from account responses. Initial/history-expiry import does not run rules against historical messages. Incremental incoming events use a durable acknowledgement outbox (`workers/providers/account-service.ts`, provider tests). Polling continues in Durable Object alarms after the desktop closes, once deployed/configured. Pub/Sub is not implemented.

Cloudflare Access email-code authentication can remain inside the app when its exact team origin is configured. External identity-provider SSO currently opens the system browser and does not transfer cookies back; that handoff remains open.

## AI and tools

`AUTOMATION_MODEL` optionally replaces the existing Workers AI model identifier. A real model call was not included in local acceptance. A rule with an AI condition or draft action needs a working AI binding. Classification cannot select a recipient or tool; rule configuration fixes those.

`AUTOMATION_MCP_HOSTS` is a comma-separated list of exact permitted public HTTPS hosts. An empty list denies MCP rule creation. `AUTOMATION_TOOL_TOKENS` is an optional server secret containing a JSON map from credential names to bearer tokens. Rules store only the name (`tokenRef`), not its value. Set these via the Cloudflare secret/configuration mechanism; no production token example is included here.

Tools use Streamable HTTP. Endpoint redirects, loopback/numeric addresses and unapproved hosts are rejected. The configured hostname is an administrator trust boundary; this is not a general DNS-rebinding firewall. Template string values may include `{{email.id}}`, `{{email.sender}}`, `{{email.subject}}`, `{{email.body}}`. Body substitution is bounded to 16,000 characters, total resolved arguments to 32 KB. Email cannot choose argument keys, endpoint or tool (`workers/automation/policy.ts`). Approval stores the resolved action and binds it to the message digest.

No local MCP server or machine gateway configuration is installed by this repository. Device execution is not implemented. Use a controlled mock/read-only tool for acceptance before enabling an automatic side effect.
