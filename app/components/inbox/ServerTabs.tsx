import { useT } from "../../lib/i18n";
import { showServer, type HeldServer, type OtherServerState } from "../../lib/other-servers";

/**
 * B-244 D-3 (SCN-099): above the inbox, All and then every server the app holds by its name, with its unread count, or
 * its state when it could not be read. All and this server's tab stay on this page (All merges the other servers'
 * mail in); another server's tab shows that server in the same window, as it was left (B-244 D-1).
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
	const t = useT();
	const stateOf = (origin: string) => states.find((s) => s.origin === origin);
	return (
		<div className="fi-chip-row fi-server-tabs" role="group" aria-label={t("Servers")}>
			<button type="button" className="fi-chip" aria-pressed={mergeAll} onClick={() => onChoose(true)}>
				{t("All")}
			</button>
			{servers.map((s) => {
				if (s.shown) {
					return (
						<button type="button" key={s.origin} className="fi-chip" aria-pressed={!mergeAll} onClick={() => onChoose(false)}>
							{s.label}{ownUnread > 0 && <span>{ownUnread}</span>}
						</button>
					);
				}
				const state = stateOf(s.origin);
				if (state?.state === "signed_out") {
					return (
						<button type="button" key={s.origin} className="fi-chip is-problem" title={t("Sign in to {server}", { server: s.label })} onClick={() => showServer(s.origin)}>
							{s.label} <span>{t("Sign In")}</span>
						</button>
					);
				}
				if (state?.state === "unreachable") {
					return (
						<span key={s.origin} className="fi-chip is-problem fi-server-unreachable">
							{s.label} <span>{t("Not reachable now")}</span>
							<button type="button" className="fi-text-button" onClick={onRetry}>{t("Retry")}</button>
						</span>
					);
				}
				return (
					<button type="button" key={s.origin} className="fi-chip" title={t("Opens on {server}", { server: s.label })} onClick={() => showServer(s.origin)}>
						{s.label}{(state?.unread ?? 0) > 0 && <span>{state!.unread}</span>}
					</button>
				);
			})}
		</div>
	);
}
