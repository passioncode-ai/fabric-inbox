// Schema versions of AgentRegistryDO. Append only; see workers/lib/do-schema.ts.
import { addColumn, statements, type SchemaStep } from "../lib/do-schema";

/** The schema as released before versioning (B-32); frozen. */
const INITIAL = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    current_version INTEGER NOT NULL,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agent_versions (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, version))`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS agent_runs_by_time ON agent_runs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS agent_runs_by_mailbox ON agent_runs(mailbox_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS agent_send_counts (
    day TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, mailbox_id))`,
  `CREATE TABLE IF NOT EXISTS agent_queue (
    mailbox_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mailbox_id, email_id))`,
];

export const AGENT_REGISTRY_STEPS: readonly SchemaStep[] = [
  statements("1_initial", INITIAL),
  // Added in 0.6.1 by a PRAGMA check before versioning, so objects may already have it.
  { name: "2_agent_queue_next_at", run: (sql) => addColumn(sql, "agent_queue", "next_at", "INTEGER NOT NULL DEFAULT 0") },
  // B-22: which address answers a message delivered to several agent addresses; pruned after a week.
  statements("3_message_claims", [
    `CREATE TABLE IF NOT EXISTS agent_message_claims (
      key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      taken INTEGER NOT NULL,
      deadline INTEGER NOT NULL,
      created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS agent_message_claims_by_time ON agent_message_claims(created_at)`,
  ]),
];
