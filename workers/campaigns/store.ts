import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { CAMPAIGNS_STEPS } from "./schema";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import {
  CampaignInputSchema, campaignProblem, MAX_RECIPIENTS, normaliseRecipient, plan, render, suppressed, suppressionEntry,
  type CampaignInput, type RecipientInput,
} from "../../shared/mail/campaign";

/**
 * B-181 (SCN-089): the workspace's outreach campaigns, their recipients and the suppression list. Step 1 of the plan
 * (docs/app-store/tasks/2026-10-27-outreach.md) prepares, previews and dry-runs a campaign; nothing here sends.
 */
export type CampaignState = "draft" | "running" | "paused" | "stopped" | "finished";
export interface Campaign extends CampaignInput { id: string; state: CampaignState; version: number; createdAt: string; updatedAt: string }
/** An error loses its class over RPC; its code travels as the message's prefix (as categories' do). */
const CODE = { 400: "invalid", 404: "not_found", 409: "conflict" } as const;
class CampaignError extends Error { constructor(status: 400 | 404 | 409, message: string) { super(`${CODE[status]}: ${message}`); } }

type Row = Record<string, string | number | null>;
const toCampaign = (r: Row): Campaign => ({ ...(JSON.parse(String(r.body)) as CampaignInput), id: String(r.id), state: String(r.state) as CampaignState,
  version: Number(r.version), createdAt: String(r.created_at), updatedAt: String(r.updated_at) });

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
