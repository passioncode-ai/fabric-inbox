// DEC-0153 at its release tag (tests/fixtures/fabric-contract/ops-digest/README.md): the Mac app's fold
// (desktop/ops-digest.cjs), the server's fold (workers/lib/ops-digest.ts) and the desktop descriptor (B-210) checked
// against the contract's own vectors and schemas, not against our reading of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { foldDay as serverFoldDay, foldHour as serverFoldHour, MAX_NAMED_OPS, OVERFLOW_OP } from "../workers/lib/ops-digest";
import { secretValue } from "./fixtures/fabric-contract/ops-digest/secret-shape";

const require = createRequire(import.meta.url);
const app = require("../desktop/ops-digest.cjs");
const { buildDescriptor, OPS_DIGEST_EXTENSION } = require("../desktop/fabric-descriptor.cjs");
const dir = new URL("./fixtures/fabric-contract/ops-digest/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("ops-digest.json", dir), "utf8")) as {
  hour: { name: string; input: { counts: { op: string; ok: number; failed: number; unknown: number }[]; from: string; previous: any }; expected: any }[];
  day: { name: string; input: { day: string; hourly: any[] }; expected: any }[];
};
const ajv = new (Ajv2020 as unknown as typeof import("ajv").default)({ allErrors: true, strict: false });
(addFormats as unknown as (a: unknown) => void)(ajv);
// The tag's own schemas first; the older pin (tests/fixtures/fabric-contract) fills only what the tag copy does not hold.
for (const base of [dir, new URL("./fixtures/fabric-contract/", import.meta.url)])
  for (const f of readdirSync(base).filter((f) => f.endsWith(".schema.json"))) {
    const schema = JSON.parse(readFileSync(new URL(f, base), "utf8"));
    if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
  }
const schemaOf = (name: string) => ajv.getSchema(`https://fabric.passioncode.ai/agent-contract/0.1.0/schemas/${name}.schema.json`)!;
const valid = (name: string, value: unknown) => { const v = schemaOf(name); assert.ok(v(value), `${name}: ${JSON.stringify(v.errors)}`); };
/** DEC-0153 OD-2, as `OP_NAME` and `OP_NAME_MAX` at the tag (src/ops-digest.ts:29-30). */
const OP_NAME = /^[a-z][A-Za-z0-9_]*(?:[.:/-][A-Za-z0-9_]+)*$/;

/** The app's fold takes a map of counts summed per name; the vector's list may name an operation twice. */
const counted = (list: { op: string; ok: number; failed: number; unknown: number }[]) => {
  const m = new Map<string, { ok: number; failed: number; unknown: number }>();
  for (const c of list) { const s = m.get(c.op) ?? { ok: 0, failed: 0, unknown: 0 }; s.ok += c.ok; s.failed += c.failed; s.unknown += c.unknown; m.set(c.op, s); }
  return m;
};

test("DEC-0153: the Mac app's hourly fold answers every hour vector of the tag, and each answer passes the schema", () => {
  assert.equal(vectors.hour.length, 11);
  for (const v of vectors.hour) {
    const got = app.foldHour(counted(v.input.counts), Date.parse(v.input.from), v.input.previous);
    assert.deepEqual(got, v.expected, v.name);
    valid("ops-digest-hourly", got);
  }
});

test("DEC-0153: the server's hourly fold answers every hour vector of the tag", () => {
  for (const v of vectors.hour) {
    const hour = new Date(Date.parse(v.input.from)).toISOString().slice(0, 13);
    const rows = [...counted(v.input.counts)].map(([op, c]) => ({ op, ...c }));
    // The server reads the hour just before from its ledger; a previous that does not adjoin is no baseline.
    const prev = v.input.previous && Date.parse(v.input.previous.to) === Date.parse(v.input.from) ? v.input.previous.ops : [];
    const got = serverFoldHour(hour, rows, prev);
    assert.deepEqual(got, v.expected, v.name);
    valid("ops-digest-hourly", got);
  }
});

test("DEC-0153: both daily folds answer every day vector of the tag, null for a day with no hour of its own", () => {
  assert.equal(vectors.day.length, 4);
  for (const v of vectors.day) {
    const got = app.foldDay(v.input.day, v.input.hourly);
    assert.deepEqual(got, v.expected, `app: ${v.name}`);
    if (got) valid("ops-digest-daily", got);
    // The server folds its ledger's rows, each hour against the one before: the same day from the same counts.
    const rows = v.input.hourly.flatMap((h: any) => h.ops.map((c: any) => ({ hour: String(h.from).slice(0, 13), ...c })));
    const server = serverFoldDay(v.input.day, rows);
    assert.deepEqual(server, v.expected, `server: ${v.name}`);
  }
});

test("DEC-0153 OD-2, OD-3: every name the app counts and the overflow names pass the grammar and FAC-SEM-167", () => {
  const src = readdirSync("desktop").filter((f) => /\.c?js$/.test(f)).map((f) => readFileSync(`desktop/${f}`, "utf8")).join("\n");
  const events = new Set([...src.matchAll(/event: ?'([a-z][a-z0-9_]*)'[^}]*outcome/g)].map((m) => m[1]));
  assert.ok(events.size > 10, "the app's own operations were found");
  for (const op of [...events, OVERFLOW_OP, app.OVERFLOW_OP, "http.agents", "send.transport_outcome_unknown", "agent.sent"]) {
    assert.match(op, OP_NAME, op);
    assert.ok(op.length <= 64, op);
    assert.equal(secretValue(op), false, `${op} is shaped like a credential`);
  }
  assert.equal(MAX_NAMED_OPS + 1, 4096, "4095 names a UTC day plus the overflow name (OD-3)");
  assert.equal(app.MAX_NAMED_OPS, MAX_NAMED_OPS);
});

test("DEC-0153 OD-9: the desktop descriptor's ops-digest extension passes the tag's schema", () => {
  const d = buildDescriptor({ tool: "Fabric Inbox 0.99.0", appPath: "/Applications/Fabric Inbox.app", userData: "/Volumes/Data/Fabric Inbox", logs: "/Volumes/Data/Logs", now: Date.parse("2026-11-06T00:00:00Z") });
  valid("service-ops-digest-extension", d.extensions[OPS_DIGEST_EXTENSION]);
});
