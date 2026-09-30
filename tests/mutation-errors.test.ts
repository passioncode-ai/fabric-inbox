import test from "node:test";
import assert from "node:assert/strict";
import {
  describeMutationError,
  emailMoveErrorMessage,
  emailUpdateErrorMessage,
  errorDetail,
} from "../app/lib/mutation-errors";

class FakeApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ApiError"; }
}

test("a mutation without meta.errorMessage stays silent (it reports its own errors)", () => {
  assert.equal(describeMutationError(undefined, {}, new Error("x")), null);
  assert.equal(describeMutationError({}, {}, new Error("x")), null);
  assert.equal(describeMutationError({ errorMessage: "" }, {}, new Error("x")), null);
});

test("a string errorMessage becomes the title and the server's reason the description", () => {
  assert.deepEqual(
    describeMutationError({ errorMessage: "Couldn't create the folder." }, {}, new FakeApiError(409, "Folder exists")),
    { title: "Couldn't create the folder.", description: "Folder exists" },
  );
  assert.deepEqual(describeMutationError({ errorMessage: "T" }, {}, "not an error"), { title: "T" });
});

test("a function errorMessage is computed from the variables, and a throwing one falls silent", () => {
  const notice = describeMutationError({ errorMessage: emailMoveErrorMessage }, { folderId: "trash" }, new Error("boom"));
  assert.deepEqual(notice, { title: "Couldn't move the message to trash.", description: "boom" });
  assert.equal(describeMutationError({ errorMessage: () => { throw new Error("bad"); } }, {}, new Error("x")), null);
});

test("timeouts and network failures read as such, not as their raw messages", () => {
  const abort = new Error("The operation was aborted."); abort.name = "AbortError";
  assert.equal(errorDetail(abort), "The request timed out. Try again.");
  assert.equal(errorDetail(new TypeError("Failed to fetch")), "Check your connection and try again.");
  assert.equal(errorDetail(new Error("   ")), undefined);
});

test("the one email update hook names the action that failed", () => {
  assert.equal(emailUpdateErrorMessage({ data: { starred: true } }), "Couldn't star the message.");
  assert.equal(emailUpdateErrorMessage({ data: { starred: false } }), "Couldn't unstar the message.");
  assert.equal(emailUpdateErrorMessage({ data: { read: true } }), "Couldn't mark the message as read.");
  assert.equal(emailUpdateErrorMessage({ data: { read: false } }), "Couldn't mark the message as unread.");
  assert.equal(emailUpdateErrorMessage(undefined), "Couldn't update the message.");
  assert.equal(emailMoveErrorMessage({ folderId: "archive" }), "Couldn't move the message.");
});
