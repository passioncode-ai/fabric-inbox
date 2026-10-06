/** Client view of /api/categories and /api/projects (workers/routes/categories.ts). */
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
  accounts: { id: string; email: string; provider: "cloudflare" | "gmail" | "imap" }[];
  limits: { backfill: number; dailyModelCalls: number };
}

export function blankCategory(): CategoryInput {
  return { name: "", description: "", scope: { all: true, accounts: [], domains: [], projects: [] },
    conditions: { senders: [], subjectWords: [], textWords: [] }, promote: false, enabled: true };
}

/** One line saying where a category looks, for lists and headings. */
export function scopeSummary(c: Pick<Category, "scope">, projects: Project[]): string {
  if (c.scope.all) return "All inboxes";
  const parts = [
    ...c.scope.projects.map((id) => projects.find((p) => p.id === id)?.name ?? id),
    ...c.scope.domains,
    ...c.scope.accounts.map((a) => a.replace(/^(cloudflare|gmail|imap):/, "")),
  ];
  return parts.length > 3 ? `${parts.slice(0, 3).join(", ")} and ${parts.length - 3} more` : parts.join(", ");
}

/** The status line of a screened category's first classification, or null when there is nothing to say. */
export function progressText(c: Category): string | null {
  const s = c.stats;
  if (c.kind !== "screened") return null;
  if (!c.enabled) return "Paused: new mail is not sorted into it";
  if (s.backfill.state === "running") return `Sorting recent mail: ${s.backfill.done} of ${s.backfill.total}${s.backfill.detail ? ` · ${s.backfill.detail}` : ""}`;
  if (s.backfill.state === "failed") return s.backfill.detail || "Recent mail could not be sorted";
  if (s.waitingBudget) return s.waitingBudget === 1 ? "1 message waits for tomorrow's model budget" : `${s.waitingBudget} messages wait for tomorrow's model budget`;
  if (s.errors) return `${s.errors} message${s.errors === 1 ? "" : "s"} could not be sorted`;
  if (s.pending) return `${s.pending} new message${s.pending === 1 ? "" : "s"} being sorted`;
  return null;
}
