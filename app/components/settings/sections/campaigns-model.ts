/**
 * Settings → Campaigns (SCR-18, SCN-091): the words for a campaign's state, a person's status and why a campaign
 * paused itself. Plain module, no `~/` imports: the tests load it directly. English marked with `msg()`; the
 * interface shows it through `t.text()`.
 */
import { msg } from "../../../../shared/i18n";
import type { Campaign, CampaignState } from "../../../services/campaigns";

export const STATE_LABEL: Record<CampaignState, string> = {
  draft: msg("Draft"), running: msg("Running"), paused: msg("Paused"), stopped: msg("Stopped"), finished: msg("Finished"),
};
export const STATE_TONE: Record<CampaignState, "neutral" | "ok" | "warn" | "bad" | "busy"> = {
  draft: "neutral", running: "busy", paused: "warn", stopped: "neutral", finished: "ok",
};

/** A person's status in a campaign, in the order the People filter offers them. */
export const STATUS_LABEL: Record<string, string> = {
  queued: msg("Waiting for the first message"), active: msg("Waiting for a follow-up"), done: msg("Had every step"),
  replied: msg("Replied"), unsubscribed: msg("Asked to stop"), bounced: msg("Bounced"), stopped: msg("Stopped"),
  suppressed: msg("On the do-not-write list"), failed: msg("Not sent"),
};
export const STATUS_ORDER = Object.keys(STATUS_LABEL);
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;

/** Why a campaign paused, or why a person was stopped, in words; an unknown code is shown as it is. */
const REASON: Record<string, string> = {
  person: msg("Paused from the app or by an agent."),
  bounces: msg("Paused by itself: 5% of its messages bounced. Check the addresses before resuming."),
  sender_needs_attention: msg("Paused by itself: the account it sends from needs signing in again (Settings → Accounts)."),
  sender_not_connected: msg("Paused by itself: the account it sends from is no longer connected."),
  company_replied: msg("Someone at the same company replied."),
  campaign_stopped: msg("The campaign was stopped."),
  replied_unsubscribe: msg("Replied asking to stop."),
};
export const reasonText = (code: string) => REASON[code] ?? code;

/** How many people are still to be written to, and how many have been written to at all. */
export function progress(c: Pick<Campaign, "counts">): { open: number; total: number } {
  const counts = c.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { open: (counts.queued ?? 0) + (counts.active ?? 0), total };
}

/** What the primary action of a campaign is, if any. */
export function primaryAction(state: CampaignState): "start" | "resume" | "pause" | null {
  return state === "draft" ? "start" : state === "paused" ? "resume" : state === "running" ? "pause" : null;
}
