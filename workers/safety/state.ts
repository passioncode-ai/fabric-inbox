import type { SafetyFindings } from "./check";
import type { SafetyReview } from "./review";

/**
 * B-178: where a message stands with the safety check. `clear`: nothing found. `held`: kept from every agent with
 * tools until a person decides. `released`: the review or a person let it through. `kept`: a person kept it held.
 */
export type SafetyState = "clear" | "held" | "released" | "kept";
export interface SafetyRecord {
  state: SafetyState; reason: string; findings: SafetyFindings; review: SafetyReview | null; checkedAt: number; decidedBy: string;
  decidedAt: number; subject: string; sender: string; timestamp: number;
}
export const safetyKey = (accountId: string, messageId: string) => `${accountId}|${messageId}`;
/** Whether a state keeps the message from agents with tools. */
export const isHeld = (state: SafetyState | undefined) => state === "held" || state === "kept";
