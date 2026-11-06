# DEC-0153 operations digests (vendored)

Copied from passioncode-ai/fabric-agent-contract at the release tag `v0.1.0+2026-11-06.1` (commit `eac1a594`, DEC-0153
merged in PR #244), never from a branch: `schemas/ops-digest-hourly.schema.json`, `schemas/ops-digest-daily.schema.json`,
`schemas/service-ops-digest-extension.schema.json` with the `path` grammar it reads from `schemas/fabric-package.schema.json` (and the two schemas that one refers to, `manifest.schema.json` and `interop-capability.schema.json`),
`fixtures/vectors/ops-digest.json` (11 hour and 4 day vectors) and `src/secret-shape.ts` (the shared credential detector,
FAC-SEM-167). `tests/ops-digest-contract.test.ts` runs the Mac app's and the server's folds and the desktop descriptor
against them. Replace them together when the pin moves.
