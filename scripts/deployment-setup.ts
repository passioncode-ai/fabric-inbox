/**
 * Builds a deployment's setup file from a read-only Cloudflare Email Routing inventory, with the
 * same conversion the server uses for /api/setup/from-cloudflare (workers/routing/to-setup.ts).
 *
 *   npx tsx scripts/deployment-setup.ts <name>
 *       reads  deployments/<name>/deployment.json and deployments/<name>/cloudflare-inventory.json
 *              (or the newest deployments/<name>/cloudflare-inventory-*.json)
 *       writes deployments/<name>/setup.json
 *   --deployment <file>  --inventory <file>  --out <file>   use other paths (then <name> is optional)
 *
 * deployments/<name>/ is local and git-ignored: it names a real account, domains and addresses.
 * deployments/README.md says how to create one; the *.example.json files beside it are the shape.
 * The committed deployments/setup.example.json is this script's output for the two examples.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSetup, type Setup } from "../shared/setup";
import type { DomainRouting } from "../workers/routing/email-routing";
import { setupFromRouting } from "../workers/routing/to-setup";

type RuleType = "forward" | "forward-disabled" | "worker" | "drop";
type ActionType = "forward" | "worker" | "drop";

/** What a read of Email Routing captured: rules as [address, type, value], the catch-all as [type, value]. */
export type Inventory = {
  otherAccounts?: Record<string, string>;
  domains: Record<string, { rules: [string, RuleType, string][]; catchAll: [ActionType, string?] | null }>;
  /** Mailboxes a previous Worker kept for its catch-all domains; each keeps a mailbox of its own. */
  workerMailboxes?: { addresses: string[] };
};

/** The part of deployments/<name>/deployment.json this script reads. */
export type Deployment = { origin: string; setupName?: string; vars?: { TEAM_DOMAIN?: string } };

export function setupFromInventory(inventory: Inventory, deployment: Deployment, fallbackName: string): Setup {
  const other = inventory.otherAccounts ?? {};
  const routings: DomainRouting[] = Object.entries(inventory.domains).map(([domain, raw]) => {
    if (other[domain]) return { domain, visible: false, enabled: false, rules: [], catchAll: null };
    const catchAllWorker = raw.catchAll?.[0] === "worker";
    return {
      domain, visible: true, enabled: true,
      rules: [
        ...raw.rules.map(([address, type, value]) => ({
          address, enabled: type !== "forward-disabled",
          action: { type: (type === "forward-disabled" ? "forward" : type) as ActionType, value },
        })),
        ...(catchAllWorker ? (inventory.workerMailboxes?.addresses ?? []).filter((a) => a.endsWith("@" + domain))
          .map((address) => ({ address, enabled: true, action: { type: "worker" as const, value: raw.catchAll![1] } })) : []),
      ],
      catchAll: raw.catchAll ? { enabled: true, action: { type: raw.catchAll[0], value: raw.catchAll[1] } } : null,
    };
  });
  const server: Setup["server"] = { origin: deployment.origin };
  if (deployment.vars?.TEAM_DOMAIN) server.accessOrigin = deployment.vars.TEAM_DOMAIN;
  const setup = setupFromRouting(routings, server, deployment.setupName?.trim() || fallbackName);
  for (const n of setup.notServed) {
    const account = other[n.domain];
    if (!account) continue;
    const shown = /^[0-9a-f]{32}$/.test(account) ? ` (${account.slice(0, 6)}…)` : "";
    n.reason = `In another Cloudflare account${shown}: its Email Routing cannot send to this Worker; it keeps forwarding as before`;
  }
  const checked = parseSetup(setup);
  if (!checked.ok) throw new Error(checked.problems.join("\n"));
  return setup;
}

/** The inventory a deployment directory holds: cloudflare-inventory.json, else the newest dated one. */
export function inventoryIn(dir: string): string {
  const plain = path.join(dir, "cloudflare-inventory.json");
  if (existsSync(plain)) return plain;
  const dated = existsSync(dir) ? readdirSync(dir).filter((f) => /^cloudflare-inventory-.+\.json$/.test(f)).sort() : [];
  if (!dated.length) throw new Error(`No cloudflare-inventory.json in ${dir}. Capture one first (deployments/README.md).`);
  return path.join(dir, dated[dated.length - 1]);
}

export function parseArgs(argv: string[]): { name?: string; deployment?: string; inventory?: string; out?: string } {
  const args: { name?: string; deployment?: string; inventory?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--deployment" || a === "--inventory" || a === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Give a file for ${a}.`);
      args[a.slice(2) as "deployment" | "inventory" | "out"] = value;
    } else if (!a.startsWith("--") && !args.name) {
      if (!/^[a-z0-9-]{1,40}$/.test(a)) throw new Error("A deployment name has lower-case letters, digits and dashes, e.g. owner.");
      args.name = a;
    } else throw new Error(`Unknown argument ${a}. Use <name>, --deployment, --inventory or --out.`);
  }
  if (!args.name && !(args.deployment && args.inventory && args.out))
    throw new Error("Name a deployment (deployments/<name>/), or give --deployment, --inventory and --out.");
  return args;
}

/** Runs the script against a repository root; returns what it wrote and a one-line summary. */
export function run(argv: string[], root: string): { out: string; summary: string } {
  const args = parseArgs(argv);
  const dir = path.join(root, "deployments", args.name ?? "");
  const deploymentFile = args.deployment ? path.resolve(root, args.deployment) : path.join(dir, "deployment.json");
  if (!existsSync(deploymentFile)) throw new Error(`No ${path.relative(root, deploymentFile)}. Copy deployments/deployment.example.json there first.`);
  const inventoryFile = args.inventory ? path.resolve(root, args.inventory) : inventoryIn(dir);
  const out = args.out ? path.resolve(root, args.out) : path.join(dir, "setup.json");
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as Deployment;
  if (typeof deployment.origin !== "string") throw new Error(`${path.relative(root, deploymentFile)} has no "origin".`);
  const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as Inventory;
  const setup = setupFromInventory(inventory, deployment, `${args.name ?? "Deployment"} — domains (Cloudflare)`);
  writeFileSync(out, JSON.stringify(setup, null, 2) + "\n");
  return {
    out,
    summary: `${path.relative(root, out)}: ${setup.domains.length} domains, ${setup.mailboxes.length} mailboxes, ` +
      `${setup.catchAll.length} catch-alls, ${setup.notServed.length} not served (from ${path.relative(root, inventoryFile)})`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    console.log(run(process.argv.slice(2), path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")).summary);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
