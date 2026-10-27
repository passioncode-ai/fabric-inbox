import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGapList, runOfRequest } from "../workers/agents/gap-closures";
import { gapRequestId } from "../workers/agents/runner";

test("B-153: a gap list gives each report's request id, state and closing item; anything else is not a list", () => {
  const page = parseGapList(JSON.stringify({ class: "internal", ledgerRevision: "abc", gaps: [
    { id: 3, requestId: "agent-1-0123456789ab", state: "closed", closedBy: { item: "fact:x", title: "X", withheld: false } },
    { id: 4, requestId: "agent-2-0123456789ab", state: "answered", closedBy: { item: null, withheld: true } },
    { id: 5, requestId: "agent-3-0123456789ab" },
    { id: "6", requestId: "agent-4-0123456789ab", state: "closed" },
  ] }));
  assert.deepEqual(page, { ledgerRevision: "abc", gaps: [
    { id: 3, requestId: "agent-1-0123456789ab", state: "closed", item: "fact:x" },
    { id: 4, requestId: "agent-2-0123456789ab", state: "answered", item: null },
    { id: 5, requestId: "agent-3-0123456789ab", state: "reported", item: null },
  ] }, "a row without a numeric id is skipped; a withheld item is null; no state is reported");
  assert.equal(parseGapList("not json"), null);
  assert.equal(parseGapList(JSON.stringify({ error: "not-found" })), null);
  assert.equal(parseGapList(JSON.stringify({ gaps: [] }))?.ledgerRevision, null);
});

test("B-153: the run of a report is its request id without the kind's hash, as the runner builds it", async () => {
  const runId = "agent-0123456789abcdef0123456789abcdef";
  assert.equal(runOfRequest(await gapRequestId(runId, "unanswered")), runId);
  assert.equal(runOfRequest(await gapRequestId(runId, "outdated")), runId);
  assert.equal(runOfRequest("no-hash-here"), null);
});
