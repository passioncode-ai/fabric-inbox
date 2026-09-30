import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inventoryIn, parseArgs, run, setupFromInventory, type Inventory } from "../scripts/deployment-setup";
import { parseSetup } from "../shared/setup";

const example = () => JSON.parse(readFileSync("deployments/cloudflare-inventory.example.json", "utf8")) as Inventory;
const deployment = { origin: "https://inbox.example.com", setupName: "Example", vars: { TEAM_DOMAIN: "https://team.cloudflareaccess.com" } };

/** A repository root with deployments/<name>/ made from the committed examples, as an owner makes one. */
function ownerRoot(name = "demo", inventoryName = "cloudflare-inventory.json"): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-setup-"));
  mkdirSync(path.join(root, "deployments", name), { recursive: true });
  copyFileSync("deployments/deployment.example.json", path.join(root, "deployments", name, "deployment.json"));
  copyFileSync("deployments/cloudflare-inventory.example.json", path.join(root, "deployments", name, inventoryName));
  return root;
}

test("an inventory becomes a setup that keeps every address where it forwarded", () => {
  const setup = setupFromInventory(example(), deployment, "fallback");
  assert.equal(parseSetup(setup).ok, true);
  assert.equal(setup.name, "Example");
  assert.deepEqual(setup.server, { origin: "https://inbox.example.com", accessOrigin: "https://team.cloudflareaccess.com" });
  assert.deepEqual(setup.domains, ["example.com", "example.org"]);
  const hello = setup.mailboxes.find((m) => m.address === "hello@example.com");
  assert.equal(hello?.forwardTo, "inbox@example.net", "a forward keeps forwarding a copy");
  assert.equal(setup.mailboxes.some((m) => m.address === "old@example.com"), false, "a disabled rule creates nothing");
  assert.equal(setup.mailboxes.some((m) => m.address === "bounce@example.com"), false, "a drop rule creates nothing");
  assert.ok(setup.mailboxes.some((m) => m.address === "sales@example.org"), "a previous Worker's mailbox on a catch-all domain keeps its own mailbox");
  assert.deepEqual(setup.catchAll.map((c) => c.domain), ["example.com", "example.org"]);
});

test("a domain of another account is listed as not served, with the account shown only when it is a real id", () => {
  const withId = example();
  withId.otherAccounts = { "example.invalid": "0123456789abcdef0123456789abcdef" };
  assert.match(setupFromInventory(withId, deployment, "x").notServed[0].reason, /^In another Cloudflare account \(012345…\): /);
  assert.match(setupFromInventory(example(), deployment, "x").notServed[0].reason, /^In another Cloudflare account: /);
});

test("with no setupName or Access team the setup is named after the deployment and has no Access origin", () => {
  const setup = setupFromInventory(example(), { origin: "https://inbox.example.com" }, "demo — domains (Cloudflare)");
  assert.equal(setup.name, "demo — domains (Cloudflare)");
  assert.deepEqual(setup.server, { origin: "https://inbox.example.com" });
});

test("a forward into a served domain keeps the mailbox and drops the copy; a setup that would not validate is refused", () => {
  const looping = example();
  looping.domains["example.com"].rules[0][2] = "loop@example.org";
  assert.equal(setupFromInventory(looping, deployment, "x").mailboxes.find((m) => m.address === "hello@example.com")?.forwardTo, undefined);
  const root = ownerRoot();
  assert.throws(() => setupFromInventory(example(), { origin: "not an address" }, "x"), /origin/);
  const broken = path.join(root, "deployments", "demo", "deployment.json");
  writeFileSync(broken, JSON.stringify({ ...JSON.parse(readFileSync(broken, "utf8")), origin: "not an address" }));
  assert.throws(() => run(["demo"], root), /origin/);
  assert.equal(existsSync(path.join(root, "deployments", "demo", "setup.json")), false, "nothing is written");
});

test("the script writes deployments/<name>/setup.json from the deployment's own files", () => {
  const root = ownerRoot();
  const { out, summary } = run(["demo"], root);
  assert.equal(out, path.join(root, "deployments", "demo", "setup.json"));
  assert.match(summary, /^deployments\/demo\/setup\.json: 2 domains, 5 mailboxes, 2 catch-alls, 1 not served \(from deployments\/demo\/cloudflare-inventory\.json\)$/);
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.server.origin, "https://fabric-inbox.your-subdomain.workers.dev");
  assert.equal(written.name, "Example — domains (Cloudflare)");
});

test("the committed setup.example.json is the script's output for the committed examples", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-setup-"));
  const out = path.join(root, "setup.json");
  run(["--deployment", path.resolve("deployments/deployment.example.json"), "--inventory", path.resolve("deployments/cloudflare-inventory.example.json"), "--out", out], root);
  assert.equal(readFileSync(out, "utf8"), readFileSync("deployments/setup.example.json", "utf8"));
});

test("a dated inventory is used when there is no undated one, the newest first", () => {
  const root = ownerRoot("demo", "cloudflare-inventory-2026-01-01.json");
  const dir = path.join(root, "deployments", "demo");
  copyFileSync(path.join(dir, "cloudflare-inventory-2026-01-01.json"), path.join(dir, "cloudflare-inventory-2026-02-01.json"));
  assert.equal(inventoryIn(dir), path.join(dir, "cloudflare-inventory-2026-02-01.json"));
  writeFileSync(path.join(dir, "cloudflare-inventory.json"), readFileSync(path.join(dir, "cloudflare-inventory-2026-01-01.json")));
  assert.equal(inventoryIn(dir), path.join(dir, "cloudflare-inventory.json"));
});

test("missing files and bad arguments say what to do", () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "fabric-setup-"));
  assert.throws(() => run(["nobody"], empty), /No deployments\/nobody\/deployment\.json\. Copy deployments\/deployment\.example\.json there first\./);
  const root = ownerRoot();
  const dir = path.join(root, "deployments", "noinv");
  mkdirSync(dir);
  copyFileSync("deployments/deployment.example.json", path.join(dir, "deployment.json"));
  assert.throws(() => run(["noinv"], root), /No cloudflare-inventory\.json in .*Capture one first/);
  assert.throws(() => parseArgs([]), /Name a deployment/);
  assert.throws(() => parseArgs(["../x"]), /lower-case letters/);
  assert.throws(() => parseArgs(["demo", "--out"]), /Give a file for --out/);
  assert.throws(() => parseArgs(["demo", "--force"]), /Unknown argument --force/);
});
