import type { Env } from "../types";

/**
 * B-26: a message back from Trash returns to the described categories it was in. Never fails the move
 * that called it: categories are a view, and a failure is logged with codes only.
 */
export async function restoreCategories(env: { CATEGORIES?: Env["CATEGORIES"] }, item: { accountIds: string[]; messageId: string; newMessageId?: string; date?: string; subject?: string; sender?: string }): Promise<void> {
  if (!env.CATEGORIES) return;
  const timestamp = item.date ? Date.parse(item.date) : NaN;
  try {
    await env.CATEGORIES.getByName("workspace").restore({
      accountIds: item.accountIds, messageId: item.messageId, newMessageId: item.newMessageId,
      ...(Number.isFinite(timestamp) && item.subject !== undefined && item.sender !== undefined ? { timestamp, subject: item.subject, sender: item.sender } : {}),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "category_restore_failed", error: (error as Error).message.slice(0, 200) }));
  }
}

/** The keys a remote account's messages are filed under in categories: its provider and its id. */
export const remoteCategoryKeys = (accountId: string) => ["gmail", "outlook", "imap"].map((p) => `${p}:${accountId}`);
