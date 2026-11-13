import { addressParser } from "postal-mime";
import { msg, type T } from "../../../shared/i18n";
/** A refusal of a later HTTP request says nothing about an earlier uncertain effect. */
export function sendRecovery(
  wasLocked: boolean,
  status: number,
  body: Record<string, unknown>,
): "failed" | "editable" | "uncertain" {
  if (body.status === "failed") return "failed";
  if (!wasLocked && [400, 401, 403, 404, 413].includes(status))
    return "editable";
  return "uncertain";
}
export type SendFailureKind = "conflict" | "rate_limited" | "failed" | "editable" | "uncertain";
export interface SendFailure {
  kind: SendFailureKind;
  /** The server's own words, for a request it refused (`editable`). */
  reason?: string;
}
/**
 * B-228: what a failed send means, the same on every surface that sends (the composer, the older
 * mailbox view, the classic compose). Only a server answer with a status tells a refusal apart; no
 * answer (a timeout, a lost connection), a server failure or anything else leaves the outcome
 * unknown, and the same attempt is retried under its key, which the outbox sends once.
 */
export function sendFailure(error: unknown, locked: boolean): SendFailure {
  const answer = error as { status?: unknown; body?: unknown; message?: unknown } | null;
  const status = typeof answer?.status === "number" ? answer.status : undefined;
  const body = answer?.body && typeof answer.body === "object" ? (answer.body as Record<string, unknown>) : undefined;
  if (status === undefined || !body) return { kind: "uncertain" };
  const code = String(body.code ?? body.error ?? "");
  if (status === 409 && /^(DRAFT_CONFLICT|draft_conflict)$/.test(code)) return { kind: "conflict" };
  if (status === 429 && code === "send_rate_limited") return { kind: "rate_limited" };
  const recovery = sendRecovery(locked, status, body);
  if (recovery === "editable") return { kind: "editable", reason: typeof answer?.message === "string" ? answer.message : "" };
  return { kind: recovery };
}
/** The one sentence a person reads for a failed send, in their language. */
export function sendFailureNotice(failure: SendFailure, t: T): string {
  switch (failure.kind) {
    case "conflict":
      return t("This draft was changed elsewhere just before sending, so it was not sent. Check it, then send again.");
    case "rate_limited":
      return t("Not sent: this account has reached this server's daily sending limit. Nothing went out; send it again later, or ask the server's administrator to raise the limit.");
    case "failed":
      return t("The provider did not accept this attempt. Correct the draft and send again, or discard it.");
    case "editable":
      return t("Send refused: {reason}. Correct the message or reconnect.", {
        reason: t.text(failure.reason ?? "").replace(/[.!?]+$/, ""),
      });
    default:
      return t("Acceptance is not confirmed. Retry the same attempt; its recovery key prevents a duplicate send.");
  }
}
export function recipientAddresses(header: string): string[] {
  if (/[\r\n]/.test(header))
    throw new Error(msg("Recipients cannot contain line breaks."));
  const addresses = addressParser(header, { flatten: true }).map(
    (a) => a.address ?? "",
  );
  if (
    !addresses.length ||
    addresses.some((a) => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(a))
  )
    throw new Error(msg("Enter valid recipient email addresses."));
  return addresses;
}
export function replyRecipient(
  from: string,
  to: string,
  accountEmail: string,
): string {
  const address = (from.match(/<([^<>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const header = address === accountEmail.trim().toLowerCase() ? to : from;
  try {
    return recipientAddresses(header).join(", ");
  } catch {
    return header;
  }
}
/**
 * Reply all: every participant except the account itself — the sender and the other To addresses
 * in To, the other Cc addresses in Cc, each address once (the server's reply-all does the same,
 * tests/mcp-tools.test.ts). Null when the account is the message's only participant; the reader
 * then offers no Reply all rather than failing.
 */
export function replyAllRecipients(
  from: string,
  to: string,
  cc: string,
  accountEmail: string,
): { to: string; cc: string } | null {
  const own = accountEmail.trim().toLowerCase();
  const parse = (header: string): string[] => {
    try {
      return header.trim() ? recipientAddresses(header) : [];
    } catch {
      return [];
    }
  };
  const sender = parse(from);
  // A message the account sent itself is answered to its original recipients, as replyRecipient does.
  const selfSent = sender.length > 0 && sender.every((a) => a.toLowerCase() === own);
  const seen = new Set<string>([own]);
  const others = (list: string[]) =>
    list.filter((a) => {
      const key = a.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const toList = others([...(selfSent ? [] : sender), ...parse(to)]);
  const ccList = others(parse(cc));
  if (!toList.length && !ccList.length) return null;
  return { to: toList.join(", "), cc: ccList.join(", ") };
}
