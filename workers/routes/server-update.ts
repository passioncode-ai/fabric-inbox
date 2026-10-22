import { Hono } from "hono";
import { version } from "../../package.json";
import type { Env } from "../types";
import { cloudflareApi, CloudflareApiError, configuredAccountId } from "../routing/cloudflare-api";
import { checkManifest, selfUpdate, SelfUpdateRefused } from "../lib/self-update";
import { msg } from "../../shared/i18n";

/**
 * The server's own version, and the update the person's app sends it (B-44). Behind Access like
 * every /api route, so only a person reaches it (`identityMayUse`: an agent key is limited to /mcp):
 * an agent can never replace the server's code.
 */
export const serverUpdateRouter = new Hono<{ Bindings: Env }>();

/** The largest bundle taken: the server and its static files are about 13 MB today. */
export const MAX_BUNDLE_BYTES = 60 * 1024 * 1024;

const scriptOf = (env: Env) => env.EMAIL_ROUTING_WORKER || "fabric-inbox";

serverUpdateRouter.get("/api/server", (c) => {
  c.header("Cache-Control", "no-store");
  const token = !!cloudflareApi(c.env);
  const account = configuredAccountId(c.env);
  return c.json({
    version,
    // Whether this server can take an update from the app without a new token.
    selfUpdate: token && account
      ? { available: true }
      : { available: false, reason: !token ? msg("This server has no Cloudflare token.") : msg("This server does not know its Cloudflare account (CLOUDFLARE_ACCOUNT_ID).") },
  });
});

serverUpdateRouter.post("/api/server/self-update", async (c) => {
  c.header("Cache-Control", "no-store");
  const api = cloudflareApi(c.env);
  const accountId = configuredAccountId(c.env);
  if (!api || !accountId) return c.json({ error: msg("This server cannot update itself: it has no Cloudflare token or does not know its account. Update it from the app with a token."), code: "not_configured" }, 409);
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BUNDLE_BYTES) return c.json({ error: msg("The bundle is larger than a server update may be."), code: "too_large" }, 413);
  let form: FormData;
  try { form = await c.req.formData(); }
  catch { return c.json({ error: msg("The update could not be read: send the bundle as multipart form data."), code: "bad_request" }, 400); }
  const started = Date.now();
  try {
    const raw = form.get("manifest");
    let parsed: unknown = null;
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : null; } catch { parsed = null; }
    const manifest = checkManifest(parsed);
    const bytesOf = async (key: string) => {
      const part = form.get(key);
      return part && typeof part !== "string" ? new Uint8Array(await part.arrayBuffer()) : null;
    };
    const result = await selfUpdate({ api, accountId, script: scriptOf(c.env), manifest,
      files: { module: (name) => bytesOf(`module:${name}`), asset: (hash) => bytesOf(`asset:${hash}`) } });
    console.log(JSON.stringify({ event: "server_self_update", outcome: "done", from: version, to: result.version, uploaded: result.uploaded, ms: Date.now() - started }));
    return c.json({ updated: true, from: version, to: result.version });
  } catch (error) {
    if (error instanceof SelfUpdateRefused) {
      console.log(JSON.stringify({ event: "server_self_update", outcome: "refused", status: error.status }));
      return c.json({ error: error.message, code: error.status === 409 ? "refused" : error.status === 413 ? "too_large" : "bad_request" }, error.status);
    }
    const permission = error instanceof CloudflareApiError && error.isPermission;
    console.error(JSON.stringify({ event: "server_self_update", outcome: "failed", permission, error: (error as Error).message.slice(0, 200) }));
    return c.json({ error: (error as Error).message, code: permission ? "permission" : "failed" }, permission ? 403 : 502);
  }
});
