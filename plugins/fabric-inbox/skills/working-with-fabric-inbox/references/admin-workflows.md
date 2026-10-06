# Administration workflows

Load when an `admin` key changes how Fabric Inbox is set up. Each block is the order of calls that
works; the live tool schemas have every input.

## Contents

- [Addresses](#addresses)
- [Cloudflare accounts](#cloudflare-accounts)
- [Domains](#domains)
- [Forwarding copies](#forwarding-copies)
- [Spam](#spam)
- [Reply agents](#reply-agents)
- [Categories and projects](#categories-and-projects)
- [Knowledge](#knowledge)
- [Rules](#rules)
- [Setup files](#setup-files)
- [Checking your own work](#checking-your-own-work)

## Addresses

- **Create:** `list_domains` (the domain must be served) → `create_address` with `localPart`,
  `domain`, optionally `name`, `agent`, `forwardTo` (`createRoute` defaults to `"auto"`: the rule is
  made when the server has a routing token; read the answer's `warning` when it was not) →
  `check_address_routing` → optionally `send_test_message`.
- **Change:** `update_address` — only the fields you pass change: `fromName`, `signature`,
  `assistantPrompt`, `agent` (`"off"` or `{ agentId }`), `forwardTo` (`null` stops forwarding).
- **Remove:** `remove_address` is two-step and deletes the address's mail for good. Its summary
  says how much; the person decides.
- **Mail arrives elsewhere:** `check_address_routing` says where it goes; `route_address_here`
  points it at this server.
- **Hide from the sidebar:** `set_hidden_addresses` (it keeps receiving).

## Cloudflare accounts

- **See them:** `list_cloudflare_accounts` — every account the server has a token for, whether it
  has mail, whether it is shown, and whether its relay is installed. `list_domains` lists only the
  shown accounts' domains, each with its `account`.
- **Show or hide:** `show_cloudflare_account` with `shown` (`null` = the default: shown when it has
  mail). An account whose domain receives here cannot be hidden.
- **Connect one more:** only the owner can, in the app (Settings → Accounts → Connect account →
  Cloudflare): the token is a secret and never goes through a tool. Say so rather than asking for it.
- **Remove:** `remove_cloudflare_account` — two-step; refused while one of its domains receives
  here (`release_domain` first).

## Domains

- **Receive a domain here:** `list_domains` → `connect_domain`. A domain in another account than
  the server's gets a `relay` step first: the server installs a small Worker there that carries its
  mail here. If another provider's MX records
  are there it stops with that finding; `replaceMx: true` replaces them — two-step, and mail stops
  reaching the old provider, so the person must say yes knowingly.
- **Catch-all:** `set_catch_all` with a mailbox, or `null`. Refused when the deployment fixes it.
- **Sending:** `enable_domain_sending` (adds DMARC when missing).
- **Stop serving:** `release_domain` — two-step; mailboxes and mail stay.

## Forwarding copies

A copy goes only to a **verified** destination **in the address's own Cloudflare account**:
`list_domains` with `destinations: true` and that domain's `account` → if absent,
`add_forward_destination` with the same `account` (Cloudflare emails it a link; someone must click
it) → once verified, `update_address` with `forwardTo`, or `create_address` with it.

## Spam

`get_spam_settings` → `update_spam_list` (`blockedSenders`, `blockedDomains`, `allowedSenders`,
`allowedDomains`; `add` or `remove`). Judging messages is `mark_spam` (mail level). `empty_spam` is
two-step and permanent for Cloudflare mailboxes; Gmail's Spam is not touched.

## Reply agents

- **Create:** `list_agents` (templates, allowed tool hosts) → `save_agent` with the whole
  definition (a new agent drafts every answer until `replyPolicy.mode` is `auto`) →
  `update_address` with `agent: { agentId }` for each address it answers.
- **Change:** `list_agents` with `agentId` → `save_agent` with `agentId`, the full `agent`, and
  `expectedVersion` = its current version. A conflict means someone changed it meanwhile: read
  again, merge, retry.
- **See what it did:** `list_agent_runs` (outcome `attention` = needs a person).
- **Delete:** `delete_agent`, two-step; its addresses stop being answered.

## Categories and projects

`list_categories` → `save_project` (group domains and addresses; with `projectId` only the fields
you give change) → `save_category` with a `scope`
and either `conditions` (rules, no model) or a `description` (screened by the model, backfilled in
the background). `delete_category` / `delete_project` are two-step.

## Knowledge

`save_knowledge_collection` (`source: { kind: "fabric", project, scope? }` makes one Fabric keeps in
step; a collection's source is chosen when it is made) → `put_knowledge_documents` (up to 100 per call, updated by
`sourceUri`; `prune: true` deletes the rest and is two-step) → grant it with `save_agent`
(`collections`). `search_knowledge` shows what an agent would be given.

## Rules

`list_rules` for the account → `save_rule` (same `id` changes only the fields you give; a new rule
needs `name`, `conditions`, `action` and starts off; the server numbers versions; `mode: approval`
waits for `approve_rule_run`) → `dry_run_rule` on a real message before enabling. Runs waiting for
approval appear in `list_rules`; `dismiss_rule_run` cancels one.

## Setup files

`export_setup` gives the setup (no secrets); with `fromCloudflare: true` it proposes one from the
account's Email Routing rules. `apply_setup` applies one — two-step, never deletes.

## What a person does

Connecting a Gmail account, connecting an IMAP account (its app password), setting Gmail up on the
server (the Google client secret), issuing or
revoking an agent key, and pasting a Cloudflare token are the person's own acts.
`gmail_setup_status` says what the Gmail setup lacks and the exact values the owner copies into
Google Cloud; `check_gmail_setup` checks the saved client with Google and names what to fix.
`gmail_connect_link` gives the address they open to connect Gmail; `list_mail_providers` lists the
IMAP presets (servers, the first step at the provider, its help page) and where in the app the
person enters the password — an agent never receives one. `disconnect_account` (two-step)
disconnects a Gmail or IMAP account;
`list_agent_keys` lists the keys (no secrets); keys are made in Settings → Agent access and tokens
pasted in Settings → Accounts.

## Checking your own work

After a change, read it back (`list_addresses`, `list_domains`, `list_agents` …) and report what is
now true, not what you asked for. `list_agent_activity` shows the journal of changes, yours included.
