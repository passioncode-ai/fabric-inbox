import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OutlookConnectStep, OutlookProblem, OutlookSetupWizard, SecretExpiryNotice, type MicrosoftSetup } from "../app/components/settings/sections/OutlookSetup";
import { PROVIDERS, availability } from "../app/components/settings/sections/providers";
import { outlookSetupState } from "../app/lib/account-status";
import { groupAccounts } from "../app/components/inbox/account-groups";
import { MICROSOFT_ENTRA, MICROSOFT_HELP, MICROSOFT_PERMISSIONS, adminConsentUrl, microsoftSetupValues } from "../shared/mail/microsoft-setup";

/** SCN-057…SCN-059 in the interface: the Outlook card, the setup steps, the connect step, and an account's reason. */
const ORIGIN = "https://fabric-inbox.owner.workers.dev";
const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const setup = (over: Partial<MicrosoftSetup> = {}): MicrosoftSetup => ({
  configured: false, missing: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MAIL_CREDENTIAL_KEY", "PUBLIC_APP_URL"],
  values: microsoftSetupValues(ORIGIN), permissions: MICROSOFT_PERMISSIONS, clientId: null, secretExpiry: null, credentialKey: "missing", publicAppUrl: null,
  addressMatches: null, canSave: true, links: { ...MICROSOFT_ENTRA }, help: { ...MICROSOFT_HELP }, ...over,
});
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, element));

test("the Outlook card connects once the server has its Microsoft setup, and is not a dead end before", () => {
  const card = PROVIDERS.find((p) => p.id === "microsoft")!;
  assert.equal(card.connect, "microsoft-oauth");
  const base = { cloudflareConnected: true, gmail: "configured" as const, imap: "configured" as const };
  assert.equal(availability(card, { ...base, outlook: "configured" }), "available");
  assert.equal(availability(card, { ...base, outlook: "not-configured" }), "not-configured", "the card opens the setup steps");
  assert.equal(availability(card, { ...base, outlook: "unavailable" }), "unknown");
  assert.equal(outlookSetupState({ providers: [{ id: "outlook", status: "configured" }] }, null), "configured");
  assert.equal(outlookSetupState({ providers: [{ id: "outlook", status: "not_configured" }] }, null), "not-configured");
  assert.equal(outlookSetupState(undefined, null), "loading");
});

test("the setup walks through Microsoft Entra with the exact values and asks for the secret's Value and end date", () => {
  const html = render(createElement(OutlookSetupWizard, { setup: setup(), onSaved: () => {} }));
  assert.ok(html.includes(`href="${MICROSOFT_ENTRA.appRegistrations}"`));
  assert.ok(html.includes(`href="${MICROSOFT_ENTRA.freeAccount}"`), "a personal account owner learns how to get a directory");
  assert.match(html, /<code>Any Entra ID Tenant \+ Personal Microsoft accounts<\/code>/);
  assert.match(html, /<code>https:\/\/fabric-inbox\.owner\.workers\.dev\/api\/accounts\/outlook\/callback<\/code>/);
  assert.match(html, /<strong>Web<\/strong>/);
  for (const p of ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"]) assert.match(html, new RegExp(`<code>${p}</code>`));
  assert.match(html, /<strong>Delegated permissions<\/strong>/);
  assert.match(html, /not the Secret ID/);
  assert.match(html, /at most 24 months/);
  assert.match(html, /type="password"/);
  assert.match(html, /type="date"/);
  assert.match(html, /30 days before/);
});

test("the connect step warns before the secret ends, offers the administrator's link, and opens Microsoft in the browser", () => {
  const link = adminConsentUrl(CLIENT_ID, ORIGIN + "/api/accounts/outlook/callback");
  const html = render(createElement(OutlookConnectStep, { setup: setup({ configured: true, clientId: CLIENT_ID, addressMatches: true, adminConsentUrl: link,
    secretExpiry: { date: "2026-10-20", daysLeft: 14, state: "soon" } }), onReplace: () => {} }));
  assert.match(html, /href="\/api\/accounts\/outlook\/connect"/);
  assert.match(html, /ends on 2026-10-20, in 14 days/);
  assert.ok(html.includes(link.replace(/&/g, "&amp;")));
  assert.match(html, /Use another client secret/);
  assert.equal(render(createElement(SecretExpiryNotice, { expiry: { date: "2027-10-20", daysLeft: 300, state: "ok" } })), "", "no warning while it is far off");
  assert.match(render(createElement(SecretExpiryNotice, { expiry: { date: "2026-10-01", daysLeft: -5, state: "expired" } })), /ended on 2026-10-01/);
});

test("an Outlook account that stopped working says why and offers its one fix", () => {
  const account = (over: Record<string, unknown>) => ({ id: "o1", email: "a@outlook.example", provider: "outlook", status: "error", ...over }) as never;
  const revoked = render(createElement(OutlookProblem, { account: account({ status: "reconnect_required", error: "reconnect_required", reason: "microsoft_access_revoked" }), onRetry: () => {}, onSetup: () => {}, busy: false }));
  assert.match(revoked, /Reconnect in browser/);
  assert.match(revoked, /href="\/api\/accounts\/outlook\/connect"/);
  const expired = render(createElement(OutlookProblem, { account: account({ error: "microsoft_secret_expired", reason: "microsoft_secret_expired" }), onRetry: () => {}, onSetup: () => {}, busy: false }));
  assert.match(expired, /Open the Outlook setup/);
  assert.match(expired, /does not need to be reconnected/);
  assert.equal(render(createElement(OutlookProblem, { account: account({ status: "connected" }), onRetry: () => {}, onSetup: () => {}, busy: false })), "");
});

test("the sidebar keeps Outlook accounts in their own group, after Gmail and before other mail", () => {
  const a = (provider: string, email: string) => ({ id: `${provider}:${email}`, provider, email, name: email, status: "connected", unread: 1 }) as never;
  const groups = groupAccounts([a("imap", "x@fastmail.com"), a("outlook", "b@outlook.example"), a("gmail", "c@gmail.com"), a("outlook", "a@contoso.example")]);
  assert.deepEqual(groups.map((g) => [g.kind, g.accounts.length]), [["gmail", 1], ["outlook", 2], ["imap", 1]]);
  assert.equal(groups[1]!.label, "Outlook");
});
