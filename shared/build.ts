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
