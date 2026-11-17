import { test } from "node:test";
import assert from "node:assert/strict";
import { brandIn, domainSignalsOf, forgetBootstrap, lookupDomains, lookupable, readDns, readRdap, senderDomains, visitSite, MAX_REDIRECTS, RDAP_BOOTSTRAP, type DomainDeps } from "../workers/safety/domains";
import { colourOf, draftOnlyReason, type DomainLookup, type MailCheck, type SafetyLikeRecord } from "../shared/mail/safety";
import { domainHeading, domainLines, domainNotRunWords } from "../app/components/inbox/safety-words";
import { createT } from "../shared/i18n";
import { DEFAULT_WATCHLIST } from "../vendor/okolos/core-lookalike/watchlist";

// S03c (B-288): the lookup of a message's sender domains, without a Worker. Every request is answered by a script;
// nothing leaves the process.

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-17T00:00:00Z");
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function deps(route: Route, extra: Partial<DomainDeps> = {}): DomainDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked, feed: null, ownDomains: ["shop.example"], now: NOW, ...extra,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(input)); asked.push(url.href); return route(url, init); }) as typeof fetch,
  };
}
const json = (body: unknown, status = 200, type = "application/json") => new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
const rdap = (registered: string, extra: Record<string, unknown> = {}) => json({
  events: [{ eventAction: "registration", eventDate: registered }, { eventAction: "expiration", eventDate: "2027-11-14T00:00:00Z" }],
  status: ["client transfer prohibited"],
  entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar​, Inc."]]] }],
  ...extra,
}, 200, "application/rdap+json");
/** DNS over HTTPS answers: `nx` names answer NXDOMAIN; others as listed. */
function dns(records: Record<string, { type: number; data: string }[]>, nx: string[] = []): Route {
  return (url) => {
    const name = url.searchParams.get("name")!;
    const type = url.searchParams.get("type")!;
    const code = { A: 1, MX: 15, TXT: 16 }[type as "A"]!;
    if (nx.some((n) => name === n || name.endsWith(`.${n}`))) return json({ Status: 3 });
    return json({ Status: 0, Answer: (records[name] ?? []).filter((r) => r.type === code) });
  };
}
const page = (html: string, headers: Record<string, string> = {}) => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

test("the domains looked up are the From and Reply-To registrable domains, Reply-To first, never the server's own", () => {
  const picked = senderDomains('"PassionCode.ai" <commercial@shop.example>', "info@mail.brand-invest.example, Other <x@other.example.com>", ["shop.example"]);
  assert.deepEqual(picked.domains, [{ domain: "brand-invest.example", roles: ["replyTo"] }, { domain: "example.com", roles: ["replyTo"] }]);
  assert.deepEqual(picked.notRun, [{ domain: "shop.example", why: "ownDomain" }]);
  // One domain in both roles is looked up once.
  assert.deepEqual(senderDomains("a@x.example.org", "b@example.org", []).domains, [{ domain: "example.org", roles: ["from", "replyTo"] }]);
  assert.deepEqual(senderDomains("", null, []).notRun, [{ why: "noSender" }]);
  const many = senderDomains("a@a1.example, b@a2.example, c@a3.example", "d@a4.example, e@a5.example", []);
  assert.equal(many.domains.length, 4);
  assert.deepEqual(many.notRun, [{ domain: "a3.example", why: "capReached" }]);
});

test("only public registrable domains are looked up: no IP, single label or reserved suffix", () => {
  for (const name of ["brand-invest.example", "example.co.uk", "xn--80ak6aa92e.com"]) assert.ok(lookupable(name), name);
  for (const name of ["localhost", "intranet", "10.0.0.1", "printer.local", "box.internal", "a.test", "x.invalid", "[::1]", ""]) assert.ok(!lookupable(name), name);
  assert.deepEqual(senderDomains("a@printer.example.invalid", null, []).notRun, [{ domain: "example.invalid", why: "notPublic" }]);
});

test("RDAP gives the registration date, the registrar (invisible characters stripped) and the status; 404 is not found", async () => {
  const d = deps((url) => url.pathname.endsWith("/gone.example") ? new Response("", { status: 404 }) : url.pathname.endsWith("/broken.example") ? new Response("x", { status: 500 }) : rdap("2026-11-14T09:00:00Z"));
  const found = await readRdap("brand-invest.example", d);
  assert.deepEqual(found, { rdap: "found", registered: Date.parse("2026-11-14T09:00:00Z"), expires: Date.parse("2027-11-14T00:00:00Z"), registrar: "Example Registrar, Inc.", status: ["client transfer prohibited"] });
  assert.equal(d.asked[0], "https://rdap.org/domain/brand-invest.example");
  assert.deepEqual(await readRdap("gone.example", d), { rdap: "notFound" });
  assert.deepEqual(await readRdap("broken.example", d), { rdap: "failed" });
  const offline = deps(() => { throw new TypeError("network"); });
  assert.deepEqual(await readRdap("x.example", offline), { rdap: "failed" });
});

test("when the redirector refuses, the registry's own server is asked, found in IANA's list", async () => {
  forgetBootstrap();
  const d = deps((url) => {
    if (url.hostname === "rdap.org") return new Response("", { status: 403 });
    if (url.href === RDAP_BOOTSTRAP) return json({ services: [[["com", "net"], ["https://rdap.verisign.example/com/v1/"]], [["pro"], ["http://rdap.pro.example/", "https://rdap.pro.example/rdap/"]]] });
    if (url.href === "https://rdap.pro.example/rdap/domain/brand-invest.pro") return rdap("2026-11-14T09:00:00Z");
    return new Response("", { status: 500 });
  });
  const found = await readRdap("brand-invest.pro", d);
  assert.equal(found.rdap, "found");
  assert.ok(d.asked.every((u) => !u.startsWith("http:")), "only https servers are asked");
  // Every read names itself (rdap.org refuses a request that does not).
  forgetBootstrap();
  const seen: string[] = [];
  await readRdap("x.pro", deps((_u, init) => { seen.push(new Headers(init?.headers).get("user-agent") ?? ""); return new Response("", { status: 404 }); }));
  assert.ok(seen.every((ua) => ua.includes("FabricInbox")));
  forgetBootstrap();
});

test("DNS says whether the name resolves, its mail hosts, SPF and the DMARC policy", async () => {
  const d = deps(dns({
    "a.example": [{ type: 1, data: "192.0.2.1" }, { type: 15, data: "10 mx1.a.example." }, { type: 16, data: '"v=spf1 include:_spf.a.example -all"' }],
    "_dmarc.a.example": [{ type: 16, data: '"v=DMARC1; p=reject; rua=mailto:d@a.example"' }],
    "b.example": [{ type: 1, data: "192.0.2.2" }, { type: 16, data: '"google-site-verification=1"' }],
  }, ["nx.example"]));
  assert.deepEqual(await readDns("a.example", d), { resolves: true, mx: ["mx1.a.example"], spf: true, dmarc: "reject" });
  assert.deepEqual(await readDns("b.example", d), { resolves: true, mx: [], spf: false, dmarc: "absent" });
  assert.deepEqual((await readDns("nx.example", d)).resolves, false);
  const failing = deps((url) => url.searchParams.get("type") === "MX" ? new Response("", { status: 502 }) : json({ Status: 0, Answer: [] }));
  assert.equal((await readDns("c.example", failing)).failed, true);
});

test("the site's main page is visited hop by hop: title, password field, where it ends; a redirect off the domain leaves", async () => {
  const d = deps((url) => {
    if (url.hostname === "scam.example") return redirect("https://www.scam.example/start");
    if (url.hostname === "www.scam.example") return redirect("https://landing.example.net/");
    return page('<html><head><title>  Tesla &amp; SpaceX​ Investments </title></head><body><form><input name=u><input type="password" name=p></form></body></html>');
  });
  const site = await visitSite("scam.example", d, DEFAULT_WATCHLIST);
  assert.deepEqual(site, { status: 200, hops: ["scam.example", "www.scam.example", "landing.example.net"], leaves: true, password: true,
    finalUrl: "https://landing.example.net/", title: "Tesla & SpaceX Investments" });
  // Only the root is visited, never a path from the message, and with no cookie.
  assert.equal(d.asked[0], "https://scam.example/");
});

test("a hop on the phishing feed, or imitating a watched name, is never requested", async () => {
  const feed = { version: 7, entries: ["evil-login.example"] } as unknown as DomainDeps["feed"];
  const d = deps((url) => url.hostname === "shady.example" ? redirect("https://evil-login.example/verify") : page("<title>x</title>"), { feed });
  const listed = await visitSite("shady.example", d, DEFAULT_WATCHLIST);
  assert.equal(listed.stopped, "listedHop");
  assert.ok(!d.asked.some((u) => u.includes("evil-login")), "the listed host is not requested");
  const look = deps((url) => url.hostname === "shady.example" ? redirect("https://paypa1.com/") : page(""));
  const lookalike = await visitSite("shady.example", look, DEFAULT_WATCHLIST);
  assert.equal(lookalike.stopped, "lookalikeHop");
  assert.ok(!look.asked.some((u) => u.includes("paypa1")));
});

test("a root that hands over a file, a redirect to an address that is not a public site, and a loop are stopped", async () => {
  const file = await visitSite("drop.example", deps(() => new Response("MZ", { status: 200, headers: { "content-type": "application/x-msdownload", "content-disposition": "attachment; filename=a.exe" } })), DEFAULT_WATCHLIST);
  assert.equal(file.file, "application/x-msdownload");
  const internal = deps((url) => url.hostname === "x.example" ? redirect("http://169.254.169.254/latest/meta-data") : page(""));
  assert.equal((await visitSite("x.example", internal, DEFAULT_WATCHLIST)).stopped, "notHttp");
  assert.equal(internal.asked.length, 1, "the metadata address is never requested");
  const scheme = await visitSite("y.example", deps(() => redirect("javascript:alert(1)")), DEFAULT_WATCHLIST);
  assert.equal(scheme.stopped, "notHttp");
  const loop = deps((url) => redirect(`https://loop.example/${url.pathname.length}`));
  const looped = await visitSite("loop.example", loop, DEFAULT_WATCHLIST);
  assert.equal(looped.stopped, "tooManyRedirects");
  assert.equal(loop.asked.length, MAX_REDIRECTS + 1);
  const silent = await visitSite("down.example", deps(() => { throw new Error("timeout"); }), DEFAULT_WATCHLIST);
  assert.deepEqual([silent.status, silent.stopped], [null, "noAnswer"]);
});

test("a page body is read only up to its cap, whatever the server sends", async () => {
  const huge = "<title>Big</title>" + "x".repeat(5_000_000) + '<input type="password">';
  const site = await visitSite("big.example", deps(() => page(huge)), DEFAULT_WATCHLIST);
  assert.equal(site.title, "Big");
  assert.equal(site.password, false, "the password field past the cap is not read");
});

test("signals: a new domain, an unregistered one, a hold, a file, a lookalike Reply-To; a From lookalike is the identity check's", () => {
  const base = { dns: { resolves: true, mx: [], spf: null, dmarc: null }, rdap: "found" as const };
  const codes = (f: Parameters<typeof domainSignalsOf>[0]) => domainSignalsOf(f, DEFAULT_WATCHLIST, NOW).map((s) => `${s.severity}:${s.code}`);
  assert.deepEqual(codes({ ...base, domain: "brand-invest.example", roles: ["replyTo"], registered: NOW - 3 * DAY }), ["major:inboxDomainNew"]);
  assert.deepEqual(codes({ ...base, domain: "old.example", roles: ["replyTo"], registered: NOW - 400 * DAY }), []);
  assert.deepEqual(codes({ ...base, domain: "gone.example", roles: ["from"], rdap: "notFound", dns: { resolves: false, mx: [], spf: null, dmarc: null } }), ["major:inboxDomainUnregistered"]);
  assert.deepEqual(codes({ ...base, domain: "held.example", roles: ["from"], status: ["client hold", "active"] }), ["major:inboxDomainOnHold"]);
  assert.deepEqual(codes({ ...base, domain: "paypa1.com", roles: ["replyTo"] }), ["critical:inboxDomainLookalike"]);
  assert.deepEqual(codes({ ...base, domain: "paypa1.com", roles: ["from"] }), [], "the identity check already names a lookalike From");
  assert.deepEqual(codes({ ...base, domain: "s.example", roles: ["from"], site: { status: 200, hops: ["s.example", "t.example"], leaves: true, password: true } }),
    ["minor:inboxDomainSitePassword", "minor:inboxDomainSiteElsewhere"]);
  assert.deepEqual(codes({ ...base, domain: "f.example", roles: ["from"], site: { status: 200, hops: ["f.example"], leaves: false, password: false, file: "application/zip" } }), ["major:inboxDomainSiteFile"]);
  assert.deepEqual(codes({ ...base, domain: "p.example", roles: ["from"], site: { status: null, hops: ["p.example", "evil.example"], leaves: true, password: false, stopped: "listedHop" } }),
    ["critical:inboxDomainSitePhishing", "minor:inboxDomainSiteElsewhere"]);
});

test("a site whose title names a watched brand on another domain is suspicious; the brand's own site and a longer word are not", () => {
  const base = { dns: { resolves: true, mx: [], spf: null, dmarc: null }, rdap: "found" as const, roles: ["replyTo" as const] };
  const site = (title: string, hops: string[]) => ({ status: 200, hops, leaves: false, password: false, title });
  const codes = (domain: string, title: string, hops = [domain]) => domainSignalsOf({ ...base, domain, site: site(title, hops) }, DEFAULT_WATCHLIST, NOW).map((s) => s.code);
  assert.deepEqual(codes("invest-now.example", "PayPal | Invest in the Future"), ["inboxDomainSiteBrand"]);
  assert.deepEqual(codes("paypal.com", "PayPal | Log in"), []);
  assert.deepEqual(codes("recipes.example", "Applesauce Recipes"), []);
  assert.equal(brandIn(undefined, DEFAULT_WATCHLIST), null);
});

test("the whole lookup: the screenshot's case, a Reply-To registered three days ago on a stranger's domain", async () => {
  const d = deps((url) => {
    if (url.hostname === "rdap.org") return rdap("2026-11-14T09:00:00Z");
    if (url.hostname === "cloudflare-dns.com") return dns({ "brand-invest.example": [{ type: 1, data: "192.0.2.9" }, { type: 15, data: "10 mx.privateemail.example." }] })(url);
    return page("<title>Tesla SpaceX Inc</title>");
  });
  const lookup = await lookupDomains({ fromLine: '"PassionCode.ai" <commercial@shop.example>', replyToLine: "info@brand-invest.example" }, d);
  assert.equal(lookup.version, 1);
  assert.deepEqual(lookup.notRun, [{ domain: "shop.example", why: "ownDomain" }]);
  const [d0] = lookup.domains;
  assert.deepEqual([d0!.domain, d0!.registrar, d0!.dns.mx, d0!.site?.title], ["brand-invest.example", "Example Registrar, Inc.", ["mx.privateemail.example"], "Tesla SpaceX Inc"]);
  assert.deepEqual(d0!.signals.map((s) => s.code), ["inboxDomainNew"]);
  // A name that does not resolve has no site to visit.
  const nx = deps((url) => url.hostname === "rdap.org" ? new Response("", { status: 404 }) : url.hostname === "cloudflare-dns.com" ? json({ Status: 3 }) : page(""));
  const gone = await lookupDomains({ fromLine: "x@gone.example" }, nx);
  assert.equal(gone.domains[0]!.site, undefined);
  assert.ok(!nx.asked.some((u) => u.startsWith("https://gone.example")));
  assert.deepEqual(gone.domains[0]!.signals.map((s) => s.code), ["inboxDomainUnregistered"]);
});

const check = (signals: MailCheck["signals"] = []): MailCheck => ({ version: 1, checkedAt: 1, feedVersion: 3, scope: "received", signals, notRun: [], links: [], files: [], contentHash: "h" });
const record = (c: MailCheck, domains?: DomainLookup): SafetyLikeRecord => ({ state: "clear", findings: { check: c, ...(domains ? { domains } : {}) } });
const lookupWith = (...signals: DomainLookup["domains"][number]["signals"]): DomainLookup => ({ version: 1, at: 1, notRun: [],
  domains: [{ domain: "x.example", roles: ["replyTo"], rdap: "found", dns: { resolves: true, mx: [], spf: null, dmarc: null }, signals }] });

test("the colour reads the lookup only upward: critical is red, major raises to suspicious, minor and a failed lookup change nothing", () => {
  const reply = { check: "replyPath" as const, severity: "major" as const, code: "mailSenderReplyElsewhere" };
  assert.equal(colourOf(record(check()), 3).label, "checked");
  assert.equal(colourOf(record(check(), lookupWith({ severity: "minor", code: "inboxDomainSitePassword" })), 3).label, "checked");
  assert.equal(colourOf(record(check([reply])), 3).label, "senderForged");
  assert.equal(colourOf(record(check([reply]), lookupWith({ severity: "major", code: "inboxDomainNew" })), 3).label, "suspicious");
  assert.equal(colourOf(record(check(), lookupWith({ severity: "critical", code: "inboxDomainSitePhishing" })), 3).label, "dangerous");
  // A lookup with nothing found, or none at all, never makes a message grey or lowers it.
  assert.equal(colourOf(record(check(), { version: 1, at: 1, domains: [], notRun: [{ why: "noSender" }] }), 3).label, "checked");
  assert.equal(colourOf(record(check([reply]), lookupWith()), 3).label, "senderForged");
  // A record of an unknown later version is not read.
  assert.equal(colourOf(record(check(), { ...lookupWith({ severity: "critical", code: "x" }), version: 2 as 1 }), 3).label, "checked");
  // A critical domain makes a reply agent draft instead of send.
  assert.equal(draftOnlyReason(record(check(), lookupWith({ severity: "critical", code: "inboxDomainLookalike" }))), "sender");
  assert.equal(draftOnlyReason(record(check(), lookupWith({ severity: "major", code: "inboxDomainNew" }))), null);
});

test("the panel's words: one heading per domain by its role, fired lines first, nothing shown as a key", () => {
  for (const locale of ["en", "ru"] as const) {
    const t = createT(locale);
    assert.ok(domainHeading({ domain: "xn--80ak6aa92e.com", roles: ["replyTo"] }, t).startsWith("xn--80ak6aa92e.com"));
    const lines = domainLines({ domain: "brand-invest.example", roles: ["replyTo"], rdap: "found", registered: Date.now() - 3 * DAY, registrar: "Registrar",
      dns: { resolves: true, mx: ["mx.example"], spf: false, dmarc: "absent" }, site: { status: 200, hops: ["brand-invest.example"], leaves: false, password: false, title: "Tesla" },
      signals: [{ severity: "major", code: "inboxDomainNew", facts: [{ label: "inboxFactDays", value: "3" }] }] }, t);
    assert.equal(lines[0]!.fired, true);
    assert.match(lines[0]!.text, /3/);
    assert.ok(lines.length >= 5);
    for (const l of lines) { assert.doesNotMatch(l.text, /\binbox[A-Z]|\{/); assert.doesNotMatch(l.text, /\u2014/); }
    for (const why of ["ownDomain", "notPublic", "capReached", "noSender"]) assert.ok(domainNotRunWords({ domain: "a.example", why }, t));
  }
});
