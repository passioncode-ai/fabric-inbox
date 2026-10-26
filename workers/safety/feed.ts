import { applyUpdate, type FeedSnapshot, type SignedUpdate, type Verifier } from "../../vendor/okolos/core-feeds/apply";
import { matchUrl } from "../../vendor/okolos/core-feeds/lookup";

/**
 * B-180: the server's copy of the Okolos phishing feed. The signed feed is fetched from its publisher
 * (`OKOLOS_FEED_URL`, Okolos's `GET /feeds/phishing`), checked against Okolos's Ed25519 key and applied with
 * Okolos's own rules (a replay of an older version is refused); the last good copy is kept and used, so mail never
 * waits on another service and no address of the mail leaves the server (packet decision 4).
 */

/** Okolos's published key for its feeds (`apps/extension/src/background/feeds.ts` in Okolos); `OKOLOS_FEED_PUBLIC_KEY` replaces it. */
export const OKOLOS_FEED_PUBLIC_KEY = "JHUePa03XAoSeQcJjNljgDESMhBI/ZG03zoOfm/vapM=";
/** How often the copy is fetched again, and how old a copy may be before a verdict says it is old. */
export const FEED_REFRESH_MS = 15 * 60_000;
export const FEED_STALE_MS = 86_400_000;
/** At most this many links of a message are looked up. */
export const MAX_LINKS = 100;

export interface FeedEnv { OKOLOS_FEED_URL?: string; OKOLOS_FEED_PUBLIC_KEY?: string }
export interface KeptFeed { snapshot: FeedSnapshot; fetchedAt: number }

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export function ed25519Verifier(publicKeyBase64: string): Verifier {
  let key: Promise<CryptoKey> | null = null;
  return async (serialised, signature) => {
    try {
      key ??= crypto.subtle.importKey("raw", bytesOf(publicKeyBase64), { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "Ed25519" }, await key, bytesOf(signature), new TextEncoder().encode(serialised));
    } catch { return false; }
  };
}

export type FeedRefresh = { kept: KeptFeed | null; outcome: "updated" | "same" | "refused" | "unreachable" | "not_configured"; detail?: string };

/** Fetches the signed feed and applies it to `current`; anything wrong keeps `current` and says why. */
export async function refreshFeed(env: FeedEnv, current: KeptFeed | null, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<FeedRefresh> {
  const url = env.OKOLOS_FEED_URL?.trim();
  if (!url) return { kept: current, outcome: "not_configured" };
  let signed: SignedUpdate;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
    if (!response.ok) return { kept: current, outcome: "unreachable", detail: `HTTP ${response.status}` };
    signed = (await response.json()) as SignedUpdate;
  } catch (error) {
    return { kept: current, outcome: "unreachable", detail: (error as Error)?.name ?? "failed" };
  }
  if (!signed?.update?.body || typeof signed.signature !== "string") return { kept: current, outcome: "refused", detail: "not a signed feed" };
  // The same version again is no news: the copy is fresh as of now.
  if (current && signed.update.kind === "snapshot" && signed.update.body.version === current.snapshot.version)
    return { kept: { ...current, fetchedAt: now }, outcome: "same" };
  const applied = await applyUpdate(current?.snapshot ?? null, signed, ed25519Verifier(env.OKOLOS_FEED_PUBLIC_KEY?.trim() || OKOLOS_FEED_PUBLIC_KEY));
  if (!applied.accepted) return { kept: current, outcome: "refused", detail: applied.reason };
  return { kept: { snapshot: applied.snapshot, fetchedAt: now }, outcome: "updated" };
}

/** The http(s) links a message's HTML points to (href, and bare addresses in its text), each once, at most MAX_LINKS. */
export function linksOf(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/\bhref\s*=\s*["']?\s*(https?:\/\/[^"'\s>]+)/gi)) found.add(m[1]!.replace(/&amp;/g, "&"));
  for (const m of html.replace(/<[^>]*>/g, " ").matchAll(/\bhttps?:\/\/[^\s"'<>)]+/gi)) found.add(m[0]!.replace(/[.,;:!?]+$/, ""));
  return [...found].slice(0, MAX_LINKS);
}

export interface PhishingLink { host: string; entry: string }

/** The links that lead to a site the feed lists (a page under a listed host or path too). Only the host is kept. */
export function phishingLinks(links: string[], feed: FeedSnapshot): PhishingLink[] {
  const out: PhishingLink[] = [];
  for (const link of links) {
    const hit = matchUrl(link, feed);
    if (!hit) continue;
    let host = "";
    try { host = new URL(link).hostname; } catch { continue; }
    if (!out.some((o) => o.host === host)) out.push({ host, entry: hit.entry });
  }
  return out;
}
