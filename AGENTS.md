# Working in fabric-inbox

## Read first

1. The PassionCode.ai knowledge base — `fabric-workspace/knowledge/` in your clone (org-index
   `scripts/clone_all.sh` makes it) or https://wiki.passioncode.ai/knowledge — at least its
   [README](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/README.md),
   vision, principles and how-to-work (private; readable by every org member).
2. This file, then the organization's
   [CONTRIBUTING.md](https://github.com/passioncode-ai/.github/blob/main/CONTRIBUTING.md).

That guide holds the names, how a change lands, the code region markers and the security contact;
this file adds the rules of this repository and wins where the two differ.

## What this repository is

Fabric Inbox: a desktop mail client with cloud email automation and tool integrations, in
development preview. Fabric's mail tool; also works on its own. It shows one triaged list across
Gmail and Cloudflare mailboxes, and every domain of your Cloudflare account can be managed from
the app. Addresses are answered by versioned agents under a reply policy. The macOS app creates
its server in your own Cloudflare account. It began as Cloudflare's
[Agentic Inbox](https://github.com/cloudflare/agentic-inbox) template (Apache-2.0), imported in
`93b86c6`; what came from it and its notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Commands

| What | Command |
|---|---|
| Install | `npm ci` |
| Test (the gate) | `npm test && npm run typecheck` |
| Build | `npm run build` (disk image: `npm run desktop:dmg`) |
| MCP (register + proving call) | `npm run dev -- --port 5174 --host 127.0.0.1`, then `claude mcp add --transport http fabric-inbox-local http://127.0.0.1:5174/mcp` and call `list_accounts` (README → Quick start) |

All the checks, from `README.md` ("Run locally", "Develop and test"):

```sh
npm ci
npm test                 # all tests; Worker code runs in workerd (Miniflare), no network
npm run typecheck        # Wrangler and React Router types, then tsc -b
npm run build
python3 docs/ux/lint.py && python3 docs/ux/doctor.py   # UX contract
python3 docs/brand/lint.py                             # brand strings (warnings are advisory)
npm run mcp:docs                                       # the agent protocol's tool reference
```

`npm run dev` serves the Worker and app on `http://localhost:5173` with local Miniflare bindings.
`npm run desktop` opens the desktop shell, and `npm run desktop:server-bundle` (run it once) gives
**Create my server** a server to upload. The checks above are the gate, run before you push;
`.github/workflows/ci.yml` runs them again on every pull request and on `main`. A documentation change also runs `git diff --check` and resolves every relative link
(see "Checks for documentation" in `docs/DOCMAP.md`).

## Local rules

### Where things live

- [docs/DOCMAP.md](docs/DOCMAP.md) gives one home per question. It separates current documents
  from history, and history is not to be followed as instructions.
- The next task is in [docs/app-store/README.md](docs/app-store/README.md) ("Exact next task").
  The status authority is the [roadmap](docs/app-store/tasks/2026-09-28-roadmap.md).
- How it works: [docs/architecture.md](docs/architecture.md), the architecture as built.
  Configuration and deployment order are in [docs/desktop-mail/setup.md](docs/desktop-mail/setup.md).
- UX scenarios, flows and screens are in [docs/ux/](docs/ux/scenarios.md), and the brand pack is
  in [docs/brand/](docs/brand/README.md).
- The open board is [docs/evidence/backlog.md](docs/evidence/backlog.md). Lessons are in
  [docs/evidence/retro.md](docs/evidence/retro.md).
- Code: `app/` is the React Router UI, `workers/app.ts` is the Worker entry (`wrangler.jsonc`),
  `desktop/` is the Electron shell, and `shared/` and `tests/` hold shared code and tests.

### Rules in this repository

- **Every function of the app is an agent tool, in the same change** (operator, 2026-09-29). A new
  or changed route gets its tool in `workers/mcp/tools.ts` (or an exclusion with its reason in
  `NOT_TOOLS`), then `npm run mcp:docs` regenerates [docs/agents/mcp.md](docs/agents/mcp.md), and
  the skill in `plugins/fabric-inbox/` is updated when a workflow changes. `npm test` fails until
  all three agree (`tests/mcp-coverage.test.ts`, `tests/mcp-docs.test.ts`, `tests/mcp-skill.test.ts`).
  The plugin's version is the app's version; a release ships both.
- The roadmap is the status authority. The T, REQ and R tables in older packets are frozen
  (`docs/DOCMAP.md`).
- Signing and notarization keys stay outside Git (`README.md`, "Install on a Mac").
- A deployment's own files (`deployments/<name>/`: account, domains, addresses, ops receipts) are
  local and git-ignored; only `deployments/README.md` and `deployments/*.example.json` are
  committed, and `tests/no-owner-data.test.ts` fails otherwise. A personal build
  (`npm run desktop:dmg -- --setup <name>`) bundles the local `deployments/<name>/setup.json` and is
  for its owner only. The public build carries no one's setup or domains.
- Licence: `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial` for this project's own code
  (`README.md` → License). The code imported from Cloudflare's Agentic Inbox template stays
  Apache-2.0: never remove or reword a `Copyright (c) 2026 Cloudflare, Inc.` header, and keep
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) true when such a file is moved, split or deleted.
- **Shared registers are edited under a lease.** [docs/AGENT_SYNC.md](docs/AGENT_SYNC.md)
  (generated from `.claude/agent-sync.json` by `agent_sync.py setup`; never edited by hand) lists
  the guarded files and the gate. Run `agent_sync.py acquire <file>` before editing one and
  `agent_sync.py release <file>` after, on every path including failure. The lease is a ref under
  `refs/agent-sync/leases/` on `origin`, so another contributor's agent sees it
  (`git ls-remote origin 'refs/agent-sync/leases/*'`); the record plane is local (`fs`), and
  `.agent-sync/` is git-ignored. No register here carries a "Next free ID" line, so nothing is
  reserved yet; a register that gains one is declared under `idRegisters` and taken with
  `agent_sync.py reserve <REG>`.

## Organisation

This repository is one of the `passioncode-ai` repositories. **The org map and onboarding live in
[passioncode-ai/org-index](https://github.com/passioncode-ai/org-index)** (private; readable by
every org member); the shared rules live in the knowledge base:

- [README](https://github.com/passioncode-ai/org-index#repositories): which repository owns what, and how they connect
- [rules](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/rules.md): branches, commits, CI, leases, secrets, handoffs
- [ONBOARDING.md](https://github.com/passioncode-ai/org-index/blob/main/ONBOARDING.md): setting up a new contributor's machine

Where this file is stricter than the rules, this file wins. A change to this repository's
role, dependencies or test command updates its row in `org-index/repositories.json` in the same change.

## After work

In the same run: update this repository's docs with the change; if a cross-repository fact changed
(a product, a version, a plan row, a principle), update the page in `fabric-workspace/knowledge/`
that owns it; land both; publish (`node scripts/workspace.mjs sync` from a Fabric checkout) or
leave it to the scheduled sync. Leave a handoff with the exact next task.
