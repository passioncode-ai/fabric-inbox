/**
 * The Cloudflare side of an agent key (AP-7): a service token, and a Service Auth policy on the
 * server's own Access application that admits it.
 *
 * One reusable policy per server (named after the application's audience tag) lists every agent's
 * token; it is attached to the application once. Legacy application-scoped policies cannot be added
 * to applications made today, so the policy is reusable and the application is updated with its
 * current policies kept as they are.
 */
import { accountIdFor, CloudflareApi, CloudflareApiError, type TokenEnv } from "../routing/cloudflare-api";

export const TOKEN_DURATIONS = { "30d": "720h", "90d": "2160h", "1y": "8760h" } as const;
export type TokenDuration = keyof typeof TOKEN_DURATIONS;

interface AccessApp { id: string; aud: string; name?: string; policies?: { id: string; precedence?: number }[]; [field: string]: unknown }
interface AccessPolicy { id: string; name: string; decision: string; include: Record<string, unknown>[] }
interface ServiceToken { id: string; client_id: string; client_secret: string; expires_at?: string; name: string }

const WHAT_TOKENS = "manage agent keys (Access: Service Tokens: Edit)";
const WHAT_APPS = "let agent keys through the server's sign-in (Access: Apps and Policies: Edit)";
/** Fields Cloudflare fills in on an application; an update sends the rest back unchanged. */
const READ_ONLY = new Set(["id", "uid", "aud", "created_at", "updated_at", "policies"]);

export const policyName = (aud: string) => `Fabric Inbox agents ${aud.slice(0, 12)}`;
const tokenRule = (tokenId: string) => ({ service_token: { token_id: tokenId } });
const ruleToken = (rule: Record<string, unknown>) => (rule.service_token as { token_id?: string } | undefined)?.token_id;

export class AgentAccess {
  constructor(private api: CloudflareApi, private env: TokenEnv & { POLICY_AUD?: string }) {}

  private async account() { return accountIdFor(this.api, this.env); }

  private async app(account: string): Promise<AccessApp> {
    const aud = this.env.POLICY_AUD;
    if (!aud) throw new CloudflareApiError("This server has no Access sign-in (POLICY_AUD), so agent keys cannot be made for it.", 400);
    const apps = await this.api.list<AccessApp>(`/accounts/${account}/access/apps`, WHAT_APPS);
    const app = apps.find((a) => a.aud === aud);
    if (!app) throw new CloudflareApiError("The Access application that signs in to this server was not found in this Cloudflare account.", 404);
    return app;
  }

  private async policy(account: string, aud: string): Promise<AccessPolicy | null> {
    const policies = await this.api.list<AccessPolicy>(`/accounts/${account}/access/policies`, WHAT_APPS);
    return policies.find((p) => p.name === policyName(aud)) ?? null;
  }

  private async writePolicy(account: string, aud: string, existing: AccessPolicy | null, tokenIds: string[]): Promise<AccessPolicy> {
    const body = { name: policyName(aud), decision: "non_identity", include: tokenIds.map(tokenRule) };
    return existing
      ? this.api.call<AccessPolicy>(`/accounts/${account}/access/policies/${existing.id}`, { method: "PUT", body, what: WHAT_APPS })
      : this.api.call<AccessPolicy>(`/accounts/${account}/access/policies`, { method: "POST", body, what: WHAT_APPS });
  }

  /**
   * Puts the policy on the application, or takes it off, keeping every other policy and setting.
   * The application is read whole just before the change; one that has no sign-in of its own besides
   * the agents' is refused, since changing it could leave the owner locked out. Afterwards the owner's
   * policies are checked, and put back if Cloudflare dropped any.
   */
  private async attach(account: string, appId: string, policyId: string, on: boolean) {
    const app = await this.api.call<AccessApp>(`/accounts/${account}/access/apps/${appId}`, { what: WHAT_APPS });
    const current = (app.policies ?? []).map((p, i) => ({ id: p.id, precedence: p.precedence ?? i + 1 }));
    const own = current.filter((p) => p.id !== policyId);
    const has = current.some((p) => p.id === policyId);
    if (has === on) return;
    if (!own.length) throw new CloudflareApiError("The server's Access application shows no sign-in policy of its own, so it was left unchanged. Check it in Zero Trust → Access → Applications.", 409);
    const policies = on ? [...current, { id: policyId, precedence: Math.max(0, ...current.map((p) => p.precedence)) + 1 }] : own;
    const body = Object.fromEntries(Object.entries(app).filter(([k]) => !READ_ONLY.has(k)));
    const saved = await this.api.call<AccessApp>(`/accounts/${account}/access/apps/${app.id}`, { method: "PUT", body: { ...body, policies }, what: WHAT_APPS });
    const kept = new Set((saved?.policies ?? []).map((p) => p.id));
    if (own.some((p) => !kept.has(p.id))) {
      await this.api.call(`/accounts/${account}/access/apps/${app.id}`, { method: "PUT", body: { ...body, policies: current }, what: WHAT_APPS }).catch(() => {});
      throw new CloudflareApiError("Cloudflare did not keep the server's own sign-in policies when the agents' policy was added; they were put back. Check Zero Trust → Access → Applications.", 502);
    }
  }

  /**
   * Makes a service token and lets it through. If letting it through fails, the token is deleted
   * again so no credential exists that the server does not know about.
   */
  async create(name: string, duration: TokenDuration | "forever", kind: "agent" | "relay" = "agent"): Promise<ServiceToken> {
    const account = await this.account();
    const app = await this.app(account);
    // A relay (workers/relay/) must not stop carrying mail on a date nobody watches: its token does not expire.
    const token = await this.api.call<ServiceToken>(`/accounts/${account}/access/service_tokens`, {
      method: "POST", body: { name: `Fabric Inbox ${kind}: ${name}`.slice(0, 120), duration: duration === "forever" ? "forever" : TOKEN_DURATIONS[duration] }, what: WHAT_TOKENS,
    });
    try {
      const existing = await this.policy(account, app.aud);
      const ids = [...new Set([...(existing?.include ?? []).map(ruleToken).filter((id): id is string => !!id), token.id])];
      const policy = await this.writePolicy(account, app.aud, existing, ids);
      await this.attach(account, app.id, policy.id, true);
    } catch (error) {
      // Out of the policy as well as deleted, so a later key never re-sends a dead token's id.
      await this.revoke(token.id).catch(() =>
        this.api.call(`/accounts/${account}/access/service_tokens/${token.id}`, { method: "DELETE", what: WHAT_TOKENS }).catch(() => {}));
      throw error;
    }
    return token;
  }

  /**
   * Takes the token out of the policy and deletes it. A token already gone in Cloudflare is not an
   * error. The last token takes the policy off the application and deletes it, since a policy that
   * includes nobody is refused.
   */
  async revoke(tokenId: string): Promise<void> {
    const account = await this.account();
    const app = await this.app(account);
    const existing = await this.policy(account, app.aud);
    if (existing) {
      const ids = existing.include.map(ruleToken).filter((id): id is string => !!id && id !== tokenId);
      if (ids.length) await this.writePolicy(account, app.aud, existing, ids);
      else {
        await this.attach(account, app.id, existing.id, false);
        await this.api.call(`/accounts/${account}/access/policies/${existing.id}`, { method: "DELETE", what: WHAT_APPS });
      }
    }
    try {
      await this.api.call(`/accounts/${account}/access/service_tokens/${tokenId}`, { method: "DELETE", what: WHAT_TOKENS });
    } catch (error) {
      if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
    }
  }
}
