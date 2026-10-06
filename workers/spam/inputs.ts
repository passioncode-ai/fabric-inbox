/** What the spam routes accept (workers/routes/spam.ts); its own module so tests read it without the Worker. */
import { z } from "zod";

export const LIST_NAMES = ["blockedSenders", "blockedDomains", "allowedSenders", "allowedDomains"] as const;
const Message = z.object({
  accountId: z.string().regex(/^(cloudflare|gmail):.+$/).max(320),
  providerMessageId: z.string().min(1).max(256),
  sender: z.string().max(320).default(""),
});
export const Report = z.object({
  messages: z.array(Message).min(1).max(100),
  /** What else goes on the list: the sender, the sender's whole domain, or nothing. */
  list: z.enum(["sender", "domain", "none"]).default("sender"),
}).strict();
export const ListEdit = z.object({
  list: z.enum(LIST_NAMES),
  value: z.string().min(1).max(320),
  action: z.enum(["add", "remove"]),
}).strict();
