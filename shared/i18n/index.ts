/**
 * The interface language (fabric-workspace knowledge/localization.md, L10N-01…06).
 *
 * English is the source text and the key: code writes `t("Refresh")` and the Russian dictionary
 * (`./ru/`) maps the English text to Russian. A string missing from the dictionary shows in
 * English, never as a key. Values go in named placeholders (`t("{count} selected", { count })`),
 * never by joining fragments. Counts take real plural forms (`t.plural`); dates and numbers follow
 * the language through `Intl`.
 *
 * The same core serves the web app (`app/lib/i18n.tsx` gives React a provider and `useT()`), the
 * Worker's own pages (`shared/i18n/server.ts` picks the language from the request) and, through a
 * generated copy of the dictionary, the Mac app (`desktop/i18n.cjs`). `scripts/check-locale.mjs`
 * (run by `tests/i18n.test.ts`) fails when a wrapped string has no Russian entry or its
 * placeholders differ.
 *
 * Plain module, no dependency: tests, the Worker and the browser load it alike.
 */
import { RU } from "./ru/index";

export type Locale = "en" | "ru";
/** What a person chose in Settings → App → Language; "system" follows the system language. */
export type LocaleChoice = "system" | Locale;
export const LOCALES: readonly Locale[] = ["en", "ru"];
export const LOCALE_CHOICES: readonly LocaleChoice[] = ["system", "en", "ru"];
/** Per device: the web app keeps the choice here (localStorage)… */
export const LOCALE_STORAGE_KEY = "fabric-inbox:locale";
/** …and mirrors it in this cookie, so the server renders its pages in the same language. */
export const LOCALE_COOKIE = "fabric-inbox-locale";
/** A year: the cookie only mirrors the device's choice, which outlives a session. */
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export type Params = Readonly<Record<string, string | number>>;
export interface PluralForms { one: string; other: string }

const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<string, string>> | null>> = { en: null, ru: RU };

/** The language the first preferred language asks for: Russian for `ru` and `ru-*`, else English. */
export function detectLocale(languages: readonly string[] | string | null | undefined): Locale {
	const list = typeof languages === "string" ? [languages] : languages ?? [];
	const first = (list[0] ?? "").trim().toLowerCase();
	return first === "ru" || first.startsWith("ru-") || first.startsWith("ru_") ? "ru" : "en";
}

/** A stored choice; anything unknown is the system default. */
export function parseLocaleChoice(value: unknown): LocaleChoice {
	return value === "en" || value === "ru" ? value : "system";
}

export function resolveLocale(choice: LocaleChoice, languages: readonly string[] | string | null | undefined): Locale {
	return choice === "system" ? detectLocale(languages) : choice;
}

/** The languages of an Accept-Language header, most wanted first (`q=0` ones dropped). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
	if (!header) return [];
	return header
		.split(",")
		.map((part, index) => {
			const [tag, ...rest] = part.trim().split(";");
			const q = rest.map((p) => p.trim()).find((p) => p.startsWith("q="));
			const weight = q ? Number(q.slice(2)) : 1;
			return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
		})
		.filter((entry) => entry.tag && entry.tag !== "*" && entry.weight > 0)
		.sort((a, b) => b.weight - a.weight || a.index - b.index)
		.map((entry) => entry.tag);
}

/** The BCP 47 tag `Intl` formats with: Russian as `ru-RU`; English keeps the system's own format. */
export function intlLocale(locale: Locale): string | undefined {
	return locale === "ru" ? "ru-RU" : undefined;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(text: string, params: Params | undefined, locale: Locale): string {
	if (!params) return text;
	return text.replace(PLACEHOLDER, (whole, name: string) => {
		if (!(name in params)) return whole;
		const value = params[name];
		return typeof value === "number" ? formatNumber(locale, value) : value;
	});
}

function formatNumber(locale: Locale, value: number): string {
	// English output stays exactly as it was before translation (plain digits).
	if (locale === "en" || !Number.isFinite(value)) return String(value);
	return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(value);
}

/**
 * A key may start with a context in brackets when one English word means two things:
 * `t("[menu] Edit")` is the menu «Правка», `t("Edit")` the button «Изменить». English drops it.
 */
const CONTEXT = /^\[[a-z-]+\] /;
export const withoutContext = (source: string) => source.replace(CONTEXT, "");

/** The text for an English source string in a language, with its placeholders filled. */
export function translate(locale: Locale, source: string, params?: Params): string {
	const entry = DICTIONARIES[locale]?.[source];
	return fill(entry ?? withoutContext(source), params, locale);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
	let rules = pluralRules.get(locale);
	if (!rules) { rules = new Intl.PluralRules(locale === "ru" ? "ru-RU" : "en-US"); pluralRules.set(locale, rules); }
	return rules.select(n);
}

/**
 * A count with its noun (L10N-03). `forms` are English, one and other, with `{n}` for the count.
 * The Russian entry of `forms.other` holds three forms separated by `|` — one (1, 21, 31…),
 * few (2–4, 22–24…), many (5–20, 25–30…, 0) — chosen with `Intl.PluralRules`; a fraction takes
 * the few form («1,5 письма»).
 */
export function pluralize(locale: Locale, n: number, forms: PluralForms, params?: Params): string {
	const values: Params = { ...params, n };
	const category = pluralCategory(locale, n);
	const entry = DICTIONARIES[locale]?.[forms.other];
	if (!entry) return fill(category === "one" ? forms.one : forms.other, values, locale);
	const [one, few = one, many = few] = entry.split("|");
	const form = category === "one" ? one : category === "few" || category === "other" ? few : many;
	return fill(form, values, locale);
}

type DateInput = Date | string | number;
const asDate = (value: DateInput) => (value instanceof Date ? value : new Date(value));

/**
 * The marker for English text written outside a `t()` call: a server error, a reason kept in the
 * store, a sentence a shared module builds. It returns the English text with its placeholders
 * filled, so the server's words (and what agents read) do not change; `scripts/check-locale.mjs`
 * collects its template, and the interface translates the finished sentence where it shows it
 * (`t.text`, L10N-04).
 */
export function msg(template: string, params?: Params): string {
	return fill(template, params, "en");
}

interface Template { re: RegExp; names: string[]; key: string }
const templates = new Map<Locale, Template[]>();
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function templatesFor(locale: Locale): Template[] {
	let list = templates.get(locale);
	if (list) return list;
	list = [];
	for (const key of Object.keys(DICTIONARIES[locale] ?? {})) {
		const names = [...key.matchAll(PLACEHOLDER)].map((m) => m[1]);
		// A template with almost no words of its own ("{error}.") would match any sentence.
		if (!names.length || key.replace(PLACEHOLDER, "").replace(/[\s\p{P}]/gu, "").length < 4) continue;
		const parts = key.split(PLACEHOLDER);
		// split() with one capture group alternates text, name, text…: the names become groups.
		const pattern = parts.map((part, i) => (i % 2 ? "([\\s\\S]+?)" : escapeRegExp(part))).join("");
		list.push({ re: new RegExp(`^${pattern}$`), names, key });
	}
	// The most specific template first: more literal text means a surer match.
	list.sort((a, b) => b.key.replace(PLACEHOLDER, "").length - a.key.replace(PLACEHOLDER, "").length);
	templates.set(locale, list);
	return list;
}

/**
 * A finished English sentence from elsewhere (the server's `error`, a stored reason) in the
 * language: the exact entry first, then the entry whose template it was filled from. Anything
 * unknown stays as it came (English), never empty.
 */
export function translateText(locale: Locale, text: string): string {
	const dictionary = DICTIONARIES[locale];
	if (!dictionary || !text) return text;
	const exact = dictionary[text];
	if (exact !== undefined) return exact;
	const trimmed = text.trim();
	if (trimmed !== text && dictionary[trimmed] !== undefined) return dictionary[trimmed];
	for (const template of templatesFor(locale)) {
		const match = template.re.exec(trimmed);
		if (!match) continue;
		const params: Record<string, string> = {};
		template.names.forEach((name, i) => { params[name] = translateText(locale, match[i + 1]); });
		const entry = dictionary[template.key];
		// A plural entry's first form reads well enough for a sentence that was already counted.
		return fill(entry.split("|")[0], params, locale);
	}
	return text;
}

/** Splits a translated sentence at its placeholders so a caller can put elements there. */
export function interpolate<N>(text: string, params: Readonly<Record<string, N | string | number>>): (N | string)[] {
	const out: (N | string)[] = [];
	const parts = text.split(PLACEHOLDER);
	parts.forEach((part, i) => {
		if (i % 2 === 0) { if (part) out.push(part); return; }
		const value = params[part];
		if (value === undefined) out.push(`{${part}}`);
		else out.push(typeof value === "number" ? String(value) : value);
	});
	return out;
}

/** Everything a piece of interface needs to speak one language. */
export interface T {
	(source: string, params?: Params): string;
	readonly locale: Locale;
	/** `t.plural(count, { one: "{n} message", other: "{n} messages" })` */
	plural(n: number, forms: PluralForms, params?: Params): string;
	/** A sentence with elements in its placeholders: `t.rich("Open {link} first.", { link: <a/> })`. */
	rich<N>(source: string, params: Readonly<Record<string, N | string | number>>): (N | string)[];
	/**
	 * A finished English text from elsewhere, in the language (L10N-04): the server's words, a
	 * reason kept in the store, a label a plain module marked with `msg()`. Safe on text that is
	 * already translated (it comes back unchanged).
	 */
	text(text: string): string;
	/** Dates and times in the language (`Intl.DateTimeFormat` options). */
	date(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
	time(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
	dateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
	number(value: number, options?: Intl.NumberFormatOptions): string;
	/** Items joined as the language joins a list: «a, b и c». */
	list(items: readonly string[], type?: "conjunction" | "disjunction"): string;
}

const cache = new Map<Locale, T>();

/** The translator for a language; one shared instance each. */
export function createT(locale: Locale): T {
	const known = cache.get(locale);
	if (known) return known;
	const tag = intlLocale(locale);
	const t = ((source: string, params?: Params) => translate(locale, source, params)) as T;
	Object.defineProperty(t, "locale", { value: locale, enumerable: true });
	t.plural = (n, forms, params) => pluralize(locale, n, forms, params);
	t.rich = (source, params) => interpolate(translate(locale, source), params);
	t.text = (text) => translateText(locale, text);
	t.date = (value, options) => asDate(value).toLocaleDateString(tag, options);
	t.time = (value, options) => asDate(value).toLocaleTimeString(tag, options);
	t.dateTime = (value, options) => asDate(value).toLocaleString(tag, options);
	t.number = (value, options) => (locale === "en" && !options ? String(value) : new Intl.NumberFormat(tag, options).format(value));
	t.list = (items, type = "conjunction") => {
		if (locale === "en") return items.join(", ");
		return new Intl.ListFormat(tag, { style: "long", type }).format(items);
	};
	cache.set(locale, t);
	return t;
}

/** English: what code and tests use when no language was chosen. */
export const englishT: T = createT("en");
