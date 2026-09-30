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
}
