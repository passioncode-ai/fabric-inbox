import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptFrameLink, frameLinkScript, guardContext, guardHref, hostParts, mailtoParts, UNCHECKED } from "../app/lib/link-guard";
import { linkDecision, type SafetyColour } from "../shared/mail/safety";

// S04 (B-270): the sanitizer's decision per href, and the parent's check of a frame's link message.

const green: SafetyColour = { colour: "green", label: "checked", linksComplete: true };
const amber: SafetyColour = { colour: "amber", label: "suspicious", linksComplete: true };
const red: SafetyColour = { colour: "red", label: "dangerous", linksComplete: true };
const greyClean: SafetyColour = { colour: "grey", label: "partly", linksComplete: true };
const greyLinks: SafetyColour = { colour: "grey", label: "partly", linksComplete: false };
const checked = [{ url: "https://example.com/", host: "example.com" }, { url: "https://acme.example/a", host: "acme.example" }];

test("green, and grey whose links check ran clean, keep a checked link; https://example.com matches its canonical form", () => {
  for (const c of [green, greyClean]) {
    const r = guardHref("https://example.com", "Example", 0, guardContext(c, checked));
    assert.equal(r.keep, true);
    assert.equal(r.link.url, "https://example.com/");
  }
});

test("amber, red, grey with links not complete, and no record remove every href and keep the index", () => {
  for (const c of [amber, red, greyLinks, UNCHECKED]) {
    const r = guardHref("https://example.com/", "Example", 3, guardContext(c, checked));
    assert.deepEqual([r.keep, r.link.index], [false, 3]);
  }
  assert.equal(guardHref("https://example.com/", "x", 0, guardContext(null, checked)).keep, false, "a record that cannot be read is grey");
});

test("on a green message, odd and unchecked hrefs lose their href and ask; mailto keeps it unless red", () => {
  const ctx = guardContext(green, [...checked, { url: "https://evil.example/", host: "evil.example" }]);
  for (const odd of ["https:\\\\evil.example", "https:evil.example", "https://evil.exa\tmple/"]) {
    const r = guardHref(odd, "x", 0, ctx);
    assert.equal(r.keep, false, odd);
    if (r.link.url) assert.equal(linkDecision(green, r.link).action, "ask", odd);
  }
  const unchecked = guardHref("https://unlisted.example/", "x", 0, ctx);
  assert.deepEqual([unchecked.keep, linkDecision(green, unchecked.link).action], [false, "ask"]);
  const js = guardHref("javascript:alert(1)", "x", 0, ctx);
  assert.deepEqual([js.keep, linkDecision(green, js.link).action], [false, "block"]);
  assert.equal(guardHref("mailto:ann@acme.example", "Ann", 0, ctx).keep, true);
  assert.equal(guardHref("mailto:ann@acme.example", "Ann", 0, guardContext(red, checked)).keep, false, "R6-6");
  const flagged = guardHref("https://x.example/", "x", 0, guardContext(green, [{ url: "https://x.example/", host: "x.example", why: "textMismatch", shown: "b.example" }]));
  assert.equal(flagged.keep, false, "a link-related signal asks even on a message that is otherwise clean");
});

test("KIMI-47: a link message counts only from this frame, with this render's nonce and a valid index", () => {
  const frame = {}, other = {};
  const ok = (data: unknown, source: unknown = frame, active = true) => acceptFrameLink({ source, data }, frame, "n1", 2, { isActive: active });
  assert.equal(ok({ type: "okolos-link", index: 1, nonce: "n1" }), 1);
  assert.equal(ok({ type: "okolos-link", index: 1, nonce: "n1" }, other), undefined, "another window");
  assert.equal(ok({ type: "okolos-link", index: 1, nonce: "n0" }), undefined, "a previous render's nonce");
  assert.equal(ok({ type: "okolos-link", index: 2, nonce: "n1" }), undefined, "past this render's list");
  assert.equal(ok({ type: "okolos-link", url: "https://evil.example/", nonce: "n1" }), undefined, "a URL instead of an index opens nothing");
  assert.equal(ok({ type: "okolos-link", index: "0", nonce: "n1" }), undefined);
  assert.equal(ok({ type: "okolos-link", index: 0, nonce: "n1" }, frame, false), undefined, "no user activation");
  assert.match(frameLinkScript('a"b'), /var N="a\\"b"/, "the nonce is written as a string literal");
});

test("the notice shows the host in ASCII with its registrable part apart", () => {
  assert.deepEqual(hostParts("https://login.bank.example/x"), { sub: "login", registrable: "bank.example" });
  assert.deepEqual(hostParts("https://www.shop.co.uk/"), { sub: "www", registrable: "shop.co.uk" });
  assert.deepEqual(hostParts("https://пример.example/"), { sub: "", registrable: "xn--e1afmkfd.example" });
  assert.equal(hostParts(null), null);
});

test("every frame runs the link script, which parses and opens nothing itself; the sanitizer drops a message's own index", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("app/components/EmailIframe.tsx", "utf8");
  assert.match(src, /const linkScript = `<script>\$\{frameLinkScript\(nonce\)\}<\\\/script>`;/);
  assert.match(src, /\$\{linkScript\}\n<\/head>|\n\$\{linkScript\}\n/);
  assert.match(src, /node\.removeAttribute\("data-okolos-link"\)/, "an index the message wrote itself is dropped");
  assert.match(src, /const nonce = crypto\.randomUUID\(\)/, "a nonce per render");
  const script = frameLinkScript("n");
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /window\.open|location|<\/script/i);
});

test("A-21: until the record arrives a mailto: asks too, as on a dangerous message; then it keeps its address", () => {
  const mail = "mailto:billing@acme.example";
  assert.equal(guardHref(mail, "Write to us", 0, guardContext(null, undefined, { pending: true })).keep, false, "pending: no live mailto");
  assert.equal(guardHref(mail, "Write to us", 0, guardContext(null, undefined)).keep, true, "a record that says grey keeps it");
  assert.equal(guardHref(mail, "Write to us", 0, guardContext(red, [])).keep, false);
  assert.equal(guardHref("https://acme.example/a", "a", 0, guardContext(green, checked, { pending: true })).keep, true, "pending changes only mailto");
});

test("A-9: a mailto: notice names the address it writes to, its domain in ASCII with the registrable part apart", () => {
  assert.deepEqual(mailtoParts("mailto:billing@pay.acme.example?subject=x"), { local: "billing", sub: "pay", registrable: "acme.example" });
  assert.deepEqual(mailtoParts("mailto:ann@пример.example"), { local: "ann", sub: "", registrable: "xn--e1afmkfd.example" });
  assert.equal(mailtoParts("mailto:"), null);
  assert.equal(mailtoParts("https://acme.example/"), null);
  assert.equal(hostParts("mailto:ann@acme.example"), null, "a mailto has no host: never \"This link goes to\" with nothing after it");
});
