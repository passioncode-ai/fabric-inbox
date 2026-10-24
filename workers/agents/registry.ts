import { EVENTS_KEPT, EVENTS_KEPT_MS, qualityEvent, runEvent, waitingEvent, type AgentEvent } from "./events";
import { MAX_ATTEMPTS as HOOK_MAX_ATTEMPTS, RETRY_MS as HOOK_RETRY_MS, readHooks, sendHook, type HookCursor } from "./event-hooks";
import { mailChannel, qualityDay } from "./quality";
import { JUDGE_SAMPLE, benchJudge, judgesFor, openRouterJudge, qualityOf, type BenchResult, type JudgeInput, type JudgeVerdict } from "./judge";
import { BENCH_MODELS, BENCH_REFERENCE, BENCH_RUNS_DEFAULT, BENCH_RUNS_MAX, BENCH_SLICE, benchLine, benchRuns, turnHash, type BenchLine } from "./bench";
import { readAllSettings } from "../lib/mailbox-store";
import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { AGENT_REGISTRY_STEPS } from "./schema";
import type { Env } from "../types";
import { validateToolUrl } from "../automation/policy";
import {
  AgentInputSchema,
  agentId,
  grantSchemaProblems,
  readAssignment,
  SCHEMA_LIMIT,
  type AgentInput,
  type AgentSummary,
  type AgentVersion,
  type ToolGrant,
} from "./definition";
import { RUN_OUTCOMES, runIdFor, type AgentRun, type RunOutcome } from "./run";
import { closeRun, runAgent, type RunnerDeps } from "./runner";
import { productionDeps, toolTokens } from "./deps";
import { readToolInfo, type ToolInfo } from "./tool-schema";
import { CLAIM_POLL_MS, CLAIM_TTL_MS, decideClaim, type MessageClaim } from "./dedupe";


/** A run left "running" this long lost its worker; it is shown as interrupted, never replayed. */
export const RUN_STALE_MS = 10 * 60_000;
/**
 * A message held because the agent was not sure (holdUnsure) is answered again every HELD_RETRY_MS for
 * its first HELD_FAST_MS, then once a day until HELD_FOR_MS (the knowledge team curates weekly, so an
 * answer added after the first week still reaches the customer). A repeated gap report counts once
 * (same request id). After that it stays held and the events keep saying so.
 */
export const HELD_RETRY_MS = 12 * 3_600_000;
export const HELD_FAST_MS = 7 * 86_400_000;
export const HELD_LATE_RETRY_MS = 24 * 3_600_000;
export const HELD_FOR_MS = 30 * 86_400_000;
/**
 * B-141: a run that failed before anything was sent (the model, the safety check, reading the agent) is
 * tried again every FAILED_RETRY_MS for its first FAILED_FAST_MS, then like a held one.
 */
export const FAILED_RETRY_MS = 3_600_000;
export const FAILED_FAST_MS = 86_400_000;
/** B-141: held runs answered again at once in one pass when their knowledge changed; the rest follow. */
const RETRY_AT_ONCE = 20;
/**
 * B-131 (support quality standard A6): a message waiting for a person (held, or a draft nobody sent)
 * is escalated once WAIT_SLA_MS after it came, the mail first-reply target. Runs older than
 * ESCALATE_WITHIN_MS when first seen are not escalated: a backlog from before this rule stays quiet.
 */
export const WAIT_SLA_MS = 4 * 3_600_000;
export const ESCALATE_WITHIN_MS = 3 * 86_400_000;
/** B-130: a run's sender, subject and texts are removed this long after it began; its counts stay. */
export const RUN_TEXT_KEPT_MS = 30 * 86_400_000;
/** B-130: missed quality days are caught up to this many days back. */
const QUALITY_CATCH_UP_DAYS = 7;
/**
 * Review 2026-10-21: a day is reported this long after it closes, so a reply sent after midnight to a
 * message of the day's evening counts as a reply, not as a message nobody answered.
 */
export const QUALITY_SETTLE_MS = 86_400_000;
/** Days reported in one alarm; the rest follow in the next (an alarm is bounded in time). */
const QUALITY_DAYS_PER_PASS = 2;
/** A waiting message whose mailbox could not be read is looked at again after this long. */
export const WAIT_CHECK_RETRY_MS = 15 * 60_000;
/** A draft escalated as waiting is looked at again this often, until a person answers it or it ages out. */
export const PERSON_CHECK_MS = 3_600_000;
/** Longest an answer waits for its spam check before the agent runs anyway (B-30). */
export const MAX_SPAM_HOLD_MS = 15 * 60_000;
const MAX_AGENTS = 100;
const MAX_RUNS_KEPT = 2000;
/** Messages answered concurrently per alarm; each may wait on the model for a minute. */
const BATCH = 3;
/** A message whose run could not even start this many times is dropped with a log line. */
const MAX_ATTEMPTS = 5;

import { AgentConflict, AgentInvalid, AgentNotFound } from "./errors";
import { msg } from "../../shared/i18n";
export { AgentConflict, AgentInvalid, AgentNotFound, registryError, type RegistryErrorCode } from "./errors";

type Row = Record<string, string | number | null>;

/**
 * One registry per workspace (`getByName("workspace")`). Holds agent versions,
 * agent runs and per-address daily send counters in SQLite so each change is
 * transactional (REQ-P2, REQ-P3).
 */
/** One day and model of the agents' model calls (B-87 part 4, B-147). */
export interface ModelUsageRow { day: string; model: string; calls: number; unpricedCalls: number; unmeasuredCalls: number; inputTokens: number; outputTokens: number; costUsd: number }

export class AgentRegistryDO extends DurableObject<Env> {
  private draining: Promise<void> | undefined;
  /** B-141: a run saved a knowledge revision other than the last one seen: held runs are looked at again soon. */
  private factsMoved = false;

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

  /**
   * What an agent would do with a message, without doing it: the whole run — prefilter, knowledge,
   * tools, model, policy — on a message given as text, as if it came to `address`. Nothing is sent,
   * drafted, stored or reported to a knowledge tool as a gap; read-only tools are called as in a real
   * run, and the model is (it spends). Answers the run and the reply it would send.
   */
  async previewAnswer(agentId: string, input: { address: string; from: string; subject: string; text: string }) {
    const agent = await this.getAgent(agentId);
    if (!agent) throw new AgentNotFound(agentId);
    const address = input.address.toLowerCase();
    const real = this.deps(address);
    const gapTools = new Set(agent.tools.flatMap((g) => (g.gaps ? [g.gaps.tool] : [])));
    let reply: { to: string; subject: string; text: string } | null = null;
    let draft: { to: string; subject: string; text: string } | null = null;
    const now = new Date().toISOString();
    const html = `<p>${input.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`;
    // Every preview shares the run id of email "preview": its model calls get a trace of their own.
    const trace = `preview-${crypto.randomUUID().slice(0, 8)}`;
    const deps: RunnerDeps = {
      ...real,
      model: (request) => real.model({ ...request, trace }),
      registry: {
        beginRun: async (run) => ({ claimed: true, run }),
        saveRun: async () => {},
        getAgent: async (id) => (id === agentId ? agent : null),
        ensureAgent: async () => null,
        agentState: async () => "live",
        sentToday: async () => 0,
        reserveSend: async () => true,
        claimMessage: async () => ({ outcome: "answer" }),
      },
      agentServes: async () => false,
      mailbox: {
        ...real.mailbox,
        settings: async () => ({ ...((await real.mailbox.settings()) ?? {}), agent: { id: agentId } }),
        saveAssignment: async () => {},
        email: async () => ({ id: "preview", sender: input.from, subject: input.subject, body: html, date: now, thread_id: null, raw_headers: null, folder_id: "inbox" }),
        thread: async () => [],
        rateLimit: async () => null,
        send: async (command) => {
          const request = command.request as { to?: string; subject?: string; text?: string };
          reply = { to: String(request.to ?? ""), subject: String(request.subject ?? ""), text: String(request.text ?? "") };
          return { id: "preview", mailboxId: address, status: "accepted", createdAt: 0, updatedAt: 0, attempts: 1, providerMessageId: "preview",
            deliveryStatus: "unconfirmed", projectionStatus: "complete", errorCode: null } as Awaited<ReturnType<RunnerDeps["mailbox"]["send"]>>;
        },
        createDraft: async (d) => { draft = { to: d.to, subject: d.subject, text: d.text }; },
      },
      // A gap report is a write to someone else's knowledge: never from a preview.
      callTool: async (grant, args) => (gapTools.has(grant.tool) ? JSON.stringify({ preview: true }) : real.callTool(grant, args)),
    };
    const run = await runAgent({ mailboxId: address, emailId: "preview" }, deps);
    if (!run || "owner" in run) return { status: "not_answered", run: null, reply: null, draft: null };
    return { status: run.status, run: { ...run, sender: "", subject: "" }, reply, draft };
  }

  /**
   * The next messages to answer: each mailbox's oldest due message, oldest first. The first due rows
   * were taken before keeping one per mailbox, so a burst of mail to one address filled the window and
   * kept every other address waiting until its backlog cleared (bug hunt 2026-10-12).
   */
  protected nextBatch() {
    return this.rows(`SELECT mailbox_id, email_id, attempts FROM (
        SELECT mailbox_id, email_id, attempts, enqueued_at,
          ROW_NUMBER() OVER (PARTITION BY mailbox_id ORDER BY attempts, enqueued_at) AS turn
        FROM agent_queue WHERE next_at <= ?)
      WHERE turn = 1 ORDER BY attempts, enqueued_at LIMIT ?`, Date.now(), BATCH);
  }

  /**
   * Held runs, and runs that failed before anything was sent (B-141), due another try go back to the queue
   * (answer_again); answers when the next one is due. B-141: a run held for missing knowledge is tried at
   * once when a later run saw its knowledge at another revision, and is not tried (its next try moves on)
   * when a later run saw the same revision; otherwise the runner itself compares the revision.
   */
  protected async retryHeld(now = Date.now()): Promise<number | null> {
    const since = new Date(now - HELD_FOR_MS).toISOString();
    const rows = this.rows(`SELECT id, status, body, created_at, updated_at FROM agent_runs WHERE created_at >= ?
      AND (status = 'held' OR (status = 'failed' AND json_extract(body, '$.failure') IS NOT NULL)) ORDER BY updated_at LIMIT 200`, since);
    const seen = new Map(this.rows("SELECT endpoint, revision, seen_at FROM agent_facts").map((r) => [String(r.endpoint), { revision: String(r.revision), at: Number(r.seen_at) }]));
    let next: number | null = null;
    let retried = 0;
    for (const row of rows) {
      const age = now - Date.parse(String(row.created_at));
      const last = Date.parse(String(row.updated_at));
      const interval = row.status === "failed" && age < FAILED_FAST_MS ? FAILED_RETRY_MS : age < HELD_FAST_MS ? HELD_RETRY_MS : HELD_LATE_RETRY_MS;
      let due = last + interval;
      let held: AgentRun["heldFacts"];
      try { held = row.status === "held" ? (JSON.parse(String(row.body)) as AgentRun).heldFacts : undefined; } catch { held = undefined; }
      if (held && Object.keys(held.revisions).length) {
        const later = Object.entries(held.revisions).map(([endpoint, revision]) => ({ revision, now: seen.get(endpoint) }))
          .map((x) => ({ ...x, now: x.now && x.now.at > last ? x.now : undefined }));
        if (later.some((x) => x.now && x.now.revision !== x.revision)) due = Math.min(due, now);
        else if (due <= now && later.every((x) => x.now && x.now.revision === x.revision)) {
          // The knowledge is the same as at the last attempt: the next try moves on, nothing is called.
          const at = new Date(now).toISOString();
          this.ctx.storage.sql.exec("UPDATE agent_runs SET updated_at = ?, body = json_set(body, '$.updatedAt', ?) WHERE id = ? AND status = 'held'", at, at, String(row.id));
          console.log(JSON.stringify({ event: "held_retry_unchanged", run: row.id }));
          due = now + interval;
        }
      }
      if (due <= now && retried < RETRY_AT_ONCE) {
        retried++;
        const result = await this.answerAgain(String(row.id), { keepFacts: true });
        if (!result.ok) console.warn(JSON.stringify({ event: "held_retry_refused", run: row.id, reason: result.reason }));
      } else {
        const at = due <= now ? now + 1000 : due;
        if (next === null || at < next) next = at;
      }
    }
    return next;
  }

  /**
   * B-141: a held or failed run whose retries ended (HELD_FOR_MS) gets one closing reply naming another
   * route (closeRun) and a second agent.waiting event. Runs older than HELD_FOR_MS + ESCALATE_WITHIN_MS
   * when first seen are left alone, as a backlog from before this rule. Answers when the next is due.
   */
  protected async closeExpired(now = Date.now()): Promise<number | null> {
    const oldest = new Date(now - HELD_FOR_MS - ESCALATE_WITHIN_MS).toISOString();
    const at = new Date(now).toISOString();
    const open = (where: string, ...args: string[]) => this.rows(`SELECT id, body, created_at FROM agent_runs WHERE created_at >= ?
      AND (status = 'held' OR (status = 'failed' AND json_extract(body, '$.failure') IS NOT NULL)) AND json_extract(body, '$.closedAt') IS NULL ${where}
      ORDER BY created_at LIMIT 20`, oldest, ...args);
    const due = open("AND created_at <= ? AND (json_extract(body, '$.closeCheckAt') IS NULL OR json_extract(body, '$.closeCheckAt') <= ?)",
      new Date(now - HELD_FOR_MS).toISOString(), at);
    for (const row of due) {
      const run = JSON.parse(String(row.body)) as AgentRun;
      let result: Awaited<ReturnType<typeof closeRun>>;
      try { result = await closeRun(run, this.deps(run.mailboxId)); }
      catch (error) { result = { status: "retry", reason: (error as Error).message?.slice(0, 120) ?? "error" }; }
      if (result.status === "retry") {
        console.warn(JSON.stringify({ event: "agent_closing_deferred", run: run.id, reason: result.reason }));
        this.ctx.storage.sql.exec("UPDATE agent_runs SET body = json_set(body, '$.closeCheckAt', ?) WHERE id = ?", new Date(now + PERSON_CHECK_MS).toISOString(), run.id);
        continue;
      }
      run.closedAt = at;
      run.closing = { status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
      delete run.closeCheckAt;
      this.ctx.storage.transactionSync(() => {
        const written = this.ctx.storage.sql.exec("UPDATE agent_runs SET body = ? WHERE id = ? AND status = ?", JSON.stringify(run), run.id, run.status).rowsWritten;
        if (written === 1) this.appendEvent(run.id, waitingEvent(run, at, { closed: true, sent: result.status !== "not_sent" }));
      });
      console.log(JSON.stringify({ event: "agent_closing", run: run.id, status: result.status, reason: result.reason ?? null }));
    }
    const times = open("").map((r) => {
      const run = JSON.parse(String(r.body)) as AgentRun;
      return Math.max(Date.parse(String(r.created_at)) + HELD_FOR_MS, run.closeCheckAt ? Date.parse(run.closeCheckAt) : 0);
    }).filter((t) => Number.isFinite(t));
    return times.length ? Math.max(now + 1000, Math.min(...times)) : null;
  }

  private async drain() {
    const retryDue = await this.retryHeld().catch((error) => {
      console.warn(JSON.stringify({ event: "held_retry_failed", error: (error as Error).message?.slice(0, 200) }));
      return null;
    });
    const waitDue = await this.superviseWaiting().catch((error) => {
      console.warn(JSON.stringify({ event: "waiting_supervision_failed", error: (error as Error).message?.slice(0, 200) }));
      return null;
    });
    const closeDue = await this.closeExpired().catch((error) => {
      console.warn(JSON.stringify({ event: "agent_closing_failed", error: (error as Error).message?.slice(0, 200) }));
      return Date.now() + PERSON_CHECK_MS;
    });
    try { this.redactOldRuns(); } catch (error) {
      console.warn(JSON.stringify({ event: "run_redact_failed", error: (error as Error).message?.slice(0, 200) }));
    }
    const qualityDue = await this.emitQualityDays().catch((error) => {
      console.warn(JSON.stringify({ event: "quality_daily_failed", error: (error as Error).message?.slice(0, 200) }));
      return Date.now() + 3_600_000;
    });
    let heldDue: number | null = [retryDue, waitDue, closeDue, qualityDue].filter((t): t is number => t !== null).reduce((a, b) => Math.min(a, b));
    // One message per mailbox at a time: two messages of one thread read the thread
    // before either answer exists, and would both be answered.
    const batch = this.nextBatch();
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
            status: "failed", failure: "read", reason: msg("The message could not be read for its agent after {attempts} attempts ({error}); it is left for you in the inbox.", { attempts, error: (error as Error).message.slice(0, 160) }),
            toolCalls: [], createdAt: at, updatedAt: at }).catch(() => undefined);
          this.ctx.storage.sql.exec("DELETE FROM agent_queue WHERE mailbox_id = ? AND email_id = ?", mailboxId, emailId);
        } else {
          console.warn(JSON.stringify({ event: "agent_run_retry", mailboxId, emailId, attempts, error: (error as Error).message }));
          this.ctx.storage.sql.exec("UPDATE agent_queue SET attempts = ? WHERE mailbox_id = ? AND email_id = ?", attempts, mailboxId, emailId);
        }
      }
    }));
    // B-141: a run of this batch saw the knowledge at a new revision: held runs are looked at in a second.
    if (this.factsMoved) { this.factsMoved = false; heldDue = Math.min(heldDue ?? Infinity, Date.now() + 1000); }
    // B-137: the events of this pass (and any a hook still owes) go to the webhooks.
    const hookDue = await this.deliverHooks().catch((error) => {
      console.warn(JSON.stringify({ event: "event_hooks_failed", error: (error as Error).message?.slice(0, 200) }));
      return Date.now() + 60_000;
    });
    const otherDue = [heldDue, hookDue].filter((t): t is number => t !== null).reduce<number | null>((a, b) => (a === null ? b : Math.min(a, b)), null);
    // Back off when nothing in the batch could start, so a broken mailbox is not hammered; a
    // message waiting for a stale run wakes the queue when that run turns stale.
    const due = this.rows("SELECT MIN(next_at) AS t FROM agent_queue")[0]?.t;
    if (due !== null && due !== undefined) {
      const soonest = Number(due) <= Date.now() ? Date.now() + (batch.length && failures === batch.length ? 30_000 : 1000) : Number(due);
      await this.ctx.storage.setAlarm(otherDue !== null ? Math.min(soonest, otherDue) : soonest);
    } else if (otherDue !== null) {
      // Nothing queued, but a held message is due another try then, or a hook another delivery.
      await this.ctx.storage.setAlarm(otherDue);
    }
  }

  private rows(query: string, ...params: (string | number | null)[]): Row[] {
    return this.ctx.storage.sql.exec<Row>(query, ...params).toArray();
  }

  private version(id: string, version: number): AgentVersion | null {
    const row = this.rows("SELECT body FROM agent_versions WHERE id = ? AND version = ?", id, version)[0];
    return row ? (JSON.parse(String(row.body)) as AgentVersion) : null;
  }

  /** Test seam: the granted tool's schema and read-only mark, read from its endpoint; production reads them over MCP. */
  protected async toolInfo(grant: ToolGrant): Promise<ToolInfo | null> {
    return readToolInfo(grant, this.env.AUTOMATION_MCP_HOSTS ?? "", toolTokens(this.env));
  }

  /** Validates the definition, every tool host against the workspace allowlist and each granted tool's schema. */
  private async validate(input: unknown): Promise<AgentInput> {
    const parsed = AgentInputSchema.safeParse(input);
    if (!parsed.success) throw new AgentInvalid(parsed.error.issues.map((i) => `${i.path.join(".") || "agent"}: ${i.message}`).join("; "));
    for (const grant of parsed.data.tools) {
      try {
        validateToolUrl(grant.endpoint, this.env.AUTOMATION_MCP_HOSTS ?? "");
      } catch (error) {
        throw new AgentInvalid(`${grant.name}: ${(error as Error).message}`);
      }
      // The schema is checked at save time, not first at run time: an unreadable tool is refused with the reason.
      let info: ToolInfo | null;
      try {
        info = await this.toolInfo(grant);
      } catch (error) {
        throw new AgentInvalid(msg("The schema of the tool {tool} could not be read: {error}", { tool: grant.name, error: (error as Error).message }));
      }
      if (info == null || info.schema == null) throw new AgentInvalid(msg("The tool {tool} is not listed by its endpoint", { tool: grant.name }));
      const schema = info.schema;
      // B-94: the endpoint's own mark, never the editor's.
      grant.readOnly = info.readOnly;
      // B-85: the endpoint's schema is what the model is offered later, so it is stored with the
      // version; whatever the editor sent in its place is replaced.
      const stored = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : {};
      const problems = grantSchemaProblems(grant, stored);
      if (problems.length) throw new AgentInvalid(`${grant.name}: ${problems.join("; ")}`);
      const text = JSON.stringify(stored);
      // A schema over the limit is not stored: the model then gets the generic wrapper (modelSchema).
      if (Object.keys(stored).length && text.length <= SCHEMA_LIMIT) grant.inputSchema = text; else delete grant.inputSchema;
      // B-85: the gap tool must be one the same endpoint offers.
      if (grant.gaps) {
        let gapSchema: unknown;
        try { gapSchema = (await this.toolInfo({ ...grant, tool: grant.gaps.tool }))?.schema ?? null; }
        catch (error) { throw new AgentInvalid(msg("The schema of the tool {tool} could not be read: {error}", { tool: grant.gaps.tool, error: (error as Error).message })); }
        if (gapSchema == null) throw new AgentInvalid(msg("The tool {tool} is not listed by its endpoint", { tool: grant.gaps.tool }));
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
    const data = await this.validate(input);
    return this.ctx.storage.transactionSync(() => {
      if (Number(this.rows("SELECT COUNT(*) AS n FROM agents WHERE deleted_at IS NULL")[0].n) >= MAX_AGENTS)
        throw new AgentInvalid(msg("At most {max} agents", { max: MAX_AGENTS }));
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
  /** Whether an id names a live agent, one deleted since, or none ever (B-93: a deleted migrated agent is never re-created). */
  async agentState(id: string): Promise<"live" | "deleted" | "none"> {
    const head = this.rows("SELECT deleted_at FROM agents WHERE id = ?", id)[0];
    return !head ? "none" : head.deleted_at ? "deleted" : "live";
  }

  async ensureAgent(id: string, input: unknown): Promise<AgentVersion | null> {
    const data = await this.validate(input);
    return this.ctx.storage.transactionSync(() => {
      const head = this.rows("SELECT current_version, deleted_at FROM agents WHERE id = ?", id)[0];
      if (head) return head.deleted_at ? null : this.version(id, Number(head.current_version));
      return this.insertVersion(id, 1, data, true);
    });
  }

  /** Every save is a new immutable version; a stale editor cannot overwrite a newer one. */
  async updateAgent(id: string, input: unknown, expectedVersion: number): Promise<AgentVersion> {
    const data = await this.validate(input);
    return this.ctx.storage.transactionSync(() => {
      const head = this.rows("SELECT current_version, deleted_at FROM agents WHERE id = ?", id)[0];
      if (!head || head.deleted_at) throw new AgentNotFound(id);
      if (Number(head.current_version) !== expectedVersion)
        throw new AgentConflict(msg("Agent changed: version {current} is newer than {expected}", { current: String(head.current_version), expected: expectedVersion }));
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
        // B-94: marked a re-run, so tools that may act are not called a second time.
        // The message came once: a re-run keeps when it was received, or its first-reply time would restart.
        const again = { ...run, createdAt: prior.createdAt, ...(prior.receivedAt ? { receivedAt: prior.receivedAt } : {}), ...(prior.attempt ? { attempt: prior.attempt } : {}), rerun: true,
          // B-131: an escalation and a waiting reply happen once per message, across its retries.
          ...(prior.escalatedAt ? { escalatedAt: prior.escalatedAt } : {}), ...(prior.acknowledged ? { acknowledged: prior.acknowledged } : {}),
          // B-141: what the last attempt held for, the gaps already reported and the closing are the message's, not the attempt's.
          ...(prior.heldFacts ? { heldFacts: prior.heldFacts } : {}), ...(prior.gapsReported ? { gapsReported: prior.gapsReported } : {}),
          ...(prior.closedAt ? { closedAt: prior.closedAt, ...(prior.closing ? { closing: prior.closing } : {}) } : {}) };
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
    this.ctx.storage.transactionSync(() => {
      const before = this.rows("SELECT status FROM agent_runs WHERE id = ?", run.id)[0]?.status;
      this.ctx.storage.sql.exec("UPDATE agent_runs SET status = ?, body = ?, updated_at = ? WHERE id = ?",
        run.status, JSON.stringify(run), run.updatedAt, run.id);
      // B-141: the newest revision each knowledge endpoint answered with.
      for (const [endpoint, revision] of Object.entries(run.factsRevisions ?? {})) {
        const prior = this.rows("SELECT revision FROM agent_facts WHERE endpoint = ?", endpoint)[0];
        if (prior && String(prior.revision) !== revision) this.factsMoved = true;
        this.ctx.storage.sql.exec(`INSERT INTO agent_facts (endpoint, revision, seen_at) VALUES (?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET revision = excluded.revision, seen_at = excluded.seen_at`, endpoint, revision, Date.now());
      }
      // B-118: a run that just ended (its status changed to a final one) appends one event.
      const event = before !== run.status ? runEvent(run) : null;
      if (event) this.appendEvent(run.id, event);
    });
  }

  private appendEvent(runId: string, event: AgentEvent) {
    this.ctx.storage.sql.exec("INSERT INTO agent_events (run_id, at, body) VALUES (?, ?, ?)", runId, event.at, JSON.stringify(event));
    this.ctx.storage.sql.exec(
      "DELETE FROM agent_events WHERE seq <= (SELECT seq FROM agent_events ORDER BY seq DESC LIMIT 1 OFFSET ?) AND at < ?",
      EVENTS_KEPT, new Date(Date.now() - EVENTS_KEPT_MS).toISOString());
  }

  /**
   * B-130 (A1): a run's sender, subject and every text it kept (the reply sent, tool results, the
   * waiting reply, the question) are removed RUN_TEXT_KEPT_MS after it began; the counts stay.
   */
  protected redactOldRuns(now = Date.now()) {
    const before = new Date(now - RUN_TEXT_KEPT_MS).toISOString();
    for (const row of this.rows("SELECT id, mailbox_id, email_id, status, created_at, body FROM agent_runs WHERE created_at < ? AND json_extract(body, '$.redacted') IS NULL LIMIT 200", before)) {
      // One unreadable row must not stop the others, nor the alarm (review 2026-10-21): it is cleared to its counts.
      try {
        const run = JSON.parse(String(row.body)) as AgentRun;
        run.sender = ""; run.subject = ""; run.redacted = true;
        if (run.sent) run.sent = { ...run.sent, to: "", subject: "", body: "" };
        if (run.acknowledged) run.acknowledged = { ...run.acknowledged, text: "" };
        run.toolCalls = (run.toolCalls ?? []).map((c) => ({ ...c, result: "" }));
        delete run.question; delete run.intent; delete run.summary;
        this.ctx.storage.sql.exec("UPDATE agent_runs SET body = ? WHERE id = ?", JSON.stringify(run), String(row.id));
      } catch (error) {
        console.warn(JSON.stringify({ event: "run_redact_failed", run: String(row.id), error: (error as Error).message?.slice(0, 200) }));
        const cleared = { id: String(row.id), mailboxId: String(row.mailbox_id), emailId: String(row.email_id), status: String(row.status), reason: "",
          sender: "", subject: "", toolCalls: [], createdAt: String(row.created_at), updatedAt: String(row.created_at), redacted: true };
        this.ctx.storage.sql.exec("UPDATE agent_runs SET body = ? WHERE id = ?", JSON.stringify(cleared), String(row.id));
      }
    }
  }

  /**
   * B-130 (A5): one support.quality_daily event per agent address for each closed UTC day not yet
   * reported (the last QUALITY_CATCH_UP_DAYS at most). Answers when the next day closes.
   */
  protected async emitQualityDays(now = Date.now()): Promise<number> {
    // A day is reported QUALITY_SETTLE_MS after it closes: "today" here is the day that settles next.
    const today = new Date(now - QUALITY_SETTLE_MS).toISOString().slice(0, 10);
    const next = Date.parse(`${today}T00:00:00.000Z`) + 86_400_000 + QUALITY_SETTLE_MS + 5 * 60_000;
    const last = (await this.ctx.storage.get<string>("quality_day")) ?? null;
    const days: string[] = [];
    for (let i = QUALITY_CATCH_UP_DAYS; i >= 1; i--) {
      const day = new Date(Date.parse(`${today}T00:00:00.000Z`) - i * 86_400_000).toISOString().slice(0, 10);
      if (last ? day > last : i === 1) days.push(day);
    }
    if (!days.length) return next;
    const more = days.length > QUALITY_DAYS_PER_PASS;
    days.splice(QUALITY_DAYS_PER_PASS);
    const served = (await readAllSettings(this.env.BUCKET)).flatMap(({ email, settings }) => {
      const assignment = readAssignment(settings);
      return assignment && assignment !== "off" ? [email.toLowerCase()] : [];
    });
    for (const day of days) {
      const since = new Date(Date.parse(`${day}T00:00:00.000Z`) - 7 * 86_400_000).toISOString();
      const at = new Date(now).toISOString();
      for (const address of served) {
        let received: number | null = null;
        try {
          const rows = await this.env.MAILBOX.get(this.env.MAILBOX.idFromName(address)).receivedPerDay(`${day}T00:00:00.000Z`);
          received = rows.find((r) => r.day === day)?.received ?? 0;
        } catch (error) {
          console.warn(JSON.stringify({ event: "quality_received_unreadable", error: (error as Error).message?.slice(0, 200) }));
        }
        // A day already reported for this address (a pass cut off after it) is not reported twice.
        if (this.rows("SELECT 1 FROM agent_events WHERE run_id = ? AND json_extract(body, '$.data.value.channel') = ? LIMIT 1",
          `quality-${day}`, mailChannel(address)).length) continue;
        // Runs of the week, and every run still waiting for a person however old (its queue counts now).
        const runs = this.rows("SELECT body FROM agent_runs WHERE mailbox_id = ? AND (created_at >= ? OR status IN ('held', 'drafted'))", address, since)
          .map((r) => JSON.parse(String(r.body)) as AgentRun);
        const judged = await this.judgeDay(address, day, runs).catch((error) => {
          console.warn(JSON.stringify({ event: "judge_day_failed", error: (error as Error).message?.slice(0, 200) }));
          return null;
        });
        const value = qualityDay({ address, day, received, runs, now, judged,
          modeOf: (r) => (r.agentId && r.agentVersion ? this.version(r.agentId, r.agentVersion)?.replyPolicy.mode : undefined) === "draft" ? "draft" : "auto" });
        this.appendEvent(`quality-${day}`, qualityEvent(address, value, at));
      }
      await this.ctx.storage.put("quality_day", day);
      console.log(JSON.stringify({ event: "quality_daily_emitted", day, addresses: served.length }));
    }
    return more ? now + 1000 : next;
  }

  /** Test seam: one verdict from a judge of another vendor; production asks OpenRouter (B-132). */
  protected async judgeAnswer(models: string[], input: JudgeInput): Promise<JudgeVerdict | null> {
    if (!this.env.OPENROUTER_API_KEY) return null;
    return openRouterJudge(this.env.OPENROUTER_API_KEY, models, input);
  }

  /**
   * B-132 (standard A3, A4): grades up to JUDGE_SAMPLE answers the address sent on `day` (not judged
   * before, not redacted), keeps each verdict on its run, and answers the day's quality family from
   * every verdict of the day; null when nothing was judged (no judge, no answer, every call failed).
   */
  protected async judgeDay(address: string, day: string, runs: AgentRun[]): Promise<ReturnType<typeof qualityOf>> {
    const ofDay = runs.filter((r) => r.createdAt.startsWith(day) && r.status === "sent" && r.sent?.body && !r.redacted);
    const todo = ofDay.filter((r) => !r.judgement).slice(0, Math.max(0, JUDGE_SAMPLE - ofDay.filter((r) => r.judgement).length));
    const deps = this.deps(address);
    let calls = 0, failed = 0;
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async (run) => {
        const models = judgesFor(run.model, run.checkedBy);
        if (!models.length) return;
        try {
          const email = await deps.mailbox.email(run.emailId);
          if (!email) return;
          const thread = email.thread_id ? await deps.mailbox.thread(email.thread_id) : [];
          const received = Date.parse(email.date);
          const earlier = thread.filter((m) => m.folder_id === "sent" && Date.parse(m.date) < received).at(-1);
          calls++;
          const verdict = await this.judgeAnswer(models, { message: `${email.subject}\n${deps.htmlToText(email.body)}`,
            earlier: earlier ? deps.htmlToText(earlier.body) : "", answer: run.sent!.body });
          if (!verdict) return;
          run.judgement = verdict;
          this.ctx.storage.sql.exec("UPDATE agent_runs SET body = json_set(body, '$.judgement', json(?)) WHERE id = ?", JSON.stringify(verdict), run.id);
        } catch (error) {
          failed++;
          console.warn(JSON.stringify({ event: "judge_failed", trace: run.id, error: (error as Error).message?.slice(0, 200) }));
        }
      }));
    }
    if (calls) console.log(JSON.stringify({ event: "judge_day", day, calls, failed }));
    return qualityOf(ofDay.flatMap((r) => (r.judgement ? [r.judgement] : [])));
  }

  /** Test seam: one model's bench verdict; production asks OpenRouter (B-152). */
  protected async benchAnswer(model: string, input: JudgeInput, reasoning: boolean): Promise<BenchResult> {
    if (!this.env.OPENROUTER_API_KEY) return { ok: false, checks: null, helped: null, costUsd: null, ms: 0, reasoning, error: "no OpenRouter key on this server" };
    return benchJudge(this.env.OPENROUTER_API_KEY, model, input, reasoning);
  }

  /**
   * B-152: a judge comparison over one address's sent answers. The first call (or restart) picks the
   * newest `runs` answers of the last `days` and one row per answer and model (the reference too);
   * every call grades one slice of rows still open and answers the progress, and the lines once all
   * are graded (paged by offset). A message gone since is counted as gone, not graded.
   */
  async judgeBench(address: string, options: { days?: number; runs?: number; models?: string[]; reference?: string; restart?: boolean; offset?: number }, now = Date.now()) {
    address = address.toLowerCase();
    const reference = options.reference ?? BENCH_REFERENCE;
    const count = () => this.rows("SELECT COUNT(*) AS n, SUM(line IS NULL) AS open FROM judge_bench WHERE address = ?", address)[0]!;
    if (options.restart) this.ctx.storage.sql.exec("DELETE FROM judge_bench WHERE address = ?", address);
    if (!Number(count().n)) {
      const days = Math.min(Math.max(Math.trunc(options.days ?? 30), 1), 90);
      const since = new Date(now - days * 86_400_000).toISOString();
      const all = this.rows("SELECT body FROM agent_runs WHERE mailbox_id = ? AND status = 'sent' AND created_at >= ?", address, since)
        .map((r) => JSON.parse(String(r.body)) as AgentRun);
      const picked = benchRuns(all, since, Math.min(Math.max(Math.trunc(options.runs ?? BENCH_RUNS_DEFAULT), 1), BENCH_RUNS_MAX));
      const models = [...new Set([...(options.models?.length ? options.models : BENCH_MODELS), reference])];
      this.ctx.storage.transactionSync(() => {
        for (const run of picked) for (const model of models)
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO judge_bench (address, run_id, model, line) VALUES (?, ?, ?, NULL)", address, run.id, model);
      });
    }
    const open = this.rows("SELECT run_id, model FROM judge_bench WHERE address = ? AND line IS NULL ORDER BY run_id, model LIMIT ?", address, BENCH_SLICE);
    if (open.length) {
      const deps = this.deps(address);
      const inputs = new Map<string, Promise<{ run: AgentRun; input: JudgeInput } | null>>();
      const inputOf = (runId: string) => {
        if (!inputs.has(runId)) inputs.set(runId, (async () => {
          const [run] = await this.runsByIds([runId]);
          if (!run?.sent?.body || run.redacted) return null;
          const email = await deps.mailbox.email(run.emailId);
          if (!email) return null;
          const thread = email.thread_id ? await deps.mailbox.thread(email.thread_id) : [];
          const received = Date.parse(email.date);
          const earlier = thread.filter((m) => m.folder_id === "sent" && Date.parse(m.date) < received).at(-1);
          return { run, input: { message: `${email.subject}\n${deps.htmlToText(email.body)}`, earlier: earlier ? deps.htmlToText(earlier.body) : "", answer: run.sent.body } };
        })());
        return inputs.get(runId)!;
      };
      await Promise.all(open.map(async (row) => {
        const runId = String(row.run_id), model = String(row.model);
        let line: BenchLine | { gone: true };
        try {
          const found = await inputOf(runId);
          if (!found) line = { gone: true };
          else line = benchLine(await turnHash(address, runId), address, found.run, model, model === reference,
            await this.benchAnswer(model, found.input, model === reference));
        } catch (error) {
          // The mailbox did not answer: left open, graded on a later call.
          console.warn(JSON.stringify({ event: "judge_bench_failed", trace: runId, error: (error as Error).message?.slice(0, 200) }));
          return;
        }
        this.ctx.storage.sql.exec("UPDATE judge_bench SET line = ? WHERE address = ? AND run_id = ? AND model = ?", JSON.stringify(line), address, runId, model);
      }));
    }
    const { n, open: left } = count();
    const lines = this.rows("SELECT line FROM judge_bench WHERE address = ? AND line IS NOT NULL ORDER BY run_id, model", address)
      .map((r) => JSON.parse(String(r.line)) as BenchLine | { gone: true });
    const graded = lines.filter((l): l is BenchLine => !("gone" in l));
    const costUsd = Math.round(graded.reduce((sum, l) => sum + (l.costUsd ?? 0), 0) * 10_000) / 10_000;
    const done = Number(left ?? 0) === 0;
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    return {
      address, reference, total: Number(n), graded: graded.length, gone: lines.length - graded.length, open: Number(left ?? 0), costUsd, done,
      ...(done ? { lines: graded.slice(offset, offset + 500), nextOffset: offset + 500 < graded.length ? offset + 500 : null } : {}),
    };
  }

  /**
   * B-131: escalates, once, each message still waiting for a person WAIT_SLA_MS after it came: a held
   * run, or a drafted one whose conversation has no reply sent after it. B-141: also a run that failed
   * before anything was sent, and one skipped because it looked like an attempt to steer the agent, unless
   * a reply was sent after the message. Answers when the next is due.
   */
  protected async superviseWaiting(now = Date.now()): Promise<number | null> {
    const from = new Date(now - ESCALATE_WITHIN_MS).toISOString();
    const at = new Date(now).toISOString();
    const pending = (where: string, ...args: string[]) => this.rows(`SELECT id, mailbox_id, email_id, body, created_at FROM agent_runs
      WHERE (status IN ('held', 'drafted') OR (status = 'failed' AND json_extract(body, '$.failure') IS NOT NULL)
        OR (status = 'skipped' AND json_extract(body, '$.injection') = 1))
      AND created_at >= ? AND json_extract(body, '$.escalatedAt') IS NULL ${where}
      ORDER BY created_at LIMIT 20`, from, ...args);
    /** Whether a person answered a drafted run: sent the draft or wrote their own reply after the message. */
    const answered = async (run: AgentRun): Promise<boolean> => {
      const box = this.deps(run.mailboxId).mailbox;
      const email = await box.email(run.emailId);
      if (!email) return true;
      const thread = email.thread_id ? await box.thread(email.thread_id) : [];
      const received = Date.parse(email.date);
      return thread.some((m) => m.folder_id === "sent" && Date.parse(m.date) > received);
    };
    const due = "AND (json_extract(body, '$.waitCheckAt') IS NULL OR json_extract(body, '$.waitCheckAt') <= ?)";
    for (const row of pending(`AND created_at <= ? ${due}`, new Date(now - WAIT_SLA_MS).toISOString(), at)) {
      const run = JSON.parse(String(row.body)) as AgentRun;
      let waiting = true;
      if (run.status !== "held") {
        try { waiting = !(await answered(run)); }
        catch (error) {
          // Review 2026-10-21: looked at again later, not on every alarm a second apart.
          console.warn(JSON.stringify({ event: "waiting_check_failed", run: run.id, error: (error as Error).message?.slice(0, 200) }));
          this.ctx.storage.sql.exec("UPDATE agent_runs SET body = json_set(body, '$.waitCheckAt', ?) WHERE id = ?",
            new Date(now + WAIT_CHECK_RETRY_MS).toISOString(), run.id);
          continue;
        }
      }
      run.escalatedAt = at;
      delete run.waitCheckAt;
      if (run.status === "drafted") {
        run.answeredByPerson = !waiting;
        if (waiting) run.personCheckAt = new Date(now + PERSON_CHECK_MS).toISOString();
      }
      this.ctx.storage.transactionSync(() => {
        const written = this.ctx.storage.sql.exec("UPDATE agent_runs SET body = ? WHERE id = ? AND status = ?", JSON.stringify(run), run.id, run.status).rowsWritten;
        // A run that changed meanwhile (answered, sent) is not escalated (review 2026-10-21).
        if (waiting && written === 1) this.appendEvent(run.id, waitingEvent(run, at));
      });
      if (waiting) console.log(JSON.stringify({ event: "agent_waiting_escalated", run: run.id, status: run.status }));
    }
    // Review 2026-10-21: a draft escalated as waiting is looked at again, so a person who answers it
    // later is counted as having answered (answeredByPerson), not as a message nobody took.
    const recheck = () => this.rows(`SELECT body FROM agent_runs WHERE status = 'drafted' AND created_at >= ?
      AND json_extract(body, '$.personCheckAt') IS NOT NULL ORDER BY json_extract(body, '$.personCheckAt') LIMIT 20`, from);
    for (const row of recheck()) {
      const run = JSON.parse(String(row.body)) as AgentRun;
      if (Date.parse(run.personCheckAt!) > now) break;
      let done = false;
      try { done = await answered(run); }
      catch (error) { console.warn(JSON.stringify({ event: "waiting_check_failed", run: run.id, error: (error as Error).message?.slice(0, 200) })); }
      const update = done
        ? "UPDATE agent_runs SET body = json_remove(json_set(body, '$.answeredByPerson', json('true')), '$.personCheckAt') WHERE id = ? AND status = 'drafted'"
        : "UPDATE agent_runs SET body = json_set(body, '$.personCheckAt', ?) WHERE id = ? AND status = 'drafted'";
      if (done) this.ctx.storage.sql.exec(update, run.id);
      else this.ctx.storage.sql.exec(update, new Date(now + PERSON_CHECK_MS).toISOString(), run.id);
    }
    const times = [
      ...pending("").map((r) => {
        const run = JSON.parse(String(r.body)) as AgentRun;
        return Math.max(Date.parse(String(r.created_at)) + WAIT_SLA_MS, run.waitCheckAt ? Date.parse(run.waitCheckAt) : 0);
      }),
      ...recheck().slice(0, 1).map((r) => Date.parse((JSON.parse(String(r.body)) as AgentRun).personCheckAt!)),
    ].filter((t) => Number.isFinite(t));
    return times.length ? Math.max(now + 1000, Math.min(...times)) : null;
  }

  /** Test seam: how a hook is called; production uses the Worker's fetch. */
  protected hookFetch: typeof fetch = (input, init) => fetch(input, init);

  /**
   * B-137: delivers each hook the events of its kinds after its cursor, in order, at most 20 a pass;
   * a refusal waits HOOK_RETRY_MS and an event refused HOOK_MAX_ATTEMPTS times is passed over with a log line.
   * Answers when the next delivery is due, or null with no hook or nothing owed.
   */
  protected async deliverHooks(now = Date.now()): Promise<number | null> {
    const hooks = await readHooks(this.env.BUCKET);
    if (!hooks.length) return null;
    const top = Number(this.rows("SELECT MAX(seq) AS s FROM agent_events")[0]?.s ?? 0);
    let due: number | null = null;
    const soon = (t: number) => { due = due === null ? t : Math.min(due, t); };
    for (const hook of hooks) {
      const key = `hook:${hook.id}`;
      // A hook first seen starts after the newest event: it never receives the history.
      let cursor: HookCursor = (await this.ctx.storage.get<HookCursor>(key)) ?? { after: top, attempts: 0, nextAt: 0 };
      if (cursor.nextAt > now) { soon(cursor.nextAt); await this.ctx.storage.put(key, cursor); continue; }
      const rows = this.rows("SELECT seq, body FROM agent_events WHERE seq > ? ORDER BY seq LIMIT 50", cursor.after);
      let sent = 0;
      for (const row of rows) {
        const seq = Number(row.seq);
        const event = JSON.parse(String(row.body)) as AgentEvent;
        if (!hook.kinds.includes(event.kind)) { cursor = { ...cursor, after: seq }; continue; }
        if (sent >= 20) { soon(now + 1000); break; }
        const result = await sendHook(hook, { id: String(seq), ...event }, this.hookFetch, now);
        if (result.ok) { cursor = { after: seq, attempts: 0, nextAt: 0, lastDeliveredAt: new Date(now).toISOString() }; sent++; continue; }
        const attempts = cursor.attempts + 1;
        console.warn(JSON.stringify({ event: "event_hook_refused", hook: hook.id, seq, attempts, error: result.error }));
        if (attempts >= HOOK_MAX_ATTEMPTS) {
          console.error(JSON.stringify({ event: "event_hook_dropped", hook: hook.id, seq, kind: event.kind }));
          cursor = { ...cursor, after: seq, attempts: 0, nextAt: 0, lastError: result.error };
          continue;
        }
        cursor = { ...cursor, attempts, nextAt: now + HOOK_RETRY_MS[Math.min(attempts - 1, HOOK_RETRY_MS.length - 1)]!, lastError: result.error };
        soon(cursor.nextAt);
        break;
      }
      if (rows.length === 50 && !cursor.nextAt) soon(now + 1000);
      await this.ctx.storage.put(key, cursor);
    }
    return due;
  }

  /** B-137: each hook's delivery state, by hook id (none for a hook no pass has seen yet). */
  async hookStates(ids: string[]): Promise<Record<string, HookCursor>> {
    const out: Record<string, HookCursor> = {};
    for (const id of ids.slice(0, 20)) { const c = await this.ctx.storage.get<HookCursor>(`hook:${id}`); if (c) out[id] = c; }
    return out;
  }

  /** B-137: wakes the delivery at once (a hook just added or tested). */
  async wakeHooks(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > Date.now() + 1000) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /**
   * The agent-events feed (B-118, fabric-service/0.1 events page): after a cursor, the next events
   * oldest first; without one, the newest `limit`. `cursor` is the last id returned, null when empty.
   */
  async listEvents(after?: string | null, limit = 50): Promise<{ events: (AgentEvent & { id: string })[]; cursor: string | null }> {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = after != null && after !== ""
      ? this.rows("SELECT seq, body FROM agent_events WHERE seq > ? ORDER BY seq ASC LIMIT ?", Number(after) || 0, n)
      : this.rows("SELECT seq, body FROM agent_events ORDER BY seq DESC LIMIT ?", n).reverse();
    const events = rows.map((row) => ({ id: String(row.seq), ...(JSON.parse(String(row.body)) as AgentEvent) }));
    return { events, cursor: events.length ? events[events.length - 1]!.id : null };
  }

  /**
   * The history, newest first. `before` is the `cursor` of the last run shown
   * (created_at and id, so runs sharing a timestamp are not skipped); `outcome`
   * narrows to one of RUN_OUTCOMES; `agentId` to one agent.
   */
  /**
   * Answer again (the voice-of-the-customer agent's "hand to the owner"): a run that ended without a
   * sent answer is marked stale and its message queued, so the runner claims it once more as the next
   * attempt and answers by the agent's policy. A sent answer, or one whose send may have happened, is
   * never repeated; a run going on now is left alone.
   */
  async answerAgain(id: string, options: { keepFacts?: boolean } = {}): Promise<{ ok: true; run: AgentRun } | { ok: false; reason: string }> {
    const prior = this.rows("SELECT body FROM agent_runs WHERE id = ?", id)[0];
    if (!prior) return { ok: false, reason: msg("This agent run is not kept any more") };
    const run = JSON.parse(String(prior.body)) as AgentRun;
    if (run.status === "sent") return { ok: false, reason: msg("This message was already answered; it is not sent twice.") };
    if (run.status === "send_unknown" || run.phase === "sending") return { ok: false, reason: msg("This answer may have been sent already; check Sent before answering again.") };
    if (run.status === "running" && Date.now() - Date.parse(run.updatedAt) <= RUN_STALE_MS) return { ok: false, reason: msg("The agent is answering this message now.") };
    const again: AgentRun = { ...run, status: "running", reason: "", attempt: (run.attempt ?? 1) + 1, updatedAt: new Date(0).toISOString() };
    delete again.phase;
    // B-141: a person answering it again wants the model to look, whatever the knowledge's revision.
    if (!options.keepFacts) delete again.heldFacts;
    this.ctx.storage.sql.exec("UPDATE agent_runs SET status = ?, body = ?, updated_at = ? WHERE id = ?", again.status, JSON.stringify(again), again.updatedAt, id);
    await this.enqueue(run.mailboxId, run.emailId);
    return { ok: true, run: this.present(again) };
  }

  /** The runs with these ids (B-115: the inbox page's messages), as the history presents them; unknown ids are left out. */
  async runsByIds(ids: string[]): Promise<AgentRun[]> {
    if (!ids.length) return [];
    const rows = this.rows("SELECT body FROM agent_runs WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids.slice(0, 500)));
    return rows.map((row) => this.present(JSON.parse(String(row.body)) as AgentRun));
  }
  /**
   * Runs per address and UTC day since `since` (B-126), and the oldest run still kept: older runs are
   * pruned (MAX_RUNS_KEPT), so days before it are not counted here.
   */
  async runsPerDay(since: string): Promise<{ counts: { mailboxId: string; day: string; runs: number }[]; keptFrom: string | null }> {
    const counts = this.rows(
      "SELECT mailbox_id, substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM agent_runs WHERE created_at >= ? GROUP BY mailbox_id, day", since)
      .map((r) => ({ mailboxId: String(r.mailbox_id), day: String(r.day), runs: Number(r.n) }));
    const oldest = this.rows("SELECT MIN(created_at) AS t FROM agent_runs")[0]?.t;
    const full = Number(this.rows("SELECT COUNT(*) AS n FROM agent_runs")[0]?.n ?? 0) >= MAX_RUNS_KEPT;
    return { counts, keptFrom: full && typeof oldest === "string" ? oldest : null };
  }

  /**
   * The model calls the reply agents made since `since`, per UTC day and model (B-87 part 4, DEC-0021):
   * from each run's receipts (B-147: tokens and the provider's charge per call) when it has them, else
   * from its call count (B-130), the writer and the checker apart, unpriced and unmeasured.
   */
  async modelUsagePerDay(since: string): Promise<ModelUsageRow[]> {
    const rows = this.rows(`SELECT substr(created_at, 1, 10) AS day, json_extract(body, '$.model') AS model,
      json_extract(body, '$.checkedBy') AS checker, json_extract(body, '$.modelCalls.calls') AS calls, json_extract(body, '$.usage') AS usage
      FROM agent_runs WHERE created_at >= ? AND (json_extract(body, '$.model') IS NOT NULL OR json_extract(body, '$.modelCalls.calls') > 0
        OR json_array_length(json_extract(body, '$.usage')) > 0)`, since);
    const out = new Map<string, ModelUsageRow>();
    const add = (day: string, model: string, part: { calls: number; priced: number; measured: number; inputTokens: number; outputTokens: number; costUsd: number }) => {
      if (part.calls <= 0) return;
      const key = `${day}\u0000${model}`;
      const row = out.get(key) ?? { day, model, calls: 0, unpricedCalls: 0, unmeasuredCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      row.calls += part.calls; row.unpricedCalls += part.calls - part.priced; row.unmeasuredCalls += part.calls - part.measured;
      row.inputTokens += part.inputTokens; row.outputTokens += part.outputTokens; row.costUsd += part.costUsd;
      out.set(key, row);
    };
    const none = { priced: 0, measured: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const r of rows) {
      const day = String(r.day);
      let receipts: { model?: unknown; inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown; measured?: unknown }[] = [];
      try { receipts = typeof r.usage === "string" ? JSON.parse(r.usage) : []; } catch { receipts = []; }
      if (Array.isArray(receipts) && receipts.length) {
        for (const x of receipts) {
          const priced = typeof x.costUsd === "number" && x.costUsd >= 0;
          const measured = x.measured === true;
          add(day, typeof x.model === "string" && x.model ? x.model : "unknown", { calls: 1, priced: priced ? 1 : 0, measured: measured ? 1 : 0,
            inputTokens: measured && typeof x.inputTokens === "number" ? x.inputTokens : 0,
            outputTokens: measured && typeof x.outputTokens === "number" ? x.outputTokens : 0,
            costUsd: priced ? (x.costUsd as number) : 0 });
        }
        continue;
      }
      const writer = typeof r.model === "string" && r.model ? r.model : "unknown";
      const checker = typeof r.checker === "string" && r.checker ? r.checker : null;
      // A run before B-130 counted nothing: its answer was one writer call, and one check when it names a checker.
      const calls = typeof r.calls === "number" ? r.calls : (writer !== "unknown" ? 1 : 0) + (checker ? 1 : 0);
      const checks = checker ? 1 : 0;
      add(day, writer, { calls: Math.max(0, calls - checks), ...none });
      if (checker) add(day, checker, { calls: checks, ...none });
    }
    return [...out.values()].sort((a, b) => (a.day === b.day ? a.model.localeCompare(b.model) : a.day.localeCompare(b.day)));
  }

  async listRuns(options: { mailboxId?: string; limit?: number; before?: string; outcome?: RunOutcome; agentId?: string } = {}): Promise<AgentRun[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (options.mailboxId) { where.push("mailbox_id = ?"); args.push(options.mailboxId.toLowerCase()); }
    if (options.agentId) { where.push("json_extract(body, '$.agentId') = ?"); args.push(options.agentId); }
    if (options.outcome === "unanswered") where.push("json_extract(body, '$.unanswered') = 1");
    else if (options.outcome) {
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
        ? msg("Processing stopped while sending. Check Sent before answering.")
        : msg("Processing stopped before a result was recorded; it is run again automatically.") };
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
  /** Counts one send for the address today; refused at the limit. A null limit counts and never refuses. */
  async reserveSend(mailboxId: string, limit: number | null, day = new Date().toISOString().slice(0, 10)): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const box = mailboxId.toLowerCase();
      const count = Number(this.rows("SELECT count FROM agent_send_counts WHERE day = ? AND mailbox_id = ?", day, box)[0]?.count ?? 0);
      if (limit !== null && count >= limit) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO agent_send_counts (day, mailbox_id, count) VALUES (?, ?, 1) ON CONFLICT(day, mailbox_id) DO UPDATE SET count = count + 1",
        day, box);
      this.ctx.storage.sql.exec("DELETE FROM agent_send_counts WHERE day < ?", new Date(Date.parse(day) - 7 * 86_400_000).toISOString().slice(0, 10));
      return true;
    });
  }
}
