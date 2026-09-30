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
 * Contracts (Cloudflare API v4, read from the OpenAPI spec 2026-09-30):
 *  GET  /accounts/{b}/workers/scripts/{relay}/settings   is it there (10007 / 404 when not)
 *  PUT  /accounts/{b}/workers/scripts/{relay}            multipart: metadata + one ES module
 *  DELETE /accounts/{b}/workers/scripts/{relay}          removing it with the account
 *  POST|DELETE /accounts/{server}/access/service_tokens  its sign-in (workers/mcp/access.ts)
 */
export const RELAYS_KEY = "config/relays.json";

export interface Relay {
  accountId: string;
  tokenId: string;
  clientId: string;
  origin: string;
  version: string;
  installedAt: string;
}

function normalise(raw: unknown): Relay[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { relays?: unknown }).relays) ? (raw as { relays: unknown[] }).relays : [];
  return list.flatMap((r) => {
    const x = r as Record<string, unknown>;
    return typeof x?.accountId === "string" && typeof x.tokenId === "string" && typeof x.clientId === "string" && typeof x.origin === "string"
      ? [{ accountId: x.accountId, tokenId: x.tokenId, clientId: x.clientId, origin: x.origin,
          version: typeof x.version === "string" ? x.version : "0", installedAt: typeof x.installedAt === "string" ? x.installedAt : new Date(0).toISOString() }]
      : [];
  });
}

/** A damaged file reads as no relays, so every relay's delivery is refused until reinstalled (fails closed). */
export async function readRelays(bucket: R2Bucket): Promise<Relay[]> {
  const object = await bucket.get(RELAYS_KEY);
  return object ? normalise(await object.json().catch(() => null)) : [];
}

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

async function relayExists(api: CloudflareApi, accountId: string): Promise<boolean> {
  try {
    await api.call(`/accounts/${accountId}/workers/scripts/${RELAY_WORKER}/settings`, { what: "read the relay (Workers Scripts: Edit)" });
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 404 || error.code === 10007)) return false;
    throw error;
  }
}

/**
 * Makes sure the relay runs in the account, current, and pointed at this server. Idempotent: a
 * relay that is there, of this version, for this address, with its registry row, is left alone.
 * Otherwise a new sign-in is made, the relay uploaded with it, then saved; the sign-in it replaces
 * is revoked afterwards. An upload that fails revokes the new sign-in, so no credential exists that
 * the registry does not name.
 */
export async function installRelay(input: { env: Env; accounts: CloudflareAccounts; accountId: string; api: CloudflareApi; origin?: string }): Promise<RelayInstallResult> {
  const { env, accounts, accountId, api } = input;
  const existing = (await readRelays(env.BUCKET)).find((r) => r.accountId === accountId);
  const origin = input.origin ?? env.PUBLIC_APP_URL ?? existing?.origin;
  if (!origin) return { outcome: "failed", detail: "The server's own address is not known here; open Domains & addresses from the server and try again." };
  let there: boolean;
  try { there = await relayExists(api, accountId); }
  catch (error) { return { outcome: "failed", detail: errorText(error) }; }
  if (there && existing && existing.version === RELAY_VERSION && existing.origin === origin)
    return { outcome: "already", detail: `The relay ${RELAY_WORKER} in this account already carries its mail here.` };

  const primary = accounts.primary();
  if (!primary) return { outcome: "failed", detail: "This server has no Cloudflare token of its own, so it cannot give the relay a sign-in." };
  const access = new AgentAccess(primary, env);
  const name = (await accounts.list()).accounts.find((a) => a.id === accountId)?.name ?? accountId;
  let token: Awaited<ReturnType<AgentAccess["create"]>>;
  try { token = await access.create(name, "forever", "relay"); }
  catch (error) { return { outcome: "failed", detail: `The relay's sign-in could not be made: ${errorText(error)}` }; }

  try {
    const form = new FormData();
    form.set("metadata", JSON.stringify({
      main_module: RELAY_MODULE,
      compatibility_date: RELAY_COMPATIBILITY_DATE,
      bindings: [
        { type: "plain_text", name: "SERVER_URL", text: origin },
        { type: "plain_text", name: "RELAY_VERSION", text: RELAY_VERSION },
        { type: "secret_text", name: "ACCESS_CLIENT_ID", text: token.client_id },
        { type: "secret_text", name: "ACCESS_CLIENT_SECRET", text: token.client_secret },
      ],
    }));
    form.set(RELAY_MODULE, new File([RELAY_SOURCE], RELAY_MODULE, { type: "application/javascript+module" }));
    await api.call(`/accounts/${accountId}/workers/scripts/${RELAY_WORKER}`, { method: "PUT", form, what: "install the relay (Workers Scripts: Edit)" });
  } catch (error) {
    await access.revoke(token.id).catch((e: unknown) => console.error(JSON.stringify({ event: "relay_token_orphaned", accountId, error: (e as Error).message })));
    return { outcome: "failed", detail: `The relay could not be installed: ${errorText(error)} Nothing was left behind; try again.` };
  }

  try {
    await updateRelays(env.BUCKET, (relays) => [...relays.filter((r) => r.accountId !== accountId),
      { accountId, tokenId: token.id, clientId: token.client_id, origin, version: RELAY_VERSION, installedAt: new Date().toISOString() }]);
  } catch (error) {
    // The relay runs with a sign-in the registry does not name, so its deliveries would be refused: undo both.
    await api.call(`/accounts/${accountId}/workers/scripts/${RELAY_WORKER}`, { method: "DELETE", what: "remove the relay (Workers Scripts: Edit)" }).catch(() => undefined);
    await access.revoke(token.id).catch(() => undefined);
    return { outcome: "failed", detail: `The relay could not be recorded (${(error as Error).message}); it was removed again. Try again.` };
  }
  if (existing && existing.tokenId !== token.id)
    await access.revoke(existing.tokenId).catch((e: unknown) => console.warn(JSON.stringify({ event: "relay_old_token_kept", accountId, error: (e as Error).message })));
  console.log(JSON.stringify({ event: "relay_installed", accountId, version: RELAY_VERSION, replaced: !!existing }));
  return { outcome: "done", detail: there
    ? `The relay ${RELAY_WORKER} in this account was updated; it carries the account's mail here.`
    : `Installed the relay ${RELAY_WORKER} in this account: Cloudflare sends the domain's mail to it, and it hands each message to this server.` };
}

/** Removes the relay of an account: its Worker there, its sign-in here, its registry row. */
export async function removeRelay(input: { env: Env; accounts: CloudflareAccounts; accountId: string; api: CloudflareApi | null }): Promise<string | null> {
  const { env, accounts, accountId, api } = input;
  const existing = (await readRelays(env.BUCKET)).find((r) => r.accountId === accountId);
  if (!existing) return null;
  if (api) await api.call(`/accounts/${accountId}/workers/scripts/${RELAY_WORKER}`, { method: "DELETE", what: "remove the relay (Workers Scripts: Edit)" })
    .catch((error: unknown) => { if (!(error instanceof CloudflareApiError && (error.status === 404 || error.code === 10007))) throw error; });
  // The registry goes first: from here on its deliveries are refused, whatever happens to the token.
  await updateRelays(env.BUCKET, (relays) => relays.filter((r) => r.accountId !== accountId));
  const primary = accounts.primary();
  if (primary) await new AgentAccess(primary, env).revoke(existing.tokenId).catch((e: unknown) =>
    console.warn(JSON.stringify({ event: "relay_token_kept", accountId, error: (e as Error).message })));
  return `The relay ${RELAY_WORKER} was removed from the account.`;
}
