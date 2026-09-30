# Handoff 2026-09-30 — private data out of the current tree before publication

**Objective.** The repository is published as open source (AGPL-3.0) with a fresh history. Before
that, the current tree must hold none of the operator's private data: no deployment of theirs, no
personal address, domain, account id, home path, name, other project or client, and no verbatim
quotes of their instructions. Behaviour of the app and server is unchanged.

**Base.** `origin/main` at `f352b43`, branch `agent/public-redaction`.

## Done

- **The owner's deployment left the repository.** `deployments/<name>/` is git-ignored
  (`.gitignore`); the repository carries [deployments/README.md](../../deployments/README.md) and
  placeholder `deployments/{deployment,cloudflare-inventory,setup}.example.json`. The README's
  [Configure your deployment](../../README.md#configure-your-deployment) says how a new owner
  creates theirs. The operator's own files were kept outside Git on their machine before the
  deletion was committed.
- `scripts/deployment-setup.ts` replaces the owner-only generator: it reads
  `deployments/<name>/deployment.json` (`origin`, `setupName`, `vars.TEAM_DOMAIN`) and a Cloudflare
  inventory and writes `setup.json` with the server's conversion. On the previous owner data its
  output is byte-identical to the old script's (`cmp`, 2026-09-30). `setup.example.json` is its
  output for the two examples, and a test holds it so.
- `desktop/dist-mac.mjs --setup <name>` reads the local setup (no commit holds it), checks it with
  `desktop/policy.cjs#readSetup` before anything is signed, and writes its SHA-256 into the receipt.
- `tests/no-owner-data.test.ts` reads identifiers from every local deployment, fails when anything
  but the guide and examples is tracked under `deployments/`, prints a file and an index — never
  the value — on a hit, and skips (saying why) only the "a local deployment names ≥ 5 identifiers"
  check on a clone with none.
- **Fixtures.** Test domains are reserved `.invalid` names; addresses at real mail domains are
  `example.com/.org/.net`, except where the vendor domain is the behaviour under test (triage of
  Stripe, GitHub, Apple, Sentry mail), where the sender is a no-reply address at that domain.
  Signing identities in `tests/dist-mac.test.ts` are synthetic. R2 keys in tests come from
  `mailboxKey`/`issueKey`/`unknownKey` helpers.
- `shared/mail/triage.ts`: the Google Calendar sender rule is held as local parts at `google.com`,
  like the Play addresses beside it (the scanner's address pattern matched the literal addresses).
  Behaviour is unchanged; `tests/triage.test.ts` also proves the local part elsewhere is not Calendar.
- UI placeholders use Acme and `example.com` addresses (`app/routes/categories.tsx`,
  `app/routes/spam.tsx`, `app/routes/settings.tsx`).
- **Documentation.** The Russian history documents in `docs/desktop-mail/` are in English. Personal
  receipts became neutral statements keeping their evidence ("one of the owner's addresses");
  requests are paraphrased, not quoted; other projects, the personal skill family's footers and
  machine notes are gone. `docs/brand/lint.py` (vendored, MIT) had four comments reworded; its code
  tokens equal upstream's, and [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) says so.

## Checks run (exit codes read directly)

| Check | Result |
|---|---|
| org-index `scripts/check_private.py` over the tracked files | 1 037 findings in 59 files before (P1 59, P2 969, P3 6, P4 3), plus 2 P3 in `.task-pipeline/build/`, a directory the scanner skips by name → 0 |
| `gitleaks detect --no-git --redact` | 1 before (generic-api-key on prose in `docs/ux/screens.md`) → 0 |
| `npm test` | 0 — 416 tests, 416 pass (405 at the base) |
| `npm run typecheck`, `npm run build` | 0, 0 |
| `python3 docs/ux/lint.py`, `python3 docs/ux/doctor.py`, `python3 docs/brand/lint.py` | 0, 0, 0 (brand: 0 errors, 985 advisory warnings; 984 at the base, the new one is the `Acme` placeholder) |
| `npm run mcp:docs -- --check`, `git diff --check`, every relative Markdown link and anchor | 0, 0, 0 broken |
| planted: `git add -f deployments/owner/deployment.json` | `tests/no-owner-data.test.ts` failed 1 ("no deployment is committed"), passed after unstaging |
| planted: a local deployment's domain appended to a committed `app/` file | failed 1 ("nothing that ships … names a deployment"), naming the file and `identifier #14`, not the value; passed after the revert |

Hosted CI: this repository has no workflow, and private-repository Actions are held by the spending
cap. No CI result is not a green result.

## Open

- **Publication.** The fresh-history public repository is the next step and is not done here.
  After it, the README's quick start still says the repository is private and release files need a
  signed-in organisation member; that sentence changes in the publication change.
- History before this commit still holds the removed data; the fresh history is what removes it.
- The org-index row of this repository needs no change (role, dependencies and test command are
  unchanged).

## Next task

Publish with a fresh history from this tree, then re-run `check_private.py` and `gitleaks` on the
published clone. After that, the release entry's "Exact next task" in
[docs/app-store/README.md](../app-store/README.md).
