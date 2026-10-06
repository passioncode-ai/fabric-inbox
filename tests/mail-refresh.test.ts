import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { refreshScope, refreshSummary } from "../app/lib/mail-refresh";

test("Refresh asks Gmail only for the Gmail accounts in view (P1-5)", () => {
  assert.equal(refreshScope({ accountId: "", domain: "" }), undefined, "every Gmail account");
  assert.deepEqual(refreshScope({ accountId: "gmail:a", domain: "" }), ["gmail:a"]);
  assert.equal(refreshScope({ accountId: "cloudflare:me@example.com", domain: "" }), null, "a Cloudflare address arrives by push");
  assert.equal(refreshScope({ accountId: "", domain: "example.com" }), null, "a domain is its Cloudflare addresses");
});

test("Refresh says Updated just now, or which account was not read and why (P1-5)", () => {
  assert.deepEqual(refreshSummary([]), { ok: true, text: "Updated just now." });
  assert.deepEqual(refreshSummary([{ accountId: "gmail:a", email: "a@example.com", result: "synced" }]), { ok: true, text: "Updated just now." });
  const importing = refreshSummary([{ accountId: "gmail:a", email: "a@example.com", result: "synced", importing: 40 }]);
  assert.equal(importing.ok, true);
  assert.match(importing.text, /a@example\.com is still importing older mail \(40%\)/);
  const mixed = refreshSummary([
    { accountId: "gmail:a", email: "a@example.com", result: "synced" },
    { accountId: "gmail:b", email: "b@example.com", result: "backoff", retryAt: Date.UTC(2026, 9, 6, 14, 5) },
    { accountId: "gmail:c", email: "c@example.com", result: "reconnect" },
    { accountId: "gmail:d", email: "d@example.com", result: "failed", error: "rate_limited" },
    { accountId: "gmail:e", email: "e@example.com", result: "not_reached" },
  ]);
  assert.equal(mixed.ok, false);
  assert.match(mixed.text, /^Updated, except:/);
  assert.match(mixed.text, /b@example\.com: Gmail failed a moment ago; it tries again at /);
  assert.match(mixed.text, /c@example\.com needs to be connected again/);
  assert.match(mixed.text, /d@example\.com: Gmail asked us to slow down/);
  assert.match(mixed.text, /e@example\.com was not checked in time/);
  assert.doesNotMatch(mixed.text, /a@example\.com/, "an account that synced is not mentioned");
});

test("the inbox's refresh button reads Gmail, not only the browser's cache (P1-5)", () => {
  const code = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(code, /fabric<RefreshResponse>\("\/api\/inbox\/refresh"/);
  assert.match(code, /aria-label="Check for new mail"[\s\S]{0,80}onClick=\{\(\) => void checkForMail\(\)\}/);
  assert.doesNotMatch(code, /Refresh cached mail/);
});
