import { SETUP_FORMAT, type Setup, type SetupMailbox } from "../../shared/setup";
import type { DomainRouting } from "./email-routing";
import { msg } from "../../shared/i18n";

/**
 * Turns what Email Routing does today into a setup that keeps it working when
 * the addresses move to this Worker: each forwarded address becomes a mailbox
 * that still forwards a copy to the same destination; a forwarding catch-all
 * becomes a `catch-all@<domain>` mailbox that does the same for every other
 * address. Disabled and "drop" rules create nothing.
 */
export function setupFromRouting(
  routings: DomainRouting[],
  server: Setup["server"],
  name = msg("Imported from Cloudflare Email Routing"),
): Setup {
  const domains: string[] = [];
  const mailboxes: SetupMailbox[] = [];
  const catchAll: Setup["catchAll"] = [];
  const notServed: Setup["notServed"] = [];
  for (const r of routings) {
    if (!r.visible) { notServed.push({ domain: r.domain, reason: msg("Not visible to this server's Cloudflare token (another account?)") }); continue; }
    if (!r.enabled) { notServed.push({ domain: r.domain, reason: msg("Email Routing is off for this domain") }); continue; }
    const boxes: SetupMailbox[] = [];
    for (const rule of r.rules) {
      if (!rule.enabled || rule.action.type === "drop") continue;
      boxes.push(rule.action.type === "forward" && rule.action.value
        // No agent is named: a new mailbox starts Off, an existing one keeps the agent it has.
        ? { address: rule.address, forwardTo: rule.action.value.toLowerCase(), note: msg("Email Routing forwarded it to {address}", { address: rule.action.value }) }
        : { address: rule.address, note: rule.action.value ? msg("Email Routing sent it to the Worker {worker}", { worker: rule.action.value }) : msg("Email Routing sent it to the Worker") });
    }
    const ca = r.catchAll;
    if (ca?.enabled && ca.action.type !== "drop") {
      const address = `catch-all@${r.domain}`;
      if (!boxes.some((b) => b.address === address))
        boxes.push(ca.action.type === "forward" && ca.action.value
          ? { address, name: "Everything else", forwardTo: ca.action.value.toLowerCase(), note: msg("The catch-all forwarded every other address to {address}", { address: ca.action.value }) }
          : { address, name: "Everything else", note: msg("The catch-all sent every other address to a Worker") });
      catchAll.push({ domain: r.domain, mailbox: address });
    }
    if (!boxes.length) { notServed.push({ domain: r.domain, reason: msg("No active address: every rule is disabled or drops mail") }); continue; }
    domains.push(r.domain);
    mailboxes.push(...boxes);
  }
  // A forward to a domain that this setup also serves would loop; keep the mailbox, drop the copy.
  const served = new Set(domains);
  for (const m of mailboxes) {
    if (m.forwardTo && served.has(m.forwardTo.slice(m.forwardTo.lastIndexOf("@") + 1))) {
      m.note = m.note
        ? msg("{note} (the copy to {address} is not kept: that domain is served here too)", { note: m.note, address: m.forwardTo })
        : msg("(the copy to {address} is not kept: that domain is served here too)", { address: m.forwardTo });
      delete m.forwardTo;
    }
  }
  return { format: SETUP_FORMAT, name, server, domains: domains.sort(), mailboxes, catchAll, notServed };
}
