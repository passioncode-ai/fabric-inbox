# Okolos detectors (vendored)

Copied from [passioncode-ai/okolos](https://github.com/passioncode-ai/okolos) at `5d664c5` (the core-injection files are unchanged since `5d55f85addd5`), unchanged except
that relative imports drop their `.js` extension (this repository's bundlers resolve TypeScript sources without it):

| Here | There |
|---|---|
| `core-injection/signals.ts` | `packages/core-injection/src/signals.ts` (`analyse`: the deterministic signals of an instruction planted for a model, English and Russian) |
| `core-injection/chars.ts` | `packages/core-injection/src/chars.ts` (`anomaliesOf`: invisible and direction-changing characters) |
| `core-feeds/apply.ts` | `packages/core-feeds/src/apply.ts` (`applyUpdate`, `serialiseUpdate`: a signed feed update checked and applied, never a replay) |
| `core-feeds/lookup.ts` | `packages/core-feeds/src/lookup.ts` (`matchUrl`: a URL against the feed, a page under a listed host or path too) |
| `core-lookalike/check.ts`, `confusables.ts`, `punycode.ts`, `suffix.ts`, `suffixes.json`, `watchlist.ts` | `packages/core-lookalike/src/` (`checkLookalike`: a host imitating a watched name by mixed scripts, a homograph, a typo, a swapped TLD or the brand in the wrong place; `DEFAULT_WATCHLIST`; `suffixes.json` is a Public Suffix List subset under MPL-2.0, see THIRD_PARTY_NOTICES.md) |

Okolos is PassionCode's browser-security product; Fabric Inbox uses its detectors and its phishing feed to check mail (B-178, B-179, B-180). Both
carry the same licence, `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`. Change them in Okolos first, then copy
them here again together and move the pin and the hashes in `manifest.json`; `tests/okolos-vendor.test.ts` fails when a
file differs from its pinned hash.
