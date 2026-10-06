import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_MAX, LOCAL_PART_MAX, LOCAL_PART_RE, checkLocalPart, parseLocalParts, roleNote, suggestDisplayName,
} from "../shared/address-name";

// SCN-061 / SCN-064: the part before @ is checked the same way in the dialog, on the server and by
// the agent protocol, and every refusal says what to type instead.

test("a valid part before @ is kept lower case and passes", () => {
  for (const name of ["support", "alex.morgan", "billing-eu", "team_42", "a", "x+tag", "9lives"]) {
    const c = checkLocalPart(name);
    assert.equal(c.valid, true, `${name}: ${c.problem}`);
    assert.equal(c.problem, null);
    assert.match(c.value, LOCAL_PART_RE);
  }
  assert.equal(checkLocalPart("  Support ").value, "support", "trimmed and lower-cased, as the server stores it");
  assert.equal(checkLocalPart("a".repeat(LOCAL_PART_MAX)).valid, true, "64 characters is the limit, inclusive");
});

test("every invalid part before @ says why, in words, and the regex agrees with the check", () => {
  const cases: [string, RegExp][] = [
    ["", /Type the part before @/],
    ["sup port", /Spaces are not allowed/],
    ["sup!port", /“!” is not allowed/],
    ["jürgen", /“ü” is not allowed/],
    ["a!b#c", /“!” and “#” are not allowed/],
    ["support@acme.test", /only the part before @/],
    [".support", /start and end with a letter or digit/],
    ["support-", /start and end with a letter or digit/],
    ["first..last", /Two dots in a row/],
    ["a".repeat(LOCAL_PART_MAX + 6), /70 characters; at most 64/],
  ];
  for (const [input, message] of cases) {
    const c = checkLocalPart(input);
    assert.equal(c.valid, false, input);
    assert.match(c.problem ?? "", message, input);
    assert.ok(!LOCAL_PART_RE.test(c.value) || c.value === "" || input.includes(".."), `the pattern refuses ${input} too`);
  }
  assert.equal(LOCAL_PART_RE.test("first..last"), false, "the server's pattern refuses two dots as well");
});

test("role names are allowed, with who writes to them", () => {
  for (const name of ["postmaster", "abuse", "hostmaster", "webmaster", "security", "mailer-daemon", "no-reply", "noreply"]) {
    const c = checkLocalPart(name);
    assert.equal(c.valid, true, name);
    assert.ok(c.note && c.note.length > 20, `${name} has a note`);
    assert.equal(roleNote(name), c.note);
  }
  assert.equal(checkLocalPart("support").note, null);
});

test("a display name is suggested from the part before @", () => {
  assert.equal(suggestDisplayName("support"), "Support");
  assert.equal(suggestDisplayName("alex.morgan"), "Alex Morgan");
  assert.equal(suggestDisplayName("billing-eu"), "Billing Eu");
  assert.equal(suggestDisplayName("team_42"), "Team 42");
  assert.equal(suggestDisplayName("x+tag"), "X Tag");
  assert.equal(suggestDisplayName(""), "");
});

test("several names are read from lines, commas or spaces; duplicates, other domains and the 51st are set aside", () => {
  const parsed = parseLocalParts("support, Sales\nhello  hello@acme.test\nbad name!\nops@other.test\nSUPPORT", "acme.test");
  assert.deepEqual(parsed.entries.map((e) => [e.input, e.check.value, e.check.valid]), [
    ["support", "support", true], ["Sales", "sales", true], ["hello", "hello", true], ["bad", "bad", true], ["name!", "name!", false],
  ]);
  assert.deepEqual(parsed.skipped.map((s) => s.input), ["hello@acme.test", "ops@other.test", "SUPPORT"]);
  assert.match(parsed.skipped[0]!.reason, /listed already/);
  assert.match(parsed.skipped[1]!.reason, /other\.test, not acme\.test/);
  const many = parseLocalParts(Array.from({ length: BATCH_MAX + 2 }, (_, i) => `n${i}`).join(","), "acme.test");
  assert.equal(many.entries.length, BATCH_MAX);
  assert.equal(many.skipped.length, 2);
  assert.match(many.skipped[0]!.reason, /At most 50/);
  assert.deepEqual(parseLocalParts("  \n , ", "acme.test"), { entries: [], skipped: [] });
});
