import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { noteServerBuild, reloadForMissingCode, resetBuildNotice, UPDATE_EVENT } from "../app/lib/build-version";

/** P3-13: a page older than its server says so, and reloads when its own code is gone. */

test("every API answer names the build that gave it (P3-13)", async () => {
  // The Worker's API, built as vite.config.ts builds it: with the build id defined.
  const bundle = await build({
    stdin: { contents: `
      import { api } from './workers/api';
      export { EmailMCP } from './workers/mcp/ledger';
      export default { fetch: (request, env) => api.fetch(request, env) };
    `, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:*", "node:*"], target: "es2022",
    alias: { mimetext: "mimetext/browser" },
    define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"', __FABRIC_BUILD__: '"0.11.0+test"' },
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"] });
  try {
    const response = await mf.dispatchFetch("http://localhost/api/no-such-route");
    assert.equal(response.headers.get("X-Fabric-Build"), "0.11.0+test");
    await response.arrayBuffer();
  } finally {
    await mf.dispose();
  }
});

test("a page offers to reload when the server's build is another one, once (P3-13)", () => {
  resetBuildNotice();
  const target = new EventTarget();
  let events = 0;
  target.addEventListener(UPDATE_EVENT, () => events++);
  const headers = (build: string | null) => ({ get: (name: string) => (name === "X-Fabric-Build" ? build : null) });
  assert.equal(noteServerBuild(headers("0.11.0+a"), "0.11.0+a", target), false, "same build");
  assert.equal(noteServerBuild(headers(null), "0.11.0+a", target), false, "no header (a proxy, an old server)");
  assert.equal(noteServerBuild(headers("dev"), "0.11.0+a", target), false);
  assert.equal(noteServerBuild(headers("0.11.0+b"), "dev", target), false, "a development page never asks");
  assert.equal(noteServerBuild(headers("0.11.0+b"), "0.11.0+a", target), true);
  assert.equal(noteServerBuild(headers("0.11.0+b"), "0.11.0+a", target), false, "said once");
  assert.equal(events, 1);
});

test("missing code after an update reloads the page once a minute at most (P3-13)", () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  let reloads = 0;
  assert.equal(reloadForMissingCode(storage, () => reloads++, 1_000_000), true);
  assert.equal(reloadForMissingCode(storage, () => reloads++, 1_030_000), false, "a broken server does not loop");
  assert.equal(reloadForMissingCode(storage, () => reloads++, 1_070_000), true);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(reloadForMissingCode(broken, () => reloads++, 10_000_000), true, "storage blocked still reloads");
  assert.equal(reloads, 3);
});

test("the build id is defined once per build, read by both API clients and shown by the app shell (P3-13)", () => {
  assert.match(readFileSync("vite.config.ts", "utf8"), /define: \{ __FABRIC_BUILD__: JSON\.stringify\(buildId\) \}/);
  assert.match(readFileSync("app/services/fabric.ts", "utf8"), /noteServerBuild\(response\.headers\)/);
  assert.match(readFileSync("app/services/api.ts", "utf8"), /noteServerBuild\(res\.headers\)/);
  const root = readFileSync("app/root.tsx", "utf8");
  assert.match(root, /<UpdateNotice \/>/);
  assert.match(root, /"vite:preloadError"/);
  assert.match(root, /Reload to update/);
});
