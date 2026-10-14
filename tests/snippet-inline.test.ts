// B-113: a list snippet read from HTML joins inline elements to the text around them, as a browser
// shows them — "Hello <b>Ann</b>." reads "Hello Ann.", not "Hello Ann ." — while block elements and
// line breaks still separate words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { textSnippet, searchText } from "../workers/lib/inbox-query";

test("inline elements join, blocks and breaks separate", () => {
  assert.equal(textSnippet("<p>Hello <b>Ann</b>. See <a href=\"https://x.invalid\">the plan</a>, <em>today</em>!</p>"), "Hello Ann. See the plan, today!");
  assert.equal(textSnippet("<div>One</div><div>Two</div>"), "One Two");
  assert.equal(textSnippet("Line one<br>Line two"), "Line one Line two");
  assert.equal(textSnippet("<section>A</section><span>B</span><strong>C</strong>"), "A BC");
  assert.equal(searchText("Price: <span>10</span> EUR."), "Price: 10 EUR.");
});

test("a style block cut by the 2,000-character read never shows as text; the stored plain text is preferred", async () => {
  const { mailboxInboxMessage } = await import("../workers/lib/inbox-query");
  const cut = "<html><head><title>Credit notice</title><style>body { margin: 0; } .main { color: red !important; } .wrap { pad";
  assert.equal(textSnippet(cut), "");
  assert.equal(textSnippet("<style>a{}</style><p>Hello</p>"), "Hello");
  const row = { id: "m1", subject: "s", sender: "a@b.invalid", sender_name: null, recipient: "c@d.invalid", date: "2026-10-14T10:00:00Z",
    read: 0, starred: 0, thread_id: null, folder_id: "inbox", raw_headers: null, message_id: null, spam_reason: null, discard_reason: null,
    snippet: cut, timestamp: 1, search_body: "" };
  assert.equal(mailboxInboxMessage("cloudflare:box@x.invalid", { ...row, snippet_text: "Your balance is low." } as never).snippet, "Your balance is low.");
  assert.equal(mailboxInboxMessage("cloudflare:box@x.invalid", { ...row, snippet_text: null } as never).snippet, "");
});
