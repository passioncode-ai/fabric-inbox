// The legacy reply quoted the original by stripping its tags and escaping the rest: entities showed as
// "&amp;nbsp;", CSS from <style> leaked in, and every line ran together (bug hunt 2026-10-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../shared/mail/text";
import { readFileSync } from "node:fs";

test("the quote reads as the original's text: entities decoded, lines kept, no CSS", () => {
  const text = htmlToText("<style>.x{color:red}</style><p>Hi&nbsp;Ann &amp; Bob,</p><p>It&#39;s ready.</p>");
  assert.doesNotMatch(text, /&nbsp;|&amp;|&#39;|color:red/);
  assert.match(text, /Hi.Ann & Bob,/);
  assert.match(text, /\n/);
});

test("buildQuotedReplyBlock converts with htmlToText before escaping", () => {
  const src = readFileSync("app/lib/utils.ts", "utf8");
  assert.match(src, /escapeHtml\(htmlToText\(body\)\)/);
  assert.doesNotMatch(src, /escapeHtml\(stripHtml\(body\)\)/);
});

test("marking a message read refreshes the search results too (bug hunt 2026-10-12)", () => {
  const src = readFileSync("app/queries/emails.ts", "utf8");
  assert.match(src, /qc\.invalidateQueries\(\{ queryKey: \["search", mailboxId\] \}\);/);
});
