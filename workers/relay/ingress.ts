import { z } from "zod";
import type { Env } from "../types";
import { receiveEmailResilient, settleRelayedCopy, MAX_EMAIL_SIZE, type IncomingEmailEvent } from "../index";
import { CloudflareAccounts, readDomainAccounts } from "../routing/accounts";
import type { AccessClaims } from "../mcp/keys";
import { readRelays, tidyRelay, upgradeRelay, type Relay } from "./install";
import { RELAY_VERSION } from "./script";
import { readSettings } from "../lib/mailbox-store";

/**
 * Where a relay hands over mail (MA-7). Access admits the relay's service token on these two paths
 * only (`identityMayUse`); here the token must be a registered relay, and the recipient's domain
 * must be in that relay's own account, so a relay can only deliver the mail of the domains it was
 * installed for. The message goes through the same `receiveEmail` as mail arriving directly.
 */
export { RELAY_PATHS } from "../mcp/keys";
export const RELAY_INCOMING = "/relay/incoming";
export const RELAY_FORWARDED = "/relay/forwarded";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

async function relayOf(env: Env, claims: AccessClaims | null): Promise<Relay | null> {
  const clientId = typeof claims?.common_name === "string" ? claims.common_name : "";
  if (!clientId) return null;
  return (await readRelays(env.BUCKET)).find((r) => r.clientId === clientId) ?? null;
}

/**
 * Whether the domain is in the relay's account: the remembered account, or an ACTIVE zone of that
 * account — a pending copy of a domain in another account does not count. This path never writes
 * the cache: what a relay says must not change where anything else thinks a domain lives.
 */
async function inRelayAccount(env: Env, relay: Relay, domain: string): Promise<boolean> {
  if ((await readDomainAccounts(env.BUCKET))[domain] === relay.accountId) return true;
  const ctx = await new CloudflareAccounts(env).zone(domain, { remember: false }).catch(() => null);
  return ctx?.accountId === relay.accountId;
}

/** The body up to `limit` bytes, or null when it is larger — whatever Content-Length said. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

export async function handleRelayIncoming(request: Request, env: Env, ctx: ExecutionContext, claims: AccessClaims | null): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST the message" }, 405);
  const relay = await relayOf(env, claims);
  if (!relay) return json({ error: "Only a relay this server installed may deliver mail here" }, 403);
  const to = (request.headers.get("X-Fabric-Envelope-To") ?? "").trim().toLowerCase();
  const from = (request.headers.get("X-Fabric-Envelope-From") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "The envelope recipient is missing" }, 400);
  if (!(await inRelayAccount(env, relay, domainOf(to)))) {
    console.warn(JSON.stringify({ event: "relay_refused_domain", accountId: relay.accountId, domain: domainOf(to) }));
    return json({ error: `${domainOf(to)} is not a domain of the account this relay serves` }, 403);
  }
  const tooLarge = { outcome: "rejected", reject: `Message too large: the limit is ${MAX_EMAIL_SIZE / 1024 / 1024} MB` };
  if (Number(request.headers.get("content-length") ?? "0") > MAX_EMAIL_SIZE) return json(tooLarge);
  const raw = await readCapped(request, MAX_EMAIL_SIZE);
  if (!raw) return json(tooLarge);
  // Off the delivery's path: a relay of an older version is brought up to this one — whichever of its
  // sign-ins it used, since an upgrade cut off half-way leaves the old relay delivering on a retired
  // one (rate-limited per account in upgradeRelay); a current one finishes any rotation it left.
  const background = request.headers.get("X-Fabric-Relay-Version") !== RELAY_VERSION
    ? upgradeRelay(env, new CloudflareAccounts(env), relay.accountId)
    : tidyRelay(env, new CloudflareAccounts(env), relay.accountId);
  ctx.waitUntil(background.catch((e: unknown) => console.warn(JSON.stringify({ event: "relay_maintenance_failed", accountId: relay.accountId, error: (e as Error).message }))));
  if (!raw.byteLength) return json({ error: "The message is empty" }, 400);

  let reject: string | null = null;
  let forwardTo: string | null = null;
  const event: IncomingEmailEvent = {
    raw: new Response(raw).body!, rawSize: raw.byteLength, to, from,
    setReject: (reason) => { reject = reason; },
    deferForward: (target) => { forwardTo = target; },
  };
  const result = await receiveEmailResilient(event, env, ctx);
  if ("rejected" in result) {
    console.log(JSON.stringify({ event: "relay_rejected", accountId: relay.accountId, reason: result.rejected }));
    return json({ outcome: "rejected", reject: reject ?? "Address not found" });
  }
  console.log(JSON.stringify({ event: "relay_received", accountId: relay.accountId, inserted: result.inserted, copy: !!forwardTo }));
  return json({
    outcome: result.inserted ? "stored" : "duplicate", mailboxId: result.mailboxId, emailId: result.emailId,
    ...(forwardTo ? { forwardTo } : {}),
  });
}

const Forwarded = z.object({
  mailboxId: z.string().trim().toLowerCase().email(),
  emailId: z.string().min(1).max(200),
  target: z.string().trim().toLowerCase().email(),
  ok: z.boolean(),
  error: z.string().max(300).optional(),
}).strict();

export async function handleRelayForwarded(request: Request, env: Env, claims: AccessClaims | null): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST the report" }, 405);
  const relay = await relayOf(env, claims);
  if (!relay) return json({ error: "Only a relay this server installed may report here" }, 403);
  const parsed = Forwarded.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Not a copy report" }, 400);
  const report = parsed.data;
  if (!(await inRelayAccount(env, relay, domainOf(report.mailboxId)))) return json({ error: "That address is not on a domain this relay serves" }, 403);
  // Only a copy this server still owes, to the address it is set to go to, is settled by a report.
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(report.mailboxId));
  const forwarding = (await readSettings(env.BUCKET, report.mailboxId).catch(() => null))?.forwarding as { enabled?: unknown; email?: unknown } | undefined;
  const target = typeof forwarding?.email === "string" ? forwarding.email.trim().toLowerCase() : "";
  if (!(await stub.forwardOwed(report.emailId).catch(() => false)) || forwarding?.enabled !== true || target !== report.target)
    return json({ settled: false, reason: "No copy of that message to that address is owed here" });
  await settleRelayedCopy(env, report.mailboxId, report.emailId, report.target, report.ok, report.error);
  console.log(JSON.stringify({ event: "relay_copy_settled", accountId: relay.accountId, ok: report.ok }));
  return json({ settled: true });
}
