import test from "node:test";
import assert from "node:assert/strict";
import { BACKLOG_DELAY_MS, GmailScheduler, type AlarmStorage, type SyncingService } from "../workers/providers/gmail-scheduler";
import type { PublicAccount, SyncOptions } from "../workers/providers/account-service";

/** P1-6, P2-8 and P1-5's budget: when Gmail accounts sync, and what Refresh reports. */
const POLL = 300_000;
class FakeStorage implements AlarmStorage {
  alarm: number | null = null;
  data = new Map<string, unknown>();
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, value); }
}
function account(id: string, over: Partial<PublicAccount> = {}): PublicAccount {
  return { id, provider: "gmail", email: id + "@example.invalid", runtime: "cloud", status: "connected", createdAt: 1, sync: { mode: "history", historyId: "1" }, ...over };
}
class FakeService implements SyncingService {
  calls: string[] = [];
  /** Accounts whose import is unfinished after a sync. */
  importing = new Set<string>();
  failures = new Map<string, Error & { code?: string }>();
  delayMs = 0;
  constructor(public accounts: PublicAccount[]) {}
  async listAccounts() { return { accounts: this.accounts }; }
  async sync(id: string, options: SyncOptions) {
    this.calls.push(`${options.historyOnly ? "history" : options.importOnly ? "import" : "full"}:${id}`);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const failure = this.failures.get(id);
    if (failure) throw failure;
    const a = this.accounts.find((x) => x.id === id)!;
    return { ...a, sync: this.importing.has(id) ? { mode: "initial" as const, historyId: "1", imported: 50, total: 200, phase: "backfill" as const } : a.sync };
  }
}
const lock = <T>(fn: () => Promise<T>) => fn();
const make = (service: FakeService, storage = new FakeStorage()) => ({ storage, scheduler: new GmailScheduler(storage, service, lock, () => POLL) });

test("a manual sync never pushes the shared alarm later (P1-6)", async () => {
  const { storage, scheduler } = make(new FakeService([account("a"), account("b")]));
  const due = Date.now() + 20_000;
  storage.alarm = due;
  await scheduler.syncNow("a");
  assert.equal(storage.alarm, due, "account b still syncs when it was going to");
  storage.alarm = null;
  await scheduler.syncNow("a");
  assert.ok(storage.alarm! > Date.now() + POLL - 5_000, "with no alarm, polling is (re)started");
});

test("a new connection syncs now, not a poll interval later (P0-1)", async () => {
  const { storage, scheduler } = make(new FakeService([account("a")]));
  storage.alarm = Date.now() + POLL;
  await scheduler.connected();
  assert.ok(storage.alarm! <= Date.now());
});

test("a tick reads every account's history before any import, and starts one account further each time (P2-8)", async () => {
  const service = new FakeService([account("a"), account("b"), account("c")]);
  service.importing.add("a");
  service.importing.add("c");
  const { storage, scheduler } = make(service);
  const first = await scheduler.tick();
  assert.deepEqual(service.calls, ["history:a", "history:b", "history:c", "import:a", "import:c"]);
  assert.equal(first.backlog, true);
  assert.ok(storage.alarm! <= Date.now() + BACKLOG_DELAY_MS, "work waits: the next tick is soon");
  service.calls = [];
  await scheduler.tick();
  assert.deepEqual(service.calls.slice(0, 3), ["history:b", "history:c", "history:a"], "rotated");
  service.importing.clear();
  const quiet = await scheduler.tick();
  assert.equal(quiet.backlog, false);
  assert.ok(storage.alarm! > Date.now() + POLL - 5_000, "nothing waits: the next tick is a poll away");
});

test("a tick skips accounts waiting out a failure or needing a reconnect, and wakes when the wait ends (P2-8)", async () => {
  const retryAt = Date.now() + 60_000;
  const service = new FakeService([account("a", { status: "error", retryAt }), account("b", { status: "reconnect_required" }), account("c")]);
  const { storage, scheduler } = make(service);
  await scheduler.tick();
  assert.deepEqual(service.calls, ["history:c"]);
  assert.equal(storage.alarm, retryAt);
});

test("one account failing does not stop the others in a tick", async () => {
  const service = new FakeService([account("a"), account("b")]);
  service.failures.set("a", Object.assign(new Error("provider_unavailable"), { code: "provider_unavailable" }));
  const { scheduler } = make(service);
  await scheduler.tick();
  assert.deepEqual(service.calls, ["history:a", "history:b"]);
});

test("Refresh reads history only, reports each account, and leaves the alarm alone (P1-5)", async () => {
  const retryAt = Date.now() + 60_000;
  const service = new FakeService([account("a"), account("b", { status: "error", retryAt, error: "provider_unavailable" }),
    account("c", { status: "reconnect_required" }), account("d"), account("e")]);
  service.importing.add("d");
  service.failures.set("e", Object.assign(new Error("rate_limited"), { code: "rate_limited" }));
  const { storage, scheduler } = make(service);
  storage.alarm = 12345;
  const outcomes = await scheduler.refresh(undefined);
  assert.deepEqual(outcomes.map((o) => [o.accountId, o.result]), [["gmail:a", "synced"], ["gmail:b", "backoff"], ["gmail:c", "reconnect"], ["gmail:d", "synced"], ["gmail:e", "failed"]]);
  assert.equal(outcomes[1].retryAt, retryAt);
  assert.equal(outcomes[3].importing, 25);
  assert.equal(outcomes[4].error, "rate_limited");
  assert.deepEqual(service.calls, ["history:a", "history:d", "history:e"], "no import, nothing for accounts that cannot sync");
  assert.equal(storage.alarm, 12345);
  assert.deepEqual((await scheduler.refresh(["gmail:a"])).map((o) => o.accountId), ["gmail:a"], "a scope reads only its accounts");
});

test("Refresh stops starting accounts when its budget is spent (P1-5)", async () => {
  const service = new FakeService([account("a"), account("b"), account("c")]);
  service.delayMs = 60;
  const { scheduler } = make(service);
  const outcomes = await scheduler.refresh(undefined, 100);
  assert.deepEqual(outcomes.map((o) => o.result), ["synced", "synced", "not_reached"]);
});
