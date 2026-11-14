import type { FeedSnapshot } from "../../vendor/okolos/core-feeds/apply";
import { matchUrl } from "../../vendor/okolos/core-feeds/lookup";
import { checkLookalike } from "../../vendor/okolos/core-lookalike/check";
import { DEFAULT_WATCHLIST } from "../../vendor/okolos/core-lookalike/watchlist";
import { registrableDomain } from "../../vendor/okolos/core-lookalike/suffix";
import { canonicalLink, decodeEntities, visibleText, type CheckedLink } from "../../shared/mail/safety";
import { MAX_LINKS } from "./feed";

/**
 * S03 §1 and S04 (B-269, B-270): a message's links, each in the form a browser would open (`new URL(decoded).href`,
 * entity-encoded and protocol-relative hrefs decoded first), checked against the Okolos feed, Okolos's lookalike
 * check, and whether the link's own text names another domain than it goes to. The reader keeps a link's address only
 * when that canonical URL is in this list.
 */
export interface FoundLink { url: string; text: string }

const ANCHOR = /<(a|area)\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)(?:<\/\1\s*>|(?=<a\b)|$)/gi;
const BARE = /\bhttps?:\/\/[^\s"'<>)]+/gi;

const textOf = (html: string) => visibleText(decodeEntities(html.replace(/<[^>]*>/g, " "))).replace(/\s+/g, " ").trim();

/** Every http(s) link of a message's HTML (anchors with their text, then bare addresses in its text), each once. */
export function extractLinks(html: string): { links: FoundLink[]; capped: boolean } {
  const seen = new Map<string, FoundLink>();
  let total = 0;
  const add = (href: string, text: string) => {
    const { url } = canonicalLink(href);
    if (!url || !/^https?:/i.test(url)) return;
    if (!seen.has(url)) { total++; if (seen.size < MAX_LINKS) seen.set(url, { url, text }); }
    else if (text && !seen.get(url)!.text) seen.get(url)!.text = text;
  };
  for (const m of html.matchAll(ANCHOR)) add(m[3] ?? m[4] ?? m[5] ?? "", m[1]!.toLowerCase() === "a" ? textOf(m[7] ?? "") : "");
  for (const m of html.replace(/<[^>]*>/g, " ").matchAll(BARE)) add(m[0].replace(/[.,;:!?]+$/, ""), "");
  return { links: [...seen.values()], capped: total > MAX_LINKS };
}

const HOST_TEXT = /^(?:https?:\/\/)?((?:[a-z0-9¡-￿-]+\.)+(?:[a-z¡-￿]{2,}|xn--[a-z0-9-]+))(?:[/:?#].*)?$/i;

/** The domain a link's visible text names, when its text is an address ("www.bank.example", "https://bank.example/x"). */
export function namedHost(text: string): string | null {
  const m = HOST_TEXT.exec(text.trim());
  if (!m) return null;
  try { return new URL(`http://${m[1]}`).hostname; } catch { return null; }
}

/** Each link checked: on the feed, a lookalike, or its text naming another registrable domain. */
export function checkLinks(found: FoundLink[], feed: FeedSnapshot | null, ownDomains: readonly string[] = []): CheckedLink[] {
  const watchlist = [...DEFAULT_WATCHLIST, ...ownDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)];
  return found.map(({ url, text }) => {
    const host = new URL(url).hostname.toLowerCase();
    const base: CheckedLink = { url, host };
    if (feed && matchUrl(url, feed)) return { ...base, why: "phishing" };
    const look = checkLookalike(host, watchlist);
    if (look) return { ...base, why: "lookalike", resembles: look.resembles };
    const shown = namedHost(text);
    if (shown) {
      const a = registrableDomain(shown), b = registrableDomain(host);
      if (a && b && a !== b) return { ...base, why: "textMismatch", shown };
    }
    return base;
  });
}
