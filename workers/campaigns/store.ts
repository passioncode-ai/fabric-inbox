import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { CAMPAIGNS_STEPS } from "./schema";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import {
  BOUNCE_PAUSE, CampaignInputSchema, campaignProblem, companyOf, composeStep, inboundKind, inWindow, MAX_RECIPIENTS, nextInWindow,
  normaliseRecipient, plan, RAMP, rampedCap, render, suppressed, suppressionEntry, type CampaignInput, type RecipientInput,
} from "../../shared/mail/campaign";

const DAY = 86_400_000;
/** Recipients a step may still go to; everyone else has finished, one way or another. */
const OPEN = "('queued', 'active')";
const bare = (value: string) => (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
/** A send's idempotency key: the same campaign, person and step never leave twice, whatever is retried. */
async function sendKey(campaignId: string, email: string, step: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${campaignId}\n${email}\n${step}`)));
  return "campaign:" + [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
type Accounts = { send(accountId: string, request: Record<string, unknown>, options?: { listUnsubscribe?: string }): Promise<{ status: string; threadId?: string; providerMessageId?: string; error?: string }>;
  listAccounts(): Promise<{ accounts: { id: string; provider?: string; email: string }[] }> };

/**
 * B-181 (SCN-089): the workspace's outreach campaigns, their recipients and the suppression list. Step 1 of the plan
 * (docs/app-store/tasks/2026-10-27-outreach.md) prepares, previews and dry-runs a campaign; nothing here sends.
 */
export type CampaignState = "draft" | "running" | "paused" | "stopped" | "finished";
export interface Campaign extends CampaignInput { id: string; state: CampaignState; version: number; createdAt: string; updatedAt: string; reason: string; launchedAt: string | null }
/** An error loses its class over RPC; its code travels as the message's prefix (as categories' do). */
const CODE = { 400: "invalid", 404: "not_found", 409: "conflict" } as const;
class CampaignError extends Error { constructor(status: 400 | 404 | 409, message: string) { super(`${CODE[status]}: ${message}`); } }

type Row = Record<string, string | number | null>;
const toCampaign = (r: Row): Campaign => ({ ...(JSON.parse(String(r.body)) as CampaignInput), id: String(r.id), state: String(r.state) as CampaignState,
  version: Number(r.version), createdAt: String(r.created_at), updatedAt: String(r.updated_at), reason: String(r.reason ?? ""),
  launchedAt: Number(r.launched_at) ? new Date(Number(r.launched_at)).toISOString() : null });

export class CampaignsDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrateSchema(ctx.storage, CAMPAIGNS_STEPS, "CampaignsDO");
  }
  private rows(query: string, ...bindings: unknown[]): Row[] { return this.sql.exec(query, ...bindings).toArray() as Row[]; }

  async listCampaigns(): Promise<(Campaign & { counts: Record<string, number> })[]> {
    return this.rows("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 200").map((r) => ({ ...toCampaign(r), counts: this.counts(String(r.id)) }));
  }
  private counts(id: string): Record<string, number> {
    return Object.fromEntries(this.rows("SELECT status, COUNT(*) AS n FROM recipients WHERE campaign_id = ? GROUP BY status", id).map((r) => [String(r.status), Number(r.n)]));
  }
  async getCampaign(id: string): Promise<(Campaign & { counts: Record<string, number> }) | null> {
    const r = this.rows("SELECT * FROM campaigns WHERE id = ?", id)[0];
    return r ? { ...toCampaign(r), counts: this.counts(id) } : null;
  }

  /** Creates a campaign (no `id`) or changes a draft (`id` and the version read); a running one is not edited here. */
  async saveCampaign(input: unknown, id?: string, expectedVersion?: number): Promise<Campaign> {
    const parsed = CampaignInputSchema.safeParse(input);
    if (!parsed.success) throw new CampaignError(400, msg("The campaign is not complete: {problem}", { problem: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) }));
    const problem = campaignProblem(parsed.data);
    if (problem) throw new CampaignError(400, problem);
    const now = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      if (!id) {
        if (Number(this.rows("SELECT COUNT(*) AS n FROM campaigns")[0]!.n) >= 200) throw new CampaignError(409, msg("At most 200 campaigns; delete one first."));
        const newId = crypto.randomUUID();
        this.sql.exec("INSERT INTO campaigns (id, body, state, version, created_at, updated_at) VALUES (?, ?, 'draft', 1, ?, ?)", newId, JSON.stringify(parsed.data), now, now);
        return toCampaign(this.rows("SELECT * FROM campaigns WHERE id = ?", newId)[0]!);
      }
      const old = this.rows("SELECT * FROM campaigns WHERE id = ?", id)[0];
      if (!old) throw new CampaignError(404, msg("No such campaign."));
      if (String(old.state) !== "draft") throw new CampaignError(409, msg("Only a draft campaign can be changed."));
      if (expectedVersion !== undefined && Number(old.version) !== expectedVersion) throw new CampaignError(409, msg("The campaign changed since it was read; read it again."));
      this.sql.exec("UPDATE campaigns SET body = ?, version = version + 1, updated_at = ? WHERE id = ?", JSON.stringify(parsed.data), now, id);
      return toCampaign(this.rows("SELECT * FROM campaigns WHERE id = ?", id)[0]!);
    });
  }

  async deleteCampaign(id: string): Promise<boolean> {
    const old = this.rows("SELECT state FROM campaigns WHERE id = ?", id)[0];
    if (!old) return false;
    if (String(old.state) === "running") throw new CampaignError(409, msg("Pause the campaign before deleting it."));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM recipients WHERE campaign_id = ?", id);
      this.sql.exec("DELETE FROM campaigns WHERE id = ?", id);
    });
    return true;
  }

  /** Adds recipients; one suppressed, repeated, invalid or over the limit is left out and counted with why. */
  async addRecipients(id: string, list: RecipientInput[]): Promise<{ added: number; skipped: { email: string; why: "invalid" | "suppressed" | "repeat" | "limit" }[] }> {
    if (!this.rows("SELECT 1 FROM campaigns WHERE id = ?", id).length) throw new CampaignError(404, msg("No such campaign."));
    const suppression = this.suppressionSet();
    const skipped: { email: string; why: "invalid" | "suppressed" | "repeat" | "limit" }[] = [];
    let added = 0;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      let total = Number(this.rows("SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?", id)[0]!.n);
      for (const raw of list.slice(0, MAX_RECIPIENTS)) {
        const r = normaliseRecipient(raw);
        if (!r) { skipped.push({ email: String(raw?.email ?? "").slice(0, 254), why: "invalid" }); continue; }
        if (suppressed(r.email, suppression)) { skipped.push({ email: r.email, why: "suppressed" }); continue; }
        if (total >= MAX_RECIPIENTS) { skipped.push({ email: r.email, why: "limit" }); continue; }
        const inserted = this.changed("INSERT OR IGNORE INTO recipients (campaign_id, email, fields, status, added_at) VALUES (?, ?, ?, 'queued', ?) RETURNING 1",
          id, r.email, JSON.stringify(r.fields), now);
        if (inserted) { added++; total++; } else skipped.push({ email: r.email, why: "repeat" });
      }
    });
    return { added, skipped: skipped.slice(0, 200) };
  }

  async listRecipients(id: string, options: { status?: string; limit?: number; offset?: number } = {}): Promise<{ recipients: { email: string; fields: Record<string, string>; status: string; step: number; detail: string }[]; total: number }> {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const where = options.status ? "campaign_id = ? AND status = ?" : "campaign_id = ?";
    const args = options.status ? [id, options.status] : [id];
    return {
      recipients: this.rows(`SELECT * FROM recipients WHERE ${where} ORDER BY added_at, email LIMIT ? OFFSET ?`, ...args, limit, Math.max(0, options.offset ?? 0))
        .map((r) => ({ email: String(r.email), fields: JSON.parse(String(r.fields)), status: String(r.status), step: Number(r.step), detail: String(r.detail) })),
      total: Number(this.rows(`SELECT COUNT(*) AS n FROM recipients WHERE ${where}`, ...args)[0]!.n),
    };
  }

  async removeRecipients(id: string, emails: string[]): Promise<number> {
    let n = 0;
    for (const e of emails.slice(0, 500)) n += this.changed("DELETE FROM recipients WHERE campaign_id = ? AND email = ? AND status = 'queued' RETURNING 1", id, e.trim().toLowerCase());
    return n;
  }

  /** Each step as one recipient gets it, and the fields every step needs that some recipients lack (up to 20 named). */
  async preview(id: string, email?: string): Promise<{ recipient: string | null; steps: { subject: string; body: string; missing: string[] }[]; lacking: { field: string; recipients: number; examples: string[] }[] }> {
    const c = await this.getCampaign(id);
    if (!c) throw new CampaignError(404, msg("No such campaign."));
    const one = (email ? this.rows("SELECT * FROM recipients WHERE campaign_id = ? AND email = ?", id, email.trim().toLowerCase())
      : this.rows("SELECT * FROM recipients WHERE campaign_id = ? ORDER BY added_at LIMIT 1", id))[0];
    const fields = one ? JSON.parse(String(one.fields)) as Record<string, string> : {};
    const steps = c.steps.map((s) => { const subject = render(s.subject, fields), body = render(s.body, fields);
      return { subject: subject.text, body: body.text, missing: [...new Set([...subject.missing, ...body.missing])] }; });
    const lacking = new Map<string, string[]>();
    for (const r of this.rows("SELECT email, fields FROM recipients WHERE campaign_id = ? LIMIT ?", id, MAX_RECIPIENTS)) {
      const f = JSON.parse(String(r.fields)) as Record<string, string>;
      for (const s of c.steps) for (const m of [...render(s.subject, f).missing, ...render(s.body, f).missing]) {
        const list = lacking.get(m) ?? [];
        if (!list.includes(String(r.email))) list.push(String(r.email));
        lacking.set(m, list);
      }
    }
    return { recipient: one ? String(one.email) : null, steps,
      lacking: [...lacking.entries()].map(([field, list]) => ({ field, recipients: list.length, examples: list.slice(0, 20) })) };
  }

  /** What the first step would do from now: when each of the first queued recipients would get it, sending nothing. */
  async dryRun(id: string, count = 50, now = Date.now()): Promise<{ sender: string; sends: { email: string; at: string }[]; queued: number }> {
    const c = await this.getCampaign(id);
    if (!c) throw new CampaignError(404, msg("No such campaign."));
    const queued = this.rows("SELECT email FROM recipients WHERE campaign_id = ? AND status = 'queued' ORDER BY added_at LIMIT ?", id, Math.min(100, count));
    const times = plan(c, queued.length, now);
    return { sender: c.sender, sends: queued.map((r, i) => ({ email: String(r.email), at: new Date(times[i] ?? now).toISOString() })),
      queued: Number(this.rows("SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND status = 'queued'", id)[0]!.n) };
  }

  // ── Step 2 of the plan: sending (B-181) ──

  /** Starts a draft or resumes a paused campaign: its queued recipients become due now, and the loop wakes. */
  async launch(id: string, now = Date.now()): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (!c) throw new CampaignError(404, msg("No such campaign."));
    if (c.state !== "draft" && c.state !== "paused") throw new CampaignError(409, msg("Only a draft or a paused campaign can be started."));
    if (!this.rows(`SELECT 1 FROM recipients WHERE campaign_id = ? AND status IN ${OPEN} LIMIT 1`, id).length)
      throw new CampaignError(409, msg("The campaign has nobody left to write to."));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE recipients SET next_at = ? WHERE campaign_id = ? AND status = 'queued' AND next_at IS NULL", now, id);
      this.sql.exec("UPDATE campaigns SET state = 'running', reason = '', launched_at = CASE WHEN launched_at = 0 THEN ? ELSE launched_at END, updated_at = ? WHERE id = ?",
        now, new Date(now).toISOString(), id);
    });
    await this.schedule(now);
    return (await this.getCampaign(id))!;
  }
  /** Holds a running campaign; nothing is lost, and `launch` resumes it. */
  async pause(id: string, reason = "person"): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (!c) throw new CampaignError(404, msg("No such campaign."));
    if (c.state !== "running") throw new CampaignError(409, msg("Only a running campaign can be paused."));
    this.sql.exec("UPDATE campaigns SET state = 'paused', reason = ?, updated_at = ? WHERE id = ?", reason.slice(0, 200), new Date().toISOString(), id);
    return (await this.getCampaign(id))!;
  }
  /** Ends a campaign for good: whoever was still to be written to is not. */
  async stop(id: string): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (!c) throw new CampaignError(404, msg("No such campaign."));
    if (c.state === "stopped" || c.state === "finished") return c;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE recipients SET status = 'stopped', detail = 'campaign_stopped' WHERE campaign_id = ? AND status IN ${OPEN}`, id);
      this.sql.exec("UPDATE campaigns SET state = 'stopped', updated_at = ? WHERE id = ?", new Date().toISOString(), id);
    });
    return (await this.getCampaign(id))!;
  }

  /** What a campaign did: recipients by status, sends per step, replies, stops and bounces, and when the next send may leave. */
  async report(id: string, now = Date.now()): Promise<{ campaign: Campaign & { counts: Record<string, number> }; sent: number; perStep: number[];
    contacted: number; replyRate: number | null; bounceRate: number | null; lastSentAt: string | null; nextSendAt: string | null; failures: { email: string; detail: string }[] }> {
    const c = await this.getCampaign(id);
    if (!c) throw new CampaignError(404, msg("No such campaign."));
    const perStep = c.steps.map((_, i) => Number(this.rows("SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ? AND step = ? AND status = 'sent'", id, i)[0]!.n));
    const contacted = Number(this.rows("SELECT COUNT(DISTINCT email) AS n FROM sends WHERE campaign_id = ? AND status = 'sent'", id)[0]!.n);
    const last = this.rows("SELECT MAX(at) AS at FROM sends WHERE campaign_id = ? AND status = 'sent'", id)[0]?.at;
    const next = c.state === "running" ? this.nextFor(c, now) : null;
    return { campaign: c, sent: perStep.reduce((a, b) => a + b, 0), perStep, contacted,
      replyRate: contacted ? ((c.counts.replied ?? 0) + (c.counts.unsubscribed ?? 0)) / contacted : null,
      bounceRate: contacted ? (c.counts.bounced ?? 0) / contacted : null,
      lastSentAt: last ? new Date(Number(last)).toISOString() : null, nextSendAt: next ? new Date(next).toISOString() : null,
      failures: this.rows("SELECT email, detail FROM recipients WHERE campaign_id = ? AND status = 'failed' ORDER BY added_at LIMIT 50", id)
        .map((r) => ({ email: String(r.email), detail: String(r.detail) })) };
  }

  /** The loop: each account sends at most one message per wake, inside its campaigns' windows, caps and gaps. */
  async alarm() { await this.tick(); }
  private ticking = false;
  /** `jitter` (0 to 1) fixes where in the gap range the next send lands; a test passes it, the alarm leaves it random. */
  async tick(now = Date.now(), jitter?: number): Promise<{ sent: number }> {
    const random = jitter === undefined ? Math.random : () => jitter;
    if (this.ticking) return { sent: 0 };
    this.ticking = true;
    let sent = 0;
    try {
      const running = this.rows("SELECT * FROM campaigns WHERE state = 'running' ORDER BY launched_at").map(toCampaign);
      const accounts = this.env.GMAIL_ACCOUNTS ? (this.env.GMAIL_ACCOUNTS.getByName("workspace") as unknown as Accounts) : null;
      if (running.length && !accounts) { console.error(JSON.stringify({ event: "campaigns_no_accounts" })); return { sent }; }
      let emails: Map<string, string> | undefined;
      for (const sender of [...new Set(running.map((c) => c.sender))]) {
        const s = this.senderRow(sender);
        if (s.next_at > now) continue;
        for (const c of running.filter((x) => x.sender === sender)) {
          if (!inWindow(c, now) || this.sentToday(sender, now) >= rampedCap(c.dailyCap, s.first_at, now)) continue;
          const r = this.rows(`SELECT * FROM recipients WHERE campaign_id = ? AND status IN ${OPEN} AND next_at <= ? ORDER BY next_at, added_at LIMIT 1`, c.id, now)[0];
          if (!r) continue;
          if (suppressed(String(r.email), this.suppressionSet())) {
            this.sql.exec("UPDATE recipients SET status = 'suppressed' WHERE campaign_id = ? AND email = ?", c.id, r.email);
            continue;
          }
          emails ??= new Map((await accounts!.listAccounts()).accounts.map((a) => [`${a.provider ?? "gmail"}:${a.id}`, a.email] as [string, string]));
          const from = emails.get(sender);
          if (!from) { await this.pause(c.id, "sender_not_connected"); continue; }
          const outcome = await this.sendOne(accounts!, c, r, from, now);
          if (outcome === "sent") {
            sent++;
            const [lo, hi] = c.gapMinutes;
            this.sql.exec("INSERT INTO senders (sender, next_at, first_at) VALUES (?, ?, ?) ON CONFLICT(sender) DO UPDATE SET next_at = excluded.next_at, first_at = CASE WHEN senders.first_at = 0 THEN excluded.first_at ELSE senders.first_at END",
              sender, now + Math.round((lo + random() * (hi - lo)) * 60_000), now);
          } else if (outcome === "rate_limited") {
            this.sql.exec("INSERT INTO senders (sender, next_at) VALUES (?, ?) ON CONFLICT(sender) DO UPDATE SET next_at = excluded.next_at", sender, now + 60 * 60_000);
          }
          break;
        }
      }
      // A running campaign with nobody left to write to has finished.
      for (const c of running)
        if (!this.rows(`SELECT 1 FROM recipients WHERE campaign_id = ? AND status IN ${OPEN} LIMIT 1`, c.id).length)
          this.sql.exec("UPDATE campaigns SET state = 'finished', updated_at = ? WHERE id = ? AND state = 'running'", new Date(now).toISOString(), c.id);
    } finally {
      this.ticking = false;
      await this.schedule(now).catch((error) => console.error(JSON.stringify({ event: "campaigns_schedule_failed", error: String(error).slice(0, 200) })));
    }
    if (sent) console.log(JSON.stringify({ event: "campaigns_sent", sent }));
    return { sent };
  }

  private senderRow(sender: string): { next_at: number; first_at: number } {
    const r = this.rows("SELECT next_at, first_at FROM senders WHERE sender = ?", sender)[0];
    return { next_at: Number(r?.next_at ?? 0), first_at: Number(r?.first_at ?? 0) };
  }
  private sentToday(sender: string, now: number): number {
    return Number(this.rows("SELECT COUNT(*) AS n FROM sends WHERE sender = ? AND at > ? AND status = 'sent'", sender, now - DAY)[0]!.n);
  }

  /** One message through the account's own send; the same campaign, person and step never leave twice. */
  private async sendOne(accounts: Accounts, c: Campaign, r: Row, from: string, now: number): Promise<"sent" | "failed" | "rate_limited"> {
    const email = String(r.email), index = Number(r.step);
    const { subject, text } = composeStep(c, index, JSON.parse(String(r.fields)), String(r.subject));
    const followUp = index > 0 && String(r.thread_id) && c.sender.startsWith("gmail:") ? { threadId: String(r.thread_id) } : {};
    const request = { to: [email], subject, text, idempotencyKey: await sendKey(c.id, email, index), ...followUp };
    let receipt: Awaited<ReturnType<Accounts["send"]>>;
    try {
      receipt = await accounts.send(c.sender.slice(c.sender.indexOf(":") + 1), request, { listUnsubscribe: `mailto:${from}?subject=unsubscribe` });
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      if (/rate_limit|rate limit|ratelimit|429|quota/i.test(text)) return "rate_limited";
      if (/account_not_found|not_connected|reauth|invalid_grant|unauthor/i.test(text)) { await this.pause(c.id, "sender_needs_attention"); return "failed"; }
      return this.failed(c, email, index, now, text.slice(0, 200));
    }
    if (receipt.status !== "accepted") {
      if (/rate_limit|rate limit|ratelimit|429|quota/i.test(receipt.error ?? "")) return "rate_limited";
      // An outcome nobody knows is never sent again: the same key would only answer the same receipt.
      return this.failed(c, email, index, now, receipt.error ?? receipt.status);
    }
    const nextIndex = index + 1, more = nextIndex < c.steps.length;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO sends (campaign_id, email, step, sender, at, status) VALUES (?, ?, ?, ?, ?, 'sent')", c.id, email, index, c.sender, now);
      this.sql.exec(`UPDATE recipients SET step = ?, status = ?, next_at = ?, thread_id = CASE WHEN thread_id = '' THEN ? ELSE thread_id END,
        subject = CASE WHEN subject = '' THEN ? ELSE subject END, detail = '' WHERE campaign_id = ? AND email = ?`,
        nextIndex, more ? "active" : "done", more ? now + c.steps[nextIndex]!.delayDays * DAY : null, receipt.threadId ?? "", subject, c.id, email);
    });
    return "sent";
  }
  private failed(c: Campaign, email: string, index: number, now: number, detail: string): "failed" {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO sends (campaign_id, email, step, sender, at, status, detail) VALUES (?, ?, ?, ?, ?, 'failed', ?)", c.id, email, index, c.sender, now, detail);
      this.sql.exec("UPDATE recipients SET status = 'failed', detail = ? WHERE campaign_id = ? AND email = ?", detail, c.id, email);
    });
    console.warn(JSON.stringify({ event: "campaign_send_failed", detail }));
    return "failed";
  }

  /** When the loop should wake next: the soonest due send of any running campaign, inside its window, cap and gap. */
  private nextFor(c: Campaign, now: number): number | null {
    const due = this.rows(`SELECT MIN(next_at) AS at FROM recipients WHERE campaign_id = ? AND status IN ${OPEN}`, c.id)[0]?.at;
    if (due === null || due === undefined) return null;
    let at = Math.max(Number(due), this.senderRow(c.sender).next_at, now);
    const day = this.rows("SELECT at FROM sends WHERE sender = ? AND at > ? AND status = 'sent' ORDER BY at", c.sender, at - DAY).map((x) => Number(x.at));
    const cap = rampedCap(c.dailyCap, this.senderRow(c.sender).first_at, at);
    if (day.length >= cap) at = Math.max(at, day[day.length - cap]! + DAY);
    return nextInWindow(c, at);
  }
  private async schedule(now: number) {
    const times = this.rows("SELECT * FROM campaigns WHERE state = 'running'").map(toCampaign).map((c) => this.nextFor(c, now)).filter((t): t is number => t !== null);
    if (!times.length) { await this.ctx.storage.deleteAlarm(); return; }
    const next = Math.max(Math.min(...times), now + 30_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next || current < now) await this.ctx.storage.setAlarm(next);
  }

  /**
   * B-181: a message that arrived in an account campaigns send from. A reply stops that person (and, with companyStop,
   * the rest of their company); "unsubscribe" also puts them on the do-not-write list; an automatic reply moves their
   * next step three days on; a bounce stops them and pauses the campaign when bounces reach 5%.
   */
  async inbound(account: string, m: { sender: string; subject: string; body: string; threadId?: string }, now = Date.now()): Promise<{ kind: string; matched: number }> {
    const ids = this.rows("SELECT id FROM campaigns WHERE lower(json_extract(body, '$.sender')) = ? AND state != 'draft'", account.toLowerCase()).map((r) => String(r.id));
    if (!ids.length) return { kind: "none", matched: 0 };
    const kind = inboundKind(m);
    const marks = ids.map(() => "?").join(", ");
    const from = bare(m.sender);
    let rows = this.rows(`SELECT * FROM recipients WHERE campaign_id IN (${marks}) AND (email = ?${m.threadId ? " OR (thread_id != '' AND thread_id = ?)" : ""})`,
      ...ids, from, ...(m.threadId ? [m.threadId] : []));
    if (!rows.length && kind === "bounce") {
      // A bounce comes from the mail system and names the address it could not deliver to.
      const body = `${m.subject}\n${m.body}`.toLowerCase();
      rows = this.rows(`SELECT * FROM recipients WHERE campaign_id IN (${marks}) AND status IN ('active', 'done')`, ...ids).filter((r) => body.includes(String(r.email)));
    }
    if (!rows.length) return { kind, matched: 0 };
    for (const r of rows) {
      const c = toCampaign(this.rows("SELECT * FROM campaigns WHERE id = ?", r.campaign_id)[0]!);
      const email = String(r.email);
      if (kind === "auto") {
        this.sql.exec(`UPDATE recipients SET next_at = MAX(COALESCE(next_at, 0), ?) WHERE campaign_id = ? AND email = ? AND status IN ${OPEN}`, now + 3 * DAY, c.id, email);
        continue;
      }
      if (kind === "bounce") {
        this.sql.exec("UPDATE recipients SET status = 'bounced', detail = '' WHERE campaign_id = ? AND email = ?", c.id, email);
        const contacted = Number(this.rows("SELECT COUNT(DISTINCT email) AS n FROM sends WHERE campaign_id = ? AND status = 'sent'", c.id)[0]!.n);
        const bounced = Number(this.rows("SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND status = 'bounced'", c.id)[0]!.n);
        if (c.state === "running" && contacted >= RAMP.start && bounced / contacted >= BOUNCE_PAUSE) await this.pause(c.id, "bounces");
        continue;
      }
      if (kind === "unsubscribe") {
        await this.addSuppression([email], "replied_unsubscribe");
        this.sql.exec("UPDATE recipients SET status = 'unsubscribed' WHERE email = ? AND status IN ('queued', 'active', 'done', 'suppressed')", email);
        continue;
      }
      // A reply: with stopOnReply (the default) nothing more goes to them; without it the reply is only noted.
      if (c.stopOnReply) this.sql.exec("UPDATE recipients SET status = 'replied', detail = '' WHERE campaign_id = ? AND email = ? AND status IN ('queued', 'active', 'done')", c.id, email);
      else this.sql.exec("UPDATE recipients SET detail = 'replied' WHERE campaign_id = ? AND email = ?", c.id, email);
      const company = companyOf(email);
      if (c.companyStop && company)
        this.sql.exec(`UPDATE recipients SET status = 'stopped', detail = 'company_replied' WHERE campaign_id = ? AND status IN ${OPEN} AND email != ? AND (email LIKE ? OR email LIKE ?)`,
          c.id, email, `%@${company}`, `%.${company}`);
    }
    console.log(JSON.stringify({ event: "campaign_inbound", kind, matched: rows.length }));
    return { kind, matched: rows.length };
  }

  /** Rows a statement changed; `rowsWritten` would also count the index rows it wrote. */
  private changed(query: string, ...args: unknown[]): number { return this.sql.exec(query, ...args).toArray().length; }
  private suppressionSet(): Set<string> { return new Set(this.rows("SELECT value FROM suppression").map((r) => String(r.value))); }
  async listSuppression(): Promise<{ value: string; reason: string; addedAt: string }[]> {
    return this.rows("SELECT * FROM suppression ORDER BY added_at DESC LIMIT 5000").map((r) => ({ value: String(r.value), reason: String(r.reason), addedAt: new Date(Number(r.added_at)).toISOString() }));
  }
  /** Adds addresses or domains; queued recipients they cover leave every campaign at once. */
  async addSuppression(values: string[], reason: string): Promise<{ added: string[]; invalid: string[]; removedRecipients: number }> {
    const added: string[] = [], invalid: string[] = [];
    let removedRecipients = 0;
    this.ctx.storage.transactionSync(() => {
      for (const v of values.slice(0, 1000)) {
        const entry = suppressionEntry(v);
        if (!entry) { invalid.push(v.slice(0, 254)); continue; }
        this.sql.exec("INSERT OR REPLACE INTO suppression (value, reason, added_at) VALUES (?, ?, ?)", entry, reason.slice(0, 200), Date.now());
        added.push(entry);
      }
      const list = this.suppressionSet();
      for (const r of this.rows("SELECT campaign_id, email FROM recipients WHERE status = 'queued'"))
        if (suppressed(String(r.email), list)) removedRecipients += this.changed("UPDATE recipients SET status = 'suppressed' WHERE campaign_id = ? AND email = ? RETURNING 1", r.campaign_id, r.email);
    });
    return { added, invalid, removedRecipients };
  }
  async removeSuppression(values: string[]): Promise<number> {
    let n = 0;
    for (const v of values.slice(0, 1000)) n += this.changed("DELETE FROM suppression WHERE value = ? RETURNING 1", suppressionEntry(v) ?? v);
    return n;
  }
}
