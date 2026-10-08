import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVIDERS, availability } from "../app/components/settings/sections/providers";
import { imapErrorText, IMAP_ERROR_CODES } from "../app/lib/imap-errors";
import { imapDraftDirty, leaveConnectForm } from "../app/components/settings/sections/ImapAccount";
import { englishT } from "../shared/i18n";
import { imapSetupState } from "../app/lib/account-status";
import { PRESETS, presetFor } from "../shared/mail/imap-presets";

/** Settings → Accounts for IMAP accounts (SCN-052…SCN-056): the card, the errors and the form. */

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
  // Outlook connects through its own Microsoft setup, not the IMAP card's credential key alone.
  assert.equal(availability(PROVIDERS.find((p) => p.id === "microsoft")!, { ...base, imap: "configured" }), "checking", "unknown until the accounts load");
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

test("a retry refused inside a backoff reads as a sentence, not a raw code (B4-03)", () => {
  for (const code of ["sync_backoff", "rate_limited"]) {
    const text = imapErrorText(code, { provider: "iCloud Mail" })!;
    assert.ok(text && text.endsWith("."), code);
    assert.doesNotMatch(text, /_/, `${code} reads as words, not a code`);
  }
  const at = Date.parse("2026-10-07T14:30:00Z");
  assert.equal(imapErrorText("sync_backoff", { provider: "iCloud Mail", retryAt: at })!,
    `The last try failed a moment ago; the next one is tried on its own at ${englishT.time(at, { hour: "2-digit", minute: "2-digit" })}.`);
  assert.match(imapErrorText("rate_limited", { provider: "iCloud Mail", retryAt: at })!, /^iCloud Mail asked to slow down; it is tried again on its own at /);
});

test("the connect form counts what a person typed, so closing asks only then (B4-01)", () => {
  const clean = { email: "", password: "" };
  assert.equal(imapDraftDirty(clean), false, "an untouched form closes without asking");
  assert.equal(imapDraftDirty({ ...clean, email: "   " }), false, "whitespace is nothing typed");
  assert.equal(imapDraftDirty({ ...clean, email: "ann@fastmail.example" }), true);
  assert.equal(imapDraftDirty({ ...clean, password: "x" }), true, "a password alone is typed too");
  const blankServer = { imapHost: "", smtpHost: "", username: "" };
  assert.equal(imapDraftDirty({ ...clean, server: blankServer }), false);
  assert.equal(imapDraftDirty({ ...clean, server: { ...blankServer, imapHost: "imap.example.com" } }), true);
  assert.equal(imapDraftDirty({ ...clean, server: { ...blankServer, smtpHost: "smtp.example.com" } }), true);
  assert.equal(imapDraftDirty({ ...clean, server: { ...blankServer, username: "ann" } }), true);
});

test("Esc, Close or Back with something typed asks first; an untouched form leaves at once (B4-01)", async () => {
  const asked: { title: string; confirmLabel: string; cancelLabel?: string; danger?: boolean }[] = [];
  const answering = (ok: boolean) => async (request: (typeof asked)[number]) => { asked.push(request); return ok; };
  let left = 0;
  const leave = () => { left += 1; };

  assert.equal(await leaveConnectForm(false, answering(false), englishT, leave), true, "a clean form closes");
  assert.equal(left, 1);
  assert.equal(asked.length, 0, "and nothing is asked");

  assert.equal(await leaveConnectForm(true, answering(false), englishT, leave), false, "Keep editing stays");
  assert.equal(left, 1, "the typed address and password are kept");
  assert.deepEqual(
    { title: asked[0].title, confirm: asked[0].confirmLabel, cancel: asked[0].cancelLabel, danger: asked[0].danger },
    { title: "Discard your changes to the new account?", confirm: "Discard changes", cancel: "Keep editing", danger: true });

  assert.equal(await leaveConnectForm(true, answering(true), englishT, leave), true, "Discard changes leaves");
  assert.equal(left, 2);

  // Every way out goes through it: the dialog's Esc/Close and the form's Back.
  const accounts = readFileSync("app/components/settings/sections/AccountsSection.tsx", "utf8");
  assert.match(accounts, /const closeGuarded = \(\) => void leaveConnectForm\(imapDirty\.current, confirm, t, onClose\);/);
  assert.match(accounts, /<Dialog open=\{open\} [^\n]*onClose=\{closeGuarded\} wide>/, "the dialog's Esc and Close ask");
  assert.match(accounts, /<ConnectImap [^\n]*onDirtyChange=\{\(d\) => \{ imapDirty\.current = d; \}\}/, "the form reports what was typed");
  const form = readFileSync("app/components/settings/sections/ImapAccount.tsx", "utf8");
  assert.match(form, /onClick=\{\(\) => void leaveConnectForm\(dirty, confirm, t, onBack\)\}[^>]*>\{t\("Back"\)\}/, "Back asks too");
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
