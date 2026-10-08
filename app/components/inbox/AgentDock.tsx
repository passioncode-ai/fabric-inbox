import { useEffect, useRef, useSyncExternalStore } from "react";
import { LazyAgentPanel } from "~/components/AgentSidebar";
import type { SavedDraft, Source } from "~/components/agent-chat";
import { mailboxOf } from "~/components/agent-chat";
import type { InboxAccount } from "./model";
import { useT } from "~/lib/i18n";

/** At this width the panel is a fourth column beside the reader; below it, a sheet over the mail. */
export const WIDE_AGENT_LAYOUT = "(min-width: 1400px)";

/** Whether the AI panel fits beside the reader. The server render says yes: the panel is closed there. */
export function useWideAgentLayout(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const query = window.matchMedia(WIDE_AGENT_LAYOUT);
			query.addEventListener("change", onChange);
			return () => query.removeEventListener("change", onChange);
		},
		() => window.matchMedia(WIDE_AGENT_LAYOUT).matches,
		() => true,
	);
}

export interface AgentDockProps {
	open: boolean;
	/** A column beside the reader (true) or a modal sheet over the mail (false). */
	wide: boolean;
	onClose: () => void;
	/** Every Cloudflare address: the chat agent reads one mailbox at a time. */
	addresses: InboxAccount[];
	/** The address the panel reads, and why: the open message's, the person's choice, or the view's. */
	reading: { account: InboxAccount; by: "message" | "choice" | "scope" } | null;
	onChoose: (accountId: string) => void;
	/** The open message's account when the panel cannot read it (Gmail, Outlook, IMAP). */
	unreadableOpen?: string | null;
	/** The open message, when it is on the address the panel reads. */
	focus?: { emailId: string; subject: string } | null;
	onOpenSource: (source: Source) => void;
	onEditDraft: (draft: SavedDraft) => void;
}

/**
 * The AI panel on the unified inbox (SCN-013, FLW-04; B11-01). It asks the chat agent of one
 * Cloudflare address about its mail; answers stay proposals (drafts open in the composer, nothing
 * is sent). The chat and its socket exist only while the panel is open: closing it unmounts them.
 * Narrow windows get a modal sheet, which keeps focus inside and closes on Esc.
 */
export default function AgentDock(props: AgentDockProps) {
	const { open, wide, onClose } = props;
	const sheet = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const el = sheet.current;
		if (open && !wide && el && !el.open) el.showModal();
	}, [open, wide]);
	if (!open) return null;
	if (!wide)
		return (
			<dialog ref={sheet} id="fi-agent-panel" className="fi-agent-panel fi-agent-sheet" aria-labelledby="fi-agent-title"
				onCancel={(e) => { e.preventDefault(); onClose(); }}>
				<AgentDockBody {...props} />
			</dialog>
		);
	return (
		<aside id="fi-agent-panel" className="fi-agent-panel" aria-labelledby="fi-agent-title"
			onKeyDown={(e) => {
				// Esc closes the column; it never reaches the list's own Esc (clear the selection).
				if (e.key !== "Escape" || e.defaultPrevented) return;
				e.stopPropagation();
				onClose();
			}}>
			<AgentDockBody {...props} />
		</aside>
	);
}

function AgentDockBody({ onClose, addresses, reading, onChoose, unreadableOpen, focus, onOpenSource, onEditDraft }: AgentDockProps) {
	const t = useT();
	const mailbox = reading ? mailboxOf(reading.account) : null;
	return (
		<>
			<header className="fi-agent-head">
				<div>
					<h2 id="fi-agent-title">{t("Ask AI")}</h2>
					{reading && (
						<p className="fi-agent-source" role="status">
							{reading.by === "message"
								? t("Reads {address}, where the open message is.", { address: reading.account.email })
								: t("Reads {address}.", { address: reading.account.email })}
						</p>
					)}
				</div>
				<button type="button" className="fi-icon-button" aria-label={t("Close AI panel")} onClick={onClose}>×</button>
			</header>
			{reading && reading.by !== "message" && addresses.length > 1 && (
				<label className="fi-agent-pick">
					<span>{t("Address")}</span>
					<select value={reading.account.id} onChange={(e) => onChoose(e.target.value)}>
						{addresses.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
					</select>
				</label>
			)}
			{unreadableOpen && (
				<p className="fi-agent-note">
					{t("The open message is in {account}. The AI panel reads only your Cloudflare addresses.", { account: unreadableOpen })}
				</p>
			)}
			{mailbox ? (
				<div className="fi-agent-chat">
					<LazyAgentPanel key={mailbox} mailboxId={mailbox} focus={focus ?? null}
						onOpenSource={onOpenSource} onEditDraft={onEditDraft} />
				</div>
			) : (
				<p className="fi-agent-note">
					{t("The AI panel reads mail on your Cloudflare addresses, and you have none yet. Gmail, Outlook and IMAP mail is not read by it.")}
				</p>
			)}
		</>
	);
}
