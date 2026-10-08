import { addressParser } from "postal-mime";
import { msg } from "../../../shared/i18n";
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
