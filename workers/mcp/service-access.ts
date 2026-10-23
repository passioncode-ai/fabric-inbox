/**
 * B-150: the fabric-service routes behind an Access application of their own.
 *
 * Behind the server's own application, a request with no credential gets a 302 to the sign-in page,
 * and the contract wants 401 from a remote placement's protocol routes (fabric-agent-contract
 * service.md, Remote placement). A second, path-scoped self-hosted application on
 * `/.well-known/fabric-service` and `/fabric/v1` carries only the agents' Service Auth policy and
 * `service_auth_401_redirect`, so Access answers 401 there and the person's sign-in is unchanged
 * everywhere else. Its audience tag is kept in R2; the Worker accepts a token of that audience on
 * those routes only.
 */
import type { CloudflareApi } from "../routing/cloudflare-api";
import { FABRIC_SERVICE_READS } from "./keys";
import { policyName, serviceAppName } from "./access";

export const SERVICE_ACCESS_KEY = "config/fabric-service-access.json";
export { serviceAppName };
const WHAT = "protect the Fabric routes with agent keys only (Access: Apps and Policies: Edit)";

export interface ServiceAccess { aud: string; appId: string; createdAt: string }
type AccessApp = { id: string; aud: string; name?: string; policies?: { id: string }[] };
type AccessPolicy = { id: string; name: string };

/** The destinations the application covers: the well-known document and everything under /fabric/v1. */
export const serviceDomains = (host: string) => [`${host}/.well-known/fabric-service`, `${host}/fabric/v1`];

/** Whether a path is one the service application covers (and so one its token may reach). */
export const servicePath = (pathname: string) => FABRIC_SERVICE_READS.includes(pathname);

/**
 * Makes the service application when it is missing. `no_keys`: no agent key exists, so there is no
 * policy to attach; the next key's first read makes it. Never touches the server's own application.
 */
export async function ensureServiceApp(api: CloudflareApi, account: string, aud: string, host: string):
  Promise<{ state: "created" | "already"; access: ServiceAccess } | { state: "no_keys" }> {
  const apps = await api.list<AccessApp>(`/accounts/${account}/access/apps`, WHAT, 100);
  const name = serviceAppName(aud);
  const found = apps.find((a) => a.name === name);
  if (found) return { state: "already", access: { aud: found.aud, appId: found.id, createdAt: new Date().toISOString() } };
  const policies = await api.list<AccessPolicy>(`/accounts/${account}/access/policies`, WHAT, 100);
  const policy = policies.find((p) => p.name === policyName(aud));
  if (!policy) return { state: "no_keys" };
  const [first] = serviceDomains(host);
  const app = await api.call<AccessApp>(`/accounts/${account}/access/apps`, { method: "POST", what: WHAT, body: {
    name, type: "self_hosted", domain: first, self_hosted_domains: serviceDomains(host), app_launcher_visible: false,
    session_duration: "24h", service_auth_401_redirect: true, read_service_tokens_from_header: "Authorization",
    policies: [{ id: policy.id, precedence: 1 }],
  } });
  return { state: "created", access: { aud: app.aud, appId: app.id, createdAt: new Date().toISOString() } };
}

/** The service application's audience as R2 keeps it, or null. */
export async function readServiceAccess(bucket: R2Bucket): Promise<ServiceAccess | null> {
  const object = await bucket.get(SERVICE_ACCESS_KEY);
  if (!object) return null;
  const value = await object.json<Partial<ServiceAccess>>().catch(() => null);
  return value && typeof value.aud === "string" && value.aud ? (value as ServiceAccess) : null;
}

let cached: { at: number; aud: string | null } | null = null;
/** The audience, read from R2 at most once a minute per isolate. */
export async function serviceAudience(bucket: R2Bucket, now = Date.now()): Promise<string | null> {
  if (cached && now - cached.at < 60_000) return cached.aud;
  const access = await readServiceAccess(bucket).catch(() => null);
  cached = { at: now, aud: access?.aud ?? null };
  return cached.aud;
}
export const forgetServiceAudience = () => { cached = null; };

/**
 * The audience a request's Access token is verified against: the server's own, except on the
 * fabric-service routes, where a token that does not name it is checked against the service
 * application's (read through `lookup` only then). Elsewhere a service token never passes.
 */
export async function audienceFor(pathname: string, claimedAud: unknown, policyAud: string, lookup: () => Promise<string | null>): Promise<string> {
  if (!servicePath(pathname)) return policyAud;
  const claimed: unknown[] = Array.isArray(claimedAud) ? claimedAud : [claimedAud];
  if (claimed.includes(policyAud)) return policyAud;
  return (await lookup()) ?? policyAud;
}
