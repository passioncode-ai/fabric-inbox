import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_DAILY_SENDS, MAX_SEND_LIMIT_DAY, REMOTE_SEND_LIMITS, sendLimitPerDay } from "../shared/mail/send-limits";
import { CAMPAIGN_DEFAULTS } from "../shared/mail/campaign";
import { DEFAULT_DAILY_SENDS, MAX_DAILY_SENDS } from "../workers/mcp/keys";

// B-262 (operator, 2026-11-13): no limits but 1000 a day by default, raised on request.
test("an account sends 1000 a day by default; SEND_LIMIT_DAY raises it, a nonsense value keeps the default", () => {
  assert.equal(REMOTE_SEND_LIMITS.day, 1000);
  assert.equal("hour" in REMOTE_SEND_LIMITS, false, "no hourly cap");
  assert.equal(sendLimitPerDay(undefined), 1000);
  assert.equal(sendLimitPerDay({}), 1000);
  assert.equal(sendLimitPerDay({ SEND_LIMIT_DAY: "5000" }), 5000);
  for (const bad of ["", "0", "-5", "1.5", "lots"]) assert.equal(sendLimitPerDay({ SEND_LIMIT_DAY: bad }), 1000, bad);
  assert.equal(sendLimitPerDay({ SEND_LIMIT_DAY: "999999999" }), MAX_SEND_LIMIT_DAY);
});

test("a campaign and an agent key default to 1000 a day and may be set higher", () => {
  assert.equal(CAMPAIGN_DEFAULTS.dailyCap, 1000);
  assert.equal(CAMPAIGN_DEFAULTS.maxDailyCap, 100_000);
  assert.equal(DEFAULT_DAILY_SENDS, KEY_DAILY_SENDS.default);
  assert.equal(DEFAULT_DAILY_SENDS, 1000);
  assert.equal(MAX_DAILY_SENDS, 100_000);
});
