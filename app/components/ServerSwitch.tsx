/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so the tests (tsx) render it as the app does.
import { CaretDownIcon, SignInIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { nextSwitchIndex, switchLayout, type AllMode } from "../lib/settings-servers";

/** A server the switch offers, as the bridge names it. */
export interface SwitchServer {
	origin: string;
	label: string;
}
/** What the last read of a server said; a server with no state reads as ok. */
export type SwitchState = "ok" | "signed_out" | "unreachable" | "loading";
/** A count beside a choice; `more` when it is a lower bound ("50+"). */
export interface SwitchCount {
	n: number;
	more?: boolean;
}
export type SwitchChoice = "all" | string;

export interface ServerSwitchProps {
	servers: readonly SwitchServer[];
	/** By origin. */
	states?: Readonly<Record<string, SwitchState>>;
	/** "all", or the origin of the server shown. */
	current: SwitchChoice;
	/** enabled: All can be chosen; disabled: shown, never focused by the arrows, `allReason` in its tooltip; hidden: no All. */
	allMode: AllMode;
	allReason?: string;
	/** By origin, and "all" for All; Settings has no mail and passes none. */
	counts?: Readonly<Record<string, SwitchCount>>;
	onChoose: (choice: SwitchChoice) => void;
	/** A server not reachable now: choosing it retries. */
	onRetry: (origin: string) => void;
	/** A signed-out server: choosing it signs in there. */
	onSignIn: (origin: string) => void;
	/** Segments or the menu; by default the number of servers decides (segments up to four). */
	layout?: "segments" | "menu";
	/** The navigation's name; "Servers" by default. */
	label?: string;
}

interface Choice {
	key: SwitchChoice;
	disabled: boolean;
	title?: string;
	content: ReactNode;
	act: () => void;
}

/**
 * S11, S01 (B-276, B-267; SCN-099): the switch of the server a screen shows, one control for every place that has one
 * (Settings' header now, the mail list's heading next). A navigation: each choice a button with `aria-current="page"` on
 * the chosen one; the arrow keys, Home and End move between choices (a disabled All is skipped), Enter chooses. A
 * signed-out or unreachable server says so in its own label with an icon, never by colour alone, and choosing it signs
 * in or retries: one control per choice, no button inside a button. Up to four servers the choices are segments
 * (`.fi-segmented`); five or more, one button opening a menu of the same rows.
 */
export default function ServerSwitch(props: ServerSwitchProps) {
	const { servers, states = {}, current, allMode, allReason, counts = {}, onChoose, onRetry, onSignIn } = props;
	const t = useT();
	const layout = props.layout ?? switchLayout(servers.length);
	const countText = (key: string) => {
		const c = counts[key];
		return c && c.n > 0 ? <span className="fi-server-count">{c.more ? `${c.n}+` : c.n}</span> : null;
	};
	const choices: Choice[] = [];
	if (allMode !== "hidden") {
		choices.push({
			key: "all", disabled: allMode === "disabled", title: allMode === "disabled" ? allReason : undefined,
			content: <><span className="fi-server-name">{t("All")}</span>{countText("all")}</>,
			act: () => onChoose("all"),
		});
	}
	for (const s of servers) {
		const state = states[s.origin] ?? "ok";
		const name = <span className="fi-server-name" key="name">{s.label}</span>;
		if (state === "signed_out") {
			choices.push({ key: s.origin, disabled: false, title: t("Sign in to {server}", { server: s.label }), act: () => onSignIn(s.origin),
				content: <><SignInIcon size={14} aria-hidden="true" />{t.rich("{name} · Sign in", { name })}</> });
		} else if (state === "unreachable") {
			choices.push({ key: s.origin, disabled: false, title: t("Not reachable now"), act: () => onRetry(s.origin),
				content: <><WarningIcon size={14} aria-hidden="true" />{t.rich("{name} · Retry", { name })}</> });
		} else {
			choices.push({ key: s.origin, disabled: false, title: s.label, act: () => onChoose(s.origin), content: <>{name}{countText(s.origin)}</> });
		}
	}
	const label = props.label ?? t("Servers");
	return layout === "menu"
		? <SwitchMenu choices={choices} current={current} label={label} servers={servers} count={countText(current)} />
		: <SwitchSegments choices={choices} current={current} label={label} />;
}

function choiceClass(c: Choice, current: SwitchChoice) {
	return "fi-server-choice" + (c.key === current ? " is-current" : "") + (c.disabled ? " is-disabled" : "");
}

function SwitchSegments({ choices, current, label }: { choices: Choice[]; current: SwitchChoice; label: string }) {
	const row = useRef<HTMLDivElement>(null);
	const focusAt = choices.findIndex((c) => c.key === current && !c.disabled);
	const tabStop = focusAt >= 0 ? focusAt : choices.findIndex((c) => !c.disabled);
	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
		const buttons = [...(row.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
		const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
		event.preventDefault();
		buttons[nextSwitchIndex(choices, at < 0 ? tabStop : at, event.key)]?.focus();
	};
	return (
		<nav className="fi-server-switch" aria-label={label}>
			<div ref={row} className="fi-segmented fi-server-switch-segments" onKeyDown={onKey}>
				{choices.map((c, i) => (
					<button type="button" key={c.key} className={choiceClass(c, current)} data-choice={c.key} title={c.title}
						aria-current={c.key === current ? "page" : undefined} aria-disabled={c.disabled || undefined}
						tabIndex={i === tabStop ? 0 : -1} onClick={() => { if (!c.disabled) c.act(); }}>
						{c.content}
					</button>
				))}
			</div>
		</nav>
	);
}

function SwitchMenu({ choices, current, label, servers, count }: { choices: Choice[]; current: SwitchChoice; label: string; servers: readonly SwitchServer[]; count?: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const id = useId();
	const buttons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
	useEffect(() => {
		if (!open) return;
		const all = buttons();
		const at = choices.findIndex((c) => c.key === current && !c.disabled);
		all[at >= 0 ? at : choices.findIndex((c) => !c.disabled)]?.focus();
		const outside = (event: MouseEvent) => {
			if (!list.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", outside);
		return () => document.removeEventListener("mousedown", outside);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	const close = () => { setOpen(false); trigger.current?.focus(); };
	const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
		if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
		if (event.key === "Tab") { setOpen(false); return; }
		if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const all = buttons();
		all[nextSwitchIndex(choices, all.indexOf(document.activeElement as HTMLButtonElement), event.key)]?.focus();
	};
	const shown = current === "all" ? null : servers.find((s) => s.origin === current);
	return (
		<nav className="fi-server-switch is-menu" aria-label={label}>
			<button ref={trigger} type="button" className="fi-server-choice fi-server-switch-trigger" aria-haspopup="true" aria-expanded={open}
				aria-controls={open ? id : undefined} title={shown?.label} onClick={() => setOpen(!open)}>
				<span className="fi-server-name">{shown ? shown.label : t("All servers")}</span>
				{count}
				<CaretDownIcon size={12} aria-hidden="true" />
			</button>
			{open && (
				<ul ref={list} id={id} className="fi-menu fi-server-switch-list" onKeyDown={onKey}>
					{choices.map((c) => (
						<li key={c.key}>
							<button type="button" className={choiceClass(c, current)} data-choice={c.key} title={c.title}
								aria-current={c.key === current ? "page" : undefined} aria-disabled={c.disabled || undefined}
								tabIndex={-1} onClick={() => { if (c.disabled) return; close(); c.act(); }}>
								{c.content}
							</button>
						</li>
					))}
				</ul>
			)}
		</nav>
	);
}
