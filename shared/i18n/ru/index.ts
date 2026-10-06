/**
 * The Russian dictionary (fabric-workspace knowledge/localization.md, L10N-02): English source
 * text → Russian, one file per part of the product so a change finds its home. Plural entries hold
 * three forms separated by `|`: one, few, many (L10N-03). A key lives in exactly one file;
 * `node scripts/check-locale.mjs` fails on a key in two, on a missing entry and on placeholders
 * that differ, and writes the Mac app's copy (`desktop/locales/ru.json`).
 *
 * Terms follow docs/brand/terminology.md ("Russian") and the organization's glossary.
 */
import { COMMON } from "./common";
import { DESKTOP } from "./desktop";
import { INBOX } from "./inbox";
import { COMPOSE } from "./compose";
import { SETTINGS } from "./settings";
import { RULES } from "./rules";
import { CONNECT } from "./connect";
import { AGENTS } from "./agents";
import { SERVER } from "./server";
import { LEGACY } from "./legacy";

export const RU: Readonly<Record<string, string>> = Object.freeze({
	...COMMON,
	...DESKTOP,
	...INBOX,
	...COMPOSE,
	...SETTINGS,
	...RULES,
	...CONNECT,
	...AGENTS,
	...SERVER,
	...LEGACY,
});
