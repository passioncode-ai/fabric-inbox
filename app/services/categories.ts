/** Client view of /api/categories and /api/projects (workers/routes/categories.ts). */
import { englishT, type T } from "../../shared/i18n";

export interface Project { id: string; name: string; domains: string[]; addresses: string[]; createdAt: string; updatedAt: string }
export interface Scope { all: boolean; accounts: string[]; domains: string[]; projects: string[] }
export interface Conditions { senders: string[]; subjectWords: string[]; textWords: string[] }
export interface CategoryInput {
  name: string;
  description: string;
  scope: Scope;
  conditions: Conditions;
  promote: boolean;
  enabled: boolean;
}
export interface CategoryStats {
  matched: number;
  /** Matched since the category was last opened. */
  fresh: number;
  classified: number;
  pending: number;
  errors: number;
  waitingBudget: number;
  backfill: { total: number; done: number; state: "idle" | "running" | "done" | "failed"; detail: string };
}
export interface Category extends CategoryInput {
  id: string;
  /** scope: the live mail of its inboxes; screened: messages the conditions or the model placed there. */
  kind: "scope" | "screened";
  version: number;
  createdAt: string;
  updatedAt: string;
  stats: CategoryStats;
  /** Inboxes it covers now. */
  accountIds?: string[];
}
export interface CategoryList {
  categories: Category[];
  projects: Project[];
  accounts: { id: string; email: string; provider: "cloudflare" | "gmail" | "imap" | "outlook" }[];
  limits: { backfill: number; dailyModelCalls: number };
}

export function blankCategory(): CategoryInput {
  return { name: "", description: "", scope: { all: true, accounts: [], domains: [], projects: [] },
    conditions: { senders: [], subjectWords: [], textWords: [] }, promote: false, enabled: true };
}

/** One line saying where a category looks, for lists and headings, in the interface's language (`t`). */
export function scopeSummary(c: Pick<Category, "scope">, projects: Project[], t: T = englishT): string {
  if (c.scope.all) return t("All inboxes");
  const parts = [
    ...c.scope.projects.map((id) => projects.find((p) => p.id === id)?.name ?? id),
    ...c.scope.domains,
    ...c.scope.accounts.map((a) => a.replace(/^(cloudflare|gmail|imap|outlook):/, "")),
  ];
  return parts.length > 3 ? t("{first} and {n} more", { first: parts.slice(0, 3).join(", "), n: parts.length - 3 }) : parts.join(", ");
}

/**
 * The status line of a screened category's first classification, or null when there is nothing to
 * say, in the interface's language (`t`). The backfill's detail is the server's own words.
 */
export function progressText(c: Category, t: T = englishT): string | null {
  const s = c.stats;
  if (c.kind !== "screened") return null;
  if (!c.enabled) return t("Paused: new mail is not sorted into it");
  if (s.backfill.state === "running") {
    const counts = { done: s.backfill.done, total: s.backfill.total };
    return s.backfill.detail
      ? t("Sorting recent mail: {done} of {total} · {detail}", { ...counts, detail: t.text(s.backfill.detail) })
      : t("Sorting recent mail: {done} of {total}", counts);
  }
  if (s.backfill.state === "failed") return s.backfill.detail ? t.text(s.backfill.detail) : t("Recent mail could not be sorted");
  if (s.waitingBudget) return t.plural(s.waitingBudget, { one: "{n} message waits for tomorrow's model budget", other: "{n} messages wait for tomorrow's model budget" });
  if (s.errors) return t.plural(s.errors, { one: "{n} message could not be sorted", other: "{n} messages could not be sorted" });
  if (s.pending) return t.plural(s.pending, { one: "{n} new message being sorted", other: "{n} new messages being sorted" });
  return null;
}
