// B-93: an address whose migrated legacy agent was deleted no longer counts as answering, so the
// copies of a message that rank it first do not wait the 20-minute claim for an agent that never runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignmentServes } from "../workers/agents/deps";
import { legacyAgentId } from "../workers/agents/definition";

const registry = (states: Record<string, "live" | "deleted">, live: string[] = []) => ({
  getAgent: async (id: string) => (live.includes(id) ? ({ id } as never) : null),
  agentState: async (id: string) => states[id] ?? "none",
});

test("an unassigned mailbox answers until its migrated agent is deleted", async () => {
  const address = "Help@Shop.invalid";
  assert.equal(await assignmentServes(undefined, address, registry({})), true, "never migrated: it migrates on its first message");
  assert.equal(await assignmentServes(undefined, address, registry({ [legacyAgentId(address)]: "live" })), true);
  assert.equal(await assignmentServes(undefined, address, registry({ [legacyAgentId(address)]: "deleted" })), false, "deleted: never re-created");
});

test("Off never answers; an assigned agent answers while it exists", async () => {
  assert.equal(await assignmentServes("off", "a@x.invalid", registry({})), false);
  assert.equal(await assignmentServes({ id: "support" }, "a@x.invalid", registry({}, ["support"])), true);
  assert.equal(await assignmentServes({ id: "gone" }, "a@x.invalid", registry({})), false);
});

test("a registry without the state read keeps the old answer", async () => {
  assert.equal(await assignmentServes(undefined, "a@x.invalid", { getAgent: async () => null }), true);
});
