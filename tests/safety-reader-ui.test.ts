// The open message's safety surface after the mail-window audit (A-2, A-10, A-17, A-18, A-23).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { englishT, createT } from "../shared/i18n";
import { fileChipWord, showsSafetyBadge } from "../app/components/inbox/safety-words";

test("A-23: sent mail and drafts show the badge only when a link fired; received mail always", () => {
  const linkFired = { signals: [{ check: "links", code: "inboxLinkPhishing", severity: "critical" }] } as never;
  const otherFired = { signals: [{ check: "hidden", code: "inboxAiOrdersVisible", severity: "major" }] } as never;
  assert.equal(showsSafetyBadge(false, null), true, "received mail with no record reads Not checked");
  assert.equal(showsSafetyBadge(true, null), false, "old sent mail with no record: no grey badge");
  assert.equal(showsSafetyBadge(true, { signals: [] }), false);
  assert.equal(showsSafetyBadge(true, otherFired), false);
  assert.equal(showsSafetyBadge(true, linkFired), true);
});

test("A-10: a file's chip says its word in both languages, the same in the reader and the composer", () => {
  assert.deepEqual((["red", "amber", "grey", "green"] as const).map((c) => fileChipWord(c, englishT)), ["Dangerous", "Suspicious", "Not checked", "Checked"]);
  const ru = createT("ru");
  assert.deepEqual((["red", "amber", "grey", "green"] as const).map((c) => fileChipWord(c, ru)).every((w) => /[а-яё]/i.test(w)), true);
  const reader = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(reader, /fileChipWord\(colour, t\)/, "the reader's attachment button carries the word");
  assert.match(readFileSync("app/components/inbox/Composer.tsx", "utf8"), /fileChipWord\(colour, t\)/);
});

test("A-2: the panel is drawn under the header, after From and To, never inside the subject line", () => {
  const reader = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const subject = reader.slice(reader.indexOf('<div className="fi-subject-line">'), reader.indexOf("<MessageHeader message={detail.data}"));
  assert.match(subject, /<SafetyBadge /);
  assert.doesNotMatch(subject, /<SafetyPanel /, "the subject line holds only the badge");
  const header = reader.slice(reader.indexOf("<MessageHeader message={detail.data}"), reader.indexOf("</header>", reader.indexOf("<MessageHeader message={detail.data}")));
  assert.match(header, /<SafetyPanel /, "the panel follows the people, the header's full width");
  const css = readFileSync("app/styles/workbench.css", "utf8");
  const panel = css.slice(css.indexOf(".fi-okolos-panel {"), css.indexOf("}", css.indexOf(".fi-okolos-panel {")));
  assert.doesNotMatch(panel, /max-width/, "no narrow column");
});

test("A-17, A-18: fired and clean lines carry their own mark; the release note is set apart", () => {
  const badge = readFileSync("app/components/inbox/SafetyBadge.tsx", "utf8");
  assert.match(badge, /className="is-fired"><Fired \/>/);
  assert.match(badge, /className="is-clean"><CheckIcon /);
  assert.match(badge, /<span className="fi-okolos-released"><span aria-hidden="true">·<\/span> \{released\}<\/span>/);
});
