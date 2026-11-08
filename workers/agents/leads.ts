/**
 * B-237 gap 8 (Fabric task a03af256): a lead found in the mail is handed to a sales agent through a granted tool (its
 * submit tool, with `leads.status` and `leads.delivered` on the same endpoint), the sender gets the policy's fixed
 * reply, and the sales owner's approved answer comes back to the same conversation: the registry reads the status
 * (pollLeads), sends or drafts the reply, and confirms it delivered. A later message of that conversation is handed
 * over again under the same key. The contract is the sales agent's: `{source, channel, caller_key, summary, language,
 * consent, contact_handle}` in, `{lead_id, state, stage}` out; status `{stage, answered, reply: {id, text} | null}`.
 */
export const LEAD_SOURCE = "fabric-inbox";
/** States of a submit that mean the sales agent holds the lead; any other (not_a_lead, closing, empty) leaves the mail to the agent. */
export const HELD_STATES = ["received", "duplicate", "updated"] as const;
/** How often an open hand-off's status is read, and how long one stays open without an answer. */
export const LEAD_POLL_MS = 15 * 60_000;
export const LEAD_OPEN_MS = 60 * 86_400_000;

/** The conversation's key, the same for every message of it: no address, no Message-ID, only a digest. */
export async function leadKey(mailboxId: string, threadId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${mailboxId.toLowerCase()}\n${threadId}`)));
  return `mail-${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The submit's arguments. The person wrote to this address about business, so the inbound mail is their consent to be answered by sales in it. */
export function submitArguments(key: string, summary: string, language: string | null): Record<string, unknown> {
  return { source: LEAD_SOURCE, channel: "mail", caller_key: key, contact_handle: key, consent: true,
    summary: summary.replace(/\s+/g, " ").trim().slice(0, 500), ...(language ? { language } : {}) };
}

const json = (text: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};

/** A submit's answer: the lead and its state; null when it is not one. */
export function parseSubmit(text: string): { leadId: string; state: string } | null {
  const v = json(text);
  return v && typeof v.lead_id === "string" && typeof v.state === "string" ? { leadId: v.lead_id, state: v.state } : null;
}

export interface LeadStatus { stage: string; answered: boolean; reply: { id: string; text: string } | null }

/** A status answer; null when it is not one. */
export function parseStatus(text: string): LeadStatus | null {
  const v = json(text);
  if (!v || typeof v.stage !== "string") return null;
  const r = v.reply && typeof v.reply === "object" ? v.reply as Record<string, unknown> : null;
  const reply = r && typeof r.id === "string" && typeof r.text === "string" && r.text.trim() ? { id: r.id, text: r.text } : null;
  return { stage: v.stage, answered: v.answered === true, reply };
}

/** What a status asks of the channel: deliver the owner's reply, close the hand-off (won or lost), or wait. */
export function leadAction(status: LeadStatus): "deliver" | "close" | "wait" {
  if (status.reply) return "deliver";
  return status.stage === "won" || status.stage === "lost" ? "close" : "wait";
}
