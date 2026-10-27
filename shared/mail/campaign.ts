import { z } from "zod";
import { msg } from "../i18n";

/**
 * B-181 (SCN-089): an outreach campaign, as the person or their agent prepares it. Pure: the store keeps it, the
 * routes and tools read and write it, tests run it. The defaults are human-paced (docs/app-store/tasks/
 * 2026-10-27-outreach.md, decision 2, with their sources in the research).
 */
export const CAMPAIGN_DEFAULTS = { dailyCap: 30, maxDailyCap: 50, gapMinutes: [5, 10] as [number, number], days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", followUpDays: 3 };
export const MAX_STEPS = 4;
export const MAX_RECIPIENTS = 5000;
export const MAX_FIELDS = 30;

/** The default line under every campaign message (the recipient reads it, in the campaign's language: change it with the steps). */
export const UNSUBSCRIBE_TEXT = "If you would rather not hear from me again, reply \"unsubscribe\" and I will not write again.";
/** The ramp-up (decision 2): an account's first sending day is held to RAMP.start, each later day RAMP.perDay more, up to the cap. */
export const RAMP = { start: 10, perDay: 5 };
/** A campaign pauses when this share of its sends bounced, once at least RAMP.start were sent. */
export const BOUNCE_PAUSE = 0.05;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export const CampaignStepSchema = z.object({
  subject: z.string().max(300).default(""),
  body: z.string().min(1).max(20_000),
  /** Days after the step before (the first step: after launch). */
  delayDays: z.number().int().min(0).max(60).default(CAMPAIGN_DEFAULTS.followUpDays),
}).strict();

export const CampaignInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** A connected Gmail, Outlook or IMAP account (`gmail:<id>`, `outlook:<id>`, `imap:<id>`); never a Cloudflare address. */
  sender: z.string().min(3).max(200),
  timezone: z.string().min(1).max(64).default("UTC"),
  window: z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default(CAMPAIGN_DEFAULTS.days),
    start: z.string().regex(TIME).default(CAMPAIGN_DEFAULTS.start),
    end: z.string().regex(TIME).default(CAMPAIGN_DEFAULTS.end),
  }).strict().default({}),
  dailyCap: z.number().int().min(1).max(CAMPAIGN_DEFAULTS.maxDailyCap).default(CAMPAIGN_DEFAULTS.dailyCap),
  gapMinutes: z.tuple([z.number().int().min(1).max(120), z.number().int().min(1).max(240)]).default(CAMPAIGN_DEFAULTS.gapMinutes),
  steps: z.array(CampaignStepSchema).min(1).max(MAX_STEPS),
  stopOnReply: z.boolean().default(true),
  /** Stop everyone at the same company domain when one of them replies (free-mail domains excluded). */
  companyStop: z.boolean().default(true),
  /** The sender's postal address, which CAN-SPAM asks every commercial message to carry. */
  postalAddress: z.string().max(300).optional(),
  /** The line under every message that says how to stop them; a reply with "unsubscribe" in it stops them. */
  unsubscribeText: z.string().min(1).max(300).default(UNSUBSCRIBE_TEXT),
}).strict();
export type CampaignInput = z.infer<typeof CampaignInputSchema>;

/** Why a campaign as given cannot be kept, or null. */
export function campaignProblem(c: CampaignInput): string | null {
  if (c.sender.toLowerCase().startsWith("cloudflare:") || !/^(gmail|outlook|imap):/.test(c.sender))
    return msg("A campaign sends from a connected Gmail, Outlook or IMAP account. Cloudflare's own sending is for transactional mail only.");
  if (c.window.start >= c.window.end) return msg("The sending window must end after it starts.");
  if (c.gapMinutes[0] > c.gapMinutes[1]) return msg("The shortest gap between sends must not be longer than the longest.");
  if (c.steps[0]!.body.trim() === "") return msg("The first step needs a message.");
  try { new Intl.DateTimeFormat("en", { timeZone: c.timezone }); } catch { return msg("{timezone} is not a time zone.", { timezone: c.timezone }); }
  return null;
}

/** `{{field}}` and `{{field|fallback}}`: the text with fields filled, and the fields it needed but did not have. */
export function render(template: string, fields: Record<string, string>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(/\{\{\s*([a-zA-Z0-9_]{1,40})\s*(?:\|([^}]*))?\}\}/g, (_, name: string, fallback?: string) => {
    const value = fields[name.toLowerCase()]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    missing.add(name.toLowerCase());
    return "";
  });
  return { text, missing: [...missing] };
}

export interface RecipientInput { email: string; fields?: Record<string, unknown> }
export interface Recipient { email: string; fields: Record<string, string> }

/** A recipient as kept: the address lower-cased, field names lower-cased, values as text, at most MAX_FIELDS. */
export function normaliseRecipient(r: RecipientInput): Recipient | null {
  const email = String(r.email ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  if (!ADDRESS.test(email) || email.length > 254) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.fields ?? {}).slice(0, MAX_FIELDS)) {
    const key = k.trim().toLowerCase();
    if (/^[a-z0-9_]{1,40}$/.test(key) && v !== null && v !== undefined) fields[key] = String(v).slice(0, 500);
  }
  fields.email = email;
  return { email, fields };
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** Whether an address is on the suppression list, by itself or by its domain (or a parent domain). */
export function suppressed(email: string, list: ReadonlySet<string>): boolean {
  if (list.has(email)) return true;
  const parts = domainOf(email).split(".");
  for (let i = 0; i < parts.length - 1; i++) if (list.has(parts.slice(i).join("."))) return true;
  return false;
}

/** A suppression entry from what a person wrote: an address, a domain, or `@domain`. */
export function suppressionEntry(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/^@/, "");
  if (ADDRESS.test(v)) return v;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/** The local time `at` falls on in a time zone: weekday (0 Sunday) and minutes past midnight. */
function local(at: number, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether a send may leave at `at`: a window day, inside its hours. */
export function inWindow(c: Pick<CampaignInput, "timezone" | "window">, at: number): boolean {
  const l = local(at, c.timezone);
  return c.window.days.includes(l.day) && l.minutes >= minutesOf(c.window.start) && l.minutes < minutesOf(c.window.end);
}

/**
 * A dry run of the first step: when each of the first `count` recipients would get it, from `from`, within the
 * window, the daily cap (a rolling day) and the gaps (`random` picks inside the gap range; a test passes a fixed one).
 */
export function plan(c: CampaignInput, count: number, from: number, random: () => number = Math.random, firstSentAt = 0): number[] {
  const out: number[] = [];
  let at = from;
  const step = 60_000;
  for (let guard = 0; out.length < count && guard < 60 * 24 * 60; guard++) {
    const dayAgo = at - 86_400_000;
    if (!inWindow(c, at) || out.filter((t) => t > dayAgo).length >= rampedCap(c.dailyCap, firstSentAt || out[0] || 0, at)) { at += 15 * step; continue; }
    out.push(at);
    const [lo, hi] = c.gapMinutes;
    at += Math.round((lo + random() * (hi - lo)) * step);
  }
  return out;
}

/** An account's cap for the rolling day that ends at `at`: the ramp from its first send, never above the campaign's. */
export function rampedCap(cap: number, firstSentAt: number, at: number): number {
  if (!firstSentAt) return Math.min(cap, RAMP.start);
  const days = Math.max(0, Math.floor((at - firstSentAt) / 86_400_000));
  return Math.min(cap, RAMP.start + RAMP.perDay * days);
}

/** The first moment at or after `at` inside the window (15-minute steps, at most 8 days ahead), or null. */
export function nextInWindow(c: Pick<CampaignInput, "timezone" | "window">, at: number): number | null {
  for (let t = at, guard = 0; guard < 8 * 24 * 4; guard++, t += 15 * 60_000) if (inWindow(c, t)) return t;
  return null;
}

/** One step as a recipient gets it: the subject (a follow-up without one answers the first), the text with the stop line. */
export function composeStep(c: CampaignInput, index: number, fields: Record<string, string>, firstSubject: string): { subject: string; text: string } {
  const step = c.steps[index]!;
  const own = render(step.subject, fields).text.trim();
  const subject = own || (index === 0 ? "" : /^re:/i.test(firstSubject) ? firstSubject : firstSubject ? `Re: ${firstSubject}` : "");
  const footer = [c.unsubscribeText, c.postalAddress].filter((v) => v && v.trim()).join("\n");
  return { subject, text: render(step.body, fields).text.trimEnd() + (footer ? `\n\n${footer}` : "") };
}

/** Free-mail domains: a reply from one stops that person only, never the "company". */
export const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "web.de", "mail.ru", "yandex.ru", "ya.ru", "bk.ru",
  "list.ru", "inbox.ru", "rambler.ru", "zoho.com", "qq.com", "163.com", "fastmail.com", "hey.com", "tutanota.com"]);
/** The company a recipient belongs to, by domain, or null for free mail. */
export const companyOf = (email: string): string | null => { const d = domainOf(email); return FREE_MAIL.has(d) ? null : d; };

export type InboundKind = "bounce" | "auto" | "unsubscribe" | "reply";
/** What a message that arrives in the sending account says about a campaign: a bounce, an automatic reply, a request to stop, or a reply. */
export function inboundKind(m: { sender: string; subject: string; body: string }): InboundKind {
  const from = m.sender.toLowerCase();
  if (/(mailer-daemon|postmaster)@/.test(from) || /^(undeliverable|undelivered|delivery status notification|mail delivery (failed|subsystem)|failure notice|returned mail|не доставлено|недоставлен)/i.test(m.subject.trim()))
    return "bounce";
  if (/^(auto(matic)?[ -]?(reply|response)|out of (the )?office|ooo\b|away|abwesend|автоответ|автоматический ответ|отсутству)/i.test(m.subject.replace(/^(re|aw|ответ):\s*/i, "").trim()))
    return "auto";
  const own = m.body.split(/\r?\n/).filter((l) => !l.trim().startsWith(">")).join("\n").split(/\n(on .{1,200} wrote:|-{2,} ?original message|от: |from: )/i)[0]!.slice(0, 400);
  if (/\b(unsubscribe|remove me|do not (contact|email|write)|don't (contact|email|write))\b|отпис|отпиш|не пишите|больше не пиш/i.test(`${m.subject}\n${own}`)) return "unsubscribe";
  return "reply";
}
