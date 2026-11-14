/** @jsxRuntime automatic @jsxImportSource react */
import { SignInIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { consoleRunning, otherSettingsBridge, showServer, useHeldServers } from "../../lib/other-servers";
import {
	addChoices, allModeFor, choiceAfterSection, isAllSection, otherItemPath, readMailChoseAll, readOtherSettings, settingsGroups,
	type ServerState, type SettingsKind,
} from "../../lib/settings-servers";
import ServerSwitch, { type SwitchState } from "../ServerSwitch";
import { settingsPath, type SectionId } from "./paths";
import { SettingsServersContext, type SettingsServersValue } from "./servers-context";
import { Dialog, useConfirm } from "./ui";

/** S11: the key under which the other servers' list of one kind is read; read again each time the list opens. */
export const otherSettingsKey = (kind: SettingsKind) => ["other-settings", kind];

interface HeaderModel {
	shownLabel: string;
	servers: { origin: string; label: string }[];
	states: Record<string, SwitchState>;
	current: string;
	allMode: "enabled" | "disabled" | "hidden";
	onChoose: (choice: string) => void;
	onRetry: () => void;
	onSignIn: (origin: string) => void;
}
const HeaderContext = createContext<HeaderModel | null>(null);

/**
 * S11 (B-276, SCN-099): Settings in a desktop app that holds two or more servers. They name the server they change and
 * offer the same switch as the mail (app/components/ServerSwitch.tsx); on Accounts, Addresses and Domains, All lists
 * every held server's items grouped by server (each other server read through its own session, desktop
 * fabric:other-settings); elsewhere All is shown disabled with its reason. Settings open on the mail's choice. An item
 * or a segment of another server switches the window to it (fabric:show-server), saying first when an agent console
 * session would stop. A page in a browser, one server, or an older desktop build without the settings read: nothing
 * changes, Settings show one server.
 */
export function SettingsServersProvider({ section, children }: { section: SectionId; children: ReactNode }) {
	const t = useT();
	const confirm = useConfirm();
	const held = useHeldServers();
	const [wantsAll, setWantsAll] = useState(readMailChoseAll);
	const reader = otherSettingsBridge();
	const shown = held.find((s) => s.shown) ?? null;
	const several = !!reader && !!shown && held.length >= 2;
	const choice = several ? choiceAfterSection(wantsAll, section) : "shown";
	const kind = isAllSection(section) ? section : null;
	const listing = several && choice === "all" && !!kind;
	const others = useQuery({
		queryKey: otherSettingsKey(kind ?? "accounts"),
		enabled: listing,
		// Once per open of the list and on Retry: never on a timer, never on focus.
		queryFn: async () => readOtherSettings(await reader!(kind!), kind!),
		staleTime: 0, refetchInterval: false, refetchOnWindowFocus: false, retry: false,
	});
	const states = useMemo(() => {
		const out: Record<string, ServerState> = {};
		for (const s of (listing ? others.data : undefined) ?? []) out[s.origin] = s.state;
		return out;
	}, [listing, others.data]);

	// Another server is shown in this window; an agent console session works for this one and stops first.
	const go = useCallback(async (origin: string, path: string) => {
		const target = held.find((s) => s.origin === origin);
		if (!target) return;
		if (await consoleRunning()) {
			const ok = await confirm({ title: t("The agent console session will stop"), confirmLabel: t("Open {server}", { server: target.label }) });
			if (!ok) return;
		}
		showServer(origin, path);
	}, [held, confirm, t]);

	const [asking, setAsking] = useState<{ path: string; resolve: (here: boolean) => void } | null>(null);
	const askAdd = useCallback((path: string) => new Promise<boolean>((resolve) => {
		if (!listing) { resolve(true); return; }
		setAsking((old) => { old?.resolve(false); return { path, resolve }; });
	}), [listing]);

	const refetch = others.refetch;
	const wrapList = useCallback((at: SectionId, ownCount: number | null, list: ReactNode) => {
		if (!listing || at !== section || !shown || !isAllSection(at)) return null;
		const groups = settingsGroups({ origin: shown.origin, label: shown.label, count: ownCount }, held, others.data ?? [], !others.isFetching);
		return <ServerGroups kind={at} groups={groups} list={list} onOpen={go} onRetry={() => void refetch()} />;
	}, [listing, section, shown, held, others.data, others.isFetching, go, refetch]);

	const value = useMemo<SettingsServersValue>(() => ({ serverName: several && shown ? shown.label : null, wrapList, askAdd }), [several, shown, wrapList, askAdd]);

	const header: HeaderModel | null = several && shown ? {
		shownLabel: shown.label,
		servers: held.map((s) => ({ origin: s.origin, label: s.label })),
		states,
		current: choice === "all" ? "all" : shown.origin,
		allMode: allModeFor(section, held.length),
		onChoose: (c) => {
			if (c === "all") setWantsAll(true);
			else if (c === shown.origin) setWantsAll(false);
			else void go(c, settingsPath(section));
		},
		onRetry: () => void refetch(),
		onSignIn: (origin) => void go(origin, settingsPath(section)),
	} : null;

	return (
		<SettingsServersContext.Provider value={value}>
			<HeaderContext.Provider value={header}>{children}</HeaderContext.Provider>
			{asking && (
				<WhichServer servers={held} shownOrigin={shown?.origin ?? ""} states={states}
					onDone={(origin) => {
						const { path, resolve } = asking;
						setAsking(null);
						if (!origin || origin === shown?.origin) { resolve(origin === shown?.origin); return; }
						resolve(false);
						void go(origin, path);
					}} />
			)}
		</SettingsServersContext.Provider>
	);
}

/** The header: "Settings · <server>" and the switch; nothing when Settings show one server. */
export function SettingsServersHeader() {
	const t = useT();
	const model = useContext(HeaderContext);
	if (!model) return null;
	return (
		<header className="fi-settings-servers">
			<p className="fi-settings-server-title">{t("Settings · {name}", { name: model.current === "all" ? t("All servers") : model.shownLabel })}</p>
			<ServerSwitch servers={model.servers} states={model.states} current={model.current} allMode={model.allMode}
				allReason={t("This section belongs to one server")} onChoose={model.onChoose} onRetry={model.onRetry} onSignIn={model.onSignIn} />
		</header>
	);
}

function ServerGroups({ kind, groups, list, onOpen, onRetry }: {
	kind: SettingsKind; groups: ReturnType<typeof settingsGroups>; list: ReactNode;
	onOpen: (origin: string, path: string) => void; onRetry: () => void;
}) {
	const t = useT();
	const countText = (n: number) => kind === "accounts" ? t.plural(n, { one: "{n} account", other: "{n} accounts" })
		: kind === "addresses" ? t.plural(n, { one: "{n} address", other: "{n} addresses" })
		: t.plural(n, { one: "{n} domain", other: "{n} domains" });
	return (
		<div className="fi-server-groups">
			{groups.map((g) => (
				<section key={g.origin} className="fi-server-group" aria-label={g.label}>
					<h2 className="fi-server-group-head">
						<span className="fi-server-name" title={g.label}>{g.label}</span>
						{g.count !== null && <span className="fi-server-group-count">{countText(g.count)}</span>}
					</h2>
					{g.shown ? list
						: g.state === "loading" ? <p className="fi-server-group-note" role="status">{t("Loading…")}</p>
						: g.state === "signed_out" ? (
							<button type="button" className="fi-secondary fi-server-group-action" onClick={() => onOpen(g.origin, settingsPath(kind))}>
								<SignInIcon size={14} aria-hidden="true" /> {t("Sign in")}
							</button>
						) : g.state === "unreachable" ? (
							<div className="fi-server-group-note">
								<p><WarningIcon size={14} aria-hidden="true" /> {t("Not reachable now")}</p>
								<button type="button" className="fi-secondary fi-server-group-action" onClick={onRetry}>{t("Retry")}</button>
							</div>
						) : !g.items.length ? <p className="fi-server-group-note">{t("None on this server yet")}</p> : (
							<ul className="fi-list-rows">
								{g.items.map((item) => (
									<li key={item.id}>
										<button type="button" className="fi-list-row fi-other-row" title={t("Opens on {server}", { server: g.label })}
											onClick={() => onOpen(g.origin, otherItemPath(kind, item.id))}>
											<span className="fi-row-main">
												<span className="fi-row-title">{item.title}</span>
												{(item.detail || item.served) && <span className="fi-row-meta">{item.served ? t("Receiving here") : item.detail}</span>}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
				</section>
			))}
		</div>
	);
}

function WhichServer({ servers, shownOrigin, states, onDone }: {
	servers: readonly { origin: string; label: string }[]; shownOrigin: string; states: Readonly<Record<string, ServerState>>;
	onDone: (origin: string | null) => void;
}) {
	const t = useT();
	const choices = addChoices(servers, shownOrigin, states);
	const [picked, setPicked] = useState(shownOrigin);
	const name = useId();
	return (
		<Dialog open title={t("Which server?")} onClose={() => onDone(null)}>
			<div className="fi-dialog-body">
				<fieldset className="fi-which-server">
					<legend className="fi-visually-hidden">{t("Which server?")}</legend>
					{choices.map((c) => (
						<label key={c.origin} className={c.disabled ? "is-disabled" : undefined} title={c.disabled ? t("Not reachable now") : undefined}>
							<input type="radio" name={name} value={c.origin} checked={picked === c.origin} disabled={c.disabled}
								data-autofocus={c.chosen ? "" : undefined} onChange={() => setPicked(c.origin)} />
							<span className="fi-server-name">{c.label}</span>
						</label>
					))}
				</fieldset>
			</div>
			<div className="fi-dialog-actions">
				<button type="button" className="fi-secondary" onClick={() => onDone(null)}>{t("Cancel")}</button>
				<button type="button" className="fi-primary" onClick={() => onDone(picked)}>{t("Continue")}</button>
			</div>
		</Dialog>
	);
}
