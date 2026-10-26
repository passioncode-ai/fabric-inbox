import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { serialiseUpdate, type FeedUpdate } from "../vendor/okolos/core-feeds/apply";
import { linksOf, phishingLinks, refreshFeed, type KeptFeed } from "../workers/safety/feed";

// B-180: the server's copy of the Okolos phishing feed, checked with Okolos's own rules. Signed here with a key made
// for the test; the live feed was checked against Okolos's real key by hand on 2026-10-26 (version 65, 220 hosts).
const keys = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const publicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
const sign = async (update: FeedUpdate) =>
  ({ update, signature: Buffer.from(await webcrypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(serialiseUpdate(update)))).toString("base64") });
const snapshot = (version: number, entries: string[]): FeedUpdate => ({ kind: "snapshot", body: { name: "phishing", version, updatedAt: "2026-10-26T00:00:00Z", entries } });
const serve = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const env = { OKOLOS_FEED_URL: "https://feed.invalid/feeds/phishing", OKOLOS_FEED_PUBLIC_KEY: publicKey };

test("a signed feed is taken; a tampered one, another key's, or a replay of an older version keeps the last good copy", async () => {
  const v2 = await sign(snapshot(2, ["login-bank.invalid", "evil.invalid/pay"]));
  const first = await refreshFeed(env, null, serve(v2), 1000);
  assert.deepEqual([first.outcome, first.kept?.snapshot.version, first.kept?.fetchedAt], ["updated", 2, 1000]);
  const tampered = { ...v2, update: snapshot(3, ["login-bank.invalid"]) };
  assert.deepEqual([(await refreshFeed(env, first.kept, serve(tampered))).outcome, (await refreshFeed(env, first.kept, serve(tampered))).kept?.snapshot.version], ["refused", 2]);
  const replay = await refreshFeed(env, first.kept, serve(await sign(snapshot(1, []))));
  assert.deepEqual([replay.outcome, replay.detail, replay.kept?.snapshot.version], ["refused", "not-newer", 2]);
  const same = await refreshFeed(env, first.kept, serve(v2), 5000);
  assert.deepEqual([same.outcome, same.kept?.fetchedAt], ["same", 5000], "the same version again only freshens the copy");
  assert.equal((await refreshFeed({ ...env, OKOLOS_FEED_PUBLIC_KEY: Buffer.alloc(32, 1).toString("base64") }, null, serve(v2))).outcome, "refused");
});

test("an unreachable or unconfigured feed keeps what there is and says so", async () => {
  const kept: KeptFeed = { snapshot: snapshot(2, ["x.invalid"]).body as never, fetchedAt: 1 };
  assert.deepEqual([(await refreshFeed(env, kept, serve({}, 503))).outcome, (await refreshFeed(env, kept, serve({}, 503))).kept], ["unreachable", kept]);
  assert.equal((await refreshFeed({}, kept, serve({}))).outcome, "not_configured");
  assert.equal((await refreshFeed(env, null, serve({ nope: 1 }))).outcome, "refused");
});

test("a message's links are read from its HTML and text, and only listed sites (a page under one too) are named, by host", () => {
  const html = `<p>Pay at <a href="https://evil.invalid/pay/now?id=1&amp;x=2">here</a> or https://login-bank.invalid/sign-in.</p><a href='https://ok.invalid'>ok</a>`;
  const links = linksOf(html);
  assert.deepEqual(links.sort(), ["https://evil.invalid/pay/now?id=1&x=2", "https://login-bank.invalid/sign-in", "https://ok.invalid"].sort());
  const feed = snapshot(2, ["login-bank.invalid", "evil.invalid/pay"]).body as never;
  assert.deepEqual(phishingLinks(links, feed).map((l) => l.host).sort(), ["evil.invalid", "login-bank.invalid"]);
  assert.deepEqual(phishingLinks(["https://mail.login-bank.invalid/x"], feed).map((l) => l.host), ["mail.login-bank.invalid"], "a subdomain of a listed host");
  assert.deepEqual(phishingLinks(["https://evil.invalid/payments"], feed), [], "a path entry covers what is under it, not its neighbours");
});

test("B-180: in the reader, a link to a listed host or one under it does not open; others do", async () => {
  const { isBlockedLink } = await import("../shared/mail/blocked-links");
  const hosts = ["secure.login-bank.invalid"];
  assert.equal(isBlockedLink("https://secure.login-bank.invalid/verify?x=1", hosts), true);
  assert.equal(isBlockedLink("https://a.secure.login-bank.invalid/", hosts), true);
  assert.equal(isBlockedLink("https://login-bank.invalid/", hosts), false, "its parent is not named by the verdict");
  assert.equal(isBlockedLink("mailto:x@y.invalid", hosts), false);
  assert.equal(isBlockedLink("not a url", hosts), false);
});
