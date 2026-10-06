import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_MAILBOX_LIMIT, workspaceKnown, workspaceOwnDomains, type WorkspaceSources } from "../workers/discard/workspace";

/**
 * Discard rules apply to the whole workspace, so "someone your addresses wrote to" and "your own
 * domains" are asked of every Cloudflare mailbox and every connected account — bounded, once per
 * sender per batch, and "known" whenever the answer cannot be read.
 */
const quiet = (t: test.TestContext) => { const warn = console.warn; console.warn = () => {}; t.after(() => { console.warn = warn; }); };

function sources(wrote: Record<string, string[]>, accounts: string[] = [], calls: string[] = []): WorkspaceSources {
  return {
    mailboxes: async () => { calls.push("list"); return Object.keys(wrote); },
    mailboxKnows: async (mailbox, address) => { calls.push(`${mailbox}?${address}`); return wrote[mailbox]!.includes(address); },
    accountsKnow: async (address) => { calls.push(`accounts?${address}`); return accounts.includes(address); },
  };
}

test("a sender any mailbox or account wrote to is known; one nobody wrote to is not", async () => {
  const known = workspaceKnown(sources({ "a@shop.example": [], "b@shop.example": ["x@out.example"] }, ["y@out.example"]));
  assert.equal(await known("X <x@out.example>"), true, "written to from another mailbox");
  assert.equal(await known("y@out.example"), true, "written to from a Gmail, IMAP or Outlook account");
  assert.equal(await known("z@out.example"), false);
  assert.equal(await known("not an address"), false);
});

test("one batch asks once per sender, and lists the mailboxes once", async () => {
  const calls: string[] = [];
  const known = workspaceKnown(sources({ "a@shop.example": [] }, [], calls));
  await Promise.all([known("z@out.example"), known("Z <z@out.example>"), known("w@out.example")]);
  assert.deepEqual(calls.filter((c) => c === "list"), ["list"]);
  assert.equal(calls.filter((c) => c.endsWith("?z@out.example")).length, 2, "the accounts and the one mailbox, once");
});

test("anything that cannot be read answers known: a failing mailbox, failing accounts, too many mailboxes, the deadline", async (t) => {
  quiet(t);
  const failing: WorkspaceSources = { mailboxes: async () => ["a@shop.example"], mailboxKnows: async () => { throw new Error("down"); } };
  assert.equal(await workspaceKnown(failing)("z@out.example"), true);
  const accounts: WorkspaceSources = { mailboxes: async () => [], mailboxKnows: async () => false, accountsKnow: async () => { throw new Error("down"); } };
  assert.equal(await workspaceKnown(accounts)("z@out.example"), true);
  const many: WorkspaceSources = { mailboxes: async () => Array.from({ length: KNOWN_MAILBOX_LIMIT + 1 }, (_, i) => `m${i}@shop.example`), mailboxKnows: async () => false };
  assert.equal(await workspaceKnown(many)("z@out.example"), true);
  const slow: WorkspaceSources = { mailboxes: async () => ["a@shop.example"], mailboxKnows: () => new Promise(() => {}) };
  assert.equal(await workspaceKnown(slow, { deadlineMs: 20 })("z@out.example"), true);
});

test("the workspace's own domains: the served ones and each account's own, never a shared personal provider", () => {
  assert.deepEqual(workspaceOwnDomains(["shop.example"], ["Me <me@corp.example>", "me@gmail.com", "me@Outlook.com", "x@icloud.com", "bad"]).sort(),
    ["corp.example", "shop.example"]);
});
