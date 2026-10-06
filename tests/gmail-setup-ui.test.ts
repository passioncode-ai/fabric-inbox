import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GmailConnectStep, GmailProblem, GmailSetupWizard, type GmailSetup } from "../app/components/settings/sections/GmailSetup";
import { PROVIDERS, availability } from "../app/components/settings/sections/providers";
import { GOOGLE_CONSOLE, GOOGLE_HELP, gmailSetupValues } from "../shared/mail/gmail-setup";

/** SCN-051 / SCN-002 / SCN-003 in the interface: the setup steps, the connect step, and an account's reason. */
const ORIGIN = "https://fabric-inbox.owner.workers.dev";
const setup = (over: Partial<GmailSetup> = {}): GmailSetup => ({
  configured: false, missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_TOKEN_ENCRYPTION_KEY", "PUBLIC_APP_URL"],
  values: gmailSetupValues(ORIGIN), clientId: null, projectNumber: null, credentialKey: "missing", publicAppUrl: null,
  addressMatches: null, canSave: true, links: { ...GOOGLE_CONSOLE }, help: { ...GOOGLE_HELP }, ...over,
});
const withClient = (element: ReturnType<typeof createElement>, client = new QueryClient()) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, element));

test("the setup lists every Google Cloud step with its page and the exact values to copy", () => {
  const html = withClient(createElement(GmailSetupWizard, { setup: setup(), onSaved: () => {} }));
  for (const href of [GOOGLE_CONSOLE.createProject, GOOGLE_CONSOLE.gmailApi, GOOGLE_CONSOLE.branding, GOOGLE_CONSOLE.audience,
    GOOGLE_CONSOLE.dataAccess, GOOGLE_CONSOLE.createClient])
    assert.ok(html.includes(`href="${href}"`), href);
  assert.match(html, /<code>Fabric Inbox<\/code>/);
  assert.match(html, /<code>owner\.workers\.dev<\/code>/);
  assert.match(html, /<code>https:\/\/www\.googleapis\.com\/auth\/gmail\.modify<\/code>/);
  assert.match(html, /<code>https:\/\/fabric-inbox\.owner\.workers\.dev\/api\/accounts\/gmail\/callback<\/code>/);
  assert.match(html, /Copy Redirect URI/);
  assert.match(html, /<strong>Internal<\/strong>/);
  assert.match(html, /<strong>Publish app<\/strong>/);
  assert.match(html, /7 days/, "why not Testing is said before it bites");
  assert.match(html, /type="password"/, "the secret is a password field");
  assert.match(html, /Save and check/);
});

test("a server that cannot save says so and the save stays off", () => {
  const html = withClient(createElement(GmailSetupWizard, { setup: setup({ canSave: false, cannotSave: "This server has no Cloudflare API token of its own." }), onSaved: () => {} }));
  assert.match(html, /no Cloudflare API token of its own/);
  assert.match(html, /<button type="submit" class="fi-primary" disabled="">Save and check/);
});

test("in the Mac app, the browser's own sign-in to the server is said before it happens", () => {
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = { fabricDesktop: {} };
  try {
    const html = renderToStaticMarkup(createElement(GmailConnectStep, { setup: setup({ configured: true, addressMatches: true }), onReplace: () => {} }));
    assert.match(html, /Google does not allow it inside apps/);
    assert.match(html, /The first time, your browser asks you to sign in to your server/);
    assert.match(html, /Connect Gmail in browser/);
    assert.match(html, /Check the setup/);
  } finally { g.window = before; }
  const inBrowser = renderToStaticMarkup(createElement(GmailConnectStep, { setup: setup({ configured: true, addressMatches: true }), onReplace: () => {} }));
  assert.ok(!/asks you to sign in to your server/.test(inBrowser), "a browser already signed in is not warned");
});

test("set up at another address, the connect step says where connecting works", () => {
  const html = renderToStaticMarkup(createElement(GmailConnectStep, { setup: setup({ configured: true, addressMatches: false, publicAppUrl: "https://inbox.example.com" }), onReplace: () => {} }));
  assert.match(html, /set up for https:\/\/inbox\.example\.com/);
});

const account = (over: Record<string, unknown>) => ({ id: "g1", email: "me@example.invalid", status: "reconnect_required", error: "reconnect_required", ...over });
const problem = (a: Record<string, unknown>, projectNumber: string | null = "123456789012") =>
  renderToStaticMarkup(createElement(GmailProblem, { account: a as never, projectNumber, onRetry: () => {}, onSetup: () => {}, busy: false }));

test("an account that stopped working says why, with one action that fixes it", () => {
  const testing = problem(account({ reason: "testing_expiry" }));
  assert.match(testing, /in Testing/);
  assert.match(testing, /Reconnect in browser/);
  assert.match(testing, /href="\/api\/accounts\/gmail\/connect"/);

  const api = problem(account({ status: "error", error: "gmail_api_disabled", reason: "gmail_api_disabled" }));
  assert.match(api, /Enable the Gmail API/);
  assert.match(api, /overview\?project=123456789012/);
  assert.match(api, /Retry/);
  assert.ok(!/Reconnect/.test(api), "nothing to reconnect when the API is off");

  const client = problem(account({ status: "error", error: "google_client_rejected", reason: "client_rejected" }));
  assert.match(client, /Check the Gmail setup/);

  const scope = problem(account({ reason: "insufficient_scope" }));
  assert.match(scope, /tick the Gmail box/);

  const old = problem(account({}));
  assert.match(old, /Reconnect in browser/, "an account from before reasons were kept still offers the reconnect");

  const transient = problem(account({ status: "error", error: "provider_unavailable" }));
  assert.match(transient, /tried again on its own/);
  assert.match(transient, /Retry now/);

  assert.equal(problem(account({ status: "connected", error: undefined })), "", "a working account shows nothing");
  const limited = problem(account({ status: "connected", error: undefined, accessUntil: Date.now() + 3 * 86_400_000 }));
  assert.match(limited, /Google ends this access on/);
});

test("Gmail with an app password is a marked card this build cannot connect yet (WS4 wires it)", () => {
  const card = PROVIDERS.find((p) => p.id === "gmail-app-password")!;
  assert.equal(card.connect, "none");
  assert.equal(availability(card, { cloudflareConnected: true, gmail: "configured" }), "unavailable");
  assert.match(card.summary, /2-Step Verification/);
  assert.match(card.summary, /not for work or school/);
  assert.match(card.tradeoff!, /labels appear as folders/);
  assert.equal(card.helpUrl, "https://support.google.com/accounts/answer/185833");
});
