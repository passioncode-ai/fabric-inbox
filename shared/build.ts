/**
 * Which build this code is (P3-13). `vite.config.ts` defines __FABRIC_BUILD__ once per build, so
 * the Worker and the web app built together carry the same id: a page whose id differs from the
 * server's `X-Fabric-Build` header is older than the server. Code run outside a build (tests,
 * scripts) is "dev", which never asks anyone to reload.
 */
declare const __FABRIC_BUILD__: string | undefined;
export const BUILD_ID: string = typeof __FABRIC_BUILD__ === "string" && __FABRIC_BUILD__ ? __FABRIC_BUILD__ : "dev";
/** The response header that carries the server's build id. */
export const BUILD_HEADER = "X-Fabric-Build";

declare const __FABRIC_SOURCE__: { commit: string; dirty: boolean; builtAt: string } | undefined;
/** The source commit this build was made from (B-87 part 4), or null for a build outside Git. */
export const SOURCE: { commit: string; dirty: boolean; builtAt: string } | null =
  typeof __FABRIC_SOURCE__ === "object" && __FABRIC_SOURCE__ && __FABRIC_SOURCE__.commit ? __FABRIC_SOURCE__ : null;
