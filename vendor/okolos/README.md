# Okolos detectors (vendored)

Copied from [passioncode-ai/okolos](https://github.com/passioncode-ai/okolos) at `5d55f85addd5`, unchanged except
that relative imports drop their `.js` extension (this repository's bundlers resolve TypeScript sources without it):

| Here | There |
|---|---|
| `core-injection/signals.ts` | `packages/core-injection/src/signals.ts` (`analyse`: the deterministic signals of an instruction planted for a model, English and Russian) |
| `core-injection/chars.ts` | `packages/core-injection/src/chars.ts` (`anomaliesOf`: invisible and direction-changing characters) |

Okolos is PassionCode's browser-security product; Fabric Inbox uses its detectors to check mail (B-178, B-179). Both
carry the same licence, `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`. Change them in Okolos first, then copy
them here again together and move the pin and the hashes in `manifest.json`; `tests/okolos-vendor.test.ts` fails when a
file differs from its pinned hash.
