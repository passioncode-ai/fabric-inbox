/**
 * When Gmail accounts sync (docs/architecture.md → "Gmail sync"). GmailAccountsDO keeps one
 * alarm for every account; this class decides what each tick does and when the next one fires,
 * and runs the Refresh button's bounded read. It holds no Durable Object API of its own, so it
 * is tested with plain fakes.
 *
 * - A tick reads **history for every due account first**, then gives the import the rest of a
 *   TICK_BUDGET_MS budget in fair shares, starting one account further on each tick (P2-8).
 * - The next tick is BACKLOG_DELAY_MS away while an import or a history page is unfinished, the
 *   poll interval otherwise.
 * - A manual sync, a refresh or a new connection **never pushes the shared alarm later**: the
 *   alarm moves only to an earlier time (P1-6). A new connection syncs at once.
 */
import { importPercent, syncPending, type PublicAccount, type SyncOptions } from "./account-service";

export interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface SyncingService {
  listAccounts(): Promise<{ accounts: PublicAccount[] }>;
  sync(accountId: string, options: SyncOptions): Promise<PublicAccount>;
}
type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

/** One tick's time for every account together. */
export const TICK_BUDGET_MS = 25_000;
/** The next tick while work is waiting. */
export const BACKLOG_DELAY_MS = 10_000;
/** How long Refresh and a manual sync may read Gmail. */
export const REFRESH_BUDGET_MS = 20_000;
/** Any one account's history in a tick, when several share it. */
const MIN_SLICE_MS = 2_000;

/** What Refresh did for one Gmail account. */
export interface RefreshOutcome {
  /** "gmail:<id>", as the feed names it. */
  accountId: string;
  email: string;
  /**
   * synced: Gmail's new mail and changes are in. backoff: Gmail failed recently and the account
   * waits until `retryAt`. reconnect: the person must connect it again. failed: Gmail answered
   * with `error` just now. not_reached: the refresh's time ran out first.
   */
  result: "synced" | "backoff" | "reconnect" | "failed" | "not_reached";
  retryAt?: number;
  error?: string;
  /** The first import's progress in percent, while it runs. */
  importing?: number;
}

const due = (a: PublicAccount, now: number) => a.status !== "reconnect_required" && !(a.retryAt && a.retryAt > now);
const quiet = (error: unknown) => (error as { code?: string })?.code ?? (error as Error)?.message ?? "sync_failed";

export class GmailScheduler {
  constructor(
    private storage: AlarmStorage,
    private service: SyncingService,
    private lock: Lock,
    /** The poll interval, or null while Gmail is not configured. */
    private pollMs: () => number | null,
  ) {}

  /** Sets the alarm to `at` unless one already fires sooner. */
  async ensureAlarm(at: number) {
    const current = await this.storage.getAlarm();
    if (current === null || current > at) await this.storage.setAlarm(at);
  }

  /** A new or reconnected account: sync it now rather than at the next poll. */
  async connected() {
    if (this.pollMs() !== null) await this.ensureAlarm(Date.now());
  }

  /** The alarm. Returns whether work is still waiting. */
  async tick(): Promise<{ backlog: boolean }> {
    const pollMs = this.pollMs();
    if (pollMs === null) return { backlog: false };
    const start = Date.now();
    // Before any request to Gmail: a crash part way never stops polling.
    await this.storage.setAlarm(start + pollMs);
    const { accounts } = await this.service.listAccounts();
    if (!accounts.length) {
      await this.storage.deleteAlarm();
      return { backlog: false };
    }
    const offset = ((await this.storage.get<number>("poll:offset")) || 0) % accounts.length;
    const order = [...accounts.slice(offset), ...accounts.slice(0, offset)].filter((a) => due(a, start));
    const deadline = start + TICK_BUDGET_MS;
    let backlog = false;
    const pending: PublicAccount[] = [];
    // History first, for everyone: new mail is never behind another account's import.
    for (let i = 0; i < order.length; i++) {
      const left = order.length - i;
      const slice = Math.max(MIN_SLICE_MS, (deadline - Date.now()) / left);
      try {
        const account = await this.service.sync(order[i].id, { historyOnly: true, deadline: Date.now() + slice, lock: this.lock });
        if (syncPending(account)) pending.push(account);
      } catch {
        /* the account's status records it; the next tick retries after its backoff */
      }
    }
    for (let i = 0; i < pending.length; i++) {
      if (Date.now() >= deadline) { backlog = true; break; }
      const share = (deadline - Date.now()) / (pending.length - i);
      try {
        const account = await this.service.sync(pending[i].id, { importOnly: true, deadline: Date.now() + share, lock: this.lock });
        if (syncPending(account)) backlog = true;
      } catch {
        /* recorded on the account */
      }
    }
    await this.storage.put("poll:offset", (offset + 1) % accounts.length);
    if (backlog) await this.ensureAlarm(Date.now() + BACKLOG_DELAY_MS);
    // An account waiting out a failure is tried again when its wait ends, not a whole poll later.
    for (const a of accounts) if (a.status !== "reconnect_required" && a.retryAt && a.retryAt > start) await this.ensureAlarm(a.retryAt);
    return { backlog };
  }

  /** sync_account: this account now, history then import, within REFRESH_BUDGET_MS. */
  async syncNow(accountId: string) {
    const pollMs = this.pollMs();
    if (pollMs !== null) await this.ensureAlarm(Date.now() + pollMs);
    const account = await this.service.sync(accountId, { deadline: Date.now() + REFRESH_BUDGET_MS, lock: this.lock });
    if (syncPending(account)) await this.ensureAlarm(Date.now() + BACKLOG_DELAY_MS);
    return account;
  }

  /**
   * Refresh: reads every chosen account's Gmail history (new mail, changes, deletions) within
   * `budgetMs`, sharing it fairly. Accounts waiting out a failure or needing a reconnect are
   * reported, not called. The alarm is left where it is.
   */
  async refresh(accountIds: string[] | undefined, budgetMs = REFRESH_BUDGET_MS): Promise<RefreshOutcome[]> {
    const { accounts } = await this.service.listAccounts();
    const chosen = accountIds ? accounts.filter((a) => accountIds.includes("gmail:" + a.id)) : accounts;
    const deadline = Date.now() + budgetMs;
    const outcomes: RefreshOutcome[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const a = chosen[i];
      const base = { accountId: "gmail:" + a.id, email: a.email };
      const now = Date.now();
      if (a.status === "reconnect_required") { outcomes.push({ ...base, result: "reconnect" }); continue; }
      if (a.retryAt && a.retryAt > now) { outcomes.push({ ...base, result: "backoff", retryAt: a.retryAt, ...(a.error ? { error: a.error } : {}) }); continue; }
      if (now >= deadline) { outcomes.push({ ...base, result: "not_reached" }); continue; }
      const share = (deadline - now) / (chosen.length - i);
      try {
        const account = await this.service.sync(a.id, { historyOnly: true, deadline: now + share, lock: this.lock });
        const importing = importPercent(account.sync);
        outcomes.push({ ...base, result: "synced", ...(account.sync.mode === "initial" ? { importing: importing ?? 0 } : {}) });
      } catch (error) {
        const code = quiet(error);
        outcomes.push(code === "reconnect_required" ? { ...base, result: "reconnect" } : { ...base, result: "failed", error: code });
      }
    }
    console.log(JSON.stringify({ event: "gmail_refresh", accounts: outcomes.length, synced: outcomes.filter((o) => o.result === "synced").length }));
    return outcomes;
  }
}
