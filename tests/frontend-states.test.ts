import test from "node:test";
import assert from "node:assert/strict";
import { describeLoadError } from "../app/lib/load-error";
import { mailboxesToCreate, provisioningFailures } from "../app/lib/mailbox-provisioning";
import { gmailSetupState } from "../app/lib/account-status";
import { isRowActivation } from "../app/lib/row-keys";

const withStatus = (status: number, message = "Request failed") =>
  Object.assign(new Error(message), { status });

test("a failed load is described by its cause, and a 404 is not worth retrying", () => {
  assert.deepEqual(describeLoadError(withStatus(404)), { description: "It may have been deleted or moved.", retryable: false });
  assert.equal(describeLoadError(withStatus(500)).description, "The server had a problem. Try again in a moment.");
  assert.equal(describeLoadError(withStatus(503)).retryable, true);
  assert.match(describeLoadError(withStatus(401)).description, /access/);
  assert.equal(describeLoadError(new TypeError("Failed to fetch")).description, "Check your connection and try again.");
  const timeout = new Error("aborted"); timeout.name = "AbortError";
  assert.equal(describeLoadError(timeout).description, "The request timed out. Try again.");
  assert.equal(describeLoadError(withStatus(422, "Bad folder")).description, "Bad folder");
  assert.equal(describeLoadError(undefined).description, "Something went wrong. Try again.");
});

test("only configured addresses that are missing are created, once each", () => {
  assert.deepEqual(
    mailboxesToCreate(["a@x.invalid", "B@x.invalid", "c@x.invalid", "C@X.invalid"], [{ email: "b@x.invalid" }]),
    ["a@x.invalid", "c@x.invalid"],
  );
  assert.deepEqual(mailboxesToCreate([], [{ email: "a@x.invalid" }]), []);
});

test("every address that could not be created is reported with its reason", () => {
  const failures = provisioningFailures(
    ["a@x.invalid", "b@x.invalid", "c@x.invalid"],
    [
      { status: "fulfilled", value: {} },
      { status: "rejected", reason: withStatus(409, "Mailbox already exists") },
      { status: "rejected", reason: "opaque" },
    ],
  );
  assert.deepEqual(failures, [
    { address: "b@x.invalid", reason: "Mailbox already exists" },
    { address: "c@x.invalid", reason: "Unknown error" },
  ]);
});

test("Gmail is only called 'not configured' once the account list has said so", () => {
  assert.equal(gmailSetupState(undefined, null), "loading");
  assert.equal(gmailSetupState(undefined, new Error("down")), "unavailable");
  assert.equal(gmailSetupState({ configuration: "configured" }, null), "configured");
  assert.equal(gmailSetupState({ configuration: "missing" }, new Error("stale refetch")), "not-configured");
});

test("Enter/Space open a row only when pressed on the row, not on its nested buttons", () => {
  const row = {}; const star = {};
  assert.equal(isRowActivation({ key: "Enter", target: row, currentTarget: row }), true);
  assert.equal(isRowActivation({ key: " ", target: row, currentTarget: row }), true);
  assert.equal(isRowActivation({ key: "Enter", target: star, currentTarget: row }), false);
  assert.equal(isRowActivation({ key: " ", target: star, currentTarget: row }), false);
  assert.equal(isRowActivation({ key: "a", target: row, currentTarget: row }), false);
});
