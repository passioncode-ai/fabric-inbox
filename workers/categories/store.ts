import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { CATEGORIES_STEPS } from "./schema";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { Env } from "../types";
import type { InboxMessage } from "../../shared/mail/inbox";
import { stripHtmlToText, textToHtml } from "../lib/email-helpers";
import { readInbox } from "../routes/inbox";
import { inboxSources } from "../lib/inbox-sources";
import {
  CategoryInputSchema, ProjectInputSchema, categoryId, inScope, kindOf, matchesConditions, selectionChanged,
  type AccountRef, type Category, type CategoryInput, type Project, type ProjectInput,
} from "./definition";
import { classify, DEFAULT_CATEGORY_MODEL, type DescribedCategory } from "./classify";
import { judgeSpam, DEFAULT_SPAM_MODEL, type SpamInput, type SpamJudgement } from "../spam/judge";
import { tooLittleToJudge } from "../../shared/mail/spam";
import { parseRemoteAccount } from "../../shared/mail/accounts";
import { msg } from "../../shared/i18n";
import { scanPromptInjection } from "../lib/ai";
import { inspectMessage, suspect, type SafetyFindings } from "../safety/check";
import { splitHidden } from "../safety/hidden";
import { reviewHeld, type SafetyReview } from "../safety/review";

/**
 * Categories (CAT-1..CAT-4): one store per workspace (`getByName("workspace")`).
 *
 * Every new message of both providers is offered here once (`ingest`). For each
 * enabled screened category whose scope holds the message's inbox, the plain
 * conditions decide first; the described categories that remain are decided by
 * one model call for the message. Each category gets a verdict (matched or not,
 * with its reason and whether a rule or the model decided), for the category's
 * current version only. Work waits in a durable queue driven by the alarm, so
 * a model that is down delays verdicts and never loses them.
 */
export interface QueueItem { accountId: string; accountEmail: string; messageId: string; sender: string; subject: string; text: string; timestamp: number;
  /** The model also judges it for spam (SP-2): a Cloudflare message no rule decided. */
  screen?: boolean;
  /** For the spam check (B-172): the sender's shown name and the domain Cloudflare's MX verified. */
  senderName?: string | null; verified?: string | null;
  /** B-180: where replies go when that is not the sender, and the names and types of its files, for the spam check. */
  replyTo?: string | null; attachments?: string[];
  /** C-5: the HTML has a link or an image, so it is judged even with little text; its first links are in `text`. */
  linked?: boolean;
  /** B-179: its files, for the safety check (a Cloudflare message's; an account's files are not read here yet). */
  files?: MailFile[];
  /** B-178: the message is checked for instructions aimed at agents; its HTML (at most HTML_CHARS) is what is read. */
  safety?: boolean; html?: string }

export { isHeld, safetyKey, type SafetyRecord, type SafetyState } from "../safety/state";
import { isHeld, safetyKey, type SafetyRecord, type SafetyState } from "../safety/state";
export interface VerdictRow { categoryId: string; accountId: string; messageId: string; matched: boolean; reason: string; source: "rule" | "model" | "error"; timestamp: number; subject: string; sender: string }
export interface CategoryStats { matched: number; fresh: number; classified: number; pending: number; errors: number; waitingBudget: number; backfill: { total: number; done: number; state: "idle" | "running" | "done" | "failed"; detail: string } }
export type CategoryView = Category & { stats: CategoryStats };
export interface PageRow { accountId: string; messageId: string; timestamp: number; reason: string; source: string }

export class CategoryError extends Error {
  constructor(message: string, readonly code: "not_found" | "invalid" | "conflict" | "limit") { super(`${code}: ${message}`); }
}


const MAX_CATEGORIES = 50;
const MAX_PROJECTS = 50;
export const BACKFILL_MESSAGES = 200;
const BATCH = 8;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;
const TEXT_CHARS = 6000;
const DEFAULT_DAILY_CALLS = 500;
/**
 * Verdicts that a message is NOT in a category, and spam answers, older than this are deleted (B-92):
 * one row per screened category per message otherwise grows for ever. Matched verdicts stay (they are
 * the category's view); an `error` verdict stays (it is shown and counted). A message this old that is
 * screened again is simply decided again.
 */
export const VERDICT_RETENTION_MS = 30 * 86_400_000;
const PRUNE_BATCH = 500;
const PRUNE_EVERY_MS = 3_600_000;
export const DEFAULT_SPAM_DAILY_CALLS = 300;
/** B-178: model calls of the safety check and its reviews per day; over it a message is held as unchecked. */
export const DEFAULT_SAFETY_DAILY_CALLS = 2000;
const HTML_CHARS = 100_000;
import { safetyOn } from "../safety/on";
import { FEED_REFRESH_MS, FEED_STALE_MS, linksOf, lookalikeLinks, phishingLinks, refreshFeed, type FeedEnv, type KeptFeed } from "../safety/feed";

/** B-179: where a file of an arriving message is read from: R2 for a Cloudflare message, the provider for an account's. */
export function fileKey(accountId: string, messageId: string, f: { id: string; filename: string }): string {
  return accountId.startsWith("cloudflare:") ? `attachments/${messageId}/${f.id}/${f.filename}`
    : `account:${[accountId, messageId, f.id].map(encodeURIComponent).join("/")}`;
}
export function parseAccountFileKey(key: string): { accountId: string; messageId: string; attachmentId: string } | null {
  if (!key.startsWith("account:")) return null;
  const parts = key.slice("account:".length).split("/").map(decodeURIComponent);
  return parts.length === 3 && parts.every(Boolean) ? { accountId: parts[0]!, messageId: parts[1]!, attachmentId: parts[2]! } : null;
}
import { readFiles, type MailFile, type ToText } from "../safety/files";
export { safetyOn };
type Row = Record<string, string | number | null>;

/** The tables of an account's labels a mailbox's move carries, with their columns (CATEGORIES_STEPS). */
const LABEL_COLUMNS: Record<string, string[]> = {
  verdicts: ["category_id", "version", "account_id", "message_id", "matched", "reason", "source", "timestamp", "subject", "sender", "classified_at"],
  spam_checks: ["account_id", "message_id", "verdict", "reason", "checked_at"],
  safety: ["account_id", "message_id", "state", "findings", "review", "reason", "checked_at", "decided_by", "decided_at", "timestamp", "subject", "sender"],
};
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const nextDay = (t = Date.now()) => Date.parse(day(t) + "T00:00:00Z") + 86_400_000 + 5 * 60_000;
/** C-5: the first links of an HTML body, which stripping its tags drops; the model reads where a message points. */
const linkLines = (html: string) => {
  const links = [...html.matchAll(/\bhref\s*=\s*["']?(https?:[^"'\s>]+)/gi)].map((m) => m[1]!).slice(0, 5);
  return links.length ? "\n" + links.join("\n") : "";
};
/** A queued item; its row's account is the authority (an address renamed moves the row, C-1). */
const queued = (row: Row): QueueItem => ({ ...(JSON.parse(String(row.payload)) as QueueItem), accountId: String(row.account_id) });

export class CategoriesDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private draining: Promise<void> | undefined;
  private prunedAt = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrateSchema(ctx.storage, CATEGORIES_STEPS, "CategoriesDO");
  }

  /** The spam check's model (B-172): `SPAM_MODEL`, else the categories' model. Overridden in tests. */
  protected spamModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai((this.env.SPAM_MODEL || this.env.CATEGORY_MODEL || this.env.AUTOMATION_MODEL || DEFAULT_SPAM_MODEL) as Parameters<typeof workersai>[0]);
  }
  /** The model. Overridden in tests with a scripted one. */
  protected model(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai((this.env.CATEGORY_MODEL || this.env.AUTOMATION_MODEL || DEFAULT_CATEGORY_MODEL) as Parameters<typeof workersai>[0]);
  }
  protected dailyCalls(): number {
    const n = Number(this.env.CATEGORY_DAILY_LIMIT);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_CALLS;
  }
  protected dailySpamCalls(): number {
    const n = Number(this.env.SPAM_DAILY_LIMIT);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_SPAM_DAILY_CALLS;
  }
  /** B-178: the light model that reads a message for instructions aimed at agents. Overridden in tests. */
  protected safetyScan(text: string): Promise<{ flagged: boolean; error?: string }> {
    return scanPromptInjection(this.env.AI, text, { plain: true });
  }
  /** B-178: the review's model, with no tools: `SAFETY_REVIEW_MODEL`, else the spam check's. Overridden in tests. */
  /** B-179: turns documents into text with Workers AI (overridden in tests); null without the AI binding. */
  protected toText(): ToText | null {
    const ai = this.env.AI as unknown as { toMarkdown?: (files: { name: string; blob: Blob }[]) => Promise<{ name: string; format: string; data?: string; error?: string }[]> } | undefined;
    if (!ai?.toMarkdown) return null;
    return async (files) => (await ai.toMarkdown!(files)).map((r) => ({ name: r.name, ...(r.format === "markdown" ? { text: r.data ?? "" } : { error: r.error ?? "failed" }) }));
  }

  /** B-180: fetches the signed Okolos feed (overridden in tests). */
  protected feedFetch(): typeof fetch { return (input, init) => fetch(input, init); }

  /**
   * B-180: the server's copy of the Okolos phishing feed, fetched again when older than FEED_REFRESH_MS. A failed
   * fetch keeps the last good copy, said once in the log; null when the server never had one.
   */
  private async phishingFeed(now = Date.now()): Promise<KeptFeed | null> {
    const kept = (await this.ctx.storage.get<KeptFeed>("okolos:feed")) ?? null;
    if (kept && now - kept.fetchedAt < FEED_REFRESH_MS) return kept;
    const tried = await this.ctx.storage.get<number>("okolos:tried");
    if (tried && now - tried < FEED_REFRESH_MS) return kept;
    await this.ctx.storage.put("okolos:tried", now);
    const result = await refreshFeed(this.env as FeedEnv, kept, this.feedFetch(), now);
    if (result.kept && result.kept !== kept) await this.ctx.storage.put("okolos:feed", result.kept);
    if (result.outcome === "refused" || result.outcome === "unreachable")
      console.warn(JSON.stringify({ event: "okolos_feed_kept", outcome: result.outcome, detail: result.detail ?? null, version: kept?.snapshot.version ?? null }));
    return result.kept;
  }

  protected reviewModel(): { model: LanguageModel; name: string } {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const name = this.env.SAFETY_REVIEW_MODEL || this.env.SPAM_MODEL || DEFAULT_SPAM_MODEL;
    return { model: workersai(name as Parameters<typeof workersai>[0]), name };
  }
  protected dailySafetyCalls(): number {
    const n = Number(this.env.SAFETY_DAILY_LIMIT);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_SAFETY_DAILY_CALLS;
  }
  /** Moves a message the model judged spam (SP-2). Overridden in tests. */
  protected async moveToSpam(item: QueueItem, reason: string): Promise<boolean> {
    if (!item.accountId.startsWith("cloudflare:")) return false;
    const mailbox = item.accountId.slice("cloudflare:".length);
    const moved = await this.env.MAILBOX.get(this.env.MAILBOX.idFromName(mailbox)).markSpam([item.messageId], reason);
    return moved.length > 0;
  }

  /**
   * The spam check run again on one stored message (B-172, `check_spam`): the model's kind and reason,
   * from today's spam budget; nothing is moved or recorded. Null when the budget is spent.
   */
  async recheckSpam(input: SpamInput): Promise<SpamJudgement | null> {
    if (!this.spendSpam()) return null;
    return judgeSpam(this.spamModel(), input);
  }

  /** Today's spam screening, for the Spam rules screen (SP-6). */
  async spamStats(): Promise<{ used: number; limit: number; spamToday: number; screenedToday: number }> {
    const today = Date.parse(day() + "T00:00:00Z");
    const one = (q: string, ...p: (string | number)[]) => Number((this.sql.exec(q, ...p).one() as Row).n);
    return {
      used: one("SELECT COALESCE(MAX(calls), 0) AS n FROM spam_budget WHERE day = ?", day()),
      limit: this.dailySpamCalls(),
      spamToday: one("SELECT COUNT(*) AS n FROM spam_checks WHERE verdict = 'spam' AND checked_at >= ?", today),
      screenedToday: one("SELECT COUNT(*) AS n FROM spam_checks WHERE checked_at >= ?", today),
    };
  }

  // ── Projects ───────────────────────────────────────────────────

  async listProjects(): Promise<Project[]> {
    return (this.sql.exec("SELECT * FROM projects ORDER BY id").toArray() as Row[]).map((r) => this.projectRow(r))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  private projectRow(r: Row): Project {
    return { ...(JSON.parse(String(r.body)) as ProjectInput), id: String(r.id), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  async createProject(input: unknown): Promise<Project> {
    const parsed = ProjectInputSchema.safeParse(input);
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? msg("Invalid project"), "invalid");
    if (Number((this.sql.exec("SELECT COUNT(*) AS n FROM projects").one() as Row).n) >= MAX_PROJECTS) throw new CategoryError(msg("At most {max} projects", { max: MAX_PROJECTS }), "limit");
    const id = this.freeId("projects", categoryId(parsed.data.name).replace(/^category$/, "project"));
    const now = new Date().toISOString();
    this.sql.exec("INSERT INTO projects (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)", id, JSON.stringify(parsed.data), now, now);
    return this.projectRow(this.sql.exec("SELECT * FROM projects WHERE id = ?", id).one() as Row);
  }
  async updateProject(id: string, input: unknown): Promise<Project> {
    if (!this.sql.exec("SELECT 1 FROM projects WHERE id = ?", id).toArray().length) throw new CategoryError(msg("No such project"), "not_found");
    const parsed = ProjectInputSchema.safeParse(input);
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? msg("Invalid project"), "invalid");
    this.sql.exec("UPDATE projects SET body = ?, updated_at = ? WHERE id = ?", JSON.stringify(parsed.data), new Date().toISOString(), id);
    // What the project covers changed: categories built on it start over.
    for (const c of await this.categories()) if (c.scope.projects.includes(id) && c.kind === "screened") await this.restart(c);
    return this.projectRow(this.sql.exec("SELECT * FROM projects WHERE id = ?", id).one() as Row);
  }
  async deleteProject(id: string): Promise<boolean> {
    const users = (await this.categories()).filter((c) => c.scope.projects.includes(id)).map((c) => c.name);
    if (users.length) throw new CategoryError(msg("Used by {categories}. Take it out of those categories first.", { categories: users.join(", ") }), "conflict");
    return this.sql.exec("DELETE FROM projects WHERE id = ? RETURNING id", id).toArray().length > 0;
  }

  private freeId(table: "projects" | "categories", base: string): string {
    let id = base;
    for (let i = 2; this.sql.exec(`SELECT 1 FROM ${table} WHERE id = ?`, id).toArray().length; i++) id = `${base}-${i}`;
    return id;
  }

  // ── Categories ─────────────────────────────────────────────────

  private categoryRow(r: Row): Category {
    const input = JSON.parse(String(r.body)) as CategoryInput;
    return { ...input, id: String(r.id), kind: kindOf(input), version: Number(r.version), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  private async categories(): Promise<Category[]> {
    return (this.sql.exec("SELECT * FROM categories").toArray() as Row[]).map((r) => this.categoryRow(r));
  }

  async listCategories(): Promise<CategoryView[]> {
    const list = await this.categories();
    return list.sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, stats: this.stats(c) }));
  }
  async getCategory(id: string): Promise<CategoryView | null> {
    const r = this.sql.exec("SELECT * FROM categories WHERE id = ?", id).toArray()[0] as Row | undefined;
    if (!r) return null;
    const c = this.categoryRow(r);
    return { ...c, stats: this.stats(c) };
  }

  private stats(c: Category): CategoryStats {
    const seen = Number((this.sql.exec("SELECT seen_at FROM categories WHERE id = ?", c.id).one() as Row).seen_at);
    const one = (q: string, ...b: (string | number)[]) => Number((this.sql.exec(q, ...b).one() as Row).n);
    const pendingAll = one("SELECT COUNT(*) AS n FROM queue WHERE target IN ('*', ?)", c.id);
    const waitingBudget = one("SELECT COUNT(*) AS n FROM queue WHERE target IN ('*', ?) AND last_error = 'budget'", c.id);
    const bf = this.sql.exec("SELECT * FROM backfills WHERE category_id = ?", c.id).toArray()[0] as Row | undefined;
    return {
      matched: one("SELECT COUNT(*) AS n FROM verdicts WHERE category_id = ? AND version = ? AND matched = 1", c.id, c.version),
      fresh: one("SELECT COUNT(*) AS n FROM verdicts WHERE category_id = ? AND version = ? AND matched = 1 AND classified_at > ?", c.id, c.version, seen),
      classified: one("SELECT COUNT(*) AS n FROM verdicts WHERE category_id = ? AND version = ?", c.id, c.version)
        + one("SELECT COALESCE(SUM(pruned), 0) AS n FROM verdict_prunes WHERE category_id = ? AND version = ?", c.id, c.version),
      pending: c.kind === "screened" && c.enabled ? pendingAll : 0,
      errors: one("SELECT COUNT(*) AS n FROM verdicts WHERE category_id = ? AND version = ? AND source = 'error'", c.id, c.version),
      waitingBudget: c.kind === "screened" && c.enabled ? waitingBudget : 0,
      backfill: bf && Number(bf.version) === c.version
        ? { total: Number(bf.total), done: Number(bf.done), state: String(bf.state) as CategoryStats["backfill"]["state"], detail: String(bf.detail) }
        : { total: 0, done: 0, state: "idle", detail: "" },
    };
  }

  async createCategory(input: unknown): Promise<CategoryView> {
    const parsed = CategoryInputSchema.safeParse(input);
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? msg("Invalid category"), "invalid");
    await this.checkProjects(parsed.data);
    if (Number((this.sql.exec("SELECT COUNT(*) AS n FROM categories").one() as Row).n) >= MAX_CATEGORIES) throw new CategoryError(msg("At most {max} categories", { max: MAX_CATEGORIES }), "limit");
    const id = this.freeId("categories", categoryId(parsed.data.name));
    const now = new Date().toISOString();
    this.sql.exec("INSERT INTO categories (id, version, body, seen_at, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)", id, JSON.stringify(parsed.data), Date.now(), now, now);
    const c = (await this.getCategory(id))!;
    if (c.kind === "screened" && c.enabled) await this.startBackfill(c);
    return (await this.getCategory(id))!;
  }

  /** A change of what it selects starts over: new version, old verdicts dropped, a fresh first classification. */
  async updateCategory(id: string, input: unknown): Promise<CategoryView> {
    const current = await this.getCategory(id);
    if (!current) throw new CategoryError(msg("No such category"), "not_found");
    const parsed = CategoryInputSchema.safeParse(input);
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? msg("Invalid category"), "invalid");
    await this.checkProjects(parsed.data);
    const changed = selectionChanged(current, parsed.data) || (!current.enabled && parsed.data.enabled);
    this.sql.exec("UPDATE categories SET body = ?, version = version + ?, updated_at = ? WHERE id = ?",
      JSON.stringify(parsed.data), changed ? 1 : 0, new Date().toISOString(), id);
    const next = (await this.getCategory(id))!;
    if (changed) await this.restart(next);
    return (await this.getCategory(id))!;
  }

  private async restart(c: Category) {
    this.sql.exec("DELETE FROM verdicts WHERE category_id = ?", c.id);
    this.sql.exec("DELETE FROM verdict_prunes WHERE category_id = ?", c.id);
    this.sql.exec("DELETE FROM queue WHERE target = ?", c.id);
    this.sql.exec("DELETE FROM backfills WHERE category_id = ?", c.id);
    if (c.kind === "screened" && c.enabled) await this.startBackfill(c);
  }

  async deleteCategory(id: string): Promise<boolean> {
    const found = this.sql.exec("DELETE FROM categories WHERE id = ? RETURNING id", id).toArray().length > 0;
    if (found) {
      this.sql.exec("DELETE FROM verdicts WHERE category_id = ?", id);
      this.sql.exec("DELETE FROM verdict_prunes WHERE category_id = ?", id);
      this.sql.exec("DELETE FROM queue WHERE target = ?", id);
      this.sql.exec("DELETE FROM backfills WHERE category_id = ?", id);
    }
    return found;
  }

  /** Opening a category: what arrived until now is no longer "new". */
  async markSeen(id: string): Promise<void> {
    this.sql.exec("UPDATE categories SET seen_at = ? WHERE id = ?", Date.now(), id);
  }

  private async checkProjects(input: CategoryInput) {
    const known = new Set((await this.listProjects()).map((p) => p.id));
    const missing = input.scope.projects.filter((p) => !known.has(p));
    if (missing.length) throw new CategoryError(msg("No such project: {names}", { names: missing.join(", ") }), "invalid");
  }

  // ── Arrival and the queue ─────────────────────────────────────

  /**
   * A new message arrived (both providers call this through their incoming journal).
   * Idempotent by (account, message): a redelivery is a no-op. Nothing is queued when
   * no enabled screened category exists, so an idle workspace costs nothing.
   */
  async ingest(account: AccountRef, event: { id: string; sender: string; subject: string; body: string; html?: string; date: string; screen?: boolean; spam?: boolean;
    senderName?: string | null; verified?: string | null; replyTo?: string | null; files?: { id: string; filename: string; mimetype: string; size: number }[] }): Promise<void> {
    if (event.spam) return;
    const screened = (await this.categories()).filter((c) => c.enabled && c.kind === "screened");
    const projects = await this.listProjects();
    const screen = !!event.screen && account.id.startsWith("cloudflare:");
    // Without the AI binding the check is not set up here (a test, a partial deploy), as without this store.
    const safety = safetyOn(this.env) && !!this.env.AI;
    if (!screen && !safety && !screened.some((c) => inScope(c.scope, account, projects))) return;
    const item: QueueItem = {
      accountId: account.id, accountEmail: account.email, messageId: event.id, sender: event.sender ?? "", subject: event.subject ?? "",
      text: (stripHtmlToText(event.body ?? "") + linkLines(event.body ?? "")).slice(0, TEXT_CHARS), timestamp: Date.parse(event.date) || Date.now(),
      // C-5: a link or an image is something to judge, though stripping the HTML leaves no text of it.
      ...(screen ? { screen: true, senderName: event.senderName ?? null, verified: event.verified ?? null,
        ...(event.replyTo ? { replyTo: event.replyTo } : {}),
        ...(event.files?.length ? { attachments: event.files.slice(0, 10).map((f) => `${f.filename} (${f.mimetype})`) } : {}),
        ...(/\bhref\s*=|<img\b/i.test(event.body ?? "") ? { linked: true } : {}) } : {}),
      // A Cloudflare body is HTML already; an account's is its text, with its HTML beside it.
      ...(safety ? { safety: true, html: (event.html || (account.id.startsWith("cloudflare:") ? event.body : textToHtml(event.body ?? "")) || "").slice(0, HTML_CHARS),
        ...(event.files?.length ? { files: event.files.map((f) => ({ key: fileKey(account.id, event.id, f), filename: f.filename, mimetype: f.mimetype, size: f.size })) } : {}) } : {}),
    };
    this.enqueue(item, "*");
    await this.arm(500);
  }

  private enqueue(item: QueueItem, target: string) {
    this.sql.exec("INSERT OR IGNORE INTO queue (account_id, message_id, target, payload, enqueued_at, next_at) VALUES (?, ?, ?, ?, ?, ?)",
      item.accountId, item.messageId, target, JSON.stringify(item), Date.now(), Date.now());
  }
  private async arm(delay: number) {
    const next = Date.now() + delay;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    this.draining ??= this.drain().finally(() => { this.draining = undefined; });
    await this.draining;
  }

  private async drain() {
    try {
      const rows = this.sql.exec("SELECT * FROM queue WHERE next_at <= ? ORDER BY next_at, enqueued_at LIMIT ?", Date.now(), BATCH).toArray() as Row[];
      // C-13: one row of a message per drain; another (a backfill beside its arrival) waits for the next one, so it
      // sees the verdicts the first wrote and is never classified twice side by side.
      const taken = new Set<string>();
      const due = rows.filter((row) => { const key = `${row.account_id}|${row.message_id}`; if (taken.has(key)) return false; taken.add(key); return true; });
      for (let i = 0; i < due.length; i += CONCURRENCY)
        await Promise.all(due.slice(i, i + CONCURRENCY).map((row) => this.process(row).catch((error: unknown) => {
          // A failure outside the item's own handling: the item waits a minute, the queue goes on (reliability audit L1).
          console.error(JSON.stringify({ event: "category_item_failed", error: (error as Error)?.message?.slice(0, 200) }));
          this.sql.exec("UPDATE queue SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE account_id = ? AND message_id = ? AND target = ?",
            Date.now() + 60_000, ((error as Error)?.message ?? "failed").slice(0, 200), row.account_id, row.message_id, row.target);
        })));
      await this.advanceBackfills().catch((error: unknown) =>
        console.error(JSON.stringify({ event: "category_backfill_failed", error: (error as Error)?.message?.slice(0, 200) })));
      try { this.prune(); }
      catch (error) { console.error(JSON.stringify({ event: "category_prune_failed", error: (error as Error)?.message?.slice(0, 200) })); }
    } finally {
      // Whatever happened above, the queue wakes again for what is left.
      const next = this.sql.exec("SELECT MIN(next_at) AS t FROM queue").one() as Row;
      if (next.t !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 200, Number(next.t)));
    }
  }

  /** Decides the item, then lets its agent run once its spam check has answered (B-30). */
  private async process(row: Row) {
    await this.decide(row);
    const item = queued(row);
    if (!item.screen && !item.safety) return;
    // The agent answers once its spam check has answered (B-30) and its safety check let it through (B-178).
    const spamDone = !item.screen || this.sql.exec("SELECT 1 FROM spam_checks WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId).toArray().length > 0;
    const state = item.safety ? this.safetyState(item.accountId, item.messageId) : "clear";
    if (spamDone && state !== undefined && !isHeld(state)) await this.releaseAgent(item);
  }

  /** The agent of a message held for its checks may answer now: a Cloudflare address's, or an account's (B-178). Overridden in tests. */
  protected async releaseAgent(item: QueueItem): Promise<void> {
    if (!this.env.AGENT_REGISTRY) return;
    const mailbox = item.accountId.startsWith("cloudflare:") ? item.accountId.slice("cloudflare:".length) : item.accountId;
    await this.env.AGENT_REGISTRY.getByName("workspace").release(mailbox, item.messageId)
      .catch((error: unknown) => console.warn(JSON.stringify({ event: "agent_release_failed", error: (error as Error)?.message?.slice(0, 200) })));
  }

  /** Decides every category the item is owed; the item leaves the queue only when all are decided. */
  private async decide(row: Row) {
    const item = queued(row);
    const target = String(row.target);
    // B-178: the safety check comes first and never fails the item: what it cannot check it holds.
    if (item.safety && target === "*" && this.safetyState(item.accountId, item.messageId) === undefined) await this.checkSafety(item);
    const account: AccountRef = { id: item.accountId, email: item.accountEmail };
    const projects = await this.listProjects();
    const owed = (await this.categories()).filter((c) => c.enabled && c.kind === "screened" && (target === "*" || c.id === target)
      && inScope(c.scope, account, projects)
      && !this.sql.exec("SELECT 1 FROM verdicts WHERE category_id = ? AND version = ? AND account_id = ? AND message_id = ?", c.id, c.version, item.accountId, item.messageId).toArray().length);
    const now = Date.now();
    const decided: { c: Category; matched: boolean; reason: string; source: VerdictRow["source"] }[] = [];
    const forModel: Category[] = [];
    for (const c of owed) {
      const rule = matchesConditions(c.conditions, { sender: item.sender, subject: item.subject, text: item.text });
      if (!rule.ok) decided.push({ c, matched: false, reason: msg("Conditions did not match"), source: "rule" });
      else if (!c.description.trim()) decided.push({ c, matched: true, reason: rule.reason || msg("Matches the conditions"), source: "rule" });
      else forModel.push(c);
    }
    let spamOwed = !!item.screen && target === "*"
      && !this.sql.exec("SELECT 1 FROM spam_checks WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId).toArray().length;
    if (spamOwed && !item.linked && tooLittleToJudge(item.text)) {
      this.recordSpamCheck(item, "clean", msg("Too little text to judge"), now);
      spamOwed = false;
    }
    let modelError = "";
    // Spam first, on its own call and its own budget (B-172): a message the model moves to Spam
    // costs no categories' call. Over its budget spam is not judged, since the message already
    // sits in the inbox; a failed call is retried with the item, and given up it lets the agent run.
    let spam: { reason: string } | null = null;
    if (spamOwed) {
      if (!this.spendSpam()) {
        this.recordSpamCheck(item, "skipped", msg("The day's spam budget was spent"), now);
        spamOwed = false;
      } else {
        try {
          const j = await judgeSpam(this.spamModel(), { sender: item.sender, senderName: item.senderName ?? undefined, to: item.accountEmail,
            subject: item.subject, text: item.text, verified: item.verified ?? null, replyTo: item.replyTo ?? null, attachments: item.attachments ?? [] });
          console.log(JSON.stringify({ event: "spam_judged", account: item.accountId, kind: j.kind, spam: j.spam, verified: !!item.verified }));
          if (j.spam) spam = { reason: j.reason || msg("The model judged it spam") };
          else { this.recordSpamCheck(item, "clean", j.reason, now); spamOwed = false; }
        } catch (error) {
          modelError = (error as Error).message.slice(0, 200);
        }
      }
    }
    if (spam) {
      // In Spam it belongs to no category: its verdicts go, and the view never shows it.
      const moved = await this.moveToSpam(item, spam.reason).catch((error: unknown) => {
        console.warn(JSON.stringify({ event: "spam_move_failed", account: item.accountId, error: (error as Error).message }));
        return false;
      });
      this.recordSpamCheck(item, moved ? "spam" : "spam_not_moved", spam.reason, now);
      spamOwed = false;
      if (moved) {
        this.sql.exec("DELETE FROM verdicts WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId);
        this.sql.exec("DELETE FROM queue WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId);
        console.log(JSON.stringify({ event: "spam_by_model", account: item.accountId }));
        return;
      }
    }
    if (modelError) {
      // The spam call failed: the item waits its backoff, its model categories asked again with it; what
      // the conditions alone decided is filed now, so a spam model that keeps failing never loses it.
      this.writeVerdicts(item, decided, now);
      this.retryOrGiveUp(row, item, target, forModel, spamOwed, modelError, now);
      return;
    }
    const categoriesPaid = forModel.length ? this.spend() : false;
    if (forModel.length && categoriesPaid) {
      try {
        const verdicts = await classify(this.model(), forModel.map<DescribedCategory>((c) => ({ id: c.id, name: c.name, description: c.description })),
          { sender: item.sender, subject: item.subject, text: item.text, to: item.accountEmail });
        for (const v of verdicts) {
          const c = forModel.find((x) => x.id === v.id)!;
          decided.push({ c, matched: v.match, reason: v.reason || (v.match ? msg("The model placed it here") : msg("The model left it out")), source: "model" });
        }
      } catch (error) {
        modelError = (error as Error).message.slice(0, 200);
      }
    }
    if (forModel.length && !categoriesPaid) {
      // Spam was judged (or skipped) on its own budget; the categories wait for tomorrow's.
      this.writeVerdicts(item, decided, now);
      this.sql.exec("UPDATE queue SET next_at = ?, last_error = 'budget', payload = ? WHERE account_id = ? AND message_id = ? AND target = ?",
        nextDay(), JSON.stringify({ ...item, screen: false }), item.accountId, item.messageId, target);
      return;
    }
    this.writeVerdicts(item, decided, now);
    if (!modelError) {
      this.sql.exec("DELETE FROM queue WHERE account_id = ? AND message_id = ? AND target = ?", item.accountId, item.messageId, target);
      return;
    }
    this.retryOrGiveUp(row, item, target, forModel, spamOwed, modelError, now);
  }

  /** A model call failed: the item waits its backoff, or after MAX_ATTEMPTS is given up, said on each category and on the spam check. */
  private retryOrGiveUp(row: Row, item: QueueItem, target: string, forModel: Category[], spamOwed: boolean, modelError: string, now: number) {
    const attempts = Number(row.attempts) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Given up: said on the category, never silently dropped; a spam check given up lets the agent run.
      this.writeVerdicts(item, forModel.map((c) => ({ c, matched: false, reason: msg("Could not classify: {error}", { error: String(modelError) }), source: "error" as const })), now);
      if (spamOwed) this.recordSpamCheck(item, "error", msg("Could not be judged: {error}", { error: String(modelError) }), now);
      this.sql.exec("DELETE FROM queue WHERE account_id = ? AND message_id = ? AND target = ?", item.accountId, item.messageId, target);
      console.error(JSON.stringify({ event: "category_classify_gave_up", account: item.accountId, error: modelError }));
    } else {
      this.sql.exec("UPDATE queue SET attempts = ?, next_at = ?, last_error = ? WHERE account_id = ? AND message_id = ? AND target = ?",
        attempts, now + 60_000 * 2 ** attempts, modelError, item.accountId, item.messageId, target);
    }
  }

  private writeVerdicts(item: QueueItem, decided: { c: Category; matched: boolean; reason: string; source: VerdictRow["source"] }[], now: number) {
    for (const d of decided)
      this.sql.exec(
        `INSERT OR REPLACE INTO verdicts (category_id, version, account_id, message_id, matched, reason, source, timestamp, subject, sender, classified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.c.id, d.c.version, item.accountId, item.messageId, d.matched ? 1 : 0, d.reason.slice(0, 300), d.source, item.timestamp,
        item.subject.slice(0, 300), item.sender.slice(0, 300), now);
  }

  private recordSpamCheck(item: QueueItem, verdict: string, reason: string, now: number) {
    this.sql.exec("INSERT OR REPLACE INTO spam_checks (account_id, message_id, verdict, reason, checked_at) VALUES (?, ?, ?, ?, ?)",
      item.accountId, item.messageId, verdict, reason.slice(0, 300), now);
    this.sql.exec("DELETE FROM spam_checks WHERE checked_at < ?", now - 90 * 86_400_000);
  }

  // ── Safety (B-178) ─────────────────────────────────────────────

  private safetyState(accountId: string, messageId: string): SafetyState | undefined {
    const row = this.sql.exec("SELECT state FROM safety WHERE account_id = ? AND message_id = ?", accountId, messageId).toArray()[0] as Row | undefined;
    return row ? (String(row.state) as SafetyState) : undefined;
  }

  /** One call from today's safety budget; false when it is spent. */
  private spendSafety(): boolean {
    const today = day();
    const used = Number((this.sql.exec("SELECT COALESCE(MAX(calls), 0) AS n FROM safety_budget WHERE day = ?", today).one() as Row).n);
    if (used >= this.dailySafetyCalls()) return false;
    this.sql.exec("INSERT INTO safety_budget (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1", today);
    this.sql.exec("DELETE FROM safety_budget WHERE day < ?", day(Date.now() - 30 * 86_400_000));
    return true;
  }

  /**
   * B-179: a file's bytes: a Cloudflare message's from R2, an account's from its provider through the accounts object
   * (the key names the account, the message and the attachment). Null when it cannot be read: the file is then named
   * as unread, never passed as read.
   */
  protected async fileBytes(key: string): Promise<Blob | null> {
    const remote = parseAccountFileKey(key);
    if (!remote) return (await this.env.BUCKET?.get(key))?.blob() ?? null;
    const accounts = this.env.GMAIL_ACCOUNTS?.getByName("workspace") as unknown as
      { getAttachment(accountId: string, messageId: string, attachmentId: string): Promise<{ data: string }> } | undefined;
    if (!accounts) return null;
    const { data } = await accounts.getAttachment(remote.accountId.slice(remote.accountId.indexOf(":") + 1), remote.messageId, remote.attachmentId);
    const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    return new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))]);
  }

  /** Checks one arriving message, reviews it when suspect, and records where it stands. */
  private async checkSafety(item: QueueItem): Promise<void> {
    const now = Date.now();
    // B-179: what its files say, read before the check so their text is checked with the body.
    const files = item.files?.length ? await readFiles(item.files, (key) => this.fileBytes(key), this.toText()).catch(() => null) : null;
    const findings = await inspectMessage({ subject: item.subject, html: item.html ?? "", files: files?.text ?? "" }, (text) =>
      this.spendSafety() ? this.safetyScan(text) : Promise.resolve({ flagged: false, error: msg("The day's safety budget was spent") }));
    if (files?.risky.length) findings.riskyFiles = files.risky;
    if (files?.unread.length) findings.unreadFiles = files.unread;
    // B-180: its links against the server's copy of the Okolos phishing feed, and for hosts imitating a known name.
    const links = linksOf(item.html ?? "");
    const lookalikes = lookalikeLinks(links, (this.env.DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean));
    if (lookalikes.length) findings.lookalikes = lookalikes;
    const feed = await this.phishingFeed(now).catch(() => null);
    if (!feed) findings.feed = "missing";
    else {
      if (now - feed.fetchedAt > FEED_STALE_MS) findings.feed = "stale";
      const phishing = phishingLinks(links, feed.snapshot);
      if (phishing.length) findings.phishing = phishing;
    }
    let state: SafetyState = "clear";
    let reason = "";
    let review: SafetyReview | null = null;
    if (suspect(findings)) {
      state = "held";
      reason = findings.phishing?.length ? msg("Links to a known phishing site: {hosts}", { hosts: findings.phishing.map((p) => p.host).join(", ") })
        : findings.riskyFiles?.length ? msg("Carries a file that runs code: {files}", { files: findings.riskyFiles.join(", ") })
        : findings.lookalikes?.length ? msg("Links to a site imitating {names}: {hosts}", {
          names: [...new Set(findings.lookalikes.map((l) => l.resembles))].join(", "), hosts: findings.lookalikes.map((l) => l.host).join(", ") })
        : findings.fileSignals?.length ? msg("An attached file gives orders to an AI")
        : findings.modelError ? msg("Not checked: {error}", { error: findings.modelError })
        : findings.hiddenSignals.length ? msg("Hidden text addresses an AI")
        : findings.visibleStrong.length ? msg("The text gives orders to an AI")
        : msg("The safety model found instructions aimed at an AI");
      // A listed phishing site is the feed's verdict: no review releases it (a person still can).
      if (!findings.modelError && !findings.phishing?.length && !findings.riskyFiles?.length && this.spendSafety()) {
        try {
          const { model, name } = this.reviewModel();
          review = await reviewHeld(model, name, { sender: item.sender, to: item.accountEmail, subject: item.subject,
            visible: splitHidden(item.html ?? "").visible, findings });
          if (review.verdict === "safe") { state = "released"; reason = msg("Reviewed: nothing aimed at an AI"); }
        } catch (error) {
          reason = msg("{reason}; the review could not run", { reason });
          console.warn(JSON.stringify({ event: "safety_review_failed", account: item.accountId, error: (error as Error)?.message?.slice(0, 200) }));
        }
      }
      console.log(JSON.stringify({ event: "safety_held", account: item.accountId, state, verdict: review?.verdict ?? null,
        hidden: findings.hiddenSignals, visible: findings.visibleStrong, model: findings.model, unchecked: !!findings.modelError }));
    }
    this.sql.exec(`INSERT OR REPLACE INTO safety (account_id, message_id, state, findings, review, reason, checked_at, decided_by, decided_at, timestamp, subject, sender)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.accountId, item.messageId, state, JSON.stringify(findings), review ? JSON.stringify(review) : null, reason.slice(0, 300), now,
      review ? "review" : "check", now, item.timestamp, item.subject.slice(0, 300), item.sender.slice(0, 300));
    this.sql.exec("DELETE FROM safety WHERE checked_at < ? AND state = 'clear'", now - 90 * 86_400_000);
  }

  /** Where these messages stand with the safety check (B-178); a message never checked is absent. */
  async safetyOf(keys: { accountId: string; messageId: string }[]): Promise<Record<string, SafetyRecord>> {
    const out: Record<string, SafetyRecord> = {};
    for (const k of keys.slice(0, 200)) {
      const row = this.sql.exec("SELECT * FROM safety WHERE account_id = ? AND message_id = ?", k.accountId, k.messageId).toArray()[0] as Row | undefined;
      if (row) out[safetyKey(k.accountId, k.messageId)] = {
        state: String(row.state) as SafetyState, reason: String(row.reason), findings: JSON.parse(String(row.findings)) as SafetyFindings,
        review: row.review ? JSON.parse(String(row.review)) as SafetyReview : null, checkedAt: Number(row.checked_at), decidedBy: String(row.decided_by),
        decidedAt: Number(row.decided_at), subject: String(row.subject), sender: String(row.sender), timestamp: Number(row.timestamp),
      };
    }
    return out;
  }

  /** The held messages, newest first (B-178). */
  async heldMessages(limit = 100): Promise<{ accountId: string; messageId: string; state: SafetyState; reason: string; subject: string; sender: string; timestamp: number }[]> {
    return (this.sql.exec("SELECT account_id, message_id, state, reason, subject, sender, timestamp FROM safety WHERE state IN ('held', 'kept') ORDER BY timestamp DESC LIMIT ?",
      Math.min(500, Math.max(1, limit))).toArray() as Row[]).map((r) => ({ accountId: String(r.account_id), messageId: String(r.message_id), state: String(r.state) as SafetyState,
      reason: String(r.reason), subject: String(r.subject), sender: String(r.sender), timestamp: Number(r.timestamp) }));
  }

  /**
   * A person (or the owner's approved agent) decides a held message (B-178): `release` lets it through and wakes its
   * reply agent; `keep` keeps it held. Null when the message was never held.
   */
  async decideHeld(key: { accountId: string; messageId: string }, action: "release" | "keep", by: string): Promise<SafetyState | null> {
    const state = this.safetyState(key.accountId, key.messageId);
    if (!state || state === "clear") return null;
    const next: SafetyState = action === "release" ? "released" : "kept";
    this.sql.exec("UPDATE safety SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE account_id = ? AND message_id = ?", next, by.slice(0, 120), Date.now(),
      action === "release" ? msg("Released by a person") : msg("Kept held by a person"), key.accountId, key.messageId);
    if (next === "released") await this.releaseAgent({ accountId: key.accountId, accountEmail: "", messageId: key.messageId, sender: "", subject: "", text: "", timestamp: 0 });
    return next;
  }

  /** One spam-only model call from today's spam budget; false when it is spent. */
  private spendSpam(): boolean {
    const today = day();
    const used = Number((this.sql.exec("SELECT COALESCE(MAX(calls), 0) AS n FROM spam_budget WHERE day = ?", today).one() as Row).n);
    if (used >= this.dailySpamCalls()) return false;
    this.sql.exec("INSERT INTO spam_budget (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1", today);
    this.sql.exec("DELETE FROM spam_budget WHERE day < ?", day(Date.now() - 30 * 86_400_000));
    return true;
  }

  /** One model call from today's budget; false when it is spent. */
  private spend(): boolean {
    const today = day();
    const used = Number((this.sql.exec("SELECT COALESCE(MAX(calls), 0) AS n FROM budget WHERE day = ?", today).one() as Row).n);
    if (used >= this.dailyCalls()) return false;
    this.sql.exec("INSERT INTO budget (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1", today);
    this.sql.exec("DELETE FROM budget WHERE day < ?", day(Date.now() - 30 * 86_400_000));
    return true;
  }

  // ── First classification of existing mail (CAT-4) ─────────────

  /** Queues the last BACKFILL_MESSAGES messages in the category's scope; progress is counted as they are decided. */
  private async startBackfill(c: Category) {
    const now = Date.now();
    this.sql.exec("INSERT OR REPLACE INTO backfills (category_id, version, total, done, state, detail, updated_at) VALUES (?, ?, 0, 0, 'running', ?, ?)",
      c.id, c.version, msg("Collecting messages"), now);
    let items: QueueItem[];
    try { items = await this.recentMessages(c); }
    catch (error) {
      this.sql.exec("UPDATE backfills SET state = 'failed', detail = ?, updated_at = ? WHERE category_id = ?",
        msg("Could not read the mail in scope: {error}", { error: (error as Error).message.slice(0, 200) }), Date.now(), c.id);
      return;
    }
    for (const item of items) this.enqueue(item, c.id);
    this.sql.exec("UPDATE backfills SET total = ?, state = ?, detail = ? WHERE category_id = ?",
      items.length, items.length ? "running" : "done", items.length ? "" : msg("No mail in scope yet"), c.id);
    await this.arm(200);
  }

  /** Recent inbox messages of the scope, newest first, with their text. Overridden in tests. */
  protected async recentMessages(c: Category): Promise<QueueItem[]> {
    const projects = await this.listProjects();
    const sources = inboxSources(this.env);
    const found: InboxMessage[] = [];
    let cursor = "";
    const emails = new Map<string, string>();
    for (let page = 0; page < Math.ceil(BACKFILL_MESSAGES / 100) && found.length < BACKFILL_MESSAGES; page++) {
      const params = new URLSearchParams({ folder: "inbox", limit: "100", ...(cursor ? { cursor } : {}) });
      const r = await readInbox(params, sources, { accounts: { key: `category:${c.id}:${c.version}`, accept: (a) => inScope(c.scope, a, projects) } });
      for (const a of r.accounts) emails.set(a.id, a.email);
      found.push(...r.messages);
      if (!r.hasMore || !r.cursor) break;
      cursor = r.cursor;
    }
    const out: QueueItem[] = [];
    for (const m of found.slice(0, BACKFILL_MESSAGES)) {
      out.push({ accountId: m.accountId, accountEmail: emails.get(m.accountId) ?? "", messageId: m.providerMessageId,
        sender: m.sender, subject: m.subject, text: await this.bodyOf(m).catch(() => m.snippet), timestamp: m.timestamp });
    }
    return out;
  }

  private async bodyOf(m: InboxMessage): Promise<string> {
    if (m.provider === "cloudflare") {
      const email = await this.env.MAILBOX.get(this.env.MAILBOX.idFromName(m.accountId.slice(11))).getEmail(m.providerMessageId);
      return stripHtmlToText(email?.body ?? m.snippet).slice(0, TEXT_CHARS);
    }
    // A Gmail or IMAP account: "<provider>:<id>", where the prefix's length differs by provider.
    const remote = parseRemoteAccount(m.accountId);
    if (!remote) return m.snippet.slice(0, TEXT_CHARS);
    const full = await this.env.GMAIL_ACCOUNTS.getByName("workspace").getMessage(remote.id, m.providerMessageId) as { text?: string; html?: string };
    return (full.text || stripHtmlToText(full.html ?? "") || m.snippet).slice(0, TEXT_CHARS);
  }

  private async advanceBackfills() {
    for (const b of this.sql.exec("SELECT * FROM backfills WHERE state = 'running'").toArray() as Row[]) {
      const left = Number((this.sql.exec("SELECT COUNT(*) AS n FROM queue WHERE target = ?", b.category_id).one() as Row).n);
      const done = Math.max(0, Number(b.total) - left);
      const waiting = Number((this.sql.exec("SELECT COUNT(*) AS n FROM queue WHERE target = ? AND last_error = 'budget'", b.category_id).one() as Row).n);
      this.sql.exec("UPDATE backfills SET done = ?, state = ?, detail = ?, updated_at = ? WHERE category_id = ?",
        done, left === 0 ? "done" : "running", waiting ? msg("{n} wait for tomorrow's model budget", { n: waiting }) : "", Date.now(), b.category_id);
    }
  }

  /**
   * Deletes up to PRUNE_BATCH unmatched verdicts and as many spam answers older than VERDICT_RETENTION_MS
   * (B-92), at most hourly unless the last pass found a full batch. Each category's pruned count is kept
   * for its current version, so its "classified" figure does not shrink. Returns how many verdicts went.
   */
  protected prune(now = Date.now(), force = false): number {
    if (!force && now - this.prunedAt < PRUNE_EVERY_MS) return 0;
    this.prunedAt = now;
    const cutoff = now - VERDICT_RETENTION_MS;
    const gone = this.sql.exec(`DELETE FROM verdicts WHERE rowid IN (SELECT rowid FROM verdicts WHERE matched = 0 AND source != 'error' AND classified_at < ? LIMIT ?)
      RETURNING category_id, version`, cutoff, PRUNE_BATCH).toArray() as Row[];
    const counts = new Map<string, { version: number; n: number }>();
    for (const r of gone) {
      const key = String(r.category_id);
      const at = counts.get(key);
      if (at && at.version === Number(r.version)) at.n++;
      else counts.set(key, { version: Number(r.version), n: 1 });
    }
    for (const [id, { version, n }] of counts)
      this.sql.exec(`INSERT INTO verdict_prunes (category_id, version, pruned) VALUES (?, ?, ?) ON CONFLICT(category_id) DO UPDATE SET
        pruned = CASE WHEN version = excluded.version THEN pruned + excluded.pruned ELSE excluded.pruned END, version = excluded.version`, id, version, n);
    // Counted from RETURNING: rowsWritten also counts the index rows a delete touches.
    const spam = this.sql.exec("DELETE FROM spam_checks WHERE rowid IN (SELECT rowid FROM spam_checks WHERE checked_at < ? LIMIT ?) RETURNING 1", cutoff, PRUNE_BATCH).toArray().length;
    // B-26: verdicts parked when their message left the view, kept as long as Trash keeps the message.
    this.sql.exec("DELETE FROM verdicts_parked WHERE rowid IN (SELECT rowid FROM verdicts_parked WHERE parked_at < ? LIMIT ?)", cutoff, PRUNE_BATCH);
    // A full batch means more is waiting: the next drain goes on rather than an hour later.
    if (gone.length >= PRUNE_BATCH || spam >= PRUNE_BATCH) this.prunedAt = 0;
    if (gone.length || spam) console.log(JSON.stringify({ event: "category_verdicts_pruned", verdicts: gone.length, spamChecks: spam }));
    return gone.length;
  }

  // ── Reads for the feed (CAT-5) ────────────────────────────────

  /** Matched messages of a screened category, newest first, after `before`. */
  async page(id: string, before: { timestamp: number; accountId: string; messageId: string } | null, limit: number): Promise<PageRow[]> {
    const c = await this.getCategory(id);
    if (!c) throw new CategoryError(msg("No such category"), "not_found");
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = (before
      ? this.sql.exec(`SELECT account_id, message_id, timestamp, reason, source FROM verdicts
          WHERE category_id = ? AND version = ? AND matched = 1
            AND (timestamp < ? OR (timestamp = ? AND (account_id > ? OR (account_id = ? AND message_id > ?))))
          ORDER BY timestamp DESC, account_id, message_id LIMIT ?`,
          id, c.version, before.timestamp, before.timestamp, before.accountId, before.accountId, before.messageId, n)
      : this.sql.exec(`SELECT account_id, message_id, timestamp, reason, source FROM verdicts
          WHERE category_id = ? AND version = ? AND matched = 1 ORDER BY timestamp DESC, account_id, message_id LIMIT ?`, id, c.version, n)
    ).toArray() as Row[];
    return rows.map((r) => ({ accountId: String(r.account_id), messageId: String(r.message_id), timestamp: Number(r.timestamp), reason: String(r.reason), source: String(r.source) }));
  }

  /**
   * A message gone from the view (to Trash, or deleted) leaves its categories. Its verdicts are parked,
   * not dropped (B-26): restoring it puts them back, and parked ones go after the retention window.
   */
  async forget(keys: { accountId: string; messageId: string }[], now = Date.now()): Promise<void> {
    for (const k of keys.slice(0, 200)) this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT OR REPLACE INTO verdicts_parked (category_id, version, account_id, message_id, matched, reason, source, timestamp,
          subject, sender, classified_at, parked_at)
        SELECT category_id, version, account_id, message_id, matched, reason, source, timestamp, subject, sender, classified_at, ?
        FROM verdicts WHERE account_id = ? AND message_id = ?`, now, k.accountId, k.messageId);
      this.sql.exec("DELETE FROM verdicts WHERE account_id = ? AND message_id = ?", k.accountId, k.messageId);
    });
  }

  /**
   * A message back from Trash returns to the categories it was in (B-26), without the model. `accountIds`
   * are the keys it may be filed under (a remote account's provider prefix is not known to every caller).
   * Found by its id; a message whose id changed on the move (IMAP) is found by its date, subject and
   * sender, and filed under its new id. Only verdicts of a category's current version come back.
   * Answers how many verdicts were restored.
   */
  /**
   * B-27: an address renamed keeping its mail keeps its category labels and spam checks: every row of
   * the old account moves to the new one. A row the new account already has is kept (a repeat changes
   * nothing). Answers how many rows moved.
   */
  async moveAccount(from: string, to: string): Promise<number> {
    let moved = 0;
    this.ctx.storage.transactionSync(() => {
      // A queued item carries its account in its payload too: decided under the old one, its row would never leave.
      this.sql.exec("UPDATE queue SET payload = json_set(payload, '$.accountId', ?, '$.accountEmail', ?) WHERE account_id = ?",
        to, to.startsWith("cloudflare:") ? to.slice("cloudflare:".length) : to, from);
      for (const table of ["verdicts", "verdicts_parked", "queue", "spam_checks", "safety"]) {
        moved += this.sql.exec(`UPDATE OR IGNORE ${table} SET account_id = ? WHERE account_id = ?`, to, from).rowsWritten;
        this.sql.exec(`DELETE FROM ${table} WHERE account_id = ?`, from);
      }
    });
    return moved;
  }

  /**
   * B-158 M1 step 3b part 2: an account's labels read out to another server, page by page (rowid order). The
   * categories its verdicts name come with the first call, so the receiving server can tell whether its own
   * category of that id selects the same mail. Work still queued is not carried: the receiving server classifies
   * what arrives there.
   */
  async exportLabels(accountId: string, table: string, after: number, limit: number): Promise<{ rows: Row[]; next: number | null }> {
    const columns = LABEL_COLUMNS[table];
    if (!columns) throw new CategoryError(msg("Choose a table: {tables}", { tables: Object.keys(LABEL_COLUMNS).join(", ") }), "invalid");
    const rows = this.sql.exec(`SELECT rowid AS r, ${columns.join(", ")} FROM ${table} WHERE account_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
      accountId, after, limit + 1).toArray() as Row[];
    const page = rows.slice(0, limit);
    return { rows: page.map(({ r: _r, account_id: _a, ...row }) => row), next: rows.length > limit ? Number(page[page.length - 1].r) : null };
  }

  async labelCategories(accountId: string): Promise<{ id: string; version: number; name: string; description: string; conditions: unknown }[]> {
    const ids = new Set((this.sql.exec("SELECT DISTINCT category_id FROM verdicts WHERE account_id = ?", accountId).toArray() as Row[]).map((r) => String(r.category_id)));
    return (await this.categories()).filter((c) => ids.has(c.id))
      .map((c) => ({ id: c.id, version: c.version, name: c.name, description: c.description, conditions: c.conditions }));
  }

  /**
   * The receiving side. A verdict is kept only for a category here with the same id that selects the same mail (its
   * description and conditions), filed under this server's version of it; the others are skipped, since a verdict
   * counts only for its category's version. A row already here is kept, so a repeat changes nothing.
   */
  async importLabels(accountId: string, table: string, rows: Row[], sources: { id: string; version: number; description: string; conditions: unknown }[]):
    Promise<{ written: number; skipped: number }> {
    const columns = LABEL_COLUMNS[table];
    if (!columns) throw new CategoryError(msg("Choose a table: {tables}", { tables: Object.keys(LABEL_COLUMNS).join(", ") }), "invalid");
    const here = new Map((await this.categories()).map((c) => [c.id, c]));
    const versions = new Map<string, Map<number, number>>();
    for (const s of sources) {
      const c = here.get(s.id);
      if (!c || c.description.trim() !== String(s.description ?? "").trim() || JSON.stringify(c.conditions) !== JSON.stringify(s.conditions)) continue;
      versions.set(s.id, (versions.get(s.id) ?? new Map()).set(Number(s.version), c.version));
    }
    let written = 0, skipped = 0;
    this.ctx.storage.transactionSync(() => {
      for (const row of rows.slice(0, 500)) {
        const values: Row = { ...row, account_id: accountId };
        if (table === "verdicts") {
          const version = versions.get(String(row.category_id))?.get(Number(row.version));
          if (version === undefined) { skipped++; continue; }
          values.version = version;
        }
        const list = columns.map((c) => values[c] ?? null);
        this.sql.exec(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...list);
        // rowsWritten also counts index entries; changes() is the rows this insert added.
        written += Number((this.sql.exec("SELECT changes() AS n").one() as Row).n);
      }
    });
    return { written, skipped };
  }

  async restore(item: { accountIds: string[]; messageId: string; newMessageId?: string; timestamp?: number; subject?: string; sender?: string }): Promise<number> {
    const current = new Map((this.sql.exec("SELECT id, version FROM categories").toArray() as Row[]).map((r) => [String(r.id), Number(r.version)]));
    let restored = 0;
    for (const accountId of item.accountIds.slice(0, 5)) this.ctx.storage.transactionSync(() => {
      let rows = this.sql.exec("SELECT * FROM verdicts_parked WHERE account_id = ? AND message_id = ?", accountId, item.messageId).toArray() as Row[];
      if (!rows.length && typeof item.timestamp === "number" && item.subject !== undefined && item.sender !== undefined)
        rows = this.sql.exec("SELECT * FROM verdicts_parked WHERE account_id = ? AND timestamp = ? AND subject = ? AND sender = ?",
          accountId, item.timestamp, item.subject.slice(0, 300), item.sender.slice(0, 300)).toArray() as Row[];
      const id = item.newMessageId || item.messageId;
      for (const r of rows) {
        this.sql.exec("DELETE FROM verdicts_parked WHERE category_id = ? AND account_id = ? AND message_id = ?", r.category_id, r.account_id, r.message_id);
        if (current.get(String(r.category_id)) !== Number(r.version)) continue;
        this.sql.exec(`INSERT OR IGNORE INTO verdicts (category_id, version, account_id, message_id, matched, reason, source, timestamp, subject, sender, classified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.category_id, r.version, accountId, id, r.matched, r.reason, r.source, r.timestamp, r.subject, r.sender, r.classified_at);
        restored++;
      }
    });
    if (restored) console.log(JSON.stringify({ event: "category_verdicts_restored", verdicts: restored }));
    return restored;
  }

  /** For a page of the feed: which enabled categories each message is in (current versions only). */
  async membership(keys: { accountId: string; messageId: string }[]): Promise<Record<string, { id: string; name: string; promote: boolean; reason: string }[]>> {
    const cats = new Map((await this.categories()).filter((c) => c.enabled && c.kind === "screened").map((c) => [c.id, c]));
    const out: Record<string, { id: string; name: string; promote: boolean; reason: string }[]> = {};
    if (!cats.size) return out;
    for (const k of keys.slice(0, 100)) {
      const rows = this.sql.exec("SELECT category_id, version, reason FROM verdicts WHERE account_id = ? AND message_id = ? AND matched = 1", k.accountId, k.messageId).toArray() as Row[];
      const hits = rows.flatMap((r) => {
        const c = cats.get(String(r.category_id));
        return c && c.version === Number(r.version) ? [{ id: c.id, name: c.name, promote: c.promote, reason: String(r.reason) }] : [];
      });
      if (hits.length) out[JSON.stringify([k.accountId, k.messageId])] = hits;
    }
    return out;
  }
}
