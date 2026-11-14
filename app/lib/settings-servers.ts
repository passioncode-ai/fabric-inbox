/**
 * S11 (B-276, SCN-099; operator, 2026-11-14: «у меня в аккаунтах только один ... аккаунт ... но в e-mail я могу поставить
 * все»): Settings in a desktop app that holds two or more servers name the server they change and, on Accounts,
 * Addresses and Domains, can list every held server's items under All, grouped by server. A change is still made on one
 * server: another server's item opens that server's settings in the window (fabric:show-server).
 *
 * Plain module, no `~/` imports: the tests load it directly.
 */
import { settingsPath, type SectionId } from "../components/settings/paths";

/** The sections whose items can be listed for every held server (the desktop's fabric:other-settings kinds). */
export const ALL_SECTIONS = ["accounts", "addresses", "domains"] as const;
export type SettingsKind = (typeof ALL_SECTIONS)[number];
export const isAllSection = (section: SectionId): section is SettingsKind => (ALL_SECTIONS as readonly string[]).includes(section);

/** How the switch shows All: enabled on the three lists, disabled (with its reason) elsewhere, hidden with one server. */
export type AllMode = "enabled" | "disabled" | "hidden";
export function allModeFor(section: SectionId, heldServers: number): AllMode {
	if (heldServers < 2) return "hidden";
	return isAllSection(section) ? "enabled" : "disabled";
}

/** Where the mail keeps its server tab (app/routes/unified-inbox.tsx): "own" for one server; anything else is All. */
export const MAIL_SERVER_TAB_KEY = "fi-server-tab";
export const mailChoseAll = (stored: string | null): boolean => stored !== "own";

/** The mail's choice, read once when Settings open; All when it cannot be read (the mail's own default). */
export function readMailChoseAll(): boolean {
	try { return mailChoseAll(window.localStorage.getItem(MAIL_SERVER_TAB_KEY)); } catch { return true; }
}

export type SettingsChoice = "all" | "shown";
/** Settings open on the mail's choice: All on the three lists, the shown server on every other section. */
export const openingChoice = (section: SectionId, mailAll: boolean): SettingsChoice => (mailAll && isAllSection(section) ? "all" : "shown");
/** All chosen stays the wish while the person moves between sections: a section of one server shows the shown server. */
export const choiceAfterSection = (wantsAll: boolean, section: SectionId): SettingsChoice => openingChoice(section, wantsAll);

/** Segments up to four servers; a menu for five or more (Settings has no list column, so the count alone decides). */
export const SEGMENTS_MAX = 4;
export const switchLayout = (servers: number): "segments" | "menu" => (servers <= SEGMENTS_MAX ? "segments" : "menu");

/** Where an arrow key, Home or End moves among the switch's choices; a disabled choice is never landed on. */
export function nextSwitchIndex(choices: readonly { disabled?: boolean }[], at: number, key: string): number {
	const open = choices.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0);
	if (!open.length) return at;
	if (key === "Home") return open[0]!;
	if (key === "End") return open[open.length - 1]!;
	const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
	if (!step) return at;
	const n = choices.length;
	for (let k = 1; k <= n; k++) {
		const i = (((at + step * k) % n) + n) % n;
		if (!choices[i]!.disabled) return i;
	}
	return at;
}

export type ServerState = "ok" | "signed_out" | "unreachable";
export interface OtherItem {
	/** The item's key in its section (an address, a domain, `gmail:<id>`): the path segment on that server. */
	id: string;
	title: string;
	/** A plain word beside it: the provider's name, the address's domain. */
	detail: string;
	/** A domain receiving mail on that server. */
	served?: boolean;
}
export interface OtherServerSettings {
	origin: string;
	label: string;
	state: ServerState;
	items: OtherItem[];
}

/** The bridge's answer for `kind`, kept to well-formed servers and items; another kind's answer is not shown. */
export function readOtherSettings(value: unknown, kind: SettingsKind): OtherServerSettings[] {
	const v = (value ?? {}) as { kind?: unknown; servers?: unknown };
	if (v.kind !== kind || !Array.isArray(v.servers)) return [];
	return v.servers
		.filter((s): s is OtherServerSettings => !!s && typeof s.origin === "string" && typeof s.label === "string" && ["ok", "signed_out", "unreachable"].includes(s.state))
		.map((s) => ({
			origin: s.origin, label: s.label, state: s.state,
			items: (Array.isArray(s.items) ? s.items : [])
				.filter((i): i is OtherItem => !!i && typeof i.id === "string" && i.id.length > 0 && typeof i.title === "string")
				.map((i) => ({ id: i.id, title: i.title, detail: typeof i.detail === "string" ? i.detail : "", ...(typeof i.served === "boolean" ? { served: i.served } : {}) })),
		}));
}

export interface SettingsGroup {
	origin: string;
	label: string;
	/** The server this window shows: its items are the section's own list. */
	shown: boolean;
	state: ServerState | "loading";
	/** Null while unknown (loading, signed out, not reachable). */
	count: number | null;
	items: OtherItem[];
}

/**
 * The groups under All: the shown server first with its own count, then every other held server in the app's order,
 * with what its last read said; a server the read did not name waits while it runs and reads as not reachable after.
 */
export function settingsGroups(shown: { origin: string; label: string; count: number | null }, others: readonly { origin: string; label: string }[],
	read: readonly OtherServerSettings[], readDone: boolean): SettingsGroup[] {
	const groups: SettingsGroup[] = [{ origin: shown.origin, label: shown.label, shown: true, state: "ok", count: shown.count, items: [] }];
	for (const server of others) {
		if (server.origin === shown.origin) continue;
		const r = read.find((s) => s.origin === server.origin);
		if (!r) { groups.push({ origin: server.origin, label: server.label, shown: false, state: readDone ? "unreachable" : "loading", count: null, items: [] }); continue; }
		groups.push({ origin: server.origin, label: server.label, shown: false, state: r.state, count: r.state === "ok" ? r.items.length : null, items: r.state === "ok" ? r.items : [] });
	}
	return groups;
}

/** The path on that server that opens one of its items in Settings. */
export const otherItemPath = (section: SettingsKind, id: string): string => settingsPath(section, id);

/** The servers "Which server?" offers: the shown one first and chosen; one not reachable now cannot take it. */
export function addChoices(servers: readonly { origin: string; label: string }[], shownOrigin: string, states: Readonly<Record<string, ServerState>>) {
	const shown = servers.filter((s) => s.origin === shownOrigin);
	const rest = servers.filter((s) => s.origin !== shownOrigin);
	return [...shown, ...rest].map((s) => ({
		origin: s.origin, label: s.label, shown: s.origin === shownOrigin, chosen: s.origin === shownOrigin,
		disabled: s.origin !== shownOrigin && states[s.origin] === "unreachable",
	}));
}
