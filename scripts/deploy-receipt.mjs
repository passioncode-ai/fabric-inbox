#!/usr/bin/env node
// B-62 (issue #26): a deployment receipt. It links the Worker version Cloudflare serves now to the Git
// commit it was built from and to the digest of the built bundle, read independently of the deploy:
// the active deployment and its version's tag come from Cloudflare's API, the commit and the tree's
// state from Git, the digest from build/. `npm run deploy` tags each version with its commit, so a
// version whose tag is not this checkout's commit, or a dirty tree, is reported "unlinked".
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/deploy-receipt.mjs [--root <checkout>] [--out <dir>] [--expect-version <id>] [--script <worker>]
//   node scripts/deploy-receipt.mjs --require-clean   (exit 1 when tracked files differ from HEAD; `npm run deploy` runs it first)
//
// --root reads another checkout (the one the deploy ran from); by default this script's own.
//
// The receipt carries no token, no account id or name. Exit 0 when linked, 2 when not, 1 on an error.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** sha256 over every file under the dirs, as "<relative path> <sha256>" lines sorted by path. */
export function buildDigest(root, dirs = ["build/server", "build/client"]) {
  const lines = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else lines.push(`${relative(root, path).split("\\").join("/")} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  for (const d of dirs) walk(join(root, d));
  lines.sort();
  return { files: lines.length, sha256: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

export function gitState(root) {
  const run = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return { commit: run("rev-parse", "HEAD"), dirty: run("status", "--porcelain", "--untracked-files=no").length > 0 };
}

/** The tag `npm run deploy` gives a version: its commit, abbreviated to 12 characters or more. */

/** What Cloudflare serves now for `script`: the active deployment's version and that version's tag. */
export async function servedVersion({ token, account, script, fetchImpl = fetch }) {
  const api = async (path) => {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(`Cloudflare answered ${response.status} for ${path.split("?")[0] || "/"}`);
    return body.result;
  };
  const deployments = (await api("/deployments")).deployments ?? [];
  const active = deployments[0];
  if (!active) throw new Error("no deployment of the script");
  const main = [...(active.versions ?? [])].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0];
  if (!main) throw new Error("the active deployment names no version");
  const version = await api(`/versions/${main.version_id}`);
  // The version's annotations are top-level in the API's answer (read live 2026-10-19); older answers nested them.
  const annotations = version?.annotations ?? version?.metadata?.annotations ?? {};
  return { deploymentId: active.id, deployedAt: active.created_on ?? null, versionId: main.version_id, percentage: main.percentage ?? null,
    split: (active.versions ?? []).length > 1, tag: annotations["workers/tag"] ?? null,
    // Cloudflare's own hash of the script it serves, for a later read to compare against.
    scriptEtag: version?.resources?.script?.etag ?? null };
}

export async function makeReceipt({ root, token, account, script, fetchImpl, expectVersion, now = new Date() }) {
  const git = gitState(root);
  const digest = buildDigest(root);
  const served = await servedVersion({ token, account, script, fetchImpl });
  const problems = [];
  if (git.dirty) problems.push("the checkout has uncommitted changes to tracked files");
  if (!(served.tag && served.tag.length >= 12 && git.commit.startsWith(served.tag))) problems.push(served.tag ? `the served version is tagged ${served.tag}, not this commit` : "the served version carries no commit tag");
  if (served.split) problems.push("the active deployment splits traffic between versions");
  if (expectVersion && expectVersion !== served.versionId) problems.push(`the served version is not ${expectVersion}`);
  return { receipt: "fabric-inbox-deploy/1", at: now.toISOString(), script, commit: git.commit, dirty: git.dirty, build: digest,
    worker: served, verdict: problems.length ? "unlinked" : "linked", problems,
    note: "The commit is tied to the served version by the tag npm run deploy sets and by this checkout's state; the build digest is of this checkout's build/. It is evidence, not a signature of the bytes Cloudflare runs." };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  // `npm run deploy` runs this first (review 2026-10-21): a version tagged with a commit is that commit's
  // code only when no tracked file differs from it, so a dirty tree is not deployed at all.
  if (process.argv.includes("--require-clean")) {
    const state = gitState(arg("--root") ?? fileURLToPath(new URL("..", import.meta.url)));
    if (state.dirty) { console.error("Not deployed: tracked files differ from the commit the version would be tagged with. Commit or stash them first."); process.exit(1); }
    process.exit(0);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) { console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed (from the vault, never typed)."); process.exit(1); }
  const root = arg("--root") ?? fileURLToPath(new URL("..", import.meta.url));
  // --script names another Worker of the account (a second server, B-169); by default the checkout's own.
  const script = arg("--script") ?? /"name"\s*:\s*"([^"]+)"/.exec(readFileSync(join(root, "wrangler.jsonc"), "utf8"))?.[1];
  try {
    const receipt = await makeReceipt({ root, token, account, script, expectVersion: arg("--expect-version") });
    const text = JSON.stringify(receipt, null, 2) + "\n";
    process.stdout.write(text);
    const out = arg("--out");
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `receipt-${receipt.at.slice(0, 10)}-${receipt.worker.versionId.slice(0, 8)}.json`), text); }
    process.exit(receipt.verdict === "linked" ? 0 : 2);
  } catch (error) {
    console.error(`No receipt: ${error.message}`);
    process.exit(1);
  }
}
