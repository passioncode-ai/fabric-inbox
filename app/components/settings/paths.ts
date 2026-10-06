/**
 * Settings (SCR-02): one screen at `/settings/:section/:id?/:tab?`. Every place in the app, the
 * desktop menu and an old bookmark reaches a section through these helpers, so a link and the
 * redirect that keeps an old address working can never disagree.
 *
 * Plain module, no `~/` imports: the tests load it directly. Labels are English, marked with
 * `msg()`; the interface shows them through `t.text()`.
 */
import { msg } from "../../../shared/i18n";

export const SECTION_IDS = [
  "addresses", "domains", "accounts", "destinations", "agents", "knowledge", "categories", "spam", "discard", "agent-access", "app",
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const DEFAULT_SECTION: SectionId = "addresses";

export interface SectionInfo {
  id: SectionId;
  label: string;
  /** One line under the section's title: what it is for. */
  description: string;
  /** Where it sits in the section list. */
  group: "mail" | "agents" | "app";
}

export const SECTIONS: readonly SectionInfo[] = [
  { id: "addresses", label: msg("Addresses"), group: "mail",
    description: msg("The addresses that receive mail here, who answers each one, and where its copy goes.") },
  { id: "domains", label: msg("Domains"), group: "mail",
    description: msg("Your domains on Cloudflare: the ones receiving mail here, and the rest one action away.") },
  { id: "accounts", label: msg("Accounts"), group: "mail",
    description: msg("Your mail accounts, and the Cloudflare accounts that hold your domains.") },
  { id: "destinations", label: msg("Forwarding destinations"), group: "mail",
    description: msg("Outside addresses a copy of each message may go to, once they confirm it.") },
  { id: "categories", label: msg("Categories"), group: "mail",
    description: msg("Views of the mail that matters, and the projects they can look at.") },
  { id: "spam", label: msg("Spam rules"), group: "mail",
    description: msg("What goes to Spam, and your lists of senders and domains.") },
  { id: "discard", label: msg("Discard rules"), group: "mail",
    description: msg("What you discarded teaches: mail like it goes straight to Discarded. Remove a rule, or always allow a sender.") },
  { id: "agents", label: msg("Agents"), group: "agents",
    description: msg("Agents answer mail on the addresses you give them, within their reply policy.") },
  { id: "knowledge", label: msg("Knowledge"), group: "agents",
    description: msg("Collections of documents your agents search when they answer.") },
  { id: "agent-access", label: msg("Agent access"), group: "agents",
    description: msg("Keys for AI agents you run elsewhere, and what they changed.") },
  { id: "app", label: msg("App"), group: "app",
    description: msg("Theme, your server, setups, and the desktop app.") },
];

export const isSection = (value: unknown): value is SectionId =>
  typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);

export const sectionInfo = (id: SectionId): SectionInfo => SECTIONS.find((s) => s.id === id)!;

/** The address of a section, an item in it, and a tab of that item. Each part is encoded once. */
export function settingsPath(section: SectionId, id?: string | null, tab?: string | null, query?: Record<string, string>): string {
  let path = `/settings/${section}`;
  if (id) path += `/${encodeURIComponent(id)}`;
  if (id && tab) path += `/${encodeURIComponent(tab)}`;
  const search = query ? new URLSearchParams(query).toString() : "";
  return search ? `${path}?${search}` : path;
}

/**
 * Where an address of an older version of the app now lives (every one keeps working). Returns
 * null for an address that is not an old settings page.
 */
export function legacyTarget(pathname: string, search = ""): string | null {
  const params = new URLSearchParams(search);
  const path = pathname.replace(/\/+$/, "") || "/";
  const c = params.get("c");
  switch (path) {
    case "/projects": {
      const domain = params.get("domain");
      return domain ? settingsPath("domains", domain) : settingsPath("addresses");
    }
    case "/mailboxes":
      return settingsPath("addresses");
    case "/accounts":
      return settingsPath("accounts");
    case "/ai-agents":
      return settingsPath("agents");
    case "/knowledge":
      return settingsPath("knowledge", c);
    case "/categories":
      return settingsPath("categories", c);
    case "/spam":
      return settingsPath("spam");
    case "/agent-access":
      return settingsPath("agent-access");
    case "/setup": {
      const source = params.get("source");
      return settingsPath("app", "setup", null, source ? { source } : undefined);
    }
  }
  // The legacy mailbox screen's own settings: display name and signature now live on the address.
  const mailbox = /^\/mailbox\/([^/]+)\/settings$/.exec(path);
  if (mailbox) return settingsPath("addresses", decodeURIComponent(mailbox[1]!), "signature");
  return null;
}

/** The address of one of the Settings screen's own pages, read back into its parts. */
export function parseSettingsPath(pathname: string): { section: SectionId; id: string | null; tab: string | null } | null {
  const match = /^\/settings(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  const section = match[1] ? decodeURIComponent(match[1]) : DEFAULT_SECTION;
  if (!isSection(section)) return null;
  return { section, id: match[2] ? decodeURIComponent(match[2]) : null, tab: match[3] ? decodeURIComponent(match[3]) : null };
}
