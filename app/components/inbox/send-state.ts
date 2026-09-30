import { addressParser } from "postal-mime";
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
    throw new Error("Recipients cannot contain line breaks.");
  const addresses = addressParser(header, { flatten: true }).map(
    (a) => a.address ?? "",
  );
  if (
    !addresses.length ||
    addresses.some((a) => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(a))
  )
    throw new Error("Enter valid recipient email addresses.");
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
