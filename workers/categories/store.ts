import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { CATEGORIES_STEPS } from "./schema";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { Env } from "../types";
import type { InboxMessage } from "../../shared/mail/inbox";
import { stripHtmlToText } from "../lib/email-helpers";
import { readInbox } from "../routes/inbox";
import { inboxSources } from "../lib/inbox-sources";
import {
  CategoryInputSchema, ProjectInputSchema, categoryId, inScope, kindOf, matchesConditions, selectionChanged,
  type AccountRef, type Category, type CategoryInput, type Project, type ProjectInput,
} from "./definition";
import { classify, DEFAULT_CATEGORY_MODEL, SPAM_CATEGORY, SPAM_ID, type DescribedCategory } from "./classify";
import { tooLittleToJudge } from "../../shared/mail/spam";
import { parseRemoteAccount } from "../../shared/mail/accounts";

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
  screen?: boolean }
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
export const DEFAULT_SPAM_DAILY_CALLS = 300;
type Row = Record<string, string | number | null>;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const nextDay = (t = Date.now()) => Date.parse(day(t) + "T00:00:00Z") + 86_400_000 + 5 * 60_000;

export class CategoriesDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private draining: Promise<void> | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrateSchema(ctx.storage, CATEGORIES_STEPS, "CategoriesDO");
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
  /** Moves a message the model judged spam (SP-2). Overridden in tests. */
  protected async moveToSpam(item: QueueItem, reason: string): Promise<boolean> {
    if (!item.accountId.startsWith("cloudflare:")) return false;
    const mailbox = item.accountId.slice("cloudflare:".length);
    const moved = await this.env.MAILBOX.get(this.env.MAILBOX.idFromName(mailbox)).markSpam([item.messageId], reason);
    return moved.length > 0;
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
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? "Invalid project", "invalid");
    if (Number((this.sql.exec("SELECT COUNT(*) AS n FROM projects").one() as Row).n) >= MAX_PROJECTS) throw new CategoryError(`At most ${MAX_PROJECTS} projects`, "limit");
    const id = this.freeId("projects", categoryId(parsed.data.name).replace(/^category$/, "project"));
    const now = new Date().toISOString();
    this.sql.exec("INSERT INTO projects (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)", id, JSON.stringify(parsed.data), now, now);
    return this.projectRow(this.sql.exec("SELECT * FROM projects WHERE id = ?", id).one() as Row);
  }
  async updateProject(id: string, input: unknown): Promise<Project> {
    if (!this.sql.exec("SELECT 1 FROM projects WHERE id = ?", id).toArray().length) throw new CategoryError("No such project", "not_found");
    const parsed = ProjectInputSchema.safeParse(input);
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? "Invalid project", "invalid");
    this.sql.exec("UPDATE projects SET body = ?, updated_at = ? WHERE id = ?", JSON.stringify(parsed.data), new Date().toISOString(), id);
    // What the project covers changed: categories built on it start over.
    for (const c of await this.categories()) if (c.scope.projects.includes(id) && c.kind === "screened") await this.restart(c);
    return this.projectRow(this.sql.exec("SELECT * FROM projects WHERE id = ?", id).one() as Row);
  }
  async deleteProject(id: string): Promise<boolean> {
    const users = (await this.categories()).filter((c) => c.scope.projects.includes(id)).map((c) => c.name);
    if (users.length) throw new CategoryError(`Used by ${users.join(", ")}. Take it out of those categories first.`, "conflict");
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
      classified: one("SELECT COUNT(*) AS n FROM verdicts WHERE category_id = ? AND version = ?", c.id, c.version),
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
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? "Invalid category", "invalid");
    await this.checkProjects(parsed.data);
    if (Number((this.sql.exec("SELECT COUNT(*) AS n FROM categories").one() as Row).n) >= MAX_CATEGORIES) throw new CategoryError(`At most ${MAX_CATEGORIES} categories`, "limit");
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
    if (!current) throw new CategoryError("No such category", "not_found");
    const parsed = CategoryInputSchema.safeParse(input);
    if (!parsed.success) throw new CategoryError(parsed.error.issues[0]?.message ?? "Invalid category", "invalid");
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
    this.sql.exec("DELETE FROM queue WHERE target = ?", c.id);
    this.sql.exec("DELETE FROM backfills WHERE category_id = ?", c.id);
    if (c.kind === "screened" && c.enabled) await this.startBackfill(c);
  }

  async deleteCategory(id: string): Promise<boolean> {
    const found = this.sql.exec("DELETE FROM categories WHERE id = ? RETURNING id", id).toArray().length > 0;
    if (found) {
      this.sql.exec("DELETE FROM verdicts WHERE category_id = ?", id);
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
    if (missing.length) throw new CategoryError(`No such project: ${missing.join(", ")}`, "invalid");
  }

  // ── Arrival and the queue ─────────────────────────────────────

  /**
   * A new message arrived (both providers call this through their incoming journal).
   * Idempotent by (account, message): a redelivery is a no-op. Nothing is queued when
   * no enabled screened category exists, so an idle workspace costs nothing.
   */
  async ingest(account: AccountRef, event: { id: string; sender: string; subject: string; body: string; date: string; screen?: boolean; spam?: boolean }): Promise<void> {
    if (event.spam) return;
    const screened = (await this.categories()).filter((c) => c.enabled && c.kind === "screened");
    const projects = await this.listProjects();
    const screen = !!event.screen && account.id.startsWith("cloudflare:");
    if (!screen && !screened.some((c) => inScope(c.scope, account, projects))) return;
    const item: QueueItem = {
      accountId: account.id, accountEmail: account.email, messageId: event.id, sender: event.sender ?? "", subject: event.subject ?? "",
      text: stripHtmlToText(event.body ?? "").slice(0, TEXT_CHARS), timestamp: Date.parse(event.date) || Date.now(),
      ...(screen ? { screen: true } : {}),
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
      const due = this.sql.exec("SELECT * FROM queue WHERE next_at <= ? ORDER BY next_at, enqueued_at LIMIT ?", Date.now(), BATCH).toArray() as Row[];
      for (let i = 0; i < due.length; i += CONCURRENCY)
        await Promise.all(due.slice(i, i + CONCURRENCY).map((row) => this.process(row).catch((error: unknown) => {
          // A failure outside the item's own handling: the item waits a minute, the queue goes on (reliability audit L1).
          console.error(JSON.stringify({ event: "category_item_failed", error: (error as Error)?.message?.slice(0, 200) }));
          this.sql.exec("UPDATE queue SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE account_id = ? AND message_id = ? AND target = ?",
            Date.now() + 60_000, ((error as Error)?.message ?? "failed").slice(0, 200), row.account_id, row.message_id, row.target);
        })));
      await this.advanceBackfills().catch((error: unknown) =>
        console.error(JSON.stringify({ event: "category_backfill_failed", error: (error as Error)?.message?.slice(0, 200) })));
    } finally {
      // Whatever happened above, the queue wakes again for what is left.
      const next = this.sql.exec("SELECT MIN(next_at) AS t FROM queue").one() as Row;
      if (next.t !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 200, Number(next.t)));
    }
  }

  /** Decides the item, then lets its agent run once its spam check has answered (B-30). */
  private async process(row: Row) {
    await this.decide(row);
    const item = JSON.parse(String(row.payload)) as QueueItem;
    if (item.screen && this.sql.exec("SELECT 1 FROM spam_checks WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId).toArray().length)
      await this.releaseAgent(item);
  }

  /** The agent of a Cloudflare message held for its spam check may answer now. Overridden in tests. */
  protected async releaseAgent(item: QueueItem): Promise<void> {
    if (!this.env.AGENT_REGISTRY || !item.accountId.startsWith("cloudflare:")) return;
    await this.env.AGENT_REGISTRY.getByName("workspace").release(item.accountId.slice("cloudflare:".length), item.messageId)
      .catch((error: unknown) => console.warn(JSON.stringify({ event: "agent_release_failed", error: (error as Error)?.message?.slice(0, 200) })));
  }

  /** Decides every category the item is owed; the item leaves the queue only when all are decided. */
  private async decide(row: Row) {
    const item = JSON.parse(String(row.payload)) as QueueItem;
    const target = String(row.target);
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
      if (!rule.ok) decided.push({ c, matched: false, reason: "Conditions did not match", source: "rule" });
      else if (!c.description.trim()) decided.push({ c, matched: true, reason: rule.reason || "Matches the conditions", source: "rule" });
      else forModel.push(c);
    }
    let spamOwed = !!item.screen && target === "*"
      && !this.sql.exec("SELECT 1 FROM spam_checks WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId).toArray().length;
    if (spamOwed && tooLittleToJudge(item.text)) {
      this.recordSpamCheck(item, "clean", "Too little text to judge", now);
      spamOwed = false;
    }
    let modelError = "";
    // Which budget pays for the call: the categories' when a category needs the model (spam
    // rides along), the spam budget when only spam does. Over its budget spam is not judged,
    // since the message already sits in the inbox; categories wait for the next day.
    const categoriesPaid = forModel.length ? this.spend() : false;
    if (forModel.length && !categoriesPaid && !spamOwed) {
      this.writeVerdicts(item, decided, now);
      this.sql.exec("UPDATE queue SET next_at = ?, last_error = 'budget' WHERE account_id = ? AND message_id = ? AND target = ?",
        nextDay(), item.accountId, item.messageId, target);
      return;
    }
    const judgeSpam = spamOwed && (categoriesPaid || this.spendSpam());
    if (spamOwed && !judgeSpam) this.recordSpamCheck(item, "skipped", "The day's spam budget was spent", now);
    const asked = [...(categoriesPaid ? forModel : []), ...(judgeSpam ? [SPAM_CATEGORY] : [])];
    let spam: { reason: string } | null = null;
    if (asked.length) {
      try {
        const verdicts = await classify(this.model(), asked.map<DescribedCategory>((c) => ({ id: c.id, name: c.name, description: c.description })),
          { sender: item.sender, subject: item.subject, text: item.text, to: item.accountEmail });
        for (const v of verdicts) {
          if (v.id === SPAM_ID) {
            if (v.match) spam = { reason: v.reason || "The model judged it spam" };
            else this.recordSpamCheck(item, "clean", v.reason, now);
            continue;
          }
          const c = forModel.find((x) => x.id === v.id)!;
          decided.push({ c, matched: v.match, reason: v.reason || (v.match ? "The model placed it here" : "The model left it out"), source: "model" });
        }
      } catch (error) {
        modelError = (error as Error).message.slice(0, 200);
      }
    }
    if (spam) {
      // In Spam it belongs to no category: its verdicts go, and the view never shows it.
      const moved = await this.moveToSpam(item, spam.reason).catch((error: unknown) => {
        console.warn(JSON.stringify({ event: "spam_move_failed", account: item.accountId, error: (error as Error).message }));
        return false;
      });
      this.recordSpamCheck(item, moved ? "spam" : "spam_not_moved", spam.reason, now);
      if (moved) {
        this.sql.exec("DELETE FROM verdicts WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId);
        this.sql.exec("DELETE FROM queue WHERE account_id = ? AND message_id = ?", item.accountId, item.messageId);
        console.log(JSON.stringify({ event: "spam_by_model", account: item.accountId }));
        return;
      }
    }
    if (forModel.length && !categoriesPaid) {
      // Spam was judged on its own budget; the categories wait for tomorrow's.
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
    const attempts = Number(row.attempts) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Given up: said on the category, never silently dropped; a spam check given up lets the agent run.
      this.writeVerdicts(item, forModel.map((c) => ({ c, matched: false, reason: `Could not classify: ${modelError}`, source: "error" as const })), now);
      if (spamOwed) this.recordSpamCheck(item, "error", `Could not be judged: ${modelError}`, now);
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
    this.sql.exec("INSERT OR REPLACE INTO backfills (category_id, version, total, done, state, detail, updated_at) VALUES (?, ?, 0, 0, 'running', 'Collecting messages', ?)",
      c.id, c.version, now);
    let items: QueueItem[];
    try { items = await this.recentMessages(c); }
    catch (error) {
      this.sql.exec("UPDATE backfills SET state = 'failed', detail = ?, updated_at = ? WHERE category_id = ?",
        `Could not read the mail in scope: ${(error as Error).message.slice(0, 200)}`, Date.now(), c.id);
      return;
    }
    for (const item of items) this.enqueue(item, c.id);
    this.sql.exec("UPDATE backfills SET total = ?, state = ?, detail = ? WHERE category_id = ?",
      items.length, items.length ? "running" : "done", items.length ? "" : "No mail in scope yet", c.id);
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
        done, left === 0 ? "done" : "running", waiting ? `${waiting} wait for tomorrow's model budget` : "", Date.now(), b.category_id);
    }
  }

  // ── Reads for the feed (CAT-5) ────────────────────────────────

  /** Matched messages of a screened category, newest first, after `before`. */
  async page(id: string, before: { timestamp: number; accountId: string; messageId: string } | null, limit: number): Promise<PageRow[]> {
    const c = await this.getCategory(id);
    if (!c) throw new CategoryError("No such category", "not_found");
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

  /** A message that no longer exists leaves its categories. */
  async forget(keys: { accountId: string; messageId: string }[]): Promise<void> {
    for (const k of keys.slice(0, 200)) this.sql.exec("DELETE FROM verdicts WHERE account_id = ? AND message_id = ?", k.accountId, k.messageId);
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
