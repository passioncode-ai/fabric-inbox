import { EVENTS_KEPT, EVENTS_KEPT_MS, runEvent, type AgentEvent } from "./events";
import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { AGENT_REGISTRY_STEPS } from "./schema";
import type { Env } from "../types";
import { validateToolUrl } from "../automation/policy";
import {
  AgentInputSchema,
  agentId,
  grantSchemaProblems,
  SCHEMA_LIMIT,
  type AgentInput,
  type AgentSummary,
  type AgentVersion,
  type ToolGrant,
} from "./definition";
import { RUN_OUTCOMES, runIdFor, type AgentRun, type RunOutcome } from "./run";
import { runAgent, type RunnerDeps } from "./runner";
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
    const deps: RunnerDeps = {
      ...real,
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

  /** Held runs due another try go back to the queue (answer_again); answers when the next one is due. */
  protected async retryHeld(now = Date.now()): Promise<number | null> {
    const since = new Date(now - HELD_FOR_MS).toISOString();
    const rows = this.rows("SELECT id, created_at, updated_at FROM agent_runs WHERE status = 'held' AND created_at >= ? ORDER BY updated_at LIMIT 20", since);
    let next: number | null = null;
    for (const row of rows) {
      const age = now - Date.parse(String(row.created_at));
      const due = Date.parse(String(row.updated_at)) + (age < HELD_FAST_MS ? HELD_RETRY_MS : HELD_LATE_RETRY_MS);
      if (due <= now) {
        const result = await this.answerAgain(String(row.id));
        if (!result.ok) console.warn(JSON.stringify({ event: "held_retry_refused", run: row.id, reason: result.reason }));
      } else if (next === null || due < next) next = due;
    }
    return next;
  }

  private async drain() {
    const heldDue = await this.retryHeld().catch((error) => {
      console.warn(JSON.stringify({ event: "held_retry_failed", error: (error as Error).message?.slice(0, 200) }));
      return null;
    });
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
            status: "failed", reason: msg("The message could not be read for its agent after {attempts} attempts ({error}); it is left for you in the inbox.", { attempts, error: (error as Error).message.slice(0, 160) }),
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
      await this.ctx.storage.setAlarm(heldDue !== null ? Math.min(soonest, heldDue) : soonest);
    } else if (heldDue !== null) {
      // Nothing queued, but a held message is due another try then.
      await this.ctx.storage.setAlarm(heldDue);
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
        const again = { ...run, createdAt: prior.createdAt, ...(prior.attempt ? { attempt: prior.attempt } : {}), rerun: true };
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
      // B-118: a run that just ended (its status changed to a final one) appends one event.
      const event = before !== run.status ? runEvent(run) : null;
      if (event) {
        this.ctx.storage.sql.exec("INSERT INTO agent_events (run_id, at, body) VALUES (?, ?, ?)", run.id, event.at, JSON.stringify(event));
        this.ctx.storage.sql.exec(
          "DELETE FROM agent_events WHERE seq <= (SELECT seq FROM agent_events ORDER BY seq DESC LIMIT 1 OFFSET ?) AND at < ?",
          EVENTS_KEPT, new Date(Date.now() - EVENTS_KEPT_MS).toISOString());
      }
    });
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
  async answerAgain(id: string): Promise<{ ok: true; run: AgentRun } | { ok: false; reason: string }> {
    const prior = this.rows("SELECT body FROM agent_runs WHERE id = ?", id)[0];
    if (!prior) return { ok: false, reason: msg("This agent run is not kept any more") };
    const run = JSON.parse(String(prior.body)) as AgentRun;
    if (run.status === "sent") return { ok: false, reason: msg("This message was already answered; it is not sent twice.") };
    if (run.status === "send_unknown" || run.phase === "sending") return { ok: false, reason: msg("This answer may have been sent already; check Sent before answering again.") };
    if (run.status === "running" && Date.now() - Date.parse(run.updatedAt) <= RUN_STALE_MS) return { ok: false, reason: msg("The agent is answering this message now.") };
    const again: AgentRun = { ...run, status: "running", reason: "", attempt: (run.attempt ?? 1) + 1, updatedAt: new Date(0).toISOString() };
    delete again.phase;
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
