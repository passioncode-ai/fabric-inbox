// Schema versions of KnowledgeDO. Append only; see workers/lib/do-schema.ts.
import { statements, type SchemaStep } from "../lib/do-schema";

/** The schema as released before versioning (B-32); frozen. */
const INITIAL = [
  `CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, source_uri TEXT NOT NULL, title TEXT NOT NULL,
    revision TEXT NOT NULL, content_hash TEXT NOT NULL, chars INTEGER NOT NULL, chunks INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (collection_id, source_uri))`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, collection_id TEXT NOT NULL,
    ord INTEGER NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS chunks_by_document ON chunks(document_id)`,
  // Its own copy of the text, rowid = chunks.id; porter stems English, unicode61 folds case and
  // diacritics for every script (Russian included).
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, title, tokenize = 'porter unicode61 remove_diacritics 2')`,
];

/**
 * B-199 (the channel-agent standard, 7.1): a collection's maximum age and when a batch last confirmed it, and when a
 * batch last confirmed each document, changed or not. A row from before reads its age from `updated_at`.
 */
const FRESHNESS = [
  `ALTER TABLE collections ADD COLUMN max_age_hours INTEGER`,
  `ALTER TABLE collections ADD COLUMN synced_at TEXT`,
  `ALTER TABLE documents ADD COLUMN checked_at TEXT`,
];

export const KNOWLEDGE_STEPS: readonly SchemaStep[] = [
  statements("1_initial", INITIAL),
  statements("2_freshness", FRESHNESS),
];
