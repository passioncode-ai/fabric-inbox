export interface IncomingMailEvent {
  id: string;
  sender: string;
  subject: string;
  body: string;
  /** B-178: the HTML part when the body is its text (an account's message), so hidden text can be read. */
  html?: string;
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
  /** B-179: its files (a Cloudflare message's, stored in R2 under `attachments/<id>/<file id>/<name>`), for the safety check. */
  files?: { id: string; filename: string; mimetype: string; size: number }[];
}
