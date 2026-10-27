/**
 * The server updates itself (B-44): the person's app sends the server bundle it carries, and this
 * Worker uploads it to Cloudflare with its own token (CLOUDFLARE_API_TOKEN, which Create my server
 * gave it with Workers Scripts: Edit), so an update never asks for a new token. The same checks as
 * the app's own upload (desktop/cloudflare-deploy.cjs, uploadServer): never an older version, never a
 * storage step that deletes or moves data, every setting and secret of the running server kept.
 *
 * Contracts (Cloudflare API v4, as desktop/cloudflare-deploy.cjs uses them):
 *  GET  /accounts/{a}/workers/scripts                    the running script and its migration tag
 *  GET  /accounts/{a}/workers/scripts/{s}/settings       its bindings (bucket names)
 *  POST /accounts/{a}/workers/scripts/{s}/assets-upload-session, POST /accounts/{a}/workers/assets/upload?base64=true
 *  PUT  /accounts/{a}/workers/scripts/{s}                 multipart: metadata + ES modules
 */
import { version as RUNNING } from "../../package.json";
import { CloudflareApi, CloudflareApiError } from "../routing/cloudflare-api";
import { msg } from "../../shared/i18n";

export const SERVER_BUNDLE_FORMAT = "fabric-inbox-server/1";

export interface ServerManifest {
  format: string;
  version: string;
  revision?: string;
  worker: { main_module: string; compatibility_date: string; compatibility_flags: string[]; observability?: unknown };
  modules: { name: string; file: string }[];
  durableObjects: { name: string; class_name: string }[];
  migrations: ({ tag: string } & Record<string, unknown>)[];
  r2Buckets: { binding: string; bucket_name: string }[];
  sendEmail: { name: string }[];
  ai: { binding: string } | null;
  assets: { config: Record<string, unknown>; files: Record<string, { hash: string; size: number; contentType: string }> };
}

export class SelfUpdateRefused extends Error {
  constructor(readonly status: 400 | 409 | 413, message: string) { super(message); }
}

/** "0.6.1" < "0.10.0", a prerelease below its release (as desktop/cloudflare-deploy.cjs compareVersions). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const [core, pre = ""] = String(v).split("-", 2); return { core: core!.split(".").map((x) => parseInt(x, 10) || 0), pre }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Whether a manifest is a server bundle this server can take; the reason when it is not. */
export function checkManifest(value: unknown, running = RUNNING): ServerManifest {
  const m = value as ServerManifest | null;
  if (!m || m.format !== SERVER_BUNDLE_FORMAT || typeof m.version !== "string" || !Array.isArray(m.modules) || !m.modules.length
    || !m.worker?.main_module || !Array.isArray(m.migrations) || !m.assets?.files)
    throw new SelfUpdateRefused(400, msg("This is not a server bundle this server can take."));
  const order = compareVersions(m.version, running);
  if (order < 0) throw new SelfUpdateRefused(409, msg("The bundle is version {version}, older than this server's {running}; an older server would not know the newer data.", { version: m.version, running }));
  if (order === 0) throw new SelfUpdateRefused(409, msg("This server already runs {version}.", { version: running }));
  // A storage step that deletes, renames or moves a class would destroy or move every user's data in it.
  const unsafe = m.migrations.find((step) => Object.keys(step).some((k) => k !== "tag" && k !== "new_sqlite_classes" && k !== "new_classes"));
  if (unsafe) throw new SelfUpdateRefused(400, msg("The server bundle has a storage step ({tag}) that would delete or move stored data; it is not sent.", { tag: unsafe.tag }));
  return m;
}

/** The storage steps from the running server's tag to the bundle's last one, or none. */
export function pendingMigrations(manifest: ServerManifest, currentTag: string | null | undefined) {
  const tags = manifest.migrations.map((m) => m.tag);
  const steps = (list: ServerManifest["migrations"]) => list.map(({ tag: _tag, ...step }) => step);
  if (!currentTag) return { new_tag: tags[tags.length - 1], steps: steps(manifest.migrations) };
  const at = tags.indexOf(currentTag);
  if (at < 0) throw new SelfUpdateRefused(409, msg("The server's storage version {tag} is not in this bundle; the bundle is from another line of releases.", { tag: currentTag }));
  const pending = manifest.migrations.slice(at + 1);
  return pending.length ? { old_tag: currentTag, new_tag: tags[tags.length - 1], steps: steps(pending) } : null;
}

export interface UpdateFiles {
  /** A Worker module by its name in the manifest. */
  module(name: string): Promise<Uint8Array | null>;
  /** A static file by its hash in the manifest. */
  asset(hash: string): Promise<Uint8Array | null>;
}

const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Uploads the bundle's static files, then the Worker with the bundle's bindings over the running
 * server's own (`keep_bindings`: DOMAINS, the Access settings, every secret). Returns the version.
 */
export async function selfUpdate(input: { api: CloudflareApi; accountId: string; script: string; manifest: ServerManifest; files: UpdateFiles;
  uploader?: (jwt: string) => CloudflareApi }): Promise<{ version: string; uploaded: number }> {
  const { api, accountId, script, manifest, files } = input;
  const a = `/accounts/${accountId}`;
  const scripts = await api.list<{ id: string; migration_tag?: string }>(`${a}/workers/scripts`, msg("read Workers (Workers Scripts: Edit)"), 100);
  const current = scripts.find((s) => s.id === script);
  if (!current) throw new SelfUpdateRefused(409, msg("The server's script {script} is not in its Cloudflare account; update it from the app with a token instead.", { script }));
  const settings = await api.call<{ bindings?: { type: string; name: string; bucket_name?: string; jurisdiction?: string }[] }>(`${a}/workers/scripts/${script}/settings`, { what: msg("read the server settings (Workers Scripts: Edit)") });
  const buckets = new Map((settings.bindings ?? []).filter((b) => b.type === "r2_bucket").map((b) => [b.name, b.bucket_name ?? ""]));
  // B-157: a bucket made in a jurisdiction is reached only with it; the update keeps the binding's.
  const places = new Map((settings.bindings ?? []).filter((b) => b.type === "r2_bucket" && b.jurisdiction).map((b) => [b.name, b.jurisdiction!]));
  const migrations = pendingMigrations(manifest, current.migration_tag);

  // Every module before anything is uploaded: a half bundle must not reach Cloudflare.
  const modules: { name: string; bytes: Uint8Array }[] = [];
  for (const m of manifest.modules) {
    const bytes = await files.module(m.name);
    if (!bytes) throw new SelfUpdateRefused(400, msg("The bundle lacks its module {name}.", { name: m.name }));
    modules.push({ name: m.name, bytes });
  }

  const entries = Object.entries(manifest.assets.files);
  const session = await api.call<{ jwt: string; buckets?: string[][] }>(`${a}/workers/scripts/${script}/assets-upload-session`, {
    method: "POST", what: msg("upload the server (Workers Scripts: Edit)"),
    body: { manifest: Object.fromEntries(entries.map(([p, f]) => [p, { hash: f.hash, size: f.size }])) },
  });
  const byHash = new Map(entries.map(([, f]) => [f.hash, f]));
  let completion = session.jwt;
  let uploaded = 0;
  const uploader = input.uploader ?? ((jwt: string) => new CloudflareApi(jwt));
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      const bytes = file ? await files.asset(hash) : null;
      if (!file || !bytes) throw new SelfUpdateRefused(400, msg("Cloudflare asked for a file the bundle does not carry ({hash}).", { hash: hash.slice(0, 12) }));
      form.append(hash, new File([base64(bytes)], hash, { type: file.contentType }), hash);
      uploaded++;
    }
    const result = await uploader(session.jwt).call<{ jwt?: string }>(`${a}/workers/assets/upload?base64=true`, { method: "POST", form, what: msg("upload the server (Workers Scripts: Edit)") });
    if (result?.jwt) completion = result.jwt;
  }

  const bindings = [
    ...manifest.durableObjects.map((d) => ({ type: "durable_object_namespace", name: d.name, class_name: d.class_name })),
    // The bucket the running server already keeps its mail in, whatever the bundle names.
    ...manifest.r2Buckets.map((r) => ({ type: "r2_bucket", name: r.binding, bucket_name: buckets.get(r.binding) || r.bucket_name, ...(places.get(r.binding) ? { jurisdiction: places.get(r.binding) } : {}) })),
    ...manifest.sendEmail.map((e) => ({ type: "send_email", name: e.name })),
    ...(manifest.ai ? [{ type: "ai", name: manifest.ai.binding }] : []),
    { type: "plain_text", name: "FABRIC_SERVER_VERSION", text: manifest.version },
  ];
  const metadata = {
    main_module: manifest.worker.main_module,
    compatibility_date: manifest.worker.compatibility_date,
    compatibility_flags: manifest.worker.compatibility_flags,
    bindings,
    ...(migrations ? { migrations } : {}),
    keep_bindings: ["secret_text", "secret_key", "plain_text", "json"],
    assets: { jwt: completion, config: manifest.assets.config },
    ...(manifest.worker.observability ? { observability: manifest.worker.observability } : {}),
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const m of modules) form.set(m.name, new File([m.bytes as Uint8Array<ArrayBuffer>], m.name, { type: "application/javascript+module" }));
  try {
    await api.call(`${a}/workers/scripts/${script}`, { method: "PUT", form, what: msg("upload the server (Workers Scripts: Edit)") });
  } catch (error) {
    if (error instanceof CloudflareApiError) throw error;
    throw new CloudflareApiError(msg("Cloudflare did not take the new server ({error}). The running server is unchanged.", { error: (error as Error).message }), 502);
  }
  return { version: manifest.version, uploaded };
}

/** The one header Access reads an agent key from for the fabric-service descriptor (B-87 part 4). */
export const SERVICE_TOKEN_HEADER = "Authorization";

/**
 * B-148: a server made before 0.28.1 has an Access application that reads an agent key only from the
 * two usual headers. Sets `read_service_tokens_from_header` on the application whose aud is the
 * server's POLICY_AUD, keeping every other field (Cloudflare's PUT replaces the whole application).
 * Never throws: the outcome is said, and a failure leaves the server as it was.
 */
export async function ensureAccessHeader(api: CloudflareApi, accountId: string, aud: string | undefined): Promise<"set" | "already" | "no_app" | `failed: ${string}`> {
  if (!aud) return "no_app";
  try {
    const apps = await api.list<Record<string, unknown> & { id?: string; aud?: string; read_service_tokens_from_header?: string }>(
      `/accounts/${accountId}/access/apps`, msg("read Access applications (Access: Apps and Policies: Edit)"), 100);
    const app = apps.find((a) => a.aud === aud);
    if (!app?.id) return "no_app";
    if (app.read_service_tokens_from_header === SERVICE_TOKEN_HEADER) return "already";
    const { id, uid: _uid, aud: _aud, created_at: _c, updated_at: _u, policies: _p, ...rest } = app as Record<string, unknown> & { id: string };
    await api.call(`/accounts/${accountId}/access/apps/${id}`, { method: "PUT", body: { ...rest, read_service_tokens_from_header: SERVICE_TOKEN_HEADER },
      what: msg("let agent keys in one header (Access: Apps and Policies: Edit)") });
    return "set";
  } catch (error) {
    return `failed: ${(error as Error).message.slice(0, 160)}`;
  }
}
