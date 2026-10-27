/** Client types for /api/campaigns and /api/suppression (workers/routes/campaigns.ts, workers/campaigns/store.ts; B-181). */
export type CampaignState = "draft" | "running" | "paused" | "stopped" | "finished";
export interface CampaignStep { subject: string; body: string; delayDays: number }
export interface Campaign {
  id: string;
  name: string;
  sender: string;
  timezone: string;
  window: { days: number[]; start: string; end: string };
  dailyCap: number;
  gapMinutes: [number, number];
  steps: CampaignStep[];
  stopOnReply: boolean;
  companyStop: boolean;
  postalAddress?: string;
  unsubscribeText: string;
  state: CampaignState;
  version: number;
  createdAt: string;
  updatedAt: string;
  reason: string;
  launchedAt: string | null;
  counts: Record<string, number>;
}
export interface CampaignReport {
  campaign: Campaign;
  sent: number;
  perStep: number[];
  contacted: number;
  replyRate: number | null;
  bounceRate: number | null;
  lastSentAt: string | null;
  nextSendAt: string | null;
  failures: { email: string; detail: string }[];
}
export interface CampaignRecipient { email: string; fields: Record<string, string>; status: string; step: number; detail: string }
export interface SuppressionEntry { value: string; reason: string; addedAt: string }
