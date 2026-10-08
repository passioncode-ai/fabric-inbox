import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TOOLS } from "../workers/mcp/tools";
import { CreateMailboxBody, DraftBody, DraftSaveBody, DraftSendBody, MailboxSettingsPatch } from "../workers/index";
import { SendEmailRequestSchema } from "../workers/lib/schemas";
import { SEND_INPUT_FIELDS } from "../workers/providers/gmail-client";
import { GmailDraftSendBody, GmailDraftUpdateBody } from "../workers/routes/accounts";
import { AgentAssignmentInput, CopyInput, CreateAddress, CreateAddresses } from "../workers/routes/agents";
import { CollectionChange, CollectionInput, DocumentsInput } from "../workers/routes/knowledge";
import { ListEdit, Report } from "../workers/spam/inputs";
import { AllowEdit, DiscardInput, RestoreInput } from "../workers/routes/discard";
import { CatchAllInput, ConnectInput, DestinationInput } from "../workers/routes/domains";
import { ShownInput } from "../workers/routes/cloudflare-accounts";
import { RuleSchema } from "../workers/automation/policy";
import { CategoryInputSchema, ProjectInputSchema } from "../workers/categories/definition";

/**
 * Schema drift (parity, 0.11): a route that accepts a field its tool cannot pass is a function of the
 * app an agent cannot reach. For every tool and every route it writes to, each field the route's
 * body accepts is either a field of the tool's input (same name, or the alias below), or listed here
 * with the reason the tool does not take it. A route that gains a field fails this test until its
 * tool takes it or the reason is written down.
 */
type Any = z.ZodTypeAny;
function keys(schema: Any): string[] {
  let s = schema;
  for (;;) {
    const def = s._def as { typeName: string; schema?: Any; innerType?: Any };
    if (def.typeName === "ZodEffects") s = def.schema!;
    else if (def.typeName === "ZodDefault" || def.typeName === "ZodOptional") s = def.innerType!;
    else break;
  }
  return Object.keys((s as z.AnyZodObject).shape);
}

const SEND = [...keys(SendEmailRequestSchema), "idempotencyKey"];
const GMAIL_SEND = [...SEND_INPUT_FIELDS, "idempotencyKey"];
/** What each written route accepts: from its exported schema, or (hand-read bodies) as its handler reads it. */
const BODIES: Record<string, string[]> = {
  "POST /api/v1/mailboxes": keys(CreateMailboxBody),
  "PUT /api/v1/mailboxes/:mailboxId": keys(MailboxSettingsPatch).map((k) => `settings.${k}`),
  "POST /api/v1/mailboxes/:mailboxId/drafts": keys(DraftBody),
  "PUT /api/v1/mailboxes/:mailboxId/drafts/:id": keys(DraftSaveBody),
  "POST /api/v1/mailboxes/:mailboxId/drafts/:id/send": keys(DraftSendBody),
  "POST /api/v1/mailboxes/:mailboxId/emails": SEND,
  "POST /api/v1/mailboxes/:mailboxId/emails/:id/reply": SEND,
  "POST /api/v1/mailboxes/:mailboxId/emails/:id/forward": SEND,
  "POST /api/accounts/:accountId/send": GMAIL_SEND,
  "POST /api/accounts/:accountId/drafts": GMAIL_SEND,
  "PUT /api/accounts/:accountId/drafts/:draftId": keys(GmailDraftUpdateBody),
  "POST /api/accounts/:accountId/drafts/:draftId/send": keys(GmailDraftSendBody),
  "POST /api/project-addresses": keys(CreateAddress),
  "POST /api/project-addresses/batch": keys(CreateAddresses),
  "PUT /api/project-addresses/:email/copy": keys(CopyInput),
  "PUT /api/project-addresses/:email/agent": keys(AgentAssignmentInput),
  "POST /api/knowledge/collections": keys(CollectionInput),
  "PUT /api/knowledge/collections/:id": keys(CollectionChange),
  "POST /api/knowledge/collections/:id/documents": keys(DocumentsInput),
  "POST /api/inbox/refresh": ["accounts"], // hand-read in workers/routes/inbox.ts
  "POST /api/spam/report": keys(Report),
  "POST /api/spam/release": keys(Report),
  "POST /api/spam/lists": keys(ListEdit),
  "POST /api/discard": keys(DiscardInput),
  "POST /api/discard/restore": keys(RestoreInput),
  "POST /api/discard/allowed": keys(AllowEdit),
  "POST /api/domains/:domain/connect": keys(ConnectInput),
  "POST /api/domains/destinations": keys(DestinationInput),
  "PUT /api/domains/:domain/catch-all": keys(CatchAllInput),
  "PUT /api/cloudflare/accounts/:id": keys(ShownInput),
  "PUT /api/automation/:account/rules": keys(RuleSchema),
  "POST /api/categories": keys(CategoryInputSchema),
  "PUT /api/categories/:id": keys(CategoryInputSchema),
  "POST /api/projects": keys(ProjectInputSchema),
  "PUT /api/projects/:id": keys(ProjectInputSchema),
  // Read by hand in their handlers (no schema to export):
  "POST /api/agents": ["agent"], // workers/routes/agents.ts
  "PUT /api/agents/:id": ["agent", "expectedVersion"], // workers/routes/agents.ts
  "POST /api/domains/:domain/release": ["force"], // workers/routes/domains.ts
  "PUT /api/inbox/hidden": ["hide", "show"], // workers/routes/inbox.ts
  "POST /api/v1/mailboxes/:mailboxId/folders": ["name"], // workers/index.ts
  "PUT /api/v1/mailboxes/:mailboxId/folders/:id": ["name"],
  "POST /api/v1/mailboxes/:mailboxId/emails/:id/move": ["folderId"],
  "PUT /api/v1/mailboxes/:mailboxId/emails/:id": ["read", "starred"],
  "POST /api/accounts/:accountId/messages/:messageId/read": ["read"], // workers/routes/accounts.ts
  "POST /api/accounts/:accountId/messages/:messageId/starred": ["starred"],
  "POST /api/accounts/:accountId/messages/:messageId/trashed": ["trashed"],
  "POST /api/automation/:account/dry-run": ["emailId", "rule"], // workers/automation/index.ts
};
/** Written routes whose body carries nothing (or that take a whole document as it is). */
const NO_BODY = new Set([
  "POST /api/v1/mailboxes/:mailboxId/threads/:threadId/read", "POST /api/v1/mailboxes/:mailboxId/incoming/retry",
  "POST /api/accounts/:accountId/messages/:messageId/archive", "POST /api/accounts/:accountId/messages/:messageId/inbox",
  "POST /api/accounts/:accountId/sync", "POST /api/accounts/:accountId/disconnect", "POST /api/categories/:id/seen",
  "POST /api/automation/:account/runs/:id/approve", "POST /api/automation/:account/runs/:id/dismiss", "POST /api/automation/:account/runs/:id/check",
  "POST /api/project-addresses/:email/routing", "POST /api/project-addresses/:email/test", "POST /api/domains/:domain/sending",
  "POST /api/spam/empty", "POST /api/credential-key",
  "POST /api/setup/apply", // the setup document itself, passed whole as apply_setup's `setup`
]);

const BY_TOOL = "set by the tool";
/**
 * Per tool and route: a body field carried by a tool field of another name ("text"), or why the tool
 * does not take it ("set by the tool: …", "not offered: …"). "*" gives one reason for a whole route.
 * `via` names a tool field whose object is the body (save_category's `category`).
 */
const MAP: Record<string, Record<string, Record<string, string> & { via?: string }>> = {
  save_draft: {
    "PUT /api/v1/mailboxes/:mailboxId/drafts/:id": { body: "text", in_reply_to: "replyToMessageId", thread_id: `${BY_TOOL}: the conversation of the message it answers`,
      keep_attachments: "keepAttachments", expected_revision: "expectedRevision" },
    "POST /api/v1/mailboxes/:mailboxId/drafts": { "*": "declared for coverage of the older screen's route; the tool saves through PUT /drafts/:id" },
    "POST /api/accounts/:accountId/drafts": { threadId: `${BY_TOOL}: from replyToMessageId`, inReplyTo: `${BY_TOOL}: from replyToMessageId`,
      references: `${BY_TOOL}: from replyToMessageId`, from: `${BY_TOOL}: Gmail sends as the account itself` },
    "PUT /api/accounts/:accountId/drafts/:draftId": { threadId: `${BY_TOOL}: the draft's own or replyToMessageId's`, inReplyTo: `${BY_TOOL}: the draft's own or replyToMessageId's`,
      references: `${BY_TOOL}: the draft's own or replyToMessageId's` },
  },
  send_draft: { "POST /api/v1/mailboxes/:mailboxId/drafts/:id/send": { expected_revision: "expectedRevision" } },
  send_email: {
    "POST /api/v1/mailboxes/:mailboxId/emails": { from: `${BY_TOOL}: the mailbox and its display name`, in_reply_to: "not offered: a new message; reply answers one",
      references: "not offered: a new message; reply answers one", thread_id: "not offered: a new message; reply answers one" },
    "POST /api/accounts/:accountId/send": { from: `${BY_TOOL}: Gmail sends as the account itself`, threadId: "not offered: a new message; reply answers one",
      inReplyTo: "not offered: a new message; reply answers one", references: "not offered: a new message; reply answers one" },
  },
  reply: {
    "POST /api/v1/mailboxes/:mailboxId/emails/:id/reply": { from: `${BY_TOOL}: the mailbox and its display name`, in_reply_to: "set by the server from the message answered",
      references: "set by the server from the message answered", thread_id: "set by the server from the message answered" },
    "POST /api/accounts/:accountId/send": { from: `${BY_TOOL}: Gmail sends as the account itself`, threadId: `${BY_TOOL}: from the message answered`,
      inReplyTo: `${BY_TOOL}: from the message answered`, references: `${BY_TOOL}: from the message answered` },
  },
  forward: {
    "POST /api/v1/mailboxes/:mailboxId/emails/:id/forward": { from: `${BY_TOOL}: the mailbox and its display name`, in_reply_to: "not offered: a forward starts its own conversation",
      references: "not offered: a forward starts its own conversation", thread_id: "not offered: a forward starts its own conversation" },
    "POST /api/accounts/:accountId/send": { from: `${BY_TOOL}: Gmail sends as the account itself`, threadId: "not offered: a forward starts its own conversation",
      inReplyTo: "not offered: a forward starts its own conversation", references: "not offered: a forward starts its own conversation" },
  },
  move_messages: {
    "POST /api/v1/mailboxes/:mailboxId/emails/:id/move": { folderId: "to" },
    "POST /api/accounts/:accountId/messages/:messageId/trashed": { trashed: `${BY_TOOL}: to "trash"` },
  },
  mark_spam: {
    "POST /api/spam/report": { messages: `${BY_TOOL}: from messages, each with its own sender read by the tool` },
    "POST /api/spam/release": { messages: `${BY_TOOL}: from messages, each with its own sender read by the tool` },
  },
  create_address: { "POST /api/v1/mailboxes": { "*": "declared for coverage of the Mailboxes screen's route; the tool creates through POST /api/project-addresses" } },
  update_address: { "PUT /api/v1/mailboxes/:mailboxId": { "settings.fromName": "fromName", "settings.signature": "signature", "settings.agentSystemPrompt": "assistantPrompt" } },
  save_category: { "POST /api/categories": { via: "category" }, "PUT /api/categories/:id": { via: "category" } },
  save_rule: { "PUT /api/automation/:account/rules": { via: "rule", version: "set by the server, one more on each save" } },
  dry_run_rule: { "POST /api/automation/:account/dry-run": { emailId: "messageId" } },
  refresh_inbox: { "POST /api/inbox/refresh": { accounts: "accountIds" } },
};

const inputKeys = (shape: Record<string, Any>, via?: string): string[] => {
  if (!via) return Object.keys(shape);
  assert.ok(shape[via], `the tool has no field ${via}`);
  return keys(shape[via]!);
};

test("every field a written route accepts is one its tool takes, or is listed with the reason it is not (schema drift)", () => {
  const problems: string[] = [];
  for (const tool of TOOLS) for (const route of tool.routes) {
    if (!/^(POST|PUT) /.test(route) || NO_BODY.has(route)) continue;
    const fields = BODIES[route];
    if (!fields) { problems.push(`${tool.name}: ${route} — no body registered; add its schema to BODIES (or the route to NO_BODY)`); continue; }
    const map = MAP[tool.name]?.[route] ?? {};
    if (map["*"]) continue;
    const own = new Set(inputKeys(tool.input as Record<string, Any>, map.via));
    for (const field of fields) {
      const mapped = map[field];
      if (mapped === undefined) { if (!own.has(field)) problems.push(`${tool.name}: ${route} accepts "${field}", which the tool drops`); continue; }
      if (/^(set by|not offered|declared)/.test(mapped)) continue;
      if (!own.has(mapped)) problems.push(`${tool.name}: ${route} "${field}" is mapped to "${mapped}", which is not a field of the tool`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the drift map names only routes its tools declare and fields their routes accept", () => {
  for (const [name, routes] of Object.entries(MAP)) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, `MAP names a tool that does not exist: ${name}`);
    for (const [route, fields] of Object.entries(routes)) {
      assert.ok(tool!.routes.includes(route), `${name} does not declare ${route}`);
      for (const field of Object.keys(fields)) if (field !== "*" && field !== "via")
        assert.ok(BODIES[route]?.includes(field), `${route} does not accept ${field} (stale entry for ${name})`);
    }
  }
});
