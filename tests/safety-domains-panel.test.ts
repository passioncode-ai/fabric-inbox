import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { colourOf, type DomainLookup, type MailCheck, type SafetyLikeRecord } from "../shared/mail/safety";

/**
 * S03c (B-288): the panel's section The sender's domains. Before a lookup it says what the lookup does and offers its
 * button; after, one block per domain with its fired lines marked; a server that does not check mail shows no button.
 */
(globalThis as { React?: unknown }).React = React;
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("~/") ? next(new URL(specifier.slice(2), APP).href, context) : next(specifier, context);
  },
});
const { I18nProvider } = await import("../app/lib/i18n");
const { SafetyPanel } = await import("../app/components/inbox/SafetyBadge");

const DAY = 86_400_000;
const check: MailCheck = { version: 1, checkedAt: 1, feedVersion: 3, scope: "received", notRun: [], links: [], files: [], contentHash: "h",
  signals: [{ check: "replyPath", severity: "major", code: "mailSenderReplyElsewhere", facts: [{ label: "mailFactReplyDomain", value: "brand-invest.example" }] }] };
const lookup: DomainLookup = { version: 1, at: Date.now(), notRun: [{ domain: "shop.example", why: "ownDomain" }], domains: [{
  domain: "brand-invest.example", roles: ["replyTo"], rdap: "found", registered: Date.now() - 3 * DAY, registrar: "Example Registrar",
  dns: { resolves: true, mx: ["mx.example"], spf: true, dmarc: "absent" },
  site: { status: 200, hops: ["brand-invest.example"], leaves: false, password: false, title: "Invest <b>now</b>" },
  signals: [{ severity: "major", code: "inboxDomainNew", facts: [{ label: "inboxFactDays", value: "3" }] }],
}] };

function render(record: SafetyLikeRecord, locale: "en" | "ru", onLookUp?: (refresh: boolean) => void) {
  return renderToStaticMarkup(createElement(I18nProvider, { locale, choice: locale },
    createElement(SafetyPanel, { colour: colourOf(record, 3), record, onLookUpDomains: onLookUp, lookingUp: false })));
}

test("before a lookup: what it does and its button; a reader without the lookup shows neither", () => {
  const html = render({ state: "clear", findings: { check } }, "en", () => {});
  assert.match(html, /The sender&#x27;s domains/);
  assert.match(html, /visited from your server, at its main page only/);
  assert.match(html, />Look up the domains</);
  assert.match(html, /Look up who registered the sender&#x27;s domains/, "First steps of an amber message point to it");
  assert.doesNotMatch(render({ state: "clear", findings: { check } }, "en"), /The sender&#x27;s domains/);
});

test("after a lookup: the domain by its role, the new-domain line marked, the title quoted as text, Look up again", () => {
  const record: SafetyLikeRecord = { state: "clear", findings: { check, domains: lookup } };
  assert.equal(colourOf(record, 3).label, "suspicious", "a three-day-old Reply-To domain raises the message");
  const html = render(record, "en", () => {});
  assert.match(html, /brand-invest\.example: replies go here/);
  assert.match(html, /class="is-fired"><svg[^]*?Registered 3 days ago: new domains are a common sign of fraud\./);
  assert.match(html, /Registrar: Example Registrar\./);
  assert.match(html, /Takes mail \(mx\.example\)\./);
  assert.match(html, /Publishes no DMARC policy for forged mail\./);
  assert.match(html, /Invest &lt;b&gt;now&lt;\/b&gt;/, "the page title is text, never markup");
  assert.match(html, /shop\.example: this server&#x27;s own domain, not looked up\./);
  assert.match(html, />Look up again</);
  const ru = render(record, "ru", () => {});
  assert.match(ru, /Домены отправителя/);
  assert.match(ru, /Зарегистрирован 3 дня назад/);
  assert.match(ru, /Проверить ещё раз/);
  assert.doesNotMatch(ru + html, /\u2014/);
});
