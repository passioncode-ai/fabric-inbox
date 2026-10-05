import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { AGENT_REGISTRY_STEPS } from "./schema";
import type { Env } from "../types";
import { validateToolUrl } from "../automation/policy";
import {
  AgentInputSchema,
  agentId,
  type AgentInput,
  type AgentSummary,
  type AgentVersion,
} from "./definition";
import { RUN_OUTCOMES, runIdFor, type AgentRun, type RunOutcome } from "./run";
import { runAgent, type RunnerDeps } from "./runner";
import { productionDeps } from "./deps";
import { CLAIM_POLL_MS, CLAIM_TTL_MS, decideClaim, type MessageClaim } from "./dedupe";


/** A run left "running" this long lost its worker; it is shown as interrupted, never replayed. */
export const RUN_STALE_MS = 10 * 60_000;
/** Longest an answer waits for its spam check before the agent runs anyway (B-30). */
export const MAX_SPAM_HOLD_MS = 15 * 60_000;
const MAX_AGENTS = 100;
const MAX_RUNS_KEPT = 2000;
/** Messages answered concurrently per alarm; each may wait on the model for a minute. */
const BATCH = 3;
/** A message whose run could not even start this many times is dropped with a log line. */
const MAX_ATTEMPTS = 5;

import { AgentConflict, AgentInvalid, AgentNotFound } from "./errors";
export { AgentConflict, AgentInvalid, AgentNotFound, registryError, type RegistryErrorCode } from "./errors";

type Row = Record<string, string | number | null>;

/**
 * One registry per workspace (`getByName("workspace")`). Holds agent versions,
 * agent runs and per-address daily send counters in SQLite so each change is
 * transactional (REQ-P2, REQ-P3).
 */
export class AgentRegistryDO extends DurableObject<Env> {
  private draining: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateSchema(ctx.storage, AGENT_REGISTRY_STEPS, "AgentRegistryDO");
  }

  // ── Durable trigger ─────────────────────────────────────────────

  /**
   * Called from the mailbox's incoming-event journal. Idempotent: the queue is
   * keyed by message and the run is claimed once, so a redelivery is harmless.
   */
  /**
   * Queues a message for its address's agent. `holdMs` keeps it back while its spam check runs
   * (B-30): `release` lets it go at once; otherwise the hold ends by itself, so a spam check that
   * never answers delays an answer and never drops it. A second enqueue only lengthens a hold.
   */
  async enqueue(mailboxId: string, emailId: string, options: { holdMs?: number } = {}): Promise<void> {
    const hold = Math.max(0, Math.min(options.holdMs ?? 0, MAX_SPAM_HOLD_MS));
    const at = hold ? Date.now() + hold : 0;
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_queue (mailbox_id, email_id, enqueued_at, next_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(mailbox_id, email_id) DO UPDATE SET next_at = MAX(next_at, excluded.next_at)`,
      mailboxId.toLowerCase(), emailId, Date.now(), at);
    const next = hold ? at + 1000 : Date.now() + 500;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  /** The message's spam check has answered: its agent may run now. */
  async release(mailboxId: string, emailId: string): Promise<void> {
    const changed = this.ctx.storage.sql.exec("UPDATE agent_queue SET next_at = 0 WHERE mailbox_id = ? AND email_id = ? AND next_at > ? RETURNING email_id",
      mailboxId.toLowerCase(), emailId, Date.now()).toArray().length;
    if (!changed) return;
    const next = Date.now() + 200;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  async queueLength(): Promise<number> {
    return Number(this.rows("SELECT COUNT(*) AS n FROM agent_queue")[0].n);
  }

  async alarm() {
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = undefined; });
    return this.draining;
  }

  /** Test seam: production effects unless a subclass supplies others. */
  protected deps(mailboxId: string): RunnerDeps {
    return productionDeps(this.env, mailboxId, {
      beginRun: (run) => this.beginRun(run),
      saveRun: (run) => this.saveRun(run),
      getAgent: (id) => this.getAgent(id),
      ensureAgent: (id, input) => this.ensureAgent(id, input),
      sentToday: (box) => this.sentToday(box),
      reserveSend: (box, limit) => this.reserveSend(box, limit),
      claimMessage: (key, box, elected) => this.claimMessage(key, box, elected),
    });
  }

  private async drain() {
    // One message per mailbox at a time: two messages of one thread read the thread
    // before either answer exists, and would both be answered.
    const candidates = this.rows("SELECT mailbox_id, email_id, attempts FROM agent_queue WHERE next_at <= ? ORDER BY attempts, enqueued_at LIMIT ?", Date.now(), BATCH * 10);
    const seen = new Set<string>();
    const batch = candidates.filter((c) => !seen.has(String(c.mailbox_id)) && seen.add(String(c.mailbox_id))).slice(0, BATCH);
    let failures = 0;
    await Promise.all(batch.map(async (item) => {
      const mailboxId = String(item.mailbox_id), emailId = String(item.email_id);
      try {
        const run = await runAgent({ mailboxId, emailId }, this.deps(mailboxId));
        // A copy of a message another address answers (B-22): look again soon, and at the latest
        // when its wait ends, so it is recorded as a duplicate or answered here.
        if (run?.status === "waiting") {
          this.ctx.storage.sql.exec("UPDATE agent_queue SET next_at = ? WHERE mailbox_id = ? AND email_id = ?",
            Math.min(run.until, Date.now() + CLAIM_POLL_MS), mailboxId, emailId);
          return;
        }
        // Another invocation holds this message's run, or held it and vanished (a deploy, an
        // eviction): keep the message until that run is finished or stale (reliability audit M2).
        if (run?.status === "running") {
          const due = (Date.parse(run.updatedAt) || Date.now()) + RUN_STALE_MS + 1000;
          this.ctx.storage.sql.exec("UPDATE agent_queue SET next_at = ? WHERE mailbox_id = ? AND email_id = ?", due, mailboxId, emailId);
          return;
        }
        this.ctx.storage.sql.exec("DELETE FROM agent_queue WHERE mailbox_id = ? AND email_id = ?", mailboxId, emailId);
      } catch (error) {
        // runAgent records every failure after its claim; reaching here means the
        // run could not start (mailbox or registry unreadable), so it is retried.
        failures++;
        const attempts = Number(item.attempts) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          console.error(JSON.stringify({ event: "agent_run_dropped", mailboxId, emailId, attempts, error: (error as Error).message }));
          // Given up: said in the history, not only in the logs (reliability audit L3).
          const at = new Date().toISOString();
          await this.beginRun({ id: await runIdFor(mailboxId, emailId), mailboxId, emailId, sender: "", subject: "",
            status: "failed", reason: `The message could not be read for its agent after ${attempts} attempts (${(error as Error).message.slice(0, 160)}); it is left for you in the inbox.`,
            toolCalls: [], createdAt: at, updatedAt: at }).catch(() => undefined);
          this.ctx.storage.sql.exec("DELETE FROM agent_queue WHERE mailbox_id = ? AND email_id = ?", mailboxId, emailId);
        } else {
          console.warn(JSON.stringify({ event: "agent_run_retry", mailboxId, emailId, attempts, error: (error as Error).message }));
          this.ctx.storage.sql.exec("UPDATE agent_queue SET attempts = ? WHERE mailbox_id = ? AND email_id = ?", attempts, mailboxId, emailId);
        }
      }
    }));
    // Back off when nothing in the batch could start, so a broken mailbox is not hammered; a
    // message waiting for a stale run wakes the queue when that run turns stale.
    const due = this.rows("SELECT MIN(next_at) AS t FROM agent_queue")[0]?.t;
    if (due !== null && due !== undefined) {
      const soonest = Number(due) <= Date.now() ? Date.now() + (batch.length && failures === batch.length ? 30_000 : 1000) : Number(due);
      await this.ctx.storage.setAlarm(soonest);
    }
  }

  private rows(query: string, ...params: (string | number | null)[]): Row[] {
    return this.ctx.storage.sql.exec<Row>(query, ...params).toArray();
  }

  private version(id: string, version: number): AgentVersion | null {
    const row = this.rows("SELECT body FROM agent_versions WHERE id = ? AND version = ?", id, version)[0];
    return row ? (JSON.parse(String(row.body)) as AgentVersion) : null;
  }

  /** Validates the definition and every tool host against the workspace allowlist. */
  private validate(input: unknown): AgentInput {
    const parsed = AgentInputSchema.safeParse(input);
    if (!parsed.success) throw new AgentInvalid(parsed.error.issues.map((i) => `${i.path.join(".") || "agent"}: ${i.message}`).join("; "));
    for (const grant of parsed.data.tools) {
      try {
        validateToolUrl(grant.endpoint, this.env.AUTOMATION_MCP_HOSTS ?? "");
      } catch (error) {
        throw new AgentInvalid(`${grant.name}: ${(error as Error).message}`);
      }
    }
    return parsed.data;
  }

  async listAgents(): Promise<AgentSummary[]> {
    return this.rows("SELECT id, current_version, updated_at FROM agents WHERE deleted_at IS NULL ORDER BY id")
      .map((row) => ({ ...this.version(String(row.id), Number(row.current_version))!, updatedAt: String(row.updated_at) }));
  }

  /** A given version is readable after deletion, so runs can show what answered them. */
  async getAgent(id: string, version?: number): Promise<AgentVersion | null> {
    const head = this.rows("SELECT current_version, deleted_at FROM agents WHERE id = ?", id)[0];
    if (!head) return null;
    if (version !== undefined) return this.version(id, version);
    return head.deleted_at ? null : this.version(id, Number(head.current_version));
  }

  async listVersions(id: string): Promise<AgentVersion[]> {
    return this.rows("SELECT body FROM agent_versions WHERE id = ? ORDER BY version DESC LIMIT 50", id)
      .map((row) => JSON.parse(String(row.body)) as AgentVersion);
  }

  async createAgent(input: unknown, requestedId?: string): Promise<AgentVersion> {
    const data = this.validate(input);
    return this.ctx.storage.transactionSync(() => {
      if (Number(this.rows("SELECT COUNT(*) AS n FROM agents WHERE deleted_at IS NULL")[0].n) >= MAX_AGENTS)
        throw new AgentInvalid(`At most ${MAX_AGENTS} agents`);
      const base = requestedId ?? agentId(data.name);
      let id = base;
      for (let n = 2; this.rows("SELECT 1 FROM agents WHERE id = ?", id).length; n++) id = `${base}-${n}`;
      return this.insertVersion(id, 1, data, true);
    });
  }

  /**
   * Creates the agent only if the id was never used (legacy migration, SCN-022).
   * A deleted id stays deleted: the operator's delete means Off, not "recreate".
   */
  async ensureAgent(id: string, input: unknown): Promise<AgentVersion | null> {
    const data = this.validate(input);
    return this.ctx.storage.transactionSync(() => {
      const head = this.rows("SELECT current_version, deleted_at FROM agents WHERE id = ?", id)[0];
      if (head) return head.deleted_at ? null : this.version(id, Number(head.current_version));
      return this.insertVersion(id, 1, data, true);
    });
  }

  /** Every save is a new immutable version; a stale editor cannot overwrite a newer one. */
  async updateAgent(id: string, input: unknown, expectedVersion: number): Promise<AgentVersion> {
    const data = this.validate(input);
    return this.ctx.storage.transactionSync(() => {
      const head = this.rows("SELECT current_version, deleted_at FROM agents WHERE id = ?", id)[0];
      if (!head || head.deleted_at) throw new AgentNotFound(id);
      if (Number(head.current_version) !== expectedVersion)
        throw new AgentConflict(`Agent changed: version ${head.current_version} is newer than ${expectedVersion}`);
      return this.insertVersion(id, expectedVersion + 1, data, false);
    });
  }

  async deleteAgent(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const changed = this.ctx.storage.sql.exec("UPDATE agents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", now, now, id);
    return changed.rowsWritten > 0;
  }

  private insertVersion(id: string, version: number, data: AgentInput, created: boolean): AgentVersion {
    const now = new Date().toISOString();
    const record: AgentVersion = { ...data, id, version, createdAt: now };
    this.ctx.storage.sql.exec("INSERT INTO agent_versions (id, version, body, created_at) VALUES (?, ?, ?, ?)", id, version, JSON.stringify(record), now);
    if (created) this.ctx.storage.sql.exec("INSERT INTO agents (id, current_version, created_at, updated_at) VALUES (?, ?, ?, ?)", id, version, now, now);
    else this.ctx.storage.sql.exec("UPDATE agents SET current_version = ?, updated_at = ? WHERE id = ?", version, now, id);
    return record;
  }

  // ── Runs ────────────────────────────────────────────────────────

  /**
   * Claims the run for one incoming message. The id is derived from mailbox and
   * message, so a repeated trigger finds the first claim and never runs twice.
   */
  async beginRun(run: AgentRun): Promise<{ claimed: boolean; run: AgentRun }> {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.rows("SELECT body FROM agent_runs WHERE id = ?", run.id)[0];
      if (existing) {
        const prior = JSON.parse(String(existing.body)) as AgentRun;
        // A worker that vanished before the send started left nothing outside: run it again.
        // One that vanished while sending is reported, since the send may have happened.
        const stale = prior.status === "running" && Date.now() - Date.parse(prior.updatedAt) > RUN_STALE_MS && prior.phase !== "sending";
        if (!stale) return { claimed: false, run: this.present(prior) };
        const again = { ...run, createdAt: prior.createdAt };
        this.ctx.storage.sql.exec("UPDATE agent_runs SET status = ?, body = ?, updated_at = ? WHERE id = ?",
          again.status, JSON.stringify(again), again.updatedAt, again.id);
        return { claimed: true, run: again };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO agent_runs (id, mailbox_id, email_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        run.id, run.mailboxId, run.emailId, run.status, JSON.stringify(run), run.createdAt, run.updatedAt);
      this.trimRuns();
      return { claimed: true, run };
    });
  }

  async saveRun(run: AgentRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec("UPDATE agent_runs SET status = ?, body = ?, updated_at = ? WHERE id = ?",
      run.status, JSON.stringify(run), run.updatedAt, run.id);
  }

  /**
   * The history, newest first. `before` is the `cursor` of the last run shown
   * (created_at and id, so runs sharing a timestamp are not skipped); `outcome`
   * narrows to one of RUN_OUTCOMES; `agentId` to one agent.
   */
  async listRuns(options: { mailboxId?: string; limit?: number; before?: string; outcome?: RunOutcome; agentId?: string } = {}): Promise<AgentRun[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (options.mailboxId) { where.push("mailbox_id = ?"); args.push(options.mailboxId.toLowerCase()); }
    if (options.agentId) { where.push("json_extract(body, '$.agentId') = ?"); args.push(options.agentId); }
    if (options.outcome) {
      const statuses = RUN_OUTCOMES[options.outcome];
      const clause = `status IN (${statuses.map(() => "?").join(", ")})`;
      args.push(...statuses);
      // A run left "running" past the stale mark is shown as interrupted, so it needs attention.
      if (options.outcome === "attention") { where.push(`(${clause} OR (status = 'running' AND updated_at < ?))`); args.push(new Date(Date.now() - RUN_STALE_MS).toISOString()); }
      else where.push(clause);
    }
    const cursor = options.before?.match(/^(.+)\|([^|]+)$/);
    if (cursor) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); args.push(cursor[1], cursor[1], cursor[2]); }
    const rows = this.rows(
      `SELECT body FROM agent_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`, ...args, limit);
    return rows.map((row) => this.present(JSON.parse(String(row.body)) as AgentRun));
  }

  /** A run whose worker vanished while sending is reported, not resumed: its send may have happened. */
  private present(run: AgentRun): AgentRun {
    if (run.status === "running" && Date.now() - Date.parse(run.updatedAt) > RUN_STALE_MS)
      return { ...run, status: "interrupted", reason: run.phase === "sending"
        ? "Processing stopped while sending. Check Sent before answering."
        : "Processing stopped before a result was recorded; it is run again automatically." };
    return run;
  }

  private trimRuns() {
    this.ctx.storage.sql.exec(
      "DELETE FROM agent_runs WHERE id IN (SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT -1 OFFSET ?)", MAX_RUNS_KEPT);
  }

  // ── One answer per message across addresses (B-22) ──────────────

  /**
   * Decides, for one copy of a message, whether it answers, waits for the address chosen to
   * answer, or is a duplicate (`decideClaim`). Keyed by the message (`messageKey`) in this
   * workspace's registry and decided in one transaction, so copies running side by side cannot
   * both answer. Claims older than a week are pruned here.
   */
  async claimMessage(key: string, mailboxId: string, elected: string, now = Date.now()): Promise<MessageClaim> {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM agent_message_claims WHERE created_at < ?", now - CLAIM_TTL_MS);
      const row = this.rows("SELECT owner, taken, deadline FROM agent_message_claims WHERE key = ?", key)[0];
      const prior = row ? { owner: String(row.owner), taken: Number(row.taken) === 1, deadline: Number(row.deadline) } : null;
      const { claim, write } = decideClaim(prior, mailboxId, elected, now);
      if (write) this.ctx.storage.sql.exec(
        `INSERT INTO agent_message_claims (key, owner, taken, deadline, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, taken = excluded.taken, deadline = excluded.deadline`,
        key, write.owner, write.taken ? 1 : 0, write.deadline, now);
      return claim;
    });
  }

  // ── Daily send budget per address ───────────────────────────────

  async sentToday(mailboxId: string, day = new Date().toISOString().slice(0, 10)): Promise<number> {
    return Number(this.rows("SELECT count FROM agent_send_counts WHERE day = ? AND mailbox_id = ?", day, mailboxId.toLowerCase())[0]?.count ?? 0);
  }

  /**
   * Takes one send from today's budget before the send is attempted. A failed or
   * unknown send keeps its slot: the budget errs toward sending less.
   */
  async reserveSend(mailboxId: string, limit: number, day = new Date().toISOString().slice(0, 10)): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const box = mailboxId.toLowerCase();
      const count = Number(this.rows("SELECT count FROM agent_send_counts WHERE day = ? AND mailbox_id = ?", day, box)[0]?.count ?? 0);
      if (count >= limit) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO agent_send_counts (day, mailbox_id, count) VALUES (?, ?, 1) ON CONFLICT(day, mailbox_id) DO UPDATE SET count = count + 1",
        day, box);
      this.ctx.storage.sql.exec("DELETE FROM agent_send_counts WHERE day < ?", new Date(Date.parse(day) - 7 * 86_400_000).toISOString().slice(0, 10));
      return true;
    });
  }
}
