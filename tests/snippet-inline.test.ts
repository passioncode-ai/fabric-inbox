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
