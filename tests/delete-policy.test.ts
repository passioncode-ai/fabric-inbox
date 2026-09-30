import test from "node:test";
import assert from "node:assert/strict";
import {
  DELETE_COPY,
  TRASH_EMPTY_STATE,
  deleteModeFor,
  permanentDeleteDescription,
  restoreFolderFor,
} from "../app/lib/delete-policy";

test("Delete outside Trash moves to Trash; only inside Trash is it permanent", () => {
  for (const folder of ["inbox", "sent", "draft", "archive", "spam", "custom-1", undefined, null])
    assert.equal(deleteModeFor(folder), "trash", String(folder));
  assert.equal(deleteModeFor("trash"), "permanent");
});

test("Undo returns a message to the folder it was deleted from", () => {
  assert.equal(restoreFolderFor("archive"), "archive");
  assert.equal(restoreFolderFor("custom-1"), "custom-1");
  assert.equal(restoreFolderFor(undefined), "inbox");
  assert.equal(restoreFolderFor("trash"), "inbox");
});

test("the permanent path says so at every step", () => {
  assert.match(DELETE_COPY.permanent.label, /permanently/);
  assert.match(DELETE_COPY.permanent.confirmTitle, /permanently/);
  assert.match(DELETE_COPY.permanent.confirmAction, /permanently/);
  assert.match(permanentDeleteDescription("Invoice"), /“Invoice” will be deleted permanently/);
  assert.match(permanentDeleteDescription("  "), /^This message will be deleted permanently/);
  assert.match(permanentDeleteDescription(null), /can't be restored/);
  assert.doesNotMatch(DELETE_COPY.trash.label, /permanent/i);
});

test("the Trash empty state promises only what the app does: restore by moving, or delete permanently", () => {
  assert.match(TRASH_EMPTY_STATE.description, /Move one to another folder to restore it/);
  assert.match(TRASH_EMPTY_STATE.description, /delete it permanently/);
});
