// B-88: the mailbox view's compose dropped a draft's files. Save used POST /drafts (a new id per save,
// files left behind in R2), Send went out without them, and a forward never carried the original's
// files. Read from source: the hook is not rendered in node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hook = readFileSync("app/hooks/useComposeForm.ts", "utf8");
const queries = readFileSync("app/queries/emails.ts", "utf8");

test("a draft is saved in place under one id for the whole compose (its files stay)", () => {
  assert.match(hook, /const draftKey = useRef<string>\(composeOptions\.draftEmail\?\.id \?\? crypto\.randomUUID\(\)\);/);
  assert.match(hook, /draft_id: draftKey\.current,/);
  assert.match(queries, /api\.putDraft\(mailboxId, draft_id, rest\)/, "PUT /drafts/:id, not POST /drafts");
  assert.doesNotMatch(queries, /api\.saveDraft\(/);
});

test("a saved draft is sent as it is, with its files, through POST /drafts/:id/send", () => {
  const send = hook.slice(hook.indexOf("const handleSend"), hook.indexOf("return { to, setTo"));
  assert.match(send, /if \(draftSaved\.current\) \{\s*await saveInPlace\(\);\s*await api\.sendDraft\(mailboxId, draftKey\.current, sendKey\.current\);/);
  assert.doesNotMatch(send, /deleteEmailMutation/, "the server removes the sent draft, files included");
});

test("a forward carries the original's files, read once", () => {
  assert.match(hook, /api\.getAttachment\(mailboxId, original\.id, a\.id\)/);
  assert.match(hook, /forwardMutation\.mutateAsync\(\{ mailboxId, emailId: originalId, email: \{ \.\.\.emailData, attachments: await originalFiles\(\) \} \}\)/);
  assert.match(hook, /first && composeOptions\.mode === "forward" \? \{ attachments: await originalFiles\(\) \}/);
});
