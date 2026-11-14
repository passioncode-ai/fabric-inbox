import { useEffect, useRef, useState } from "react";
import { showServer, type HeldServer, type OtherServerState } from "../../lib/other-servers";
import ServerSwitch, { type SwitchCount, type SwitchState } from "../ServerSwitch";

/** S01 (B-267): below this width of the mail list the switch is one menu button, whatever the number of servers. */
export const SEGMENTS_MIN_WIDTH = 360;

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
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const list = box.current?.closest(".fi-message-list");
		if (!list || typeof ResizeObserver === "undefined") return;
		const watch = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < SEGMENTS_MIN_WIDTH));
		watch.observe(list);
		return () => watch.disconnect();
	}, []);
	const shown = servers.find((s) => s.shown);
	const switchStates: Record<string, SwitchState> = {};
	for (const s of states) switchStates[s.origin] = s.state;
	return (
		<div ref={box} className="fi-server-tabs">
			<ServerSwitch servers={servers.map((s) => ({ origin: s.origin, label: s.label }))} states={switchStates}
				current={mergeAll || !shown ? "all" : shown.origin} allMode="enabled" counts={switchCounts(servers, states, ownUnread)}
				layout={narrow || servers.length > 4 ? "menu" : "segments"}
				onChoose={(choice) => {
					if (choice === "all") onChoose(true);
					else if (choice === shown?.origin) onChoose(false);
					else showServer(choice);
				}}
				onRetry={() => onRetry()} onSignIn={(origin) => showServer(origin)} />
		</div>
	);
}
