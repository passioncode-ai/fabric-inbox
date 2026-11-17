import { checkLookalike } from "../../vendor/okolos/core-lookalike/check";
import { registrableDomain } from "../../vendor/okolos/core-lookalike/suffix";
import { DEFAULT_WATCHLIST } from "../../vendor/okolos/core-lookalike/watchlist";
import type { FeedSnapshot } from "../../vendor/okolos/core-feeds/apply";
import { matchUrl } from "../../vendor/okolos/core-feeds/lookup";
import { asciiHost, visibleText, type DomainFinding, type DomainLookup, type DomainRole, type DomainSite } from "../../shared/mail/safety";
import { addresses } from "./sender";

/**
 * S03c (B-288): the lookup of a message's sender domains, run when a person or an agent asks (never on arrival): who
 * registered each From and Reply-To domain and when (RDAP), whether it takes mail and publishes SPF and DMARC (DNS over
 * HTTPS), and what its site does when its main page is visited from the server. Only the domain's root is visited,
 * never a link from the message (a link may tell the sender who opened it); every hop is checked against the Okolos
 * feed and the lookalike check before the next request. Its signals only ever raise a message's colour (`colourOf`).
 */
export const MAX_DOMAINS = 4;
/** Every request of one lookup together (RDAP, DNS, the site's hops), under the Workers free plan's 50 subrequests a call. */
export const MAX_REQUESTS = 40;
export const MAX_REDIRECTS = 5;
export const SITE_BYTES = 64 * 1024;
export const READ_TIMEOUT_MS = 8_000;
/** The whole site visit, every hop together: the lookup answers inside the app's 30-second request. */
export const SITE_BUDGET_MS = 12_000;
/** The registry's reads together (the redirector, IANA's list, the registry's own server): RDAP, then the site, end in 22 s. */
export const RDAP_BUDGET_MS = 10_000;
export const NEW_DOMAIN_DAYS = 30;
const DAY = 86_400_000;

export const RDAP_BASE = "https://rdap.org/domain/";
/** IANA's list of each top-level domain's own RDAP server (RFC 9224), asked when the redirector does not answer. */
export const RDAP_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
/** rdap.org refuses a request with no User-Agent or a bare runtime one (403, measured 2026-11-17), so every read names itself. */
export const USER_AGENT = "Mozilla/5.0 (compatible; FabricInbox-Okolos/1; sender-domain-check)";
export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Suffixes that name no public site: never visited, never looked up. */
const RESERVED = /\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|onion|arpa)$/i;
/** RDAP statuses a registry sets when it stops a domain, often for abuse (RFC 8056). */
const HOLD = new Set(["client hold", "server hold", "redemption period", "pending delete", "pending restore"]);
/** Content types a page hands over as a file. */
const FILE_TYPES = /^(application\/(octet-stream|x-msdownload|x-msdos-program|x-msi|x-ms-installer|vnd\.microsoft\.portable-executable|x-dosexec|x-sh|x-executable|x-mach-binary|java-archive|x-apple-diskimage|x-iso9660-image|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed|x-msdownload|vnd\.android\.package-archive))\b/i;

export interface DomainDeps {
  fetch: typeof fetch;
  feed: FeedSnapshot | null;
  ownDomains: readonly string[];
  now: number;
}

/** Whether a name is a public registrable domain this lookup may read and visit. */
export function lookupable(domain: string): boolean {
  if (!domain || domain.length > 253 || !domain.includes(".")) return false;
  if (/^[\d.]+$/.test(domain) || domain.includes(":") || domain.startsWith("[")) return false;
  if (RESERVED.test(domain) || domain === "localhost") return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain);
}

/** The registrable domains of a message's From and Reply-To, each once with its roles, at most MAX_DOMAINS. */
export function senderDomains(fromLine: string, replyToLine: string | null | undefined, ownDomains: readonly string[]):
  { domains: { domain: string; roles: DomainRole[] }[]; notRun: DomainLookup["notRun"] } {
  const own = new Set(ownDomains.map((d) => registrableDomain(asciiHost(d))));
  const seen = new Map<string, DomainRole[]>();
  const notRun: DomainLookup["notRun"] = [];
  const add = (role: DomainRole) => (a: { domain: string | null }) => {
    if (!a.domain) return;
    const domain = registrableDomain(asciiHost(a.domain));
    const roles = seen.get(domain);
    if (roles) { if (!roles.includes(role)) roles.push(role); return; }
    seen.set(domain, [role]);
  };
  addresses(fromLine).forEach(add("from"));
  addresses(replyToLine).forEach(add("replyTo"));
  if (!seen.size) return { domains: [], notRun: [{ why: "noSender" }] };
  const domains: { domain: string; roles: DomainRole[] }[] = [];
  // Reply-To first: it is where an answer would go, and the reason a person looks.
  const ordered = [...seen].sort(([, a], [, b]) => Number(b.includes("replyTo")) - Number(a.includes("replyTo")));
  for (const [domain, roles] of ordered) {
    if (own.has(domain)) notRun.push({ domain, why: "ownDomain" });
    else if (!lookupable(domain)) notRun.push({ domain, why: "notPublic" });
    else if (domains.length >= MAX_DOMAINS) notRun.push({ domain, why: "capReached" });
    else domains.push({ domain, roles });
  }
  return { domains, notRun };
}

const timed = (deps: DomainDeps, url: string, init: RequestInit = {}, ms = READ_TIMEOUT_MS) =>
  deps.fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

type Rdap = Pick<DomainFinding, "rdap" | "registered" | "expires" | "changed" | "registrar" | "status">;

/** The registry's record of a domain (RFC 9083): its dates, its registrar and its status. */
export async function readRdap(domain: string, deps: DomainDeps): Promise<Rdap> {
  const started = Date.now();
  const left = () => Math.min(READ_TIMEOUT_MS, RDAP_BUDGET_MS - (Date.now() - started));
  const ask = async (url: string) => left() <= 0 ? null
    : timed(deps, url, { headers: { Accept: "application/rdap+json, application/json", "User-Agent": USER_AGENT }, redirect: "follow" }, left()).catch(() => null);
  let response = await ask(RDAP_BASE + encodeURIComponent(domain));
  // The redirector down or refusing: the registry's own server, from IANA's list.
  if (!response || (!response.ok && response.status !== 404)) {
    const base = left() > 0 ? await registryServer(domain, deps, left()) : null;
    if (base) response = await ask(`${base}domain/${encodeURIComponent(domain)}`);
  }
  if (!response) return { rdap: "failed" };
  if (response.status === 404) return { rdap: "notFound" };
  if (!response.ok) return { rdap: "failed" };
  let body: { events?: { eventAction?: string; eventDate?: string }[]; status?: unknown; entities?: unknown[] };
  try { body = await response.json() as typeof body; } catch { return { rdap: "failed" }; }
  const at = (action: string) => {
    const date = body.events?.find((e) => e.eventAction?.toLowerCase() === action)?.eventDate;
    const time = date ? Date.parse(date) : NaN;
    return Number.isFinite(time) ? time : undefined;
  };
  const status = Array.isArray(body.status) ? body.status.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase()).slice(0, 12) : [];
  const registrar = registrarOf(body.entities);
  const out: Rdap = { rdap: "found" };
  const registered = at("registration"), expires = at("expiration"), changed = at("last changed");
  if (registered !== undefined) out.registered = registered;
  if (expires !== undefined) out.expires = expires;
  if (changed !== undefined) out.changed = changed;
  if (registrar) out.registrar = registrar;
  if (status.length) out.status = status;
  return out;
}

/** IANA's bootstrap list, kept by the isolate for a day. */
let bootstrap: { at: number; services: [string[], string[]][] } | null = null;

/** The RDAP server of a domain's top-level domain (the longest suffix IANA lists), ending in `/`, or null. */
async function registryServer(domain: string, deps: DomainDeps, ms: number): Promise<string | null> {
  if (!bootstrap || deps.now - bootstrap.at > DAY) {
    try {
      const response = await timed(deps, RDAP_BOOTSTRAP, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } }, ms);
      if (!response.ok) return null;
      const body = await response.json() as { services?: [string[], string[]][] };
      if (!Array.isArray(body.services)) return null;
      bootstrap = { at: deps.now, services: body.services };
    } catch { return null; }
  }
  const labels = domain.split(".");
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const service = bootstrap.services.find(([tlds]) => tlds.includes(suffix));
    const url = service?.[1].find((u) => u.startsWith("https://"));
    if (url) return url.endsWith("/") ? url : `${url}/`;
  }
  return null;
}

/** A seam for tests: forget the bootstrap list. */
export const forgetBootstrap = () => { bootstrap = null; };

/** The registrar's name from an RDAP entity list (its jCard `fn`), cut to 120 characters. */
function registrarOf(entities: unknown[] | undefined): string | undefined {
  for (const e of entities ?? []) {
    const entity = e as { roles?: string[]; vcardArray?: unknown[] };
    if (!entity.roles?.includes("registrar")) continue;
    const card = Array.isArray(entity.vcardArray?.[1]) ? entity.vcardArray![1] as unknown[][] : [];
    const fn = card.find((p) => Array.isArray(p) && p[0] === "fn")?.[3];
    if (typeof fn === "string" && fn.trim()) return visibleText(fn).trim().slice(0, 120);
  }
  return undefined;
}

type Doh = { Status?: number; Answer?: { type?: number; data?: string }[] };

async function doh(name: string, type: string, deps: DomainDeps): Promise<Doh | null> {
  try {
    const response = await timed(deps, `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: "application/dns-json", "User-Agent": USER_AGENT } });
    return response.ok ? await response.json() as Doh : null;
  } catch { return null; }
}

const txt = (answer: Doh | null) => (answer?.Answer ?? []).filter((a) => a.type === 16).map((a) => (a.data ?? "").replace(/"\s*"/g, "").replace(/^"|"$/g, ""));

/** The domain's DNS: whether it resolves, its mail hosts, whether it publishes SPF, its DMARC policy. */
export async function readDns(domain: string, deps: DomainDeps): Promise<DomainFinding["dns"]> {
  const [a, mx, spf, dmarc] = await Promise.all([doh(domain, "A", deps), doh(domain, "MX", deps), doh(domain, "TXT", deps), doh(`_dmarc.${domain}`, "TXT", deps)]);
  const failed = !a || !mx || !spf || !dmarc;
  const nx = [a, mx, spf].some((r) => r?.Status === 3);
  const record = txt(dmarc).find((t) => /^v=dmarc1/i.test(t.trim()));
  return {
    resolves: nx ? false : a || mx ? true : null,
    mx: (mx?.Answer ?? []).filter((r) => r.type === 15).map((r) => (r.data ?? "").split(/\s+/).pop()!.replace(/\.$/, "").toLowerCase()).filter(Boolean).slice(0, 5),
    spf: spf ? txt(spf).some((t) => /^v=spf1\b/i.test(t.trim())) : null,
    // `absent`: no DMARC record; a record without a readable `p=` reads as `none`, as receivers treat it.
    dmarc: dmarc ? record ? record.match(/\bp\s*=\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? "none" : "absent" : null,
    ...(failed ? { failed: true } : {}),
  };
}

/**
 * The domain's main page, visited from the server: redirects followed by hand so every hop is checked before it is
 * requested, at most SITE_BYTES of the body read, no cookies, nothing run.
 */
export async function visitSite(domain: string, deps: DomainDeps, watchlist: readonly string[]): Promise<DomainSite> {
  const own = new Set(deps.ownDomains.map((d) => registrableDomain(asciiHost(d))));
  const site: DomainSite = { status: null, hops: [], leaves: false, password: false };
  let url = `https://${domain}/`;
  const started = Date.now();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { site.stopped = "notHttp"; return site; }
    // Only the web's own ports: a hop to another port is a service, not a site.
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.port) { site.stopped = "notHttp"; site.finalUrl = shown(parsed.href); return site; }
    const host = parsed.hostname.toLowerCase();
    if (!site.hops.includes(host)) site.hops.push(host);
    site.leaves = registrableDomain(host) !== domain;
    if (deps.feed && matchUrl(parsed.href, deps.feed)) { site.stopped = "listedHop"; site.finalUrl = shown(parsed.href); return site; }
    if (host !== domain && checkLookalike(host, watchlist)) { site.stopped = "lookalikeHop"; site.finalUrl = shown(parsed.href); return site; }
    // Never a name that is not a public site, and never this server's own: the visit must not call the server it runs on.
    if (!lookupable(registrableDomain(host)) || own.has(registrableDomain(host))) { site.stopped = "notHttp"; site.finalUrl = shown(parsed.href); return site; }
    const left = Math.min(READ_TIMEOUT_MS, SITE_BUDGET_MS - (Date.now() - started));
    if (left <= 0) { site.stopped = "noAnswer"; return site; }
    let response: Response;
    try {
      response = await timed(deps, parsed.href, { redirect: "manual", headers: { Accept: "text/html,*/*;q=0.5", "User-Agent": USER_AGENT } }, left);
    } catch { site.stopped = "noAnswer"; return site; }
    site.status = response.status;
    site.finalUrl = shown(parsed.href);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      try { url = new URL(location, parsed).href; } catch { site.stopped = "notHttp"; return site; }
      continue;
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const disposition = response.headers.get("content-disposition") ?? "";
    if (/\battachment\b/i.test(disposition) || FILE_TYPES.test(type)) {
      // Only the media type's own token: a header is the sender's text and reaches agents.
      site.file = type.match(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+/)?.[0]?.slice(0, 80) || "attachment";
      await response.body?.cancel().catch(() => undefined);
      return site;
    }
    if (type.includes("html") || !type) {
      const html = await readCapped(response, SITE_BYTES);
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      if (title) {
        const clean = visibleText(decode(title)).replace(/\s+/g, " ").trim().slice(0, 120);
        if (clean) site.title = clean;
      }
      site.password = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html);
    } else await response.body?.cancel().catch(() => undefined);
    return site;
  }
  site.stopped = "tooManyRedirects";
  return site;
}

/** An address as kept: invisible characters stripped, at most 300 characters (a Location header is the sender's text). */
const shown = (url: string) => visibleText(url).slice(0, 300);

async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch { /* what was read is kept */ }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const c of chunks) { const part = c.subarray(0, Math.min(c.byteLength, bytes.byteLength - at)); bytes.set(part, at); at += part.byteLength; if (at >= bytes.byteLength) break; }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " })[e] ?? "");

/**
 * The watched domain a page title names, or null: Okolos's `brandIn` rule for display names (a whole word of at least
 * 4 letters, so "Applesauce" is not Apple), read over the site's title.
 */
export function brandIn(title: string | undefined, watchlist: readonly string[]): string | null {
  if (!title) return null;
  const haystack = title.toLowerCase();
  const wordish = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  for (const domain of watchlist) {
    const label = domain.slice(0, domain.indexOf("."));
    if (label.length < 4) continue;
    const at = haystack.indexOf(label);
    if (at < 0 || wordish(haystack[at - 1]) || wordish(haystack[at + label.length])) continue;
    return domain;
  }
  return null;
}

/** The signals of one domain from what was read (section 2 of the plan). */
export function domainSignalsOf(f: Omit<DomainFinding, "signals">, watchlist: readonly string[], now: number): DomainFinding["signals"] {
  const signals: DomainFinding["signals"] = [];
  const fact = (label: string, value: string) => ({ label, value });
  if (f.site?.stopped === "listedHop") signals.push({ severity: "critical", code: "inboxDomainSitePhishing", facts: [fact("mailFactAddress", f.site.hops.at(-1) ?? f.domain)] });
  // A From domain's lookalike is the identity check's; a Reply-To domain's, and a site's hop, are new here.
  const looks = f.roles.includes("replyTo") ? checkLookalike(f.domain, watchlist) : null;
  if (looks) signals.push({ severity: "critical", code: "inboxDomainLookalike", facts: [fact("mailFactAddress", f.domain), fact("mailFactResembles", looks.resembles)] });
  else if (f.site?.stopped === "lookalikeHop") {
    const host = f.site.hops.at(-1) ?? "";
    signals.push({ severity: "critical", code: "inboxDomainLookalike", facts: [fact("mailFactAddress", host), fact("mailFactResembles", checkLookalike(host, watchlist)?.resembles ?? "")] });
  }
  if (f.registered !== undefined && now - f.registered < NEW_DOMAIN_DAYS * DAY && now >= f.registered)
    signals.push({ severity: "major", code: "inboxDomainNew", facts: [fact("inboxFactDays", String(Math.floor((now - f.registered) / DAY)))] });
  if (f.rdap === "notFound" && f.dns.resolves === false) signals.push({ severity: "major", code: "inboxDomainUnregistered" });
  const held = (f.status ?? []).filter((s) => HOLD.has(s));
  if (held.length) signals.push({ severity: "major", code: "inboxDomainOnHold", facts: [fact("inboxFactStatus", held.join(", "))] });
  const claimed = brandIn(f.site?.title, watchlist);
  if (claimed && registrableDomain(f.site!.hops.at(-1) ?? f.domain) !== registrableDomain(claimed) && f.domain !== registrableDomain(claimed))
    signals.push({ severity: "major", code: "inboxDomainSiteBrand", facts: [fact("mailFactResembles", claimed)] });
  if (f.site?.file) signals.push({ severity: "major", code: "inboxDomainSiteFile", facts: [fact("inboxFactType", f.site.file)] });
  if (f.site?.password) signals.push({ severity: "minor", code: "inboxDomainSitePassword" });
  if (f.site?.leaves && f.site.hops.length > 1) signals.push({ severity: "minor", code: "inboxDomainSiteElsewhere", facts: [fact("mailFactAddress", registrableDomain(f.site.hops.at(-1)!))] });
  return signals;
}

/** Whether a lookup read everything it tried: one that did not is not kept as the answer for a day. */
export const lookupComplete = (lookup: DomainLookup) => lookup.domains.every((d) => d.rdap !== "failed" && !d.dns.failed && d.site?.stopped !== "noAnswer");

/** The whole lookup of one message's sender domains. */
export async function lookupDomains(input: { fromLine: string; replyToLine?: string | null }, given: DomainDeps): Promise<DomainLookup> {
  // Past MAX_REQUESTS a read fails like an unanswered one, so the lookup says it did not run in full instead of failing.
  let sent = 0;
  const deps: DomainDeps = { ...given, fetch: ((url, init) => ++sent > MAX_REQUESTS ? Promise.reject(new Error("request cap")) : given.fetch(url, init)) as typeof fetch };
  const watchlist = [...DEFAULT_WATCHLIST, ...deps.ownDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)];
  const picked = senderDomains(input.fromLine, input.replyToLine, deps.ownDomains);
  const domains = await Promise.all(picked.domains.map(async ({ domain, roles }) => {
    const [rdap, dns] = await Promise.all([readRdap(domain, deps), readDns(domain, deps)]);
    // A name that does not resolve has no site to visit.
    const site = dns.resolves === false ? undefined : await visitSite(domain, deps, watchlist);
    const base: Omit<DomainFinding, "signals"> = { domain, roles, ...rdap, dns, ...(site ? { site } : {}) };
    return { ...base, signals: domainSignalsOf(base, watchlist, deps.now) };
  }));
  return { version: 1, at: deps.now, domains, notRun: picked.notRun };
}
