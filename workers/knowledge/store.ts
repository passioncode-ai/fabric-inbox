import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "../lib/do-schema";
import { KNOWLEDGE_STEPS } from "./schema";
import type { Env } from "../types";
import { chunkText, COLLECTION_ID, ftsQuery, LIMITS, sha256Hex } from "./text";
export { COLLECTION_ID, LIMITS } from "./text";

/**
 * Knowledge collections (KN-1, KN-6): one store per workspace
 * (`getByName("workspace")`), SQLite with an FTS5 index.
 *
 * A document is addressed by its source — `sourceUri` plus `revision` — the
 * shape Fabric memory's search returns (ADR-0069): a Fabric sync upserts the
 * same documents a person pastes by hand, and a changed revision replaces the
 * chunks in one transaction. Search is lexical (bm25), always scoped to named
 * collections: there is no call that searches everything.
 */
export type CollectionSource = { kind: "manual" } | { kind: "fabric"; project: string; scope?: string };
export interface Collection {
  id: string;
  name: string;
  description: string;
  source: CollectionSource;
  documents: number;
  chars: number;
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeDocument {
  id: string;
  collectionId: string;
  sourceUri: string;
  title: string;
  revision: string;
  chars: number;
  chunks: number;
  updatedAt: string;
}
export interface DocumentInput { sourceUri: string; title: string; text: string; revision?: string }
export interface UpsertResult { added: number; updated: number; unchanged: number; removed: number; refused: { sourceUri: string; reason: string }[] }
export interface KnowledgeHit {
  /** Stable within a revision: `<collection>/<document>#<chunk>`. */
  ref: string;
  collectionId: string;
  documentId: string;
  title: string;
  sourceUri: string;
  revision: string;
  text: string;
  snippet: string;
  score: number;
}


export class KnowledgeError extends Error {
  constructor(message: string, readonly code: "not_found" | "invalid" | "conflict" | "limit") { super(`${code}: ${message}`); }
}


type Row = Record<string, string | number | null>;
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

function readSource(raw: string): CollectionSource {
  try {
    const v = JSON.parse(raw) as CollectionSource;
    return v.kind === "fabric" ? { kind: "fabric", project: String(v.project), ...(v.scope ? { scope: String(v.scope) } : {}) } : { kind: "manual" };
  } catch { return { kind: "manual" }; }
}

export class KnowledgeDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrateSchema(ctx.storage, KNOWLEDGE_STEPS, "KnowledgeDO");
  }

  private collectionRow(r: Row): Collection {
    const stats = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS c FROM documents WHERE collection_id = ?", r.id).one() as Row;
    return {
      id: String(r.id), name: String(r.name), description: String(r.description), source: readSource(String(r.source)),
      documents: Number(stats.n), chars: Number(stats.c), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  async listCollections(): Promise<Collection[]> {
    return (this.sql.exec("SELECT * FROM collections ORDER BY name COLLATE NOCASE").toArray() as Row[]).map((r) => this.collectionRow(r));
  }

  async getCollection(id: string): Promise<Collection | null> {
    const r = this.sql.exec("SELECT * FROM collections WHERE id = ?", id).toArray()[0] as Row | undefined;
    return r ? this.collectionRow(r) : null;
  }

  async createCollection(input: { name: string; description?: string; source?: CollectionSource }): Promise<Collection> {
    const name = String(input.name ?? "").trim().slice(0, 80);
    if (!name) throw new KnowledgeError("A collection needs a name", "invalid");
    const count = Number((this.sql.exec("SELECT COUNT(*) AS n FROM collections").one() as Row).n);
    if (count >= LIMITS.collections) throw new KnowledgeError(`At most ${LIMITS.collections} collections`, "limit");
    const base = slug(name) || "collection";
    let id = base;
    for (let i = 2; this.sql.exec("SELECT 1 FROM collections WHERE id = ?", id).toArray().length; i++) id = `${base}-${i}`;
    const now = new Date().toISOString();
    const source: CollectionSource = input.source?.kind === "fabric"
      ? { kind: "fabric", project: String(input.source.project).slice(0, 120), ...(input.source.scope ? { scope: String(input.source.scope).slice(0, 200) } : {}) }
      : { kind: "manual" };
    this.sql.exec("INSERT INTO collections (id, name, description, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, name, String(input.description ?? "").trim().slice(0, 500), JSON.stringify(source), now, now);
    return (await this.getCollection(id))!;
  }

  async updateCollection(id: string, patch: { name?: string; description?: string }): Promise<Collection> {
    const current = await this.getCollection(id);
    if (!current) throw new KnowledgeError("No such collection", "not_found");
    const name = patch.name === undefined ? current.name : String(patch.name).trim().slice(0, 80);
    if (!name) throw new KnowledgeError("A collection needs a name", "invalid");
    const description = patch.description === undefined ? current.description : String(patch.description).trim().slice(0, 500);
    this.sql.exec("UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?", name, description, new Date().toISOString(), id);
    return (await this.getCollection(id))!;
  }

  /** Deletes the collection with its documents. Whether an agent still uses it is the caller's check. */
  async deleteCollection(id: string): Promise<boolean> {
    if (!(await this.getCollection(id))) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE collection_id = ?)", id);
      this.sql.exec("DELETE FROM chunks WHERE collection_id = ?", id);
      this.sql.exec("DELETE FROM documents WHERE collection_id = ?", id);
      this.sql.exec("DELETE FROM collections WHERE id = ?", id);
    });
    return true;
  }

  async listDocuments(collectionId: string): Promise<KnowledgeDocument[]> {
    if (!(await this.getCollection(collectionId))) throw new KnowledgeError("No such collection", "not_found");
    return (this.sql.exec("SELECT * FROM documents WHERE collection_id = ? ORDER BY title COLLATE NOCASE LIMIT ?", collectionId, LIMITS.documentsPerCollection).toArray() as Row[])
      .map((r) => ({ id: String(r.id), collectionId, sourceUri: String(r.source_uri), title: String(r.title), revision: String(r.revision),
        chars: Number(r.chars), chunks: Number(r.chunks), updatedAt: String(r.updated_at) }));
  }

  /** One document's text, reassembled from its chunks (for the screen and for a read tool). */
  async readDocument(collectionId: string, documentId: string): Promise<{ document: KnowledgeDocument; text: string } | null> {
    const docs = await this.listDocuments(collectionId);
    const document = docs.find((d) => d.id === documentId);
    if (!document) return null;
    const parts = this.sql.exec("SELECT text FROM chunks WHERE document_id = ? ORDER BY ord", documentId).toArray() as Row[];
    return { document, text: parts.map((p) => String(p.text)).join("\n\n") };
  }

  /**
   * Adds or replaces documents by source URI. Unchanged text and revision is a
   * no-op; `prune` removes the collection's documents the batch did not name —
   * what a full sync from a source (Fabric) means. A document that breaks a limit
   * is refused alone, with its reason; the others still land.
   */
  async upsertDocuments(collectionId: string, docs: DocumentInput[], options: { prune?: boolean } = {}): Promise<UpsertResult> {
    if (!(await this.getCollection(collectionId))) throw new KnowledgeError("No such collection", "not_found");
    if (docs.length > LIMITS.batchDocuments) throw new KnowledgeError(`At most ${LIMITS.batchDocuments} documents per call`, "limit");
    const result: UpsertResult = { added: 0, updated: 0, unchanged: 0, removed: 0, refused: [] };
    const seen = new Set<string>();
    const prepared: { d: DocumentInput & { revision: string }; hash: string; chunks: ReturnType<typeof chunkText> }[] = [];
    for (const raw of docs) {
      const sourceUri = String(raw?.sourceUri ?? "").trim().slice(0, 500);
      const text = String(raw?.text ?? "");
      const title = String(raw?.title ?? "").trim().slice(0, 200) || sourceUri.split("/").pop() || "Untitled";
      if (!sourceUri) { result.refused.push({ sourceUri: "", reason: "A document needs a source (a file name, a URL or a Fabric reference)" }); continue; }
      if (seen.has(sourceUri)) { result.refused.push({ sourceUri, reason: "Named twice in one batch" }); continue; }
      seen.add(sourceUri);
      if (text.length > LIMITS.documentChars) { result.refused.push({ sourceUri, reason: `Longer than ${LIMITS.documentChars.toLocaleString("en")} characters; split it` }); continue; }
      const chunks = chunkText(text);
      if (!chunks.length) { result.refused.push({ sourceUri, reason: "No text" }); continue; }
      const hash = await sha256Hex(title + "\u0000" + text);
      prepared.push({ d: { sourceUri, title, text, revision: String(raw.revision ?? "").slice(0, 100) || hash.slice(0, 12) }, hash, chunks });
    }
    const existingCount = Number((this.sql.exec("SELECT COUNT(*) AS n FROM documents WHERE collection_id = ?", collectionId).one() as Row).n);
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      let count = existingCount;
      for (const { d, hash, chunks } of prepared) {
        const row = this.sql.exec("SELECT id, content_hash, revision FROM documents WHERE collection_id = ? AND source_uri = ?", collectionId, d.sourceUri).toArray()[0] as Row | undefined;
        if (row && row.content_hash === hash && row.revision === d.revision) { result.unchanged++; continue; }
        if (!row && count >= LIMITS.documentsPerCollection) { result.refused.push({ sourceUri: d.sourceUri, reason: `The collection holds its limit of ${LIMITS.documentsPerCollection} documents` }); continue; }
        const id = row ? String(row.id) : crypto.randomUUID();
        if (row) {
          this.sql.exec("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)", id);
          this.sql.exec("DELETE FROM chunks WHERE document_id = ?", id);
          this.sql.exec("UPDATE documents SET title = ?, revision = ?, content_hash = ?, chars = ?, chunks = ?, updated_at = ? WHERE id = ?",
            d.title, d.revision, hash, d.text.length, chunks.length, now, id);
          result.updated++;
        } else {
          this.sql.exec("INSERT INTO documents (id, collection_id, source_uri, title, revision, content_hash, chars, chunks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id, collectionId, d.sourceUri, d.title, d.revision, hash, d.text.length, chunks.length, now, now);
          result.added++;
          count++;
        }
        for (const c of chunks) {
          const chunkId = Number((this.sql.exec("INSERT INTO chunks (document_id, collection_id, ord, text) VALUES (?, ?, ?, ?) RETURNING id", id, collectionId, c.ord, c.text).one() as Row).id);
          this.sql.exec("INSERT INTO chunks_fts (rowid, text, title) VALUES (?, ?, ?)", chunkId, c.text, d.title);
        }
      }
      if (options.prune) {
        const stale = (this.sql.exec("SELECT id, source_uri FROM documents WHERE collection_id = ?", collectionId).toArray() as Row[])
          .filter((r) => !seen.has(String(r.source_uri)));
        for (const r of stale) {
          this.sql.exec("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)", r.id);
          this.sql.exec("DELETE FROM chunks WHERE document_id = ?", r.id);
          this.sql.exec("DELETE FROM documents WHERE id = ?", r.id);
          result.removed++;
        }
      }
      this.sql.exec("UPDATE collections SET updated_at = ? WHERE id = ?", now, collectionId);
    });
    return result;
  }

  async deleteDocument(collectionId: string, documentId: string): Promise<boolean> {
    const row = this.sql.exec("SELECT id FROM documents WHERE id = ? AND collection_id = ?", documentId, collectionId).toArray()[0];
    if (!row) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)", documentId);
      this.sql.exec("DELETE FROM chunks WHERE document_id = ?", documentId);
      this.sql.exec("DELETE FROM documents WHERE id = ?", documentId);
    });
    return true;
  }

  /**
   * The best passages for `query` within `collections` only. An empty grant
   * returns nothing — never "everything". Free text is quoted term by term, so
   * an email cannot inject FTS syntax.
   */
  async search(query: string, collections: string[], limit = 5): Promise<KnowledgeHit[]> {
    const ids = [...new Set(collections.filter((c) => COLLECTION_ID.test(c)))].slice(0, 20);
    if (!ids.length) return [];
    const match = ftsQuery(String(query).slice(0, LIMITS.queryChars));
    if (!match) return [];
    const n = Math.max(1, Math.min(LIMITS.searchResults, Math.floor(limit)));
    const rows = this.sql.exec(
      `SELECT c.id AS chunk_id, c.ord, c.text, c.collection_id, d.id AS document_id, d.title, d.source_uri, d.revision,
              snippet(chunks_fts, 0, '«', '»', '…', 20) AS snippet, bm25(chunks_fts, 1.0, 3.0) AS score
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.document_id
       WHERE chunks_fts MATCH ? AND c.collection_id IN (${ids.map(() => "?").join(",")})
       ORDER BY score LIMIT ?`, match, ...ids, n).toArray() as Row[];
    return rows.map((r) => ({
      ref: `${r.collection_id}/${r.document_id}#${r.ord}`,
      collectionId: String(r.collection_id), documentId: String(r.document_id), title: String(r.title),
      sourceUri: String(r.source_uri), revision: String(r.revision), text: String(r.text), snippet: String(r.snippet),
      score: Number(r.score),
    }));
  }
}
