// B-158 (D2): a server's context as contract DEC-0082 writes it, read from FABRIC_CONTEXT.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { contextOf, CONTEXT_PATTERN } from "../workers/lib/context";
const require = createRequire(import.meta.url);
const { CONTEXT } = require("../desktop/cloudflare-deploy.cjs");

test("no FABRIC_CONTEXT is a person's own server; a context is taken exactly as written", () => {
  assert.deepEqual(contextOf({}), { context: "personal", valid: true });
  assert.deepEqual(contextOf({ FABRIC_CONTEXT: "" }), { context: "personal", valid: true });
  assert.deepEqual(contextOf({ FABRIC_CONTEXT: "org:org_ABC23" }), { context: "org:org_ABC23", valid: true });
  assert.deepEqual(contextOf({ FABRIC_CONTEXT: `org:a${"b".repeat(127)}` }).valid, true);
});

test("what is no context is reported, never folded into one (the contract's vectors)", () => {
  for (const bad of ["Personal", "org:", "org:-a", "org:a.b", `org:a${"b".repeat(128)}`, "org:a\n", "org_ABC23", " org:a"])
    assert.deepEqual(contextOf({ FABRIC_CONTEXT: bad }).valid, false, JSON.stringify(bad));
});

test("the deployer checks a context with the server's own pattern", () => {
  assert.equal(String(CONTEXT), String(CONTEXT_PATTERN));
});
