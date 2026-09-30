# Handoff 2026-09-30 — the repository standard and the AGPL-or-commercial licence

**Objective.** Bring Fabric Inbox onto the PassionCode.ai repository standard
(fabric-workspace `knowledge/repository-standard.md`, rules F1–F11) and the licence of Fabric
ADR-0092: `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial` for this project's own code, with
the imported third-party code kept under its own licence. No behaviour change.

**Base.** `origin/main` at `4c71642`, branch `agent/standard-agpl`.

## Done

- `LICENSE` is the AGPL-3.0 text, byte for byte the knowledge-base template (SHA-256
  `0d96a4ff…abcb0`). `COMMERCIAL-LICENSE.md` and `CLA.md` are the templates, unchanged.
- The Apache-2.0 text that was `LICENSE` moved unchanged to `LICENSES/Apache-2.0.txt`
  (SHA-256 `e0a6e6c7…cd547`, the same as the upstream file). `LICENSES/MIT-super-ux.txt` is the
  MIT text of super-ux at `v0.56.2`.
- `THIRD_PARTY_NOTICES.md` names the upstream — `cloudflare/agentic-inbox` at `48039bb6785a`,
  imported in `93b86c6` by `cloudflare[bot]` (byte-identical except `wrangler.jsonc`) — the 71
  imported files still present, the 67 Cloudflare headers kept as written, and the three
  unmodified super-ux scripts.
- Manifests carry the SPDX expression: `package.json`, the root entry of `package-lock.json`,
  `desktop/package.json`, `plugins/fabric-inbox/.claude-plugin/plugin.json`, the skill's
  `license:` front matter; `tests/mcp-skill.test.ts` asserts it.
- `README.md`: first paragraph (Fabric's mail tool, works on its own), quick-start steps named
  Install / Configure / MCP / Develop, `## License` in the knowledge-base wording (versions up to
  and including 0.7.1: Apache-2.0). `AGENTS.md` in the template's shape (Read first … After work),
  with the commands, local rules and the org-index back-link kept. `CHANGELOG.md` has an
  Unreleased entry; `docs/DOCMAP.md` has a licence row.

## Checks run (exit codes read directly)

| Check | Result |
|---|---|
| `npm test` | 0 — 405 tests, 405 pass |
| `npm run typecheck` | 0 |
| `npm run build` | 0 |
| `python3 docs/ux/lint.py`, `python3 docs/ux/doctor.py`, `python3 docs/brand/lint.py` | 0, 0, 0 |
| `git diff --cached --check` | 0 |
| planted defect: `plugin.json` licence set back to `Apache-2.0` | `tests/mcp-skill.test.ts` failed 1, then passed 3 after the revert |
| org-index `check_format.py --offline --repo fabric-inbox` | 7 findings before → 0 after |
| MCP proving call with a real client: `npm run dev -- --port 5174 --host 127.0.0.1`, then `claude -p … --strict-mcp-config --mcp-config <http://127.0.0.1:5174/mcp>` calling `list_accounts` | `{"accounts":[],"gmail":{"configuration":"not_configured","accounts":[]},"hidden":[],"issues":[]}` |

Hosted CI: this repository has no workflow, and the organisation's private-repository Actions are
held by the spending cap. No CI result is not a green result.

## Open

- **Released binaries and a private repository** (knowledge base `licensing.md`, CO-KB-01): the
  next disk image would be AGPL while the source is private. The operator decides whether to
  publish the repository first or to ship binaries under the commercial terms until then.
- The macOS app bundles npm packages; no generated notice of them ships with the image yet.
- The org-index row of this repository needs no change (role, dependencies and test command are
  unchanged).

## Next task

Unchanged: the release entry's "Exact next task" in [docs/app-store/README.md](../app-store/README.md).
