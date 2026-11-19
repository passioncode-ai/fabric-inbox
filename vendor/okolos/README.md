# Okolos detectors (vendored)

Copied from [passioncode-ai/okolos](https://github.com/passioncode-ai/okolos) at `009df1f3388b378380c9413caaa2582f3162f170`
(Okolos `main`, 2026-11-19, PR #109; the files copied before are unchanged at that pin, but for the notes of
`suffixes.json`, whose lists are the same), unchanged except for two
rewrites: relative imports drop their `.js` extension (this repository's bundlers resolve TypeScript sources without
it), and a bare `@okolos/<pkg>` import becomes the relative vendored path (`@okolos/core-lookalike` is
`../core-lookalike/index`):

| Here | There |
|---|---|
| `core-injection/signals.ts` | `packages/core-injection/src/signals.ts` (`analyse`: the deterministic signals of an instruction planted for a model, English and Russian) |
| `core-injection/chars.ts` | `packages/core-injection/src/chars.ts` (`anomaliesOf`: invisible and direction-changing characters) |
| `core-feeds/apply.ts` | `packages/core-feeds/src/apply.ts` (`applyUpdate`, `serialiseUpdate`: a signed feed update checked and applied, never a replay) |
| `core-feeds/lookup.ts` | `packages/core-feeds/src/lookup.ts` (`matchUrl`: a URL against the feed, a page under a listed host or path too) |
| `core-lookalike/check.ts`, `confusables.ts`, `index.ts`, `punycode.ts`, `suffix.ts`, `suffixes.json`, `watchlist.ts` | `packages/core-lookalike/src/` (`checkLookalike`: a host imitating a watched name by mixed scripts, a homograph, a typo, a swapped TLD or the brand in the wrong place; `DEFAULT_WATCHLIST`; `suffixes.json` is a Public Suffix List subset under MPL-2.0, see THIRD_PARTY_NOTICES.md) |
| `core-mail/types.ts`, `verdict.ts`, `sender.ts`, `parse.ts` | `packages/core-mail/src/` (`checkSenderIdentity`, `checkReplyPath`, `parseAddressList`, the verdict's shape: what fired and what did not run, never a score; B-269. `checkSenderAuth` is vendored but not used: it reads the first header of that name, and only the receiver's topmost one counts here, `workers/safety/sender.ts`) |
| `core-collect/collect.ts`, `tree.ts`, `view.ts`, `index.ts` | `packages/core-collect/src/` (`collectFrom` over `treeView`: the hidden-text candidates of a page given as a plain tree; B-303 reads HTML attachments with it) |
| `core-injection/stage1.ts` | `packages/core-injection/src/stage1.ts` (`detectHidden`: the verdicts of Okolos's rules on hidden-text candidates, one decisive signal a suspicion, two or one standing alone a verdict) |
| `contracts/*.ts` (all seven) | `packages/contracts/src/` (the types and `decideAction` the collector and the rules import; copied whole so the import of `@okolos/contracts` keeps the second rewrite) |
| `corpora/injections/*.json`, `corpora/collect/carriers.json` | `corpora/` (Okolos's labelled hidden texts and carrier documents; B-303's tests, `tests/safety-html-hidden.test.ts`) |
| `core-download/judge.ts` | `packages/core-download/src/judge.ts` (`judgeDownload`: a file's name, declared type and checks judged together; B-269 passes it the type its bytes show) |

Okolos is PassionCode's browser-security product; Fabric Inbox uses its detectors and its phishing feed to check mail (B-178, B-179, B-180, B-269). Both
carry the same licence, `AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`. Change them in Okolos first, then copy
them here again together and move the pin and the hashes in `manifest.json`; `tests/okolos-vendor.test.ts` fails when a
file differs from its pinned hash.
