#!/usr/bin/env node
// Registers a person's Fabric Inbox server with Fabric Dashboards on this computer (B-87 part 4):
// the fabric-service/0.1 descriptor of the remote placement and its token file.
//
//   node scripts/register-fabric-service.mjs --origin https://<server> [--instance default] < key.json
//   … --offer --custody organization-managed --residency DE,EU --max-data-class confidential < key.json
//
// The descriptor's `runner` (DEC-0061) is what the server says in its well-known document: an issued
// OpenRouter key or the platform's own metered Workers AI. `--offer` adds `peer` (B-87, an organization
// listing): others reach the server's MCP surface with keys of their own; the offer grants nobody access.
// The key is an agent key of the server (Settings, Agent access, New key, level Read), read from
// stdin as {"clientId","clientSecret"} (or the server's own answer, {"key":{"clientId"},"clientSecret"}),
// never from an argument. Cloudflare Access reads it from one header, Authorization (the only one it
// accepts there), as {"cf-access-client-id","cf-access-client-secret"} (read_service_tokens_from_header on the server's
// Access application; Create my server sets it). Files are written 0600, atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVICE_ID = "fabric-inbox";
export const HEADER = "Authorization";
export const RUNNER_EXTENSION = "https://passioncode.ai/fabric-inbox/runner";
const CREDENTIAL_KINDS = ["key", "platform-metered", "none"];
const CUSTODY = ["organization-managed", "personal", "processor-hosted"];
const DATA_CLASSES = ["public", "internal", "confidential", "restricted"];
// ISO 3166-1 alpha-2 in upper case, EU admitted; the user-assigned codes are refused (DEC-0061).
const USER_ASSIGNED = /^(AA|Q[M-Z]|X[A-Z]|ZZ)$/;

/** The services directory a host reads (FABRIC_SERVICES_DIR, else the platform's default, DEC-0032). */
export function servicesDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.FABRIC_SERVICES_DIR) return env.FABRIC_SERVICES_DIR;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ai.passioncode.fabric", "services");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "passioncode-fabric", "services");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "passioncode-fabric", "services");
}

/** The single-header value Access reads, from a key as the server issues it. */
export function tokenFromKey(raw) {
  const key = typeof raw === "string" ? JSON.parse(raw) : raw;
  const id = key?.clientId ?? key?.key?.clientId ?? key?.["cf-access-client-id"];
  const secret = key?.clientSecret ?? key?.["cf-access-client-secret"];
  if (typeof id !== "string" || !/\.access$/.test(id) || typeof secret !== "string" || secret.length < 16)
    throw new Error("Give the agent key as {\"clientId\": \"….access\", \"clientSecret\": \"…\"} on stdin.");
  return JSON.stringify({ "cf-access-client-id": id, "cf-access-client-secret": secret });
}

/** The runner the server declares (its well-known document's extension), or null for a server before 0.29.2. */
export function runnerFrom(wellKnown) {
  const kind = wellKnown?.extensions?.[RUNNER_EXTENSION]?.credentialKind;
  if (kind === undefined) return null;
  if (!CREDENTIAL_KINDS.includes(kind)) throw new Error(`The server names an unknown credential kind: ${String(kind).slice(0, 40)}.`);
  return { credentialKind: kind };
}

/** The `peer` of an offered server: where others reach it, who controls the account, where it runs, what it may receive. */
export function peerFor({ origin, custody, residency, maxDataClass }) {
  if (!CUSTODY.includes(custody)) throw new Error(`--custody is one of ${CUSTODY.join(", ")}.`);
  if (!DATA_CLASSES.includes(maxDataClass)) throw new Error(`--max-data-class is one of ${DATA_CLASSES.join(", ")}.`);
  const codes = [...new Set(String(residency || "").split(",").map((c) => c.trim()).filter(Boolean))];
  if (!codes.length || codes.length > 32 || codes.some((c) => !/^[A-Z]{2}$/.test(c) || USER_ASSIGNED.test(c)))
    throw new Error("--residency is 1 to 32 country codes in upper case (ISO 3166-1, EU admitted), such as DE,EU.");
  return { endpoint: `${new URL(origin).origin}/mcp`, custody, residency: codes, maxDataClass };
}

/** The descriptor of the remote placement (contract service-descriptor.schema.json). */
export function descriptorFor({ origin, instance = "default", tokenFile, version, now = new Date(), runner = null, peer = null }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.username || /^\d+\.\d+\.\d+\.\d+$|^\[/.test(url.hostname))
    throw new Error("The origin is https://<the server's name>, with no path.");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(instance)) throw new Error("An instance is lower-case letters, digits and -.");
  if (peer && !runner) throw new Error("An offered server names its runner: update the server to 0.29.2 or later first.");
  return {
    protocol: "fabric-service/0.1", id: SERVICE_ID, instance, name: "Fabric Inbox",
    summary: "Your mail server on Cloudflare: reply agents' events and what they spent.",
    placement: "remote", origin: url.origin,
    auth: { tokenFile, header: HEADER, scheme: "none" },
    lifecycle: { manager: "none" },
    source: { repository: "https://github.com/passioncode-ai/fabric-inbox" },
    installedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    installedBy: { by: "person", role: "operator", tool: `fabric-inbox register-fabric-service ${version}` },
    ...(runner ? { runner } : {}),
    ...(peer ? { peer } : {}),
  };
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The server's well-known document, read with the key the descriptor will carry. */
export async function readWellKnown(origin, token, fetchImpl = fetch) {
  const response = await fetchImpl(`${new URL(origin).origin}/.well-known/fabric-service`, {
    headers: { [HEADER]: token, "User-Agent": "fabric-inbox-register", Accept: "application/json" }, redirect: "manual",
  });
  if (response.status !== 200) throw new Error(`The server did not let the key in (HTTP ${response.status}): check the key and that the server is 0.28.1 or later.`);
  return response.json();
}

export function register({ origin, instance = "default", key, env = process.env, version, runner = null, peer = null }) {
  const dir = servicesDir(env);
  const tokenFile = path.join(path.dirname(dir), "tokens", `${SERVICE_ID}.${instance}.token`);
  const descriptor = descriptorFor({ origin, instance, tokenFile, version, runner, peer });
  writeAtomic(tokenFile, tokenFromKey(key));
  const file = path.join(dir, `${SERVICE_ID}.${instance}.json`);
  writeAtomic(file, JSON.stringify(descriptor, null, 2) + "\n");
  return { descriptor: file, tokenFile };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const origin = arg("--origin");
    if (!origin) throw new Error("Give --origin https://<the server's name>.");
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const key = readFileSync(0, "utf8");
    const runner = runnerFrom(await readWellKnown(origin, tokenFromKey(key)));
    const peer = process.argv.includes("--offer")
      ? peerFor({ origin, custody: arg("--custody"), residency: arg("--residency"), maxDataClass: arg("--max-data-class") }) : null;
    const out = register({ origin, instance: arg("--instance") || "default", key, version, runner, peer });
    console.log(JSON.stringify({ registered: `${SERVICE_ID}.${arg("--instance") || "default"}`, ...out }));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
