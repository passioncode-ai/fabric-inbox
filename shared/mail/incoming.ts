export interface IncomingMailEvent {
  id: string;
  sender: string;
  subject: string;
  body: string;
  date: string;
  thread_id?: string | null;
  /** Stored in Spam on arrival (SP-1): no consumer acts on it. */
  spam?: boolean;
  /** No rule decided: the model may read it for spam (SP-2). */
  screen?: boolean;
  /** With screen: the sender's shown name and the domain Cloudflare's MX verified for it, for the model's spam check (B-172). */
  senderName?: string | null;
  verified?: string | null;
  /** Stored in Discarded on arrival by a discard rule: no consumer acts on it, as if deleted. */
  discarded?: boolean;
}
