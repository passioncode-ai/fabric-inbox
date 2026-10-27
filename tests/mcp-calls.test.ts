import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { NOT_TOOLS, TOOLS } from "../workers/mcp/tools";
import type { Api, ToolContext } from "../workers/mcp/protocol";

/**
 * P-5 (bug hunt 2026-10-26): a route a tool lists must be one its `call` reaches, and a route its `call` reaches must be
 * listed. Reading the source cannot tell (paths are built from arguments), so every tool is run: its arguments are made
 * from its own input schema (every value of an enum such as `action`, every optional field set and left out), the app's
 * API is a recorder that answers every request, and the concrete paths are matched to the route patterns.
 */
type Shape = Record<string, z.ZodTypeAny>;
const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny => {
  const d = (s as any)._def;
  if (d.typeName === "ZodOptional" || d.typeName === "ZodNullable" || d.typeName === "ZodDefault" || d.typeName === "ZodReadonly") return unwrap(d.innerType);
  if (d.typeName === "ZodEffects") return unwrap(d.schema);
  if (d.typeName === "ZodBranded") return unwrap(d.type);
  if (d.typeName === "ZodPipeline") return unwrap(d.out);
  return s;
};
const STRING_TRIES = ["support@shop.invalid", "cloudflare:support@shop.invalid", "gmail:abc123", "outlook:abc123", "imap:abc123", "https://shop.example/a", "shop.example", "key-1", "abc123", "2026-10-27T10:00:00.000Z",
  "2026-10-27", "hook-0123abcd", "agent-0123456789abcdef0123456789abcdef", "Label_1", "l-0123abcd", "archive", "trash", "inbox", "a".repeat(64), "0123456789abcdef0123456789abcdef", "#336699", "10:00", "Mon", "x"];
/** Run once per kind of account, so a nested account id (a list of messages) is also each provider's. */
let PREFER: string[] = [];
function values(schema: z.ZodTypeAny, depth = 0): unknown[] {
  const s = unwrap(schema);
  const d = (s as any)._def;
  switch (d.typeName) {
    case "ZodString": { const ok = [...PREFER, ...STRING_TRIES].filter((v) => schema.safeParse(v).success); return ok.length ? [...new Set(ok)] : ["x"]; }
    case "ZodNumber": { for (const v of [1, 10, 100, 1000, 0.5, 0]) if (s.safeParse(v).success) return [v]; return [1]; }
    case "ZodBigInt": return [1n];
    case "ZodBoolean": return [true, false];
    case "ZodEnum": return [...d.values];
    case "ZodNativeEnum": return Object.values(d.values);
    case "ZodLiteral": return [d.value];
    case "ZodArray": return [[first(d.type, depth + 1)]];
    case "ZodObject": return depth > 4 ? [{}] : objects(d.shape(), depth + 1, 1);
    case "ZodUnion": case "ZodDiscriminatedUnion": return (d.options as z.ZodTypeAny[]).flatMap((o) => values(o, depth + 1)).slice(0, 6);
    case "ZodRecord": return [{ [String(first(d.keyType ?? z.string(), depth + 1))]: first(d.valueType, depth + 1) }];
    case "ZodTuple": return [d.items.map((i: z.ZodTypeAny) => first(i, depth + 1))];
    case "ZodAny": case "ZodUnknown": return [{}];
    default: return [undefined];
  }
}
const first = (s: z.ZodTypeAny, depth: number) => values(s, depth)[0];
/** The required fields alone, then each field (optional ones too) at each of its values, and every action with each. */
function objects(shape: Shape, depth: number, cap = 2000): Record<string, unknown>[] {
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) if (!v.isOptional()) base[k] = first(v, depth);
  if (cap === 1) { for (const [k, v] of Object.entries(shape)) if (v.isOptional() && base[k] === undefined) base[k] = first(v, depth); return [base]; }
  const variants = (from: Record<string, unknown>) => {
    const out = [from];
    for (const [k, v] of Object.entries(shape)) if (k !== "action") for (const value of values(v, depth)) out.push({ ...from, [k]: value });
    return out;
  };
  // A second base with every field set: a branch that needs two optional fields at once (rename: folderId and name).
  const full: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(shape)) if (full[k] === undefined) full[k] = first(v, depth);
  const out = [...variants(base), ...variants(full)];
  if (shape.action) for (const action of values(shape.action, depth)) out.push(...variants({ ...base, action }), ...variants({ ...full, action }));
  return out.slice(0, cap);
}

const pattern = (route: string) => {
  const [method, path] = route.split(" ");
  return { method, params: (path.match(/:/g) ?? []).length, re: new RegExp("^" + path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]+/g, "[^/]+").replace(/\\\*/g, ".*") + "$") };
};
/** An answer generous enough that a tool reads it and goes on: any field is a list, a count, a text or this again. */
function answer(): unknown {
  const target: any = () => undefined; // an arrow has no non-configurable `prototype`, so the answer spreads
  return new Proxy(target, {
    apply() { return answer(); },
    get(_t, key) {
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive) return (hint: string) => (hint === "number" ? 0 : "answer");
      if (key === "then") return undefined;
      if (key === "toJSON") return () => ({});
      if (key === "length") return 0;
      return answer();
    },
  });
}

/** A literal segment wins over a parameter, as in the app (`/api/domains/destinations` is not `/api/domains/:domain`). */
const literalFirst = <T extends { params: number }>(list: T[]) => [...list].sort((a, b) => a.params - b.params);
/**
 * Routes this generator cannot reach because a call needs a nested argument it does not build; each was checked by
 * reading the call. A route that becomes reached fails until it is taken out of here.
 */
const BUILT_ARGS: Record<string, string> = {
  "POST /api/transfer/:email/agent": "import_mailbox agent: needs an agent definition from export_mailbox setup (tests/mailbox-transfer-setup-workerd.test.ts)",
  "POST /api/transfer/:email/documents": "import_mailbox documents: needs documents from export_mailbox document (tests/mailbox-transfer-setup-workerd.test.ts)",
  "POST /api/transfer/:email/labels": "import_mailbox labels: needs label rows from export_mailbox labels (tests/mailbox-transfer-setup-workerd.test.ts)",
};
const ALL = literalFirst([...new Set([...TOOLS.flatMap((t) => t.routes), ...Object.keys(NOT_TOOLS)])].map((r) => ({ route: r, ...pattern(r) })));
/** The app's own spelling of a concrete request, or the request itself when no route matches. */
const spelled = (method: string, path: string) => ALL.find((x) => x.method === method && x.re.test(path))?.route ?? `${method} ${path} (no route)`;

test("every route a tool reaches is one it lists, and every route a tool lists is one some call reaches (P-5)", async () => {
  const reached = new Map<string, Set<string>>();
  const unlisted: string[] = [];
  for (const tool of TOOLS) {
    const pats = literalFirst(tool.routes.map((r) => ({ route: r, ...pattern(r) })));
    const seen = new Set<string>();
    reached.set(tool.name, seen);
    const api: Api = {
      async request(method, path) {
        const p = path.split("?")[0];
        const hit = pats.find((x) => x.method === method && x.re.test(p));
        if (hit) seen.add(hit.route); else unlisted.push(`${tool.name}: ${spelled(method, p)}`);
        return { status: 200, data: answer(), contentType: "application/json" };
      },
    };
    const ctx = { api, principal: { kind: "owner", level: "full", label: "test" } } as unknown as ToolContext;
    let parsedAny = false;
    for (const prefer of [[], ["gmail:abc123"], ["outlook:abc123"], ["imap:abc123"]]) for (const args of (PREFER = prefer, objects(tool.input as Shape, 0))) {
      const parsed = z.object(tool.input).safeParse(args);
      if (!parsed.success) continue;
      parsedAny = true;
      // The confirmation's summary reads too (a two-step tool lists what its summary reads).
      if (tool.confirm) try { await tool.confirm(parsed.data, ctx); } catch { /* as below */ }
      try { await tool.call(parsed.data, ctx); } catch { /* the recorder's answers are not real; only the requests count */ }
    }
    assert.ok(parsedAny, `${tool.name}: no argument set the generator built passes its input schema; teach it the format`);
  }
  assert.deepEqual([...new Set(unlisted)], [], "a tool calls a route it does not list: add it to the tool's routes");
  // A route counts as covered (tests/mcp-coverage.test.ts) only when a tool's call reaches it.
  const anyReached = new Set([...reached.values()].flatMap((x) => [...x]));
  const listedOnly = [...new Set(TOOLS.flatMap((t) => t.routes))].filter((r) => !anyReached.has(r) && !(r in BUILT_ARGS)).sort();
  assert.deepEqual(listedOnly, [], "a tool lists a route its call never reaches: take it out (and exclude the route in NOT_TOOLS with its reason)");
  for (const route of Object.keys(BUILT_ARGS)) assert.ok(!anyReached.has(route), `${route} is reached now: take it out of BUILT_ARGS`);
});
