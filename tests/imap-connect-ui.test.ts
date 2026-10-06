import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVIDERS, availability } from "../app/components/settings/sections/providers";
import { imapErrorText, IMAP_ERROR_CODES } from "../app/lib/imap-errors";
import { imapSetupState } from "../app/lib/account-status";
import { PRESETS, presetFor } from "../shared/mail/imap-presets";

/** Settings → Accounts for IMAP accounts (SCN-060…SCN-063): the card, the errors and the form. */

test("the IMAP card connects where the server holds a credential key, and says so where it does not", () => {
  const card = PROVIDERS.find((p) => p.id === "imap")!;
  assert.equal(card.connect, "app-password");
  assert.equal(card.preset, undefined, "the card offers the choice of provider");
  const base = { cloudflareConnected: true, gmail: "not-configured" as const };
  assert.equal(availability(card, { ...base, imap: "configured" }), "available");
  assert.equal(availability(card, { ...base, imap: "not-configured" }), "not-configured");
  assert.equal(availability(card, { ...base, imap: "loading" }), "checking");
  assert.equal(availability(card, { ...base, imap: "unavailable" }), "unknown", "a failed load never claims the server cannot");
  assert.equal(imapSetupState({ providers: [{ id: "imap", status: "configured" }] }, null), "configured");
  assert.equal(imapSetupState({ providers: [{ id: "imap", status: "not_configured" }] }, null), "not-configured");
  assert.equal(imapSetupState({}, null), "not-configured", "a server before 0.11 has no IMAP");
  assert.equal(imapSetupState(undefined, new Error("x")), "unavailable");
  assert.equal(availability(PROVIDERS.find((p) => p.id === "microsoft")!, { ...base, imap: "configured" }), "unavailable", "Outlook is not in this build");
});

test("every code the server answers a connect with is a sentence naming who refused and what to do", () => {
  const routes = readFileSync("workers/routes/accounts.ts", "utf8");
  for (const code of ["auth_failed", "app_password_required", "imap_disabled", "auth_or_imap_disabled", "web_login_required", "smtp_auth_failed",
    "tls_failed", "host_unreachable", "smtp_unreachable", "smtp_tls_failed", "invalid_server", "imap_tls_required", "port_blocked", "already_connected"]) {
    assert.ok(routes.includes(`${code}:`), `${code} is a public code of the route`);
    assert.ok((IMAP_ERROR_CODES as readonly string[]).includes(code), code);
    const text = imapErrorText(code, { provider: "iCloud Mail", imapHost: "imap.mail.me.com", smtpHost: "smtp.mail.me.com" })!;
    assert.ok(text && text.endsWith("."), code);
    assert.doesNotMatch(text, /_/, `${code} reads as words, not a code`);
  }
  assert.match(imapErrorText("app_password_required", { provider: "Yahoo Mail" })!, /^Yahoo Mail needs an app password/);
  assert.match(imapErrorText("smtp_auth_failed", { provider: "X", imapHost: "imap.x.org", smtpHost: "smtp.x.org" })!, /smtp\.x\.org refused it/);
  assert.equal(imapErrorText("something_else", { provider: "X" }), null, "an unknown code falls back to the server's own text");
});

test("an address suggests its provider's card; every card links its own help page", () => {
  assert.equal(presetFor("Ann@iCloud.com")?.id, "icloud");
  assert.equal(presetFor("ann@gmx.de")?.id, "gmx-net");
  assert.equal(presetFor("ann@example.org"), undefined);
  for (const p of PRESETS) assert.ok(p.steps.every((s) => s.endsWith(".")), p.id);
});

test("the form never shows the password again, nor keeps it after a connect", () => {
  const ui = readFileSync("app/components/settings/sections/ImapAccount.tsx", "utf8");
  assert.equal((ui.match(/type="password"/g) ?? []).length, 2, "the connect form and the new-password form");
  assert.match(ui, /setPassword\(""\)/);
  assert.match(ui, /autoComplete="off"/);
  assert.match(ui, /"\/api\/accounts\/imap"/);
  assert.match(ui, /\/password", \{ password \}, "PUT"\)/);
});
