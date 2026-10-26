# Mail that protects its reader and its agents, a Government request category, and outreach

Status: planned 2026-10-26; module 1 live as configuration. Rows: B-177 to B-181 in
[the board](../../evidence/backlog.md). Route: task-pipeline, cut into modules; each module runs stages 3 to 10.

## The request (operator, 2026-10-26, paraphrased from Russian voice input)

Fix what is in progress first, then:

1. Requests from authorities and services about our products arrive often; agents should filter them and put them
   in their own category, "Government request".
2. Attachments (PDF and others) and links: the mail should protect me.
3. An extra verifier: a light model reads the whole body, including hidden text, for instructions aimed at agents.
   A message that has them is marked and kept from every agent that has tools until it is reviewed; the review
   runs separately in a restricted environment and gives a verdict.
4. Links are checked against phishing databases. Okolos (PassionCode's browser-security extension) already has
   them: integrate with it, so Fabric Inbox's mail is guarded by Okolos, and Okolos can later guard other mailboxes
   on its own.
5. Outreach: people send partnership and site offers in bulk; Fabric Inbox should let an agent run outreach well:
   given a dataset of addresses and messages, start one loop that sends them optimally instead of one call per
   message. Study what outreach tools people use. The product stays one inbox for personal, agent, support and
   automation mail, outreach included.
6. Check every scenario so nothing breaks, and that the new ones work.

## What exists (facts)

- **Categories:** a screened category has a description the model judges each message against, can raise its mail
  to Important (`promote`) and classifies the latest 200 messages on creation (`workers/categories/definition.ts`,
  tool `save_category`). The owner's server had one screened category before this (refund requests).
- **Prompt-injection check:** `scanPromptInjection` (`workers/lib/ai.ts:40`, Workers AI
  `@cf/meta/llama-3.1-8b-instruct-fast`, YES or NO per chunk) runs only inside a reply agent's run
  (`workers/agents/runner.ts:473`) and on a tool's output (`:524`). It does not run on arrival; an outside agent
  reading mail over MCP, an automation rule and the categories read an injected message unmarked.
- **Okolos** (`passioncode-ai/okolos`, AGPL-3.0-only or commercial): a phishing feed from OpenPhish's community
  feed (`tools/ingest.mjs:88`), hosts only, at most 5,000, signed and published to Cloudflare D1; served by the Worker
  `okolos-proxy` at `GET /feeds/phishing` (the whole signed feed, cached 900 s) and `GET /status/domain?domain=`
  (exact domain); pure `matchUrl(url, feed)` (`packages/core-feeds/src/lookup.ts:21`, a parent domain matches);
  `@okolos/core-mail` assembles a message verdict with sender auth and lookalike links but does not consult the
  feed. No MCP or fabric-service surface. The feed's data stays under its source's terms (`LICENSING.md:43`):
  OpenPhish's community terms must be read before commercial use; Google Safe Browsing is non-commercial only
  (Web Risk is the commercial route).

## Requirements (REQ spine)

| REQ | Requirement | Module | Verified by |
|---|---|---|---|
| REQ-1 | A Government request category judges every inbox's mail by the rule above and raises it to Important | M1 | live: its verdicts over the latest 200 messages, read by hand |
| REQ-2 | Every arriving message (Cloudflare, Gmail, IMAP, Outlook) is checked on arrival for instructions aimed at agents, in its visible and hidden text | M2 | workerd tests with hidden-text fixtures; live counts |
| REQ-3 | A flagged message is held from every agent that has tools (reply agents, automation rules, outside agents over MCP get a notice instead of its text) until it is reviewed or a person releases it | M2 | tests per surface |
| REQ-4 | The review runs in a restricted environment: a model with no tools and no other mail reads it as data and answers safe, injection or phishing with its reasons; a person can release or keep it | M2 | tests; scenario |
| REQ-5 | Links in a message are checked against the Okolos phishing feed and for lookalikes; a dangerous link is marked for the person and for agents, and opening it warns first | M3, M4 | tests with feed fixtures; scenario |
| REQ-6 | Attachments: the text of a PDF or document is checked like the body; executable and macro files are marked | M3 | tests with fixtures |
| REQ-7 | Fabric Inbox reads the Okolos feed (signed, cached) through a contract another mailbox can reuse; Okolos as a standalone mail guard is its own later product | M4 | contract test against the feed's signature |
| REQ-8 | Outreach: a campaign takes a list of recipients with their fields and a template, sends from a chosen account in a server-side loop within a sending window and per-account and per-domain limits, stops for a recipient who replies, carries an unsubscribe link and honours a suppression list, follows up, and reports per campaign; agent tools and a screen | M5 | tests; scenario; a dry run |
| REQ-9 | Every existing scenario still holds and the new ones are written and linted | all | `npm test`, `docs/ux/lint.py`, `docs/ux/doctor.py` |

## Decisions taken here (reversible; reasons)

1. Government request also covers a provider's request that a regulation requires (KYC, AML, a regulatory bundle):
   that is what the owner's mail actually holds (a search of the Cloudflare mailboxes on 2026-10-26 found Twilio
   regulatory bundles, an AML review and a KYC request, and no letter from a state body). Phishing posing as an
   authority stays Spam.
2. The arrival check uses the same light model as the reply agents' check, so a verdict means the same everywhere;
   it runs before categories and agents, inside the spam call's daily budget.
3. Held means "no agent with tools gets the text", not "hidden from the person": the person sees it, marked.
4. Links are checked against a copy of the signed Okolos feed kept by the server (refreshed every 15 minutes), not a
   call per link, so mail never waits on another service and no address leaves the server.
5. Outreach sends only from the person's own accounts and addresses, never a shared pool, and every campaign is
   started by a person or an agent with a sending key under the key's daily allowance.

## Order

M1 (now, configuration) → M2 (arrival check and hold) → M3 and M4 (links and attachments with Okolos) → M5
(outreach, researched first). Each ends with a release.

## Exact next step

M2 stage 3: the scenario of a held message (super-ux), then the arrival check in `workers/index.ts` and the
accounts' `drain`.
