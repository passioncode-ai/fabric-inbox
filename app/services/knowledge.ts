/** Client types for /api/knowledge (workers/routes/knowledge.ts, workers/knowledge/store.ts). */
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
  /** Names of the agents that may search it. */
  agents: string[];
}
export interface CollectionList {
  collections: Collection[];
  limits: { collections: number; documentsPerCollection: number; documentChars: number; batchDocuments: number };
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
export interface UpsertResult { added: number; updated: number; unchanged: number; removed: number; refused: { sourceUri: string; reason: string }[] }
export interface KnowledgeHit { ref: string; collectionId: string; documentId: string; title: string; sourceUri: string; snippet: string; text: string; score: number }
