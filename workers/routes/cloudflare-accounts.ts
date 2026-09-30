import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { CloudflareApi, CloudflareApiError, ACCOUNT_TOKEN_PERMISSIONS } from "../routing/cloudflare-api";
import { accountTokenName, CloudflareAccounts, isAccountId, writeChoice } from "../routing/accounts";
import { DomainManager } from "../routing/domains";
import { allServedDomains } from "../lib/mailbox-store";
import { readRelays, removeRelay } from "../relay/install";

/**
 * The Cloudflare accounts of this server (MA-2, MA-3, MA-5, SCR-09): which ones there are, which
 * show on Domains & addresses, connecting one more with its own token, and removing it. A token is
 * kept as the server's own Worker secret `CLOUDFLARE_API_TOKEN_<account id>`; it is never echoed,
 * logged or stored anywhere else.
 */
export const cloudflareAccountsRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const NOT_CONNECTED = "This server has no Cloudflare token of its own yet; connect Cloudflare first (Domains & addresses).";
const TOKEN = /^[A-Za-z0-9._-]{20,300}$/;
const SECRETS_WHAT = "keep a token on your server (Workers Scripts: Edit on the server's account)";

function failure(c: C, error: unknown, event: string) {
  console.error(JSON.stringify({ event, error: (error as Error).message }));
  if (error instanceof CloudflareApiError) return c.json({ error: error.message }, error.isPermission ? 403 : 502);
  return c.json({ error: `The server could not finish this: ${(error as Error).message}. Try again.` }, 502);
}

/** The domains of an account that receive here (they keep it from being hidden or removed). */
async function servedIn(m: DomainManager, env: Env, accountId: string): Promise<string[]> {
  const [overview, served] = await Promise.all([m.overview(), allServedDomains(env)]);
  return overview.zones.filter((z) => z.accountId === accountId && served.includes(z.zone.name.toLowerCase())).map((z) => z.zone.name.toLowerCase()).sort();
}

cloudflareAccountsRouter.get("/api/cloudflare/accounts", async (c) => {
  c.header("Cache-Control", "no-store");
  const accounts = new CloudflareAccounts(c.env);
  if (!accounts.connected) return c.json({ connected: false, problem: NOT_CONNECTED, accounts: [], permissions: ACCOUNT_TOKEN_PERMISSIONS });
  try {
    const [overview, relays] = await Promise.all([new DomainManager(accounts, c.env).overview(), readRelays(c.env.BUCKET)]);
    return c.json({
      connected: true, permissions: ACCOUNT_TOKEN_PERMISSIONS,
      accounts: overview.accounts.map((a) => {
        const relay = relays.find((r) => r.accountId === a.id);
        return { ...a, relay: relay ? { version: relay.version, installedAt: relay.installedAt } : null };
      }),
      ...(overview.problems.length ? { problems: overview.problems } : {}),
    });
  } catch (error) { return failure(c, error, "cloudflare_accounts_read_failed"); }
});

cloudflareAccountsRouter.put("/api/cloudflare/accounts/:id", async (c) => {
  const id = c.req.param("id");
  if (!isAccountId(id)) return c.json({ error: "Not a Cloudflare account id" }, 400);
  const parsed = z.object({ shown: z.boolean().nullable() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Say whether the account is shown (true, false, or null for the default)" }, 400);
  const accounts = new CloudflareAccounts(c.env);
  if (!accounts.connected) return c.json({ error: NOT_CONNECTED }, 503);
  try {
    if (!(await accounts.list()).accounts.some((a) => a.id === id)) return c.json({ error: "No token this server has reaches that account" }, 404);
    if (parsed.data.shown === false) {
      const served = await servedIn(new DomainManager(accounts, c.env), c.env, id);
      if (served.length) return c.json({ error: `Its domains receive here (${served.join(", ")}); stop receiving them first, or keep the account shown.`, served }, 409);
    }
    const choices = await writeChoice(c.env.BUCKET, id, parsed.data.shown === null ? null : parsed.data.shown ? "shown" : "hidden");
    console.log(JSON.stringify({ event: "cloudflare_account_choice", accountId: id, choice: choices[id] ?? "default" }));
    return c.json({ id, choice: choices[id] ?? null });
  } catch (error) { return failure(c, error, "cloudflare_account_choice_failed"); }
});

cloudflareAccountsRouter.post("/api/cloudflare/accounts", async (c) => {
  const parsed = z.object({ token: z.string().trim() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !TOKEN.test(parsed.data.token))
    return c.json({ error: "This does not look like a Cloudflare API token. Copy it again from the page Cloudflare showed after creating it." }, 400);
  const accounts = new CloudflareAccounts(c.env);
  const primary = accounts.primary();
  if (!primary) return c.json({ error: NOT_CONNECTED }, 503);
  let seen: { id: string; name: string }[];
  try {
    seen = await new CloudflareApi(parsed.data.token).list<{ id: string; name: string }>("/accounts", "find its account (Account Settings: Read)");
  } catch (error) {
    // The message never carries the token: CloudflareApi names the permission or the refusal only.
    const refused = error instanceof CloudflareApiError && (error.status === 401 || /no longer accepts/.test(error.message));
    return c.json({ error: refused ? "Cloudflare does not accept this token: it may be mistyped, expired or deleted. Copy it again, or create a new one."
      : error instanceof CloudflareApiError ? error.message.replace("The Cloudflare token", "This token") : "Cloudflare could not be reached; try again." }, 400);
  }
  if (!seen.length) return c.json({ error: "The token sees no Cloudflare account. When creating it, choose the account under Account Resources." }, 400);
  try {
    const server = await accounts.serverAccountId();
    const own = new Set(accounts.tokens.filter((t) => t.accountId).map((t) => t.accountId));
    const connected: { id: string; name: string }[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    for (const a of seen) {
      if (a.id === server) { skipped.push({ ...a, reason: "the server's own account, reached by its own token" }); continue; }
      if (own.has(a.id)) { skipped.push({ ...a, reason: "already connected; remove it first to replace its token" }); continue; }
      await primary.call(`/accounts/${server}/workers/scripts/${accounts.script}/secrets`, {
        method: "PUT", what: SECRETS_WHAT, body: { name: accountTokenName(a.id), text: parsed.data.token, type: "secret_text" },
      });
      connected.push({ id: a.id, name: a.name });
    }
    console.log(JSON.stringify({ event: "cloudflare_accounts_connected", connected: connected.map((a) => a.id), skipped: skipped.length }));
    return c.json({ connected, skipped, note: connected.length ? "The server starts using the token within a few seconds." : undefined }, connected.length ? 201 : 200);
  } catch (error) { return failure(c, error, "cloudflare_account_connect_failed"); }
});

cloudflareAccountsRouter.delete("/api/cloudflare/accounts/:id", async (c) => {
  const id = c.req.param("id");
  if (!isAccountId(id)) return c.json({ error: "Not a Cloudflare account id" }, 400);
  const accounts = new CloudflareAccounts(c.env);
  const primary = accounts.primary();
  if (!primary) return c.json({ error: NOT_CONNECTED }, 503);
  if (!accounts.tokens.some((t) => t.accountId === id))
    return c.json({ error: "That account has no token of its own here; the server's own token reaches it, so hide it instead." }, 404);
  try {
    const server = await accounts.serverAccountId();
    if (id === server) return c.json({ error: "This is the account the server runs in; it cannot be removed." }, 400);
    const m = new DomainManager(accounts, c.env);
    const served = await servedIn(m, c.env, id);
    if (served.length) return c.json({ error: `Its domains receive here (${served.join(", ")}); stop receiving them first.`, served }, 409);
    const relay = await removeRelay({ env: c.env, accounts, accountId: id, api: await accounts.apiFor(id) });
    await primary.call(`/accounts/${server}/workers/scripts/${accounts.script}/secrets/${accountTokenName(id)}`, { method: "DELETE", what: SECRETS_WHAT })
      .catch((error: unknown) => { if (!(error instanceof CloudflareApiError && error.status === 404)) throw error; });
    await writeChoice(c.env.BUCKET, id, null);
    console.log(JSON.stringify({ event: "cloudflare_account_removed", accountId: id, relay: !!relay }));
    return c.json({ id, removed: true, ...(relay ? { relay } : {}) });
  } catch (error) { return failure(c, error, "cloudflare_account_remove_failed"); }
});
