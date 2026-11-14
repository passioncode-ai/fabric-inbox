import { useLayoutEffect, useRef, useState } from "react";
import { showServer, type HeldServer, type OtherServerState } from "../../lib/other-servers";
import ServerSwitch, { type SwitchCount, type SwitchState } from "../ServerSwitch";

/** S01 (B-267): segments for up to this many servers; more always take the menu. */
export const SEGMENTS_MAX_SERVERS = 4;

/**
 * A-13 (S01): segments when every choice fits whole beside the folder's name, the menu otherwise. `natural` is the
 * segments' own width with every name at its full length (up to 160 px), measured off screen; `available` the room
 * the heading leaves. Until both are measured (the first paint) the segments are drawn, so the default window with
 * up to three servers shows them; a fixed width threshold kept the default list column (349 px) on the menu.
 */
export function tabsLayout(servers: number, natural: number | null, available: number | null): "segments" | "menu" {
	if (servers > SEGMENTS_MAX_SERVERS) return "menu";
	if (natural === null || available === null) return "segments";
	return natural <= available + 0.5 ? "segments" : "menu";
}

/** The counts the switch shows: this server's own unread; another's from its last read, "N+" when that read was full. */
export function switchCounts(servers: HeldServer[], states: OtherServerState[], ownUnread: number): Record<string, SwitchCount> {
	const counts: Record<string, SwitchCount> = {};
	let total = 0;
	let more = false;
	for (const s of servers) {
		if (s.shown) {
			counts[s.origin] = { n: ownUnread };
			total += ownUnread;
			continue;
		}
		const state = states.find((x) => x.origin === s.origin);
		if (state?.state !== "ok" || state.unread == null) continue;
		counts[s.origin] = { n: state.unread, ...(state.full ? { more: true } : {}) };
		total += state.unread;
		more ||= !!state.full;
	}
	counts.all = { n: total, ...(more ? { more: true } : {}) };
	return counts;
}

/**
 * B-244 D-3, S01 (B-267; SCN-099): the mail list's server switch, in the list heading: All, then every server the app
 * holds by its name with its unread count, or its state when it could not be read. All and this server stay on this
 * page (All merges the other servers' mail in); another server's choice shows that server in the same window, as it was
 * left (B-244 D-1). The control itself is the one Settings uses (`ServerSwitch`, S11).
 */
export default function ServerTabs({ servers, states, mergeAll, ownUnread, onChoose, onRetry }: {
	servers: HeldServer[];
	states: OtherServerState[];
	/** All is chosen: the other servers' mail is in the list. */
	mergeAll: boolean;
	ownUnread: number;
	onChoose: (all: boolean) => void;
	onRetry: () => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const measure = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<{ natural: number; available: number } | null>(null);
	useLayoutEffect(() => {
		const el = box.current, probe = measure.current;
		if (!el || !probe) return;
		const read = () => setSize((was) => {
			const next = { natural: Math.ceil(probe.getBoundingClientRect().width), available: Math.floor(el.getBoundingClientRect().width) };
			return was && was.natural === next.natural && was.available === next.available ? was : next;
		});
		read();
		if (typeof ResizeObserver === "undefined") return;
		const watch = new ResizeObserver(read);
		watch.observe(el);
		watch.observe(probe);
		return () => watch.disconnect();
	}, []);
	const shown = servers.find((s) => s.shown);
	const switchStates: Record<string, SwitchState> = {};
	for (const s of states) switchStates[s.origin] = s.state;
	const props = {
		servers: servers.map((s) => ({ origin: s.origin, label: s.label })), states: switchStates,
		current: mergeAll || !shown ? "all" : shown.origin, allMode: "enabled" as const, counts: switchCounts(servers, states, ownUnread),
		onChoose: (choice: string) => {
			if (choice === "all") onChoose(true);
			else if (choice === shown?.origin) onChoose(false);
			else showServer(choice);
		},
		onRetry: () => onRetry(), onSignIn: (origin: string) => showServer(origin),
	};
	return (
		<div ref={box} className="fi-server-tabs">
			<ServerSwitch {...props} layout={tabsLayout(servers.length, size?.natural ?? null, size?.available ?? null)} />
			{/* The segments as they would be drawn whole, off screen and out of reach, to know whether they fit. */}
			<div ref={measure} className="fi-server-tabs-measure" aria-hidden="true" inert>
				<ServerSwitch {...props} layout="segments" />
			</div>
		</div>
	);
}
