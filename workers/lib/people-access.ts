/**
 * B-215: the people on the list (Settings → People, workers/lib/members.ts) can sign in with nothing done in
 * Cloudflare by hand. The server keeps one reusable Access policy of its own on its Access application, named after
 * the application's audience tag, that admits every listed email; it is rewritten from the whole list after each
 * change, so it never drifts, and taken off and deleted when the list is empty. The organization's own sign-in
 * policies (an Access group, an identity provider) are never touched: the application keeps them as they are
 * (`attachPolicy`). The outcome of the last sync is kept in R2 so the list can say who can sign in.
 */
import { accountIdFor, cloudflareApi, CloudflareApiError, cloudflareToken, type CloudflareApi, type TokenEnv } from "../routing/cloudflare-api";
import { attachPolicy, WHAT_APPS, type AccessApp } from "../mcp/access";
import type { Member } from "./members";

export const SIGN_IN_KEY = "config/members-sign-in.json";
/** At most this many emails in one policy: the list's own limit (members.ts MAX_MEMBERS). */
const MAX_EMAILS = 500;

interface AccessPolicy { id: string; name: string; decision: string; include: Record<string, unknown>[] }
export const peoplePolicyName = (aud: string) => `Fabric Inbox people ${aud.slice(0, 12)}`;
const emailOf = (rule: Record<string, unknown>) => (rule.email as { email?: string } | undefined)?.email?.toLowerCase();

/** What the last sync did: the emails the policy admits, or why it could not be written. */
export interface SignInState {
  at: string;
  state: "ok" | "failed" | "not_set_up";
  /** The emails the policy admitted after the sync (empty when it failed or is not set up). */
  emails: string[];
  reason?: string;
}

export type SignInEnv = TokenEnv & { POLICY_AUD?: string; BUCKET: R2Bucket };

/** The emails the list lets in: every listed person, administrators and members. */
export const emailsOf = (members: readonly Member[]) => [...new Set(members.map((m) => m.email.toLowerCase()))].sort().slice(0, MAX_EMAILS);

/**
 * Makes the server's people policy admit exactly `emails`, and records the outcome. Never throws: a failure is
 * the outcome, so a saved list stays saved and the caller says the sign-in waits.
 */
export async function syncSignIn(env: SignInEnv, emails: string[], api?: CloudflareApi): Promise<SignInState> {
  const at = new Date().toISOString();
  let state: SignInState;
  const client = api ?? cloudflareApi(env);
  if (!env.POLICY_AUD || !cloudflareToken(env) || !client) {
    state = { at, state: "not_set_up", emails: [], reason: "This server has no Access sign-in or no Cloudflare token, so people sign in however its Access application allows." };
  } else {
    try {
      await writePolicy(client, env, env.POLICY_AUD, emails);
      state = { at, state: "ok", emails };
    } catch (error) {
      const reason = error instanceof CloudflareApiError ? error.message : (error as Error)?.message ?? String(error);
      console.error(JSON.stringify({ event: "people_sign_in_failed", error: reason.slice(0, 200) }));
      state = { at, state: "failed", emails: [], reason: reason.slice(0, 500) };
    }
  }
  await env.BUCKET.put(SIGN_IN_KEY, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
  console.log(JSON.stringify({ event: "people_sign_in_synced", state: state.state, people: state.emails.length }));
  return state;
}

async function writePolicy(api: CloudflareApi, env: TokenEnv, aud: string, emails: string[]) {
  const account = await accountIdFor(api, env);
  const app = (await api.list<AccessApp>(`/accounts/${account}/access/apps`, WHAT_APPS)).find((a) => a.aud === aud);
  if (!app) throw new CloudflareApiError("The Access application that signs in to this server was not found in this Cloudflare account.", 404);
  const existing = (await api.list<AccessPolicy>(`/accounts/${account}/access/policies`, WHAT_APPS)).find((p) => p.name === peoplePolicyName(aud)) ?? null;
  if (!emails.length) {
    // A policy that includes nobody is refused: the empty list takes it off and deletes it.
    if (existing) {
      await attachPolicy(api, account, app.id, existing.id, false);
      await api.call(`/accounts/${account}/access/policies/${existing.id}`, { method: "DELETE", what: WHAT_APPS });
    }
    return;
  }
  const same = existing && existing.decision === "allow" && existing.include.length === emails.length
    && existing.include.map(emailOf).sort().join(",") === emails.join(",");
  const body = { name: peoplePolicyName(aud), decision: "allow", include: emails.map((email) => ({ email: { email } })) };
  const policy = same ? existing! : existing
    ? await api.call<AccessPolicy>(`/accounts/${account}/access/policies/${existing.id}`, { method: "PUT", body, what: WHAT_APPS })
    : await api.call<AccessPolicy>(`/accounts/${account}/access/policies`, { method: "POST", body, what: WHAT_APPS });
  await attachPolicy(api, account, app.id, policy.id, true);
}

/** The last sync's outcome, or null before the first one. */
export async function readSignIn(bucket: R2Bucket): Promise<SignInState | null> {
  const object = await bucket.get(SIGN_IN_KEY);
  if (!object) return null;
  const raw = (await object.json().catch(() => null)) as Partial<SignInState> | null;
  if (!raw || typeof raw.at !== "string" || !["ok", "failed", "not_set_up"].includes(String(raw.state))) return null;
  return { at: raw.at, state: raw.state as SignInState["state"], emails: Array.isArray(raw.emails) ? raw.emails.filter((e): e is string => typeof e === "string") : [],
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}) };
}

/** Whether one person can sign in by the last sync: yes, no (with the reason) or unknown before any sync. */
export function signInOf(state: SignInState | null, email: string): { canSignIn: boolean | null; reason?: string } {
  if (!state) return { canSignIn: null };
  if (state.state === "not_set_up") return { canSignIn: null, reason: state.reason };
  if (state.emails.includes(email.toLowerCase())) return { canSignIn: true };
  return { canSignIn: false, reason: state.reason ?? "Not in the server's sign-in yet. Try again." };
}
