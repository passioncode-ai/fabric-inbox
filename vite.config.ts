// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// One id per build, shared by the Worker and the web app built together: an open page compares
// it with the server's X-Fabric-Build header and offers to reload after an update (shared/build.ts).
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;
const buildId = process.env.FABRIC_BUILD_ID || `${version}+${Date.now().toString(36)}`;
// The source commit and whether the tree carried other changes, for the fabric-service well-known
// document's build (B-87 part 4); empty outside a Git checkout.
const git = (args: string[]) => { try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const commit = /^[0-9a-f]{40}$/.test(git(["rev-parse", "HEAD"])) ? git(["rev-parse", "HEAD"]) : "";
const sourceBuild = { commit, dirty: commit ? git(["status", "--porcelain", "--untracked-files=no"]) !== "" : false, builtAt: new Date().toISOString() };

export default defineConfig({
  define: { __FABRIC_BUILD__: JSON.stringify(buildId), __FABRIC_SOURCE__: JSON.stringify(sourceBuild) },
  // imapflow's default logger (pino) cannot load in workerd; ours is never used (workers/providers/imap/pino-stub.ts).
  resolve: { alias: { pino: fileURLToPath(new URL("./workers/providers/imap/pino-stub.ts", import.meta.url)) } },
  plugins: [
    cloudflare({ remoteBindings: process.env.FABRIC_REMOTE_BINDINGS === "1", viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
