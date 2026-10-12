// MCP sweep 2026-10-12: destructiveHint followed only `confirm`, so tools that remove or overwrite
// (manage_folder, remove_discard_rule, save_agent, set_catch_all…) told clients they were additive.
// The MCP spec reads destructiveHint: false as "only additive updates".
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../workers/mcp/tools";
import { annotationsFor } from "../workers/mcp/protocol";

const hints = (name: string) => annotationsFor(TOOLS.find((t) => t.name === name)!);

test("a tool that changes something is destructive unless it only adds", () => {
  for (const name of ["manage_folder", "update_spam_list", "update_discard_allow_list", "remove_discard_rule", "clear_incoming_failures",
    "move_messages", "discard_messages", "set_hidden_addresses", "save_agent", "save_rule", "save_category", "update_address", "set_catch_all",
    "delete_message", "delete_agent"]) {
    assert.equal(hints(name).destructiveHint, true, name);
  }
  for (const name of ["create_address", "create_addresses", "send_email", "reply", "forward", "send_test_message", "add_forward_destination"]) {
    assert.equal(hints(name).destructiveHint, false, name);
  }
});

test("a read-only tool is read-only and never destructive", () => {
  for (const tool of TOOLS.filter((t) => t.readOnly)) {
    const a = annotationsFor(tool);
    assert.equal(a.readOnlyHint, true, tool.name);
    assert.equal(a.destructiveHint, false, tool.name);
  }
});

test("every tool that confirms is destructive", () => {
  for (const tool of TOOLS.filter((t) => t.confirm)) assert.equal(annotationsFor(tool).destructiveHint, true, tool.name);
});

test("a bare error code from a route reaches the agent as a sentence with the code", async () => {
  const { unwrap } = await import("../workers/mcp/protocol");
  assert.throws(() => unwrap({ status: 404, data: { error: "account_not_found", status: 404 }, contentType: "application/json" }), /^Error: Account not found \(account_not_found\)$|Account not found \(account_not_found\)/);
  assert.throws(() => unwrap({ status: 404, data: { error: "Email not found" }, contentType: "application/json" }), /Email not found/);
});
