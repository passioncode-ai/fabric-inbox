// B-305 (SCN-106): a new coding session in Fabric from an email, in the desktop app only. Fabric owns starting it
// (fabric-session-links/1, board thread 3ca40854; the `fabric://` links of fabric-agent-contract DEC-0040): Inbox opens
// Fabric's start in the chosen project and Fabric asks the person before it runs anything. A link carries ids only, never
// words, so the email's reference is copied for the person to paste into the session.
import { useEffect, useId, useRef, useState } from "react";
import { TerminalWindowIcon } from "@phosphor-icons/react";
import { useT } from "~/lib/i18n";

export interface SessionLetter {
	subject: string;
	sender: string;
	date: string;
	accountId: string;
	messageId: string;
}

/** What is copied: enough for the person and their agent to find the email through Fabric Inbox's MCP (read_message). */
export function letterReference(t: ReturnType<typeof useT>, letter: SessionLetter): string {
	return t("Email in Fabric Inbox: \"{subject}\" from {sender}, {date}. Read it with the fabric-inbox tool read_message: accountId {accountId}, messageId {messageId}.", {
		subject: letter.subject.slice(0, 200) || t("(no subject)"), sender: letter.sender, date: letter.date, accountId: letter.accountId, messageId: letter.messageId,
	});
}

export default function FabricSessionButton({ letter }: { letter: SessionLetter }) {
	const t = useT();
	const bridge = typeof window !== "undefined" ? window.fabricDesktop : undefined;
	const [open, setOpen] = useState(false);
	const [projects, setProjects] = useState<string[]>([]);
	const [project, setProject] = useState("");
	const [runner, setRunner] = useState<"claude" | "codex">("claude");
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const listId = useId();

	useEffect(() => {
		if (!open || !bridge?.sessionProjects) return;
		let live = true;
		void bridge.sessionProjects().then((r) => {
			if (!live) return;
			setProjects(r.projects);
			setProject((current) => current || r.projects[0] || "");
			if (!r.fabric) setNote(t("Fabric is not installed. Get it at passioncode.ai/fabric"));
		}, () => {});
		const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
		const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", escape);
		ref.current?.querySelector<HTMLElement>("input")?.focus();
		return () => { live = false; document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
	}, [open]);

	if (!bridge?.sessionNew) return null;

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!bridge?.sessionNew || busy) return;
		setBusy(true);
		const copied = await navigator.clipboard?.writeText(letterReference(t, letter)).then(() => true, () => false) ?? false;
		const out = await bridge.sessionNew({ project: project.trim(), runner }).catch(() => ({ ok: false, error: "open" }));
		setBusy(false);
		if (out.ok) {
			setOpen(false);
			setNote(copied ? t("Fabric is open: confirm the start there. The email's reference is copied: paste it into the session.") : t("Fabric is open: confirm the start there."));
			return;
		}
		setNote(out.error === "project" ? t("Write the project as Fabric names it: letters, digits, dots and dashes, no spaces or slashes.")
			: out.error === "not_installed" ? t("Fabric is not installed. Get it at passioncode.ai/fabric")
			: t("Fabric could not be opened."));
	}

	return (
		<div ref={ref} className="fi-session-new">
			<button type="button" className="fi-secondary" aria-haspopup="dialog" aria-expanded={open}
				title={t("Start a coding session in Fabric about this email")}
				onClick={() => { setNote(null); setOpen((o) => !o); }}>
				<TerminalWindowIcon size={17} /> {t("New session")}
			</button>
			{open && (
				<form role="dialog" aria-label={t("New session in Fabric")} className="fi-session-new-panel" onSubmit={(e) => void submit(e)}>
					<strong>{t("New session in Fabric")}</strong>
					<label>
						<span>{t("Fabric project")}</span>
						<input value={project} list={listId} required maxLength={128} spellCheck={false} autoComplete="off"
							placeholder={t("as Fabric names it")} onChange={(e) => setProject(e.target.value)} />
						<datalist id={listId}>{projects.map((p) => <option key={p} value={p} />)}</datalist>
					</label>
					<label>
						<span>{t("Agent")}</span>
						<select value={runner} onChange={(e) => setRunner(e.target.value === "codex" ? "codex" : "claude")}>
							<option value="claude">Claude Code</option>
							<option value="codex">Codex</option>
						</select>
					</label>
					<p className="fi-muted">{t("Fabric shows the start and asks before it runs. The link carries no words, so this email's reference is copied for you to paste into the session.")}</p>
					{note && <p role="alert" className="fi-session-new-note">{note}</p>}
					<div className="fi-session-new-actions">
						<button type="submit" className="fi-primary" disabled={busy || !project.trim()}>{t("Open in Fabric")}</button>
						<button type="button" className="fi-secondary" onClick={() => setOpen(false)}>{t("Cancel")}</button>
					</div>
				</form>
			)}
			{!open && note && <p role="status" className="fi-session-new-note">{note}</p>}
		</div>
	);
}
