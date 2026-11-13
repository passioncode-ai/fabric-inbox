// B-228: every surface that sends says the same thing for the same cause. The composer told the
// causes apart; the older mailbox view and the classic compose showed the raw error ("signal is
// aborted without reason", "Failed to fetch", "Request failed: 502") or "Failed to send email.".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendFailure, sendFailureNotice } from "../app/components/inbox/send-state";
import { ApiError } from "../app/services/api";
import { createT } from "../shared/i18n";

const en = createT("en");
const ru = createT("ru");
const notice = (error: unknown, locked = false) => sendFailureNotice(sendFailure(error, locked), en);

test("a draft changed elsewhere just before sending", () => {
  const error = new ApiError(409, { error: "Draft changed", code: "DRAFT_CONFLICT" });
  assert.equal(sendFailure(error, false).kind, "conflict");
  assert.match(notice(error), /changed elsewhere just before sending, so it was not sent/);
});

test("the server's daily sending limit", () => {
  const error = new ApiError(429, { error: "send_rate_limited" });
  assert.equal(sendFailure(error, false).kind, "rate_limited");
  assert.match(notice(error), /daily sending limit\. Nothing went out/);
});

test("the provider refused the attempt", () => {
  const error = new ApiError(502, { status: "failed", error: "provider refused" });
  assert.equal(sendFailure(error, false).kind, "failed");
  assert.match(notice(error), /provider did not accept this attempt/);
});

test("a request the server refused names its reason", () => {
  const error = new ApiError(400, { error: "Invalid send request or sender", code: "INVALID_REQUEST" });
  assert.deepEqual(sendFailure(error, false), { kind: "editable", reason: "Invalid send request or sender" });
  assert.equal(notice(error), "Send refused: Invalid send request or sender. Correct the message or reconnect.");
});

test("a refusal after an uncertain attempt does not unlock it", () => {
  assert.equal(sendFailure(new ApiError(403, { error: "refused" }), true).kind, "uncertain");
});

test("no answer, a lost connection or a server failure leave the outcome unknown", () => {
  const timeout = Object.assign(new Error("signal is aborted without reason"), { name: "AbortError" });
  const offline = new TypeError("Failed to fetch");
  const crashed = new ApiError(502, {});
  const pending = new Error("Send is still pending or uncertain. Check the outbox before repeating it.");
  for (const error of [timeout, offline, crashed, pending, "not an error"]) {
    assert.equal(sendFailure(error, false).kind, "uncertain", String(error));
    assert.match(notice(error), /Acceptance is not confirmed\. Retry the same attempt/);
  }
});

test("every notice reads in Russian", () => {
  const errors = [
    new ApiError(409, { code: "DRAFT_CONFLICT" }),
    new ApiError(429, { error: "send_rate_limited" }),
    new ApiError(502, { status: "failed" }),
    new ApiError(400, { error: "Invalid send request or sender" }),
    new TypeError("Failed to fetch"),
  ];
  for (const error of errors) {
    const text = sendFailureNotice(sendFailure(error, false), ru);
    assert.match(text, /[а-яё]/i, text);
    assert.doesNotMatch(text, /Acceptance|Send refused|provider|Correct the/, text);
  }
});

test("every surface that sends uses the one wording", () => {
  for (const file of ["app/components/EmailPanel.tsx", "app/hooks/useComposeForm.ts", "app/components/inbox/Composer.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /sendFailure\(/, file);
    assert.match(source, /sendFailureNotice\(/, file);
    assert.doesNotMatch(source, /Failed to send email\./, file);
  }
});
