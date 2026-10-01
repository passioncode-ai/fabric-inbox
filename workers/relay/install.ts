import type { Env } from "../types";
import { CloudflareApi, CloudflareApiError } from "../routing/cloudflare-api";
import { RELAY_WORKER, type CloudflareAccounts } from "../routing/accounts";
import { AgentAccess } from "../mcp/access";
import { RELAY_COMPATIBILITY_DATE, RELAY_MODULE, RELAY_SOURCE, RELAY_VERSION } from "./script";

/**
 * Installing the relay in another account (MA-6), and the registry of relays (R2 `config/relays.json`,
 * no secrets: the account, the Access service token's id and Client ID, the server address it was
 * given, its version).
 *
 * What the relay runs with is read from the relay itself: its plain bindings name its sign-in
 * (`RELAY_TOKEN_ID`), its version and the server it calls. So "already installed" is a fact about
 * Cloudflare, not about a row that a lost write or a timed-out upload can leave wrong.
 *
 * A reinstall rotates in two rows: the new sign-in is registered before the upload, so the new
 * relay is accepted from its first message; the old one stays accepted as `retiring` while old
 * instances drain, and is revoked by a later change once it is an hour old. A failure never deletes
 * a relay that was working.
 *
 * Every change runs under the lock agent keys use: both edit the one Access policy.
 *
 * Contracts (Cloudflare API v4, read from the OpenAPI spec 2026-09-30):
 *  GET  /accounts/{b}/workers/scripts/{relay}/settings   its bindings (10007 / 404 when absent)
 *  PUT  /accounts/{b}/workers/scripts/{relay}            multipart: metadata + one ES module
 *  DELETE /accounts/{b}/workers/scripts/{relay}          removing it with the account
 *  POST|DELETE /accounts/{server}/access/service_tokens  its sign-in (workers/mcp/access.ts)
 */
export const RELAYS_KEY = "config/relays.json";
/** Shared with agent keys (workers/routes/agent-keys.ts): one writer of the Access policy at a time. */
export const ACCESS_LOCK = "agent-keys";
const RETIRE_AFTER_MS = 60 * 60 * 1000;

export interface Relay {
  accountId: string;
  tokenId: string;
  clientId: string;
  origin: string;
  version: string;
  installedAt: string;
  /** Replaced by a newer sign-in; still accepted until it is revoked. */
  retiredAt?: string;
  /** The last automatic upgrade tried for this account (at most one an hour). */
  upgradeTriedAt?: string;
}

function normalise(raw: unknown): Relay[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { relays?: unknown }).relays) ? (raw as { relays: unknown[] }).relays : [];
  return list.flatMap((r) => {
    const x = r as Record<string, unknown>;
    if (typeof x?.accountId !== "string" || typeof x.tokenId !== "string" || typeof x.clientId !== "string" || typeof x.origin !== "string") return [];
    const relay: Relay = { accountId: x.accountId, tokenId: x.tokenId, clientId: x.clientId, origin: x.origin,
      version: typeof x.version === "string" ? x.version : "0", installedAt: typeof x.installedAt === "string" ? x.installedAt : new Date(0).toISOString() };
    if (typeof x.retiredAt === "string") relay.retiredAt = x.retiredAt;
    if (typeof x.upgradeTriedAt === "string") relay.upgradeTriedAt = x.upgradeTriedAt;
    return [relay];
  });
}

/** A damaged file reads as no relays, so every relay's delivery is refused until reinstalled (fails closed). */
export async function readRelays(bucket: R2Bucket): Promise<Relay[]> {
  const object = await bucket.get(RELAYS_KEY);
  return object ? normalise(await object.json().catch(() => null)) : [];
}

/** The relay an account runs today (its newest, not retiring, sign-in). */
export const currentRelay = (relays: Relay[], accountId: string) => relays.find((r) => r.accountId === accountId && !r.retiredAt);

export async function updateRelays(bucket: R2Bucket, change: (relays: Relay[]) => Relay[]): Promise<Relay[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(RELAYS_KEY);
    const next = change(object ? normalise(await object.json().catch(() => null)) : []);
    const written = await bucket.put(RELAYS_KEY, JSON.stringify({ relays: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new Error("The relay list changed several times at once; try again");
}

export interface RelayInstallResult { outcome: "done" | "already" | "failed"; detail: string }

const errorText = (e: unknown) => (e instanceof CloudflareApiError ? e.message : `Unexpected error: ${(e as Error).message}`);
const absent = (e: unknown) => e instanceof CloudflareApiError && (e.status === 404 || e.code === 10007);

/** Runs `fn` alone among the changes to the server's Access policy; waits up to ~10 s for another to finish. */
export async function underAccessLock<T>(env: Env, fn: () => Promise<T>): Promise<T | "busy"> {
  const ledger = env.EMAIL_MCP.getByName("workspace");
  const holder = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    if (await ledger.acquireLock(ACCESS_LOCK, holder, 120_000)) break;
    if (attempt >= 10) return "busy";
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  try { return await fn(); }
  finally { await ledger.releaseLock(ACCESS_LOCK, holder).catch(() => {}); }
}

/** The relay's plain bindings as Cloudflare holds them, or null when there is no relay there. */
async function relayBindings(api: CloudflareApi, accountId: string): Promise<Record<string, string> | null> {
  try {
    const settings = await api.call<{ bindings?: { type?: string; name?: string; text?: string }[] }>(
      `/accounts/${accountId}/workers/scripts/${RELAY_WORKER}/settings`, { what: "read the relay (Workers Scripts: Edit)" });
    return Object.fromEntries((settings.bindings ?? []).filter((b) => b.type === "plain_text" && b.name).map((b) => [b.name!, b.text ?? ""]));
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

/** Where the relay should call: the configured public address, else the one this request came to, else the one it has. */
export function relayOrigin(env: Env, requestOrigin: string | undefined, existing: Relay | undefined): string | null {
  const candidates = [env.PUBLIC_APP_URL, requestOrigin, existing?.origin];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      // A relay in Cloudflare cannot reach a development server on this machine.
      if (url.protocol === "https:" && !/^(localhost|127\.|\[::1\])/.test(url.hostname)) return url.origin;
    } catch { /* not a URL: try the next */ }
  }
  return null;
}

/** Revokes retiring sign-ins older than an hour (old instances have drained); returns the rows kept. */
async function revokeRetired(env: Env, access: AgentAccess, accountId: string, now = Date.now()) {
  const stale = (await readRelays(env.BUCKET)).filter((r) => r.accountId === accountId && r.retiredAt && now - Date.parse(r.retiredAt) >= RETIRE_AFTER_MS);
  for (const r of stale) {
    await access.revoke(r.tokenId).catch((e: unknown) => console.warn(JSON.stringify({ event: "relay_old_token_kept", accountId, error: (e as Error).message })));
    await updateRelays(env.BUCKET, (relays) => relays.filter((x) => x.tokenId !== r.tokenId)).catch(() => undefined);
  }
}

/**
 * Makes sure the relay runs in the account, current, and pointed at this server. Idempotent: a
 * relay whose own bindings name the registered sign-in, this version and this address is left
 * alone. Otherwise a new sign-in is made and registered, the relay uploaded with it, and the old
 * sign-in retired.
 */
export async function installRelay(input: { env: Env; accounts: CloudflareAccounts; accountId: string; api: CloudflareApi; origin?: string }): Promise<RelayInstallResult> {
  const result = await underAccessLock(input.env, () => install(input));
  return result === "busy" ? { outcome: "failed", detail: "Another change to your server's sign-in is running (an agent key or a relay); try again in a moment." } : result;
}

async function install({ env, accounts, accountId, api, origin: requestOrigin }: { env: Env; accounts: CloudflareAccounts; accountId: string; api: CloudflareApi; origin?: string }): Promise<RelayInstallResult> {
  const current = currentRelay(await readRelays(env.BUCKET), accountId);
  const origin = relayOrigin(env, requestOrigin, current);
  if (!origin) return { outcome: "failed", detail: "The relay needs your server's public https address; open Domains & addresses from the server (or set PUBLIC_APP_URL) and try again." };
  let bindings: Record<string, string> | null;
  try { bindings = await relayBindings(api, accountId); }
  catch (error) { return { outcome: "failed", detail: errorText(error) }; }

  const primary = accounts.primary();
  if (!primary) return { outcome: "failed", detail: "This server has no Cloudflare token of its own, so it cannot give the relay a sign-in." };
  let serverId: string;
  try { serverId = await accounts.serverAccountId(); }
  catch (error) { return { outcome: "failed", detail: errorText(error) }; }
  const access = new AgentAccess(primary, env, serverId);

  if (bindings && current && bindings.RELAY_TOKEN_ID === current.tokenId && bindings.RELAY_VERSION === RELAY_VERSION && bindings.SERVER_URL === origin) {
    await revokeRetired(env, access, accountId);
    return { outcome: "already", detail: `The relay ${RELAY_WORKER} in this account already carries its mail here.` };
  }
  // Otherwise — no relay, another version or address, or a sign-in that is not the current one
  // (an upload that never applied) — this is a (re)install. An unconfirmed earlier upload that did
  // apply already names the current sign-in, and was answered as installed above.
  const name = (await accounts.list()).accounts.find((a) => a.id === accountId)?.name ?? accountId;
  let token: Awaited<ReturnType<AgentAccess["create"]>>;
  try { token = await access.create(name, "forever", "relay"); }
  catch (error) { return { outcome: "failed", detail: `The relay's sign-in could not be made: ${errorText(error)}` }; }

  const now = new Date().toISOString();
  const row: Relay = { accountId, tokenId: token.id, clientId: token.client_id, origin, version: RELAY_VERSION, installedAt: now };
  // Registered before the upload: the new relay is accepted from its first message, and the one
  // running now stays accepted (retiring) until it has drained.
  try {
    await updateRelays(env.BUCKET, (list) => [
      ...list.map((r) => (r.accountId === accountId && !r.retiredAt ? { ...r, retiredAt: now } : r)), row]);
  } catch (error) {
    await access.revoke(token.id).catch(() => undefined);
    return { outcome: "failed", detail: `The relay could not be recorded (${(error as Error).message}); nothing was changed. Try again.` };
  }

  try {
    const form = new FormData();
    form.set("metadata", JSON.stringify({
      main_module: RELAY_MODULE,
      compatibility_date: RELAY_COMPATIBILITY_DATE,
      bindings: [
        { type: "plain_text", name: "SERVER_URL", text: origin },
        { type: "plain_text", name: "RELAY_VERSION", text: RELAY_VERSION },
        { type: "plain_text", name: "RELAY_TOKEN_ID", text: token.id },
        { type: "secret_text", name: "ACCESS_CLIENT_ID", text: token.client_id },
        { type: "secret_text", name: "ACCESS_CLIENT_SECRET", text: token.client_secret },
      ],
    }));
    form.set(RELAY_MODULE, new File([RELAY_SOURCE], RELAY_MODULE, { type: "application/javascript+module" }));
    await api.call(`/accounts/${accountId}/workers/scripts/${RELAY_WORKER}`, { method: "PUT", form, what: "install the relay (Workers Scripts: Edit)" });
  } catch (error) {
    // No answer, or a server error: the upload may have applied.
    if (error instanceof CloudflareApiError && (error.status === 0 || error.status >= 500)) {
      // No answer: the upload may have applied. Both sign-ins stay accepted; the next attempt reads
      // what the relay runs with and settles it. Nothing working is taken away.
      console.warn(JSON.stringify({ event: "relay_upload_unconfirmed", accountId }));
      return { outcome: "failed", detail: `Cloudflare did not confirm the relay's upload (${error.message}). Your mail keeps arriving; run this again to finish.` };
    }
    // Refused: the relay that was there (if any) still runs with its old sign-in, which becomes current again.
    await updateRelays(env.BUCKET, (list) => list.filter((r) => r.tokenId !== token.id)
      .map((r) => (r.accountId === accountId && r.retiredAt === now ? { ...r, retiredAt: undefined } : r))).catch(() => undefined);
    await access.revoke(token.id).catch((e: unknown) => console.error(JSON.stringify({ event: "relay_token_orphaned", accountId, error: (e as Error).message })));
    return { outcome: "failed", detail: `The relay could not be installed: ${errorText(error)} Nothing was left behind; try again.` };
  }

  await revokeRetired(env, access, accountId);
  console.log(JSON.stringify({ event: "relay_installed", accountId, version: RELAY_VERSION, replaced: !!bindings }));
  return { outcome: "done", detail: bindings
    ? `The relay ${RELAY_WORKER} in this account was updated; it carries the account's mail here.`
    : `Installed the relay ${RELAY_WORKER} in this account: Cloudflare sends the domain's mail to it, and it hands each message to this server.` };
}

/**
 * Brings a relay that reported an older version up to this one, at most once an hour per account,
 * off the delivery's path (workers/relay/ingress.ts). A failure is logged and tried again later.
 */
export async function upgradeRelay(env: Env, accounts: CloudflareAccounts, accountId: string): Promise<void> {
  const now = Date.now();
  const relay = currentRelay(await readRelays(env.BUCKET), accountId);
  if (!relay || (relay.upgradeTriedAt && now - Date.parse(relay.upgradeTriedAt) < RETIRE_AFTER_MS)) return;
  await updateRelays(env.BUCKET, (list) => list.map((r) => (r.tokenId === relay.tokenId ? { ...r, upgradeTriedAt: new Date(now).toISOString() } : r)));
  const api = await accounts.apiFor(accountId);
  if (!api) return;
  const result = await installRelay({ env, accounts, accountId, api });
  console.log(JSON.stringify({ event: "relay_upgrade", accountId, outcome: result.outcome, ...(result.outcome === "failed" ? { detail: result.detail } : {}) }));
}

/**
 * Removes the relay of an account: its Worker there, its sign-ins here, its registry rows. A token
 * that can no longer reach that account (the reason it is being removed) leaves the Worker in place,
 * said in the answer; the sign-ins and rows go regardless, so it delivers nothing.
 */
export async function removeRelay(input: { env: Env; accounts: CloudflareAccounts; accountId: string; api: CloudflareApi | null }): Promise<string | null> {
  const result = await underAccessLock(input.env, () => remove(input));
  if (result === "busy") throw new CloudflareApiError("Another change to your server's sign-in is running (an agent key or a relay); try again in a moment.", 409);
  return result;
}

async function remove({ env, accounts, accountId, api }: { env: Env; accounts: CloudflareAccounts; accountId: string; api: CloudflareApi | null }): Promise<string | null> {
  const rows = (await readRelays(env.BUCKET)).filter((r) => r.accountId === accountId);
  if (!rows.length) return null;
  let left = "";
  if (api) {
    try {
      await api.call(`/accounts/${accountId}/workers/scripts/${RELAY_WORKER}`, { method: "DELETE", what: "remove the relay (Workers Scripts: Edit)" });
    } catch (error) {
      if (!absent(error)) left = ` Its Worker ${RELAY_WORKER} could not be deleted there (${errorText(error)}); it can no longer deliver anything, and you can delete it in that account's dashboard.`;
    }
  } else left = ` No token reaches that account any more, so its Worker ${RELAY_WORKER} stays there; it can no longer deliver anything.`;
  // The registry goes first: from here on its deliveries are refused, whatever happens to the tokens.
  await updateRelays(env.BUCKET, (relays) => relays.filter((r) => r.accountId !== accountId));
  const primary = accounts.primary();
  if (primary) {
    const access = new AgentAccess(primary, env, await accounts.serverAccountId().catch(() => undefined));
    for (const r of rows) await access.revoke(r.tokenId).catch((e: unknown) =>
      console.warn(JSON.stringify({ event: "relay_token_kept", accountId, error: (e as Error).message })));
  }
  return `The relay was removed from the account.${left}`;
}
