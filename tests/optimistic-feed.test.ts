import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { applyFeedChange, showFeedChange } from "../app/lib/mail-refresh";
import { expectedChange } from "../app/components/inbox/MessageActions";

/** P3-12: actions show at once in the unified inbox and go back when the server refuses. */
const row = (id: string, read = false) => ({ id, read, starred: false });
const pages = () => ({ pages: [{ messages: [row("a"), row("b")], hasMore: true }, { messages: [row("c")], hasMore: false }], pageParams: ["", "x"] });

test("a change applies to the row in whichever page holds it (P3-12)", () => {
  const removed = applyFeedChange(pages(), { id: "c", removed: true })!;
  assert.deepEqual(removed.pages.map((p) => p.messages.map((m) => m.id)), [["a", "b"], []]);
  const read = applyFeedChange(pages(), { id: "b", patch: { read: true } })!;
  assert.deepEqual(read.pages[0].messages.map((m) => m.read), [false, true]);
  const single = applyFeedChange({ messages: [row("a")], hasMore: false }, { id: "a", removed: true })!;
  assert.deepEqual(single.messages, [], "the first page read after Load older is one page, not pages");
});

test("archive, trash and read show at once in every cached list and roll back exactly on failure (P3-12)", async () => {
  const client = new QueryClient();
  const listKey = ["unified-inbox", "", "", "", "", "inbox", "", false];
  const headKey = ["unified-inbox-head", "", "", "", "inbox", "", false];
  client.setQueryData(listKey, pages());
  client.setQueryData(headKey, { messages: [row("a"), row("b")], hasMore: true });
  client.setQueryData(["emails", "box"], { untouched: true });
  const undo = await showFeedChange(client, { id: "a", removed: true });
  assert.deepEqual((client.getQueryData(listKey) as ReturnType<typeof pages>).pages[0].messages.map((m) => m.id), ["b"]);
  assert.deepEqual((client.getQueryData(headKey) as { messages: { id: string }[] }).messages.map((m) => m.id), ["b"]);
  undo();
  assert.deepEqual(client.getQueryData(listKey), pages(), "the row is back where it was");
  assert.deepEqual((client.getQueryData(headKey) as { messages: { id: string }[] }).messages.map((m) => m.id), ["a", "b"]);
  assert.deepEqual(client.getQueryData(["emails", "box"]), { untouched: true }, "other caches are not touched");
});

test("each message action names what the list may show before the server answers (P3-12)", () => {
  const m = { id: "row", accountId: "gmail:a", provider: "gmail" as const, providerMessageId: "m", starred: false };
  assert.deepEqual(expectedChange(m, { starred: true }), { id: "row", starred: true });
  assert.deepEqual(expectedChange(m, { trashed: true }), { id: "row", removed: true });
  assert.deepEqual(expectedChange(m, { spam: true }), { id: "row", removed: true });
  const ui = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(ui, /\{ id: selected\.id, removed: true \}/, "archive leaves the list at once");
  assert.match(ui, /\{ id: selected\.id, patch: \{ read: !detail\.data\?\.read \} \}/, "mark read or unread shows at once");
  assert.match(ui, /showChange\(\{ id: selected\.id, patch: \{ read: true \} \}\)/, "opening marks the row read at once");
  assert.match(ui, /catch \(e\) \{\n\s+undo\?\.\(\);/, "a refused action is rolled back");
});

test("a change in one mailbox's own view refreshes the unified inbox too (P3-12)", () => {
  const code = readFileSync("app/queries/emails.ts", "utf8");
  // The shared invalidation (send, delete, move, draft, reply, forward), update and mark-thread-read.
  assert.equal((code.match(/invalidateQueries\(\{ queryKey: UNIFIED_INBOX \}\)/g) ?? []).length, 3);
  assert.match(code, /const UNIFIED_INBOX = \["unified-inbox"\]/);
});
