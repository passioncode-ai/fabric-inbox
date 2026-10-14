// B-115 (M2): a message an agent answered, drafted or skipped is marked in the inbox, and the
// reader shows what the agent did, read by the run's id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachAgentRuns } from "../workers/routes/inbox";

test("each Cloudflare message on the page gets its run's mark; other providers and messages without a run get none", async () => {
  const page = [
    { accountId: "cloudflare:support@x.invalid", providerMessageId: "e1" },
    { accountId: "cloudflare:support@x.invalid", providerMessageId: "e2" },
    { accountId: "gmail:g1", providerMessageId: "g1" },
  ] as never as { accountId: string; providerMessageId: string; agentRun?: unknown }[];
  const asked: string[][] = [];
  await attachAgentRuns(page as never, async (ids) => {
    asked.push(ids);
    return [{ id: ids[0]!, status: "drafted", agentId: "support", agentVersion: 3, draftId: "d1", reason: "This agent drafts only" }] as never;
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.length, 2, "only Cloudflare messages are looked up, in one call");
  assert.deepEqual(page[0]!.agentRun, { id: asked[0]![0], status: "drafted", agentId: "support", agentVersion: 3, draftId: "d1" });
  assert.equal(page[1]!.agentRun, undefined);
  assert.equal(page[2]!.agentRun, undefined);
});

test("a registry that cannot answer leaves the page unmarked", async () => {
  const page = [{ accountId: "cloudflare:a@x.invalid", providerMessageId: "e1" }] as never as { agentRun?: unknown }[];
  await attachAgentRuns(page as never, async () => { throw new Error("down"); });
  assert.equal(page[0]!.agentRun, undefined);
});

test("the list's mark says what the agent did, and flags what needs a look", async () => {
  const { agentRunLabel, agentRunNeedsLook } = await import("../app/components/inbox/agent-run");
  const { englishT } = await import("../shared/i18n");
  assert.equal(agentRunLabel("sent", englishT), "Agent replied");
  assert.equal(agentRunLabel("drafted", englishT), "Agent's draft");
  assert.equal(agentRunLabel("skipped", englishT), "Agent left it alone");
  assert.equal(agentRunLabel("send_unknown", englishT), "Agent: needs a look");
  assert.equal(agentRunNeedsLook("failed"), true);
  assert.equal(agentRunNeedsLook("sent"), false);
});

test("the reader shows the run and opens the agent's draft in the composer; the list row carries the mark", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(route, /<AgentRunPanel message=\{selected\} onOpenDraft=\{\(draftId\) => \{/);
  assert.match(route, /saved\.openServer\(\{ accountId: selected\.accountId, serverId: draftId,/);
  const row = readFileSync("app/components/inbox/TriagedList.tsx", "utf8");
  assert.match(row, /\{message\.agentRun && \(/);
  const panel = readFileSync("app/components/inbox/AgentRunPanel.tsx", "utf8");
  assert.match(panel, /fabric<AgentRunView>\(`\/api\/agent-runs\/\$\{encodeURIComponent\(id!\)\}`\)/);
});

test("B-115: an agent's draft is told apart in Drafts by its id", async () => {
  const { isAgentDraft } = await import("../app/components/inbox/agent-run");
  assert.equal(isAgentDraft("agent-0123456789abcdef0123456789abcdef-draft"), true);
  assert.equal(isAgentDraft("d1"), false);
  assert.equal(isAgentDraft("agent-0123456789abcdef0123456789abcdef"), false);
  const { readFileSync } = await import("node:fs");
  const dialog = readFileSync("app/components/inbox/DraftsDialog.tsx", "utf8");
  assert.match(dialog, /isAgentDraft\(r\.row\.serverId\) && <span className="fi-agent-tag">\{t\("Agent's draft"\)\}<\/span>/);
});

test("B-115: the agents' answers are one click from the inbox, opened on the chosen filter", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(route, /<Link className="fi-nav-item" to=\{settingsPath\("agents"\)\}>/);
  const section = readFileSync("app/components/settings/sections/AgentsSection.tsx", "utf8");
  assert.match(section, /useState\(\(\) => initialOutcome\(params\.get\("runs"\)\)\)/);
  const { initialOutcome } = await import("../app/services/agents");
  assert.equal(initialOutcome("unanswered"), "unanswered");
  assert.equal(initialOutcome("bogus"), "");
  assert.equal(initialOutcome(null), "");
});
