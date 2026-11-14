import { test } from "node:test";
import assert from "node:assert/strict";
import { createT } from "../shared/i18n";
import { TRIAGE_GROUPS } from "../shared/mail/triage";

/**
 * A-12: one English word with two meanings gets two dictionary entries. The mail list's "Security"
 * group (sign-in and security mail) is «Безопасность»; the IMAP form's "Security" setting (TLS or
 * STARTTLS for sending) is «Шифрование», under its context key.
 */
test("the Security group reads «Безопасность», the connection's Security setting «Шифрование» (A-12)", () => {
  const ru = createT("ru");
  const en = createT("en");
  const security = TRIAGE_GROUPS.find((g) => g.id === "security")!;
  assert.equal(ru.text(security.label), "Безопасность");
  assert.equal(en.text(security.label), "Security");
  assert.equal(ru("[connection] Security"), "Шифрование");
  assert.equal(en("[connection] Security"), "Security");
});
