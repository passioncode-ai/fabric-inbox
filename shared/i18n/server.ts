/**
 * The language of a page the server renders itself (the app's first render, the Gmail and Outlook
 * result pages): a `lang` the page was opened with, then the device's choice mirrored in the
 * `fabric-inbox-locale` cookie, then the browser's Accept-Language (L10N-01).
 *
 * The OAuth sign-ins run in the system browser, which has none of the app's cookies; the connect
 * route therefore keeps the language it started with beside the sign-in's state and the callback
 * renders its page in it (`workers/routes/gmail-setup.ts`, `microsoft-setup.ts`).
 */
import { LOCALE_COOKIE, parseAcceptLanguage, parseLocaleChoice, resolveLocale, type Locale, type LocaleChoice } from "./index";

/** The value of one cookie, or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() !== name) continue;
		try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
	}
	return null;
}

/** The choice a request carries: `?lang=` first, then the cookie; "system" when neither says. */
export function requestLocaleChoice(request: Request): LocaleChoice {
	let fromQuery: string | null = null;
	try { fromQuery = new URL(request.url).searchParams.get("lang"); } catch { fromQuery = null; }
	const query = parseLocaleChoice(fromQuery);
	if (query !== "system") return query;
	return parseLocaleChoice(readCookie(request.headers.get("Cookie"), LOCALE_COOKIE));
}

/** The language to render a request's page in. */
export function requestLocale(request: Request): Locale {
	return resolveLocale(requestLocaleChoice(request), parseAcceptLanguage(request.headers.get("Accept-Language")));
}
