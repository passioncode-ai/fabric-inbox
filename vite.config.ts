// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// One id per build, shared by the Worker and the web app built together: an open page compares
// it with the server's X-Fabric-Build header and offers to reload after an update (shared/build.ts).
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;
const buildId = process.env.FABRIC_BUILD_ID || `${version}+${Date.now().toString(36)}`;

export default defineConfig({
  define: { __FABRIC_BUILD__: JSON.stringify(buildId) },
  plugins: [
    cloudflare({ remoteBindings: process.env.FABRIC_REMOTE_BINDINGS === "1", viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
