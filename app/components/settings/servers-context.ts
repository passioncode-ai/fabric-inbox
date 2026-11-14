/**
 * S11 (B-276, SCN-099): what Settings know of the other servers the desktop app holds, for the parts that live below the
 * route (the section's list, its add buttons, a sentence naming the server). Its own module so ui.tsx can read it
 * without importing the provider (servers.tsx), which itself uses ui.tsx's dialogs.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { SectionId } from "./paths";

export interface SettingsServersValue {
	/** The shown server's name when the app holds two or more servers, else null ("your server"). */
	serverName: string | null;
	/** Under All on Accounts, Addresses or Domains: the section's own list inside the shown server's group, then the others. */
	wrapList: (section: SectionId, ownCount: number | null, list: ReactNode) => ReactNode | null;
	/**
	 * Before adding under All: asks "Which server?" (the shown one chosen). True to add here; false when cancelled or
	 * when another server was chosen (the window then shows that server at `path`).
	 */
	askAdd: (path: string) => Promise<boolean>;
}

export const SettingsServersContext = createContext<SettingsServersValue | null>(null);

export const useSettingsServers = () => useContext(SettingsServersContext);
