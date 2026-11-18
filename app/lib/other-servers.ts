// B-244 D-3 (SCN-099; operator, 2026-11-11: «чтобы они все показывались внутри одного окна, я бы не переключался между
// ними, не щелкал этими окнами»): in the desktop app, the inbox shows a row of tabs for every server the app holds and
// one merged list of their inboxes. The other servers' rows come through the app's bridge (desktop/mail-preload.cjs,
// B-244 D-2), each read by the app through that server's own sign-in; this page never sends them anywhere. A page in a
// browser, or an app that holds one server, has no bridge for it and shows its own inbox as before.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { pollInterval } from "./window-activity";

/** A server the app holds, as the bridge names it. */
export interface HeldServer {
	origin: string;
	label: string;
	context: string | null;
	/** The server this page belongs to. */
	shown: boolean;
}
/** One message of another server's inbox (desktop/all-servers.cjs `rowOf`). */
export interface OtherRow {
	origin: string;
	server: string;
	sender: string;
	to: string;
	subject: string;
	snippet: string;
	/** Epoch ms. */
	at: number;
	read: boolean;
	/** A path of that server that opens the message there. */
	link: string;
}
export interface OtherServerState {
	origin: string;
	label: string;
	state: "ok" | "signed_out" | "unreachable";
	/** Unread among the messages read; null when the server was not read. */
	unread: number | null;
	/** S01 (B-267): the read came back full, so `unread` is a lower bound. */
	full?: boolean;
}
export interface OtherInbox {
	servers: OtherServerState[];
	messages: OtherRow[];
}
interface ServersBridge {
	servers(): Promise<unknown>;
	otherInbox(): Promise<unknown>;
	showServer(origin: string, link?: string): Promise<unknown>;
}

/** How often the other servers are read while the window is active; the app's own inbox list polls at the same pace. */
export const OTHER_INBOX_POLL_MS = 60_000;

/** The bridge's servers calls, when this page runs in a desktop app that has them. */
export function serversBridge(): ServersBridge | null {
	if (typeof window === "undefined") return null;
	const bridge = (window as unknown as { fabricDesktop?: Partial<ServersBridge> }).fabricDesktop;
	return bridge && typeof bridge.servers === "function" && typeof bridge.otherInbox === "function" && typeof bridge.showServer === "function"
		? (bridge as ServersBridge)
		: null;
}

/**
 * S11 (B-276): the bridge's read of the other servers' settings lists (fabric:other-settings), detected on its own: an
 * older desktop build without it keeps the mail switch (serversBridge) and Settings simply show one server.
 */
export function otherSettingsBridge(): ((kind: string) => Promise<unknown>) | null {
	if (!serversBridge()) return null;
	const bridge = (window as unknown as { fabricDesktop?: { otherSettings?: unknown } }).fabricDesktop;
	return typeof bridge?.otherSettings === "function" ? (kind: string) => (bridge.otherSettings as (k: string) => Promise<unknown>)(kind) : null;
}

/** S11: whether an agent console session runs, so a switch of server says first that it stops; false when unknown. */
export async function consoleRunning(): Promise<boolean> {
	if (typeof window === "undefined") return false;
	const bridge = (window as unknown as { fabricDesktop?: { consoleRunning?: () => Promise<unknown> } }).fabricDesktop;
	if (typeof bridge?.consoleRunning !== "function") return false;
	try { return (await bridge.consoleRunning()) === true; } catch { return false; }
}

/** The bridge's list, kept to well-formed entries. */
export function readServers(value: unknown): HeldServer[] {
	if (!Array.isArray(value)) return [];
	return value.filter((s): s is HeldServer => !!s && typeof s.origin === "string" && typeof s.label === "string" && typeof s.shown === "boolean")
		.map((s) => ({ origin: s.origin, label: s.label, context: typeof s.context === "string" ? s.context : null, shown: s.shown }));
}

/** The bridge's other inbox, kept to well-formed rows and states. */
export function readOtherInbox(value: unknown): OtherInbox {
	const v = (value ?? {}) as { servers?: unknown; messages?: unknown };
	const states = Array.isArray(v.servers) ? v.servers : [];
	const rows = Array.isArray(v.messages) ? v.messages : [];
	return {
		servers: states.filter((s): s is OtherServerState => !!s && typeof s.origin === "string" && typeof s.label === "string" && ["ok", "signed_out", "unreachable"].includes(s.state))
			.map((s) => ({ origin: s.origin, label: s.label, state: s.state, unread: typeof s.unread === "number" ? s.unread : null, ...(s.full === true ? { full: true } : {}) })),
		messages: rows.filter((r): r is OtherRow => !!r && typeof r.origin === "string" && typeof r.link === "string" && r.link.startsWith("/") && typeof r.at === "number")
			.map((r) => ({ origin: r.origin, server: String(r.server ?? ""), sender: String(r.sender ?? ""), to: String(r.to ?? ""), subject: String(r.subject ?? ""),
				snippet: String(r.snippet ?? ""), at: r.at, read: !!r.read, link: r.link })),
	};
}

export type ListItem<T> = { kind: "own"; item: T } | { kind: "other"; row: OtherRow };

/**
 * This server's messages and the other servers' rows, newest first. The other rows are kept only down to the oldest
 * message of this server loaded so far, so loading older mail brings the older ones in; with every page of this
 * server loaded (`complete`), all of them. This server's order among its own messages is kept as it is.
 */
export function interleave<T>(own: readonly T[], timeOf: (item: T) => number, others: readonly OtherRow[], complete: boolean): ListItem<T>[] {
	// Each message stands where the newest message at or below it in the list stands, so a message pinned to the top
	// out of date order (pinTriage) keeps its place and does not pull the other rows above it.
	const standing: number[] = new Array(own.length);
	for (let k = own.length - 1, newest = Number.NEGATIVE_INFINITY; k >= 0; k--) {
		newest = Math.max(newest, timeOf(own[k]) || 0);
		standing[k] = newest;
	}
	const oldest = own.length ? standing[own.length - 1] : Number.NEGATIVE_INFINITY;
	const kept = others.filter((r) => complete || r.at >= oldest).sort((a, b) => b.at - a.at);
	const out: ListItem<T>[] = [];
	let i = 0;
	own.forEach((item, k) => {
		while (i < kept.length && kept[i].at > standing[k]) out.push({ kind: "other", row: kept[i++] });
		out.push({ kind: "own", item });
	});
	while (i < kept.length) out.push({ kind: "other", row: kept[i++] });
	return out;
}

/** The servers this app holds, read once per page and again when the Mac wakes; [] in a browser. */
export function useHeldServers(): HeldServer[] {
	const [servers, setServers] = useState<HeldServer[]>([]);
	useEffect(() => {
		const bridge = serversBridge();
		if (!bridge) return;
		let live = true;
		const read = () => void bridge.servers().then((value) => { if (live) setServers(readServers(value)); }, () => {});
		read();
		const off = (window as unknown as { fabricDesktop?: { onResume?(cb: () => void): (() => void) | undefined } }).fabricDesktop?.onResume?.(read);
		return () => { live = false; off?.(); };
	}, []);
	return servers;
}

/** The other servers' inboxes while `enabled`, read again every minute while the window is active. */
export function useOtherInbox(enabled: boolean, active: boolean) {
	return useQuery({
		queryKey: ["other-servers-inbox"],
		enabled: enabled && !!serversBridge(),
		queryFn: async () => readOtherInbox(await serversBridge()!.otherInbox()),
		refetchInterval: pollInterval(active, OTHER_INBOX_POLL_MS),
		refetchOnWindowFocus: true,
		staleTime: 10_000,
	});
}

/** Shows a held server in the window, at one of its paths when given (B-244 D-1, D-2). */
export function showServer(origin: string, link?: string): void {
	void serversBridge()?.showServer(origin, link).catch(() => {});
}

/** B-291 (U2): the server switch's choice, kept by the app for every server's page of the window. */
export type ServerTab = "all" | "own";
interface ServerTabBridge {
	serverTab(): Promise<unknown>;
	setServerTab(tab: ServerTab): Promise<unknown>;
	onServerTab(callback: (tab: ServerTab) => void): () => void;
}
/** The app's keeper of the switch's choice; null in a browser and in a desktop build older than B-291. */
export function serverTabBridge(): ServerTabBridge | null {
	if (!serversBridge()) return null;
	const bridge = (window as unknown as { fabricDesktop?: Partial<ServerTabBridge> }).fabricDesktop;
	return typeof bridge?.serverTab === "function" && typeof bridge.setServerTab === "function" && typeof bridge.onServerTab === "function"
		? (bridge as ServerTabBridge)
		: null;
}
/** A tab the bridge answered, or null when it has none yet (no page chose since the app started). */
export function readServerTab(value: unknown): ServerTab | null {
	return value === "all" || value === "own" ? value : null;
}
/** B-291 (U2): whether a switch of server would stop a running console; a build that keeps it says so. */
export function consoleStopsOnSwitch(): boolean {
	if (typeof window === "undefined") return true;
	const bridge = (window as unknown as { fabricDesktop?: { consoleKeepsOnSwitch?: () => unknown } }).fabricDesktop;
	try { return !(typeof bridge?.consoleKeepsOnSwitch === "function" && bridge.consoleKeepsOnSwitch() === true); } catch { return true; }
}
/** B-291 (U2): a message of another server opened from All keeps All on that server's page (`?servers=all`). */
export function linkWithAll(link: string): string {
	const at = link.indexOf("?");
	const params = new URLSearchParams(at < 0 ? "" : link.slice(at + 1));
	params.set("servers", "all");
	return (at < 0 ? link : link.slice(0, at)) + "?" + params.toString().replace(/\+/g, "%20");
}
