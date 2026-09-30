import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * CF-4: whoever installs the app or deploys the server gets nothing of any
 * deployment's own: no domain, address, account, Access team or audience.
 * A deployment's files live only on its owner's machine (deployments/<name>/ is
 * git-ignored; deployments/README.md). The identifiers to look for come from
 * each local deployments/<name>/deployment.json and setup.json, so an owner's
 * checkout checks the owner's values; a clone with none checks the rest.
 */
function identifiersOf(root: string): { deployments: string[]; identifiers: string[] } {
  const dir = path.join(root, "deployments");
  const deployments = existsSync(dir)
    ? readdirSync(dir).filter((d) => existsSync(path.join(dir, d, "deployment.json")))
    : [];
  const identifiers = deployments.flatMap((d) => {
    const v = JSON.parse(readFileSync(path.join(dir, d, "deployment.json"), "utf8")) as { identifiers?: string[]; accountId?: string; vars?: Record<string, string> };
    // Every domain and address the deployment's setup serves, not only the hand-picked list:
    // a placeholder naming one of the 19 owner domains shipped in 0.4.0 unseen by a list of 9.
    const setupFile = path.join(dir, d, "setup.json");
    const setup = existsSync(setupFile)
      ? JSON.parse(readFileSync(setupFile, "utf8")) as { domains?: string[]; mailboxes?: { address?: string; forwardTo?: string }[] }
      : {};
    return [
      ...(v.identifiers ?? []), v.accountId, ...Object.values(v.vars ?? {}).flatMap((x) => x.split(/[\s,]+/)),
      ...(setup.domains ?? []), ...(setup.mailboxes ?? []).flatMap((m) => [m.address, m.forwardTo]),
    ].filter((x): x is string => !!x && x.length > 5);
  });
  return { deployments, identifiers };
}

const { deployments, identifiers } = identifiersOf(".");
const SHIPPED = ["app", "workers", "shared", "desktop", "public", "wrangler.jsonc", "package.json", "react-router.config.ts", "vite.config.ts"];
/** What deployments/ may hold in Git: the guide and the placeholder examples, never a deployment. */
const DEPLOYMENTS_TRACKED = ["deployments/README.md", "deployments/cloudflare-inventory.example.json", "deployments/deployment.example.json", "deployments/setup.example.json"];

/** A repository root holding one deployment made from the committed examples, as an owner would. */
function exampleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-deployment-"));
  mkdirSync(path.join(root, "deployments", "example"), { recursive: true });
  copyFileSync("deployments/deployment.example.json", path.join(root, "deployments", "example", "deployment.json"));
  copyFileSync("deployments/setup.example.json", path.join(root, "deployments", "example", "setup.json"));
  return root;
}

function files(): string[] {
  return execFileSync("git", ["ls-files", "--", ...SHIPPED], { encoding: "utf8" }).split("\n").filter(Boolean)
    .filter((f) => existsSync(f) && statSync(f).size < 5 * 1024 * 1024 && !/\.(png|icns|ico|woff2?)$/.test(f));
}

function hitsIn(fileList: string[], ids: string[]): string[] {
  const hits: string[] = [];
  for (const f of fileList) {
    const text = readFileSync(f, "utf8");
    // The file and the position, never the value: a failing run must not print what it protects.
    ids.forEach((id, i) => { if (text.includes(id)) hits.push(`${f}: identifier #${i + 1} of the local deployments`); });
  }
  return hits;
}

test("no deployment is committed: deployments/ tracks only its guide and the examples", () => {
  const tracked = execFileSync("git", ["ls-files", "--", "deployments"], { encoding: "utf8" }).split("\n").filter(Boolean);
  assert.deepEqual(tracked.sort(), [...DEPLOYMENTS_TRACKED].sort());
  const ignored = execFileSync("git", ["check-ignore", "--no-index", "deployments/owner/setup.json", "deployments/any-name/deployment.json"], { encoding: "utf8" });
  assert.equal(ignored.trim().split("\n").length, 2, "every deployments/<name>/ is git-ignored");
});

test("a local deployment's file names what must never ship", { skip: deployments.length ? false : "no local deployments/<name>/deployment.json on this clone" }, () => {
  assert.ok(identifiers.length >= 5, `found ${identifiers.length} identifiers in ${deployments.length} local deployment(s)`);
});

test("nothing that ships in the app or the server names a deployment", () => {
  assert.deepEqual(hitsIn(files(), identifiers), []);
});

test("the example deployment reads the way a real one does", () => {
  const { deployments: found, identifiers: ids } = identifiersOf(exampleRoot());
  assert.deepEqual(found, ["example"]);
  // The placeholder account id, vars, identifiers, domains and mailboxes are all collected.
  for (const id of ["<your-cloudflare-account-id>", "your-subdomain.workers.dev", "https://your-team.cloudflareaccess.com", "example.org", "support@example.org", "inbox@example.net"])
    assert.ok(ids.includes(id), `collects ${id}`);
});

test("wrangler.jsonc carries no account and no Access or domain values", () => {
  const text = readFileSync("wrangler.jsonc", "utf8");
  assert.doesNotMatch(text, /"account_id"/);
  assert.doesNotMatch(text, /"(POLICY_AUD|TEAM_DOMAIN|DOMAINS)"\s*:/);
  assert.match(text, /"keep_vars":\s*true/, "a deploy keeps the values set on the Worker");
});

test("the scan itself finds a planted identifier", () => {
  // With no local deployment, the example's identifiers stand in: the scan must still catch one.
  const ids = identifiers.length ? identifiers : identifiersOf(exampleRoot()).identifiers;
  const planted = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-planted-")), "setup.html");
  writeFileSync(planted, readFileSync(path.join("desktop", "setup.html"), "utf8") + `<!-- ${ids[ids.length - 1]} -->`);
  assert.ok(hitsIn([planted], ids).length >= 1);
});
