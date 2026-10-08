/** Transport acceptance is not recipient delivery. Journal intentionally omits payloads. */
export type OutboxStatus = 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown';
export interface OutboxEntry {
  id: string;
  mailboxId: string;
  status: OutboxStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  providerMessageId: string | null;
  deliveryStatus: 'unconfirmed';
  projectionStatus: 'pending' | 'complete';
  errorCode: string | null;
  /** The provider's own words for a refusal (300 characters at most), when it gave any. */
  errorDetail?: string | null;
}
