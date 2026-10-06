import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { COLLECTION_ID, LIMITS } from "../knowledge/text";

/**
 * Knowledge collections (KN-2, SCR-12), behind the same Access and same-origin
 * boundary as every /api route. The batch endpoint is the one a Fabric memory
 * sync will call (KN-6): upsert by source URI + revision, optional prune.
 */
export const knowledgeRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const store = (c: C) => c.env.KNOWLEDGE.getByName("workspace");
const registry = (c: C) => c.env.AGENT_REGISTRY.getByName("workspace");

/** A Durable Object error loses its class over RPC; its code travels as the message prefix. */
function failure(c: C, error: unknown) {
  const text = (error as Error)?.message ?? String(error);
  const m = text.match(/(not_found|invalid|conflict|limit): (.*)$/s);
  if (m) return c.json({ error: m[2] }, m[1] === "not_found" ? 404 : m[1] === "conflict" ? 409 : 400);
  console.error(JSON.stringify({ event: "knowledge_error", error: text.slice(0, 300) }));
  return c.json({ error: "Knowledge is unavailable right now. Try again." }, 503);
}

knowledgeRouter.use("/api/knowledge/*", async (c, next) => {
  if (!c.env.KNOWLEDGE) return c.json({ error: "Knowledge is not configured on this server; update the server from the app" }, 503);
  await next();
});

/** Agents that read a collection, so the screen can say who is affected. */
async function readers(c: C): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!c.env.AGENT_REGISTRY) return map;
  for (const a of await registry(c).listAgents())
    for (const id of a.collections ?? []) map.set(id, [...(map.get(id) ?? []), a.name]);
  return map;
}

knowledgeRouter.get("/api/knowledge/collections", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const [collections, used] = await Promise.all([store(c).listCollections(), readers(c)]);
    return c.json({ collections: collections.map((x) => ({ ...x, agents: used.get(x.id) ?? [] })), limits: LIMITS });
  } catch (error) { return failure(c, error); }
});

export const CollectionInput = z.object({
  name: z.string().trim().min(1, "A collection needs a name").max(80),
  description: z.string().trim().max(500).optional(),
  source: z.union([
    z.object({ kind: z.literal("manual") }).strict(),
    z.object({ kind: z.literal("fabric"), project: z.string().trim().min(1).max(120), scope: z.string().trim().max(200).optional() }).strict(),
  ]).optional(),
}).strict();

knowledgeRouter.post("/api/knowledge/collections", async (c) => {
  const parsed = CollectionInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid collection" }, 400);
  try {
    const collection = await store(c).createCollection(parsed.data);
    console.log(JSON.stringify({ event: "knowledge_collection_created", source: collection.source.kind }));
    return c.json(collection, 201);
  } catch (error) { return failure(c, error); }
});

knowledgeRouter.get("/api/knowledge/collections/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const collection = await store(c).getCollection(c.req.param("id"));
    if (!collection) return c.json({ error: "No such collection" }, 404);
    const [documents, used] = await Promise.all([store(c).listDocuments(collection.id), readers(c)]);
    return c.json({ collection: { ...collection, agents: used.get(collection.id) ?? [] }, documents });
  } catch (error) { return failure(c, error); }
});

export const CollectionChange = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).optional() }).strict();
knowledgeRouter.put("/api/knowledge/collections/:id", async (c) => {
  const parsed = CollectionChange
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Name up to 80 characters, description up to 500" }, 400);
  try { return c.json(await store(c).updateCollection(c.req.param("id"), parsed.data)); }
  catch (error) { return failure(c, error); }
});

knowledgeRouter.delete("/api/knowledge/collections/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const using = (await readers(c)).get(id) ?? [];
    if (using.length) return c.json({ error: `Used by ${using.join(", ")}. Remove it from those agents first.`, agents: using }, 409);
    return (await store(c).deleteCollection(id)) ? c.body(null, 204) : c.json({ error: "No such collection" }, 404);
  } catch (error) { return failure(c, error); }
});

const DocumentInput = z.object({
  sourceUri: z.string().trim().min(1).max(500),
  title: z.string().trim().max(200).default(""),
  text: z.string().max(LIMITS.documentChars, `A document is at most ${LIMITS.documentChars.toLocaleString("en")} characters; split it`),
  revision: z.string().trim().max(100).optional(),
}).strict();

/** Add or replace documents. `prune: true` makes the batch the whole collection (a sync). */
export const DocumentsInput = z.object({ documents: z.array(DocumentInput).min(1).max(LIMITS.batchDocuments), prune: z.boolean().default(false) }).strict();
knowledgeRouter.post("/api/knowledge/collections/:id/documents", async (c) => {
  const parsed = DocumentsInput
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid documents" }, 400);
  try {
    const collection = await store(c).getCollection(c.req.param("id"));
    if (!collection) return c.json({ error: "No such collection" }, 404);
    const result = await store(c).upsertDocuments(collection.id, parsed.data.documents, { prune: parsed.data.prune });
    console.log(JSON.stringify({ event: "knowledge_documents", collection: collection.id, source: collection.source.kind,
      added: result.added, updated: result.updated, unchanged: result.unchanged, removed: result.removed, refused: result.refused.length }));
    return c.json(result);
  } catch (error) { return failure(c, error); }
});

knowledgeRouter.get("/api/knowledge/collections/:id/documents/:doc", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const found = await store(c).readDocument(c.req.param("id"), c.req.param("doc"));
    return found ? c.json(found) : c.json({ error: "No such document" }, 404);
  } catch (error) { return failure(c, error); }
});

knowledgeRouter.delete("/api/knowledge/collections/:id/documents/:doc", async (c) => {
  try {
    return (await store(c).deleteDocument(c.req.param("id"), c.req.param("doc"))) ? c.body(null, 204) : c.json({ error: "No such document" }, 404);
  } catch (error) { return failure(c, error); }
});

/** Try a search as an agent would: only within the collections named. */
knowledgeRouter.get("/api/knowledge/search", async (c) => {
  c.header("Cache-Control", "no-store");
  const q = (c.req.query("q") ?? "").trim();
  const collections = (c.req.query("collections") ?? "").split(",").map((s) => s.trim()).filter((s) => COLLECTION_ID.test(s));
  if (!q) return c.json({ error: "Type what to look for" }, 400);
  if (!collections.length) return c.json({ error: "Name at least one collection" }, 400);
  try { return c.json({ hits: await store(c).search(q, collections, Number(c.req.query("limit") ?? 5)) }); }
  catch (error) { return failure(c, error); }
});

/** Collections that exist, for validating an agent's grant. */
export async function knownCollections(env: Env): Promise<Set<string>> {
  if (!env.KNOWLEDGE) return new Set();
  return new Set((await env.KNOWLEDGE.getByName("workspace").listCollections()).map((x) => x.id));
}
