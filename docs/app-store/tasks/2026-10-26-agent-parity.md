# B-154: every button is an agent tool (DEC-0121)

Status: steps 1 and 2 in 0.38.0 (2026-10-26). Row: [B-154](../../evidence/backlog.md). Contract: fabric-agent-contract
`docs/DECISIONS.md` DEC-0121 (accepted 2026-10-24; its consumers CT-124 to CT-127), read at the contract's
`origin/main` on 2026-10-26. Deadline from the board request `e1b2cc69`: 2026-11-21.

## What the contract asks

- **AP-1 parity.** Every action a person can take in the app has an agent tool with the same effect, checks,
  audit record and an idempotency key, and the service declares its actions in its well-known document under
  `https://fabric.passioncode.ai/agent-contract/extensions/actions/0.1` (`actions[]` of
  `{id, title, tool, gate, humanStep?}`; `gate` is `none`, `relayed` or `human`).
- **AP-2 relayed decision.** A `relayed` action from a T0 or T1 caller carries the operator's words in
  `_meta.decision`; a **T2 caller** without an accepted approval is refused `approval-required`, and a decision in its
  call changes nothing.
- **AP-4 human gates.** Sign-in, consent, payment, a typed secret, spend above a limit and a passkey stay the
  person's; their tool refuses `human-step-required` with `data.humanStep` and `data.url`, the direct link.

## Facts in this repository

- Fabric Inbox is a remote-placement service (`workers/routes/fabric-service.ts:11`): it runs in Cloudflare and is
  reached over the internet with an agent key. It cannot place any caller in T0 or T1 (the contract's
  `docs/specification/delegation.md` DL-25: "any caller the callee cannot place in T0 or T1" is T2). So AP-2's
  relayed decision never applies here; what applies is the T2 rule, an approval. The server already has one: the
  owner's approval of a key's irreversible actions (B-38, `workers/mcp/protocol.ts:174`, `needsApproval`).
- The acts that are not tools are listed with their reasons in `NOT_TOOLS` (`workers/mcp/tools.ts:1770`, 21 routes).
  By DEC-0121's gates they fall into three groups:
  - **human** (a person's consent or secret): connecting Gmail and Outlook (`consent`; the links already exist as
    `gmail_connect_link`, `outlook_connect_link`), an IMAP password, a Cloudflare token, the Google and Microsoft
    client secrets (`secret`). They become tools that answer `human-step-required` with the exact settings link.
  - **relayed, through the owner's approval** (they change people, keys or the server): members (`PUT`, `DELETE
    /api/members/:email`), agent keys (`POST`, `DELETE /api/agent-keys`, `PATCH /api/agent-keys/:id`), deciding a
    waiting approval (`/api/agent-keys/approvals`), the server's self-update. Each needs the owner's approval on every
    call whatever the key's setting, since an agent approving its own escalation is what AP-5 forbids.
  - **not actions** (redirects and the app's own reads): the OAuth callbacks, `GET /api/me`.
- The well-known document declares no actions extension yet (`workers/routes/fabric-service.ts:134` names only the
  runner extension), and the vendored contract schemas (`tests/fixtures/fabric-contract/README.md`, pin `2f020a6`)
  predate DEC-0121.

## Decisions taken here (reversible)

1. Use the owner's approval of B-38 as the T2 approval for every `relayed` action that is not a tool today, required
   on every call of those tools (not only for keys set to "owner approves"). Reason: the row's own text and AP-5; the
   contract's `approval/1` needs a hub this server does not reach. Revisit when a hub can mint approvals for remote
   services.
2. Deciding a waiting approval (`POST /api/agent-keys/approvals/:code`) and switching a key's approval off (`PATCH
   /api/agent-keys/:id`) stay out of the agent surface: an agent approving an approval is no approval (B-38, AP-5).
   FAC-SEM-142 refuses a declared action without its tool, so they stay undeclared, named in `NOT_TOOLS` with this
   reason, and the gap goes to the contract's owner on the board.

## Plan

1. Vendor the contract schemas at the pin that carries DEC-0121 (`service-actions-extension`, `delegation-refusal`).
2. `human` tools: one tool per human step, answering `human-step-required` with `data.humanStep` and `data.url`.
3. `relayed` tools for members, agent keys and self-update, each always through the owner's approval.
4. The actions declaration in the well-known document, generated from the tool list, checked against the schema and
   FAC-SEM-142's rules in a test.
5. Scenarios (SCN-018-like approval flow for the new tools), `docs/agents/mcp.md`, the skill, CHANGELOG; a release.

## Steps 1 and 2 receipt (0.38.0)

- The vendored contract schemas moved to `1197a90d` (tag `v0.1.0+2026-10-26.12`), adding
  `service-actions-extension`, `decision`, `delegation-refusal` and what they reference
  (`tests/fixtures/fabric-contract/README.md`); `tests/fabric-service.test.ts` still green.
- `HumanStepRequired` (`workers/mcp/protocol.ts`): `runTool` answers the contract's refusal
  `{error: {code: "human-step-required", message, data: {humanStep, url}}}` as `structuredContent` and as text.
- Tools `connect_account` (gmail and outlook: consent at the provider's sign-in, or secret at the server's setup
  when it is not set up; imap and cloudflare: secret), `set_account_password` (imap: secret at the account's page),
  `set_provider_setup` (secret). The secret routes stay in `NOT_TOOLS`, whose reasons now name these tools.
- `tests/mcp-human-steps.test.ts` checks every refusal against `delegation-refusal.schema.json`.

## Exact next step

Step 3: the `relayed` tools for members, agent keys and the server's update, each through the owner's approval on
every call; then step 4, the actions declaration.
