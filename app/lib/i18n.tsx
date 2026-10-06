/**
 * The interface language in React (shared/i18n, L10N-01…06).
 *
 * The server picks the language of the first render from the device's choice (the
 * `fabric-inbox-locale` cookie) or the browser's Accept-Language, and the root route hands it to
 * <I18nProvider>; every component reads it with `useT()`. Choosing a language in Settings → App →
 * Language keeps it on this device (localStorage), mirrors it in the cookie for the server, tells
 * the Mac app (desktop/mail-preload.cjs) so its menus follow, and reloads the window: text built
 * at start-up is then in one language.
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import {
	createT, englishT, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALE_STORAGE_KEY, parseLocaleChoice, resolveLocale,
	type Locale, type LocaleChoice, type T,
} from "../../shared/i18n";
import { readCookie } from "../../shared/i18n/server";

export type { Locale, LocaleChoice, T } from "../../shared/i18n";

interface LocaleState { locale: Locale; choice: LocaleChoice }
const LocaleContext = createContext<LocaleState>({ locale: "en", choice: "system" });

export function I18nProvider({ locale, choice, children }: LocaleState & { children: ReactNode }) {
	return <LocaleContext.Provider value={{ locale, choice }}>{children}</LocaleContext.Provider>;
}

/** The translator for the interface's language (English outside a provider, as in tests). */
export function useT(): T {
	const { locale } = useContext(LocaleContext);
	return locale === "en" ? englishT : createT(locale);
}

export function useLocale(): LocaleState {
	return useContext(LocaleContext);
}

/** The translator for a route's `meta()`, from the root route's data (the page's language). */
export function metaT(matches: readonly ({ id: string; data?: unknown; loaderData?: unknown } | undefined)[] | undefined): T {
	const root = matches?.find((m) => m?.id === "root");
	const data = (root?.loaderData ?? root?.data) as { locale?: unknown } | undefined;
	return data?.locale === "ru" ? createT("ru") : englishT;
}

declare global {
	interface Window {
		/** Present only in the desktop app's mail window (desktop/mail-preload.cjs). */
		fabricDesktop?: {
			pendingSetup(): Promise<unknown>;
			pendingSetupDone(): Promise<unknown>;
			onResume?(callback: () => void): () => void;
			/** The language chosen on this Mac ("system", "en", "ru"), shared with the app's menus. */
			locale?(): Promise<unknown>;
			setLocale?(choice: LocaleChoice): Promise<unknown>;
		};
	}
}

function readStored(): LocaleChoice | null {
	try {
		const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
		return value === null ? null : parseLocaleChoice(value);
	} catch {
		return null;
	}
}

function writeCookie(choice: LocaleChoice) {
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	document.cookie = choice === "system"
		? `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
		: `${LOCALE_COOKIE}=${choice}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/** Keeps a choice on this device: localStorage, the cookie, and the Mac app. False when nothing could keep it. */
export async function saveLocaleChoice(choice: LocaleChoice): Promise<boolean> {
	let kept = false;
	try {
		if (choice === "system") window.localStorage.removeItem(LOCALE_STORAGE_KEY);
		else window.localStorage.setItem(LOCALE_STORAGE_KEY, choice);
		kept = true;
	} catch { /* storage refused (private window): the cookie still carries it */ }
	try { writeCookie(choice); kept = true; } catch { /* cookies off */ }
	try { await window.fabricDesktop?.setLocale?.(choice); } catch { /* an older Mac app without the bridge */ }
	return kept;
}

const RELOADED = "fabric-inbox:locale-reloaded";

/**
 * Once after the first render: brings the device's choice, the cookie and the Mac app's choice
 * together. The Mac app's choice wins (it outlives a change of server, whose storage is separate);
 * then this device's stored choice; the cookie follows. When the page was rendered in another
 * language than the choice asks for, it reloads once.
 */
export function useLocaleSync({ locale }: LocaleState) {
	useEffect(() => {
		let cancelled = false;
		(async () => {
			let desktop: LocaleChoice | null = null;
			try {
				const value = await window.fabricDesktop?.locale?.();
				desktop = value === undefined || value === null ? null : parseLocaleChoice(value);
			} catch { desktop = null; }
			if (cancelled) return;
			const stored = readStored();
			const cookie = parseLocaleChoice(readCookie(document.cookie, LOCALE_COOKIE));
			const target = desktop ?? stored ?? cookie;
			if (stored !== target) {
				try {
					if (target === "system") window.localStorage.removeItem(LOCALE_STORAGE_KEY);
					else window.localStorage.setItem(LOCALE_STORAGE_KEY, target);
				} catch { /* storage refused */ }
			}
			if (cookie !== target) { try { writeCookie(target); } catch { /* cookies off */ } }
			const wanted = resolveLocale(target, navigator.languages?.length ? navigator.languages : [navigator.language]);
			if (wanted === locale) {
				try { window.sessionStorage.removeItem(RELOADED); } catch { /* storage refused */ }
				return;
			}
			// The server cannot know a choice it was never told; tell it, then reload once.
			let reloaded = false;
			try { reloaded = window.sessionStorage.getItem(RELOADED) === wanted; } catch { reloaded = true; }
			if (reloaded || cookie === target && target === "system") return;
			try { window.sessionStorage.setItem(RELOADED, wanted); } catch { return; }
			window.location.reload();
		})();
		return () => { cancelled = true; };
	}, [locale]);
}
