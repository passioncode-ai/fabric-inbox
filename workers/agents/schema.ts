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
  // B-118: the agent-events feed — one row per run that ended, read forward by seq.
  statements("4_agent_events", [
    `CREATE TABLE IF NOT EXISTS agent_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      at TEXT NOT NULL,
      body TEXT NOT NULL)`,
  ]),
  // B-141: the newest revision each knowledge endpoint answered with, and when (ms), so a held message is
  // answered again at once when its knowledge changes, and not at all while it stays the same.
  statements("5_agent_facts", [
    `CREATE TABLE IF NOT EXISTS agent_facts (
      endpoint TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      seen_at INTEGER NOT NULL)`,
  ]),
  // B-152: a judge comparison over one address's sent answers: one row per answer and model, holding a
  // verdict line with no words of the mail (hashes, marks, cost, time), filled a slice per call.
  statements("6_judge_bench", [
    `CREATE TABLE IF NOT EXISTS judge_bench (
      address TEXT NOT NULL,
      run_id TEXT NOT NULL,
      model TEXT NOT NULL,
      line TEXT,
      PRIMARY KEY (address, run_id, model))`,
  ]),
  // B-199 step 4: eval tickets per agent, one per source run at most (a removed one is kept, so it is not made again).
  statements("7_agent_evals", [
    `CREATE TABLE IF NOT EXISTS agent_evals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_run TEXT UNIQUE,
      body TEXT NOT NULL,
      removed_at TEXT,
      created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS agent_evals_by_agent ON agent_evals(agent_id, created_at)`,
  ]),
  // B-237 gap 8: conversations handed to a sales agent, one row per key (workers/agents/leads.ts): read every
  // LEAD_POLL_MS until closed, the owner's replies delivered in the conversation.
  statements("8_agent_leads", [
    `CREATE TABLE IF NOT EXISTS agent_leads (
      key TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      email_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      grant_name TEXT NOT NULL,
      lead_id TEXT,
      state TEXT NOT NULL,
      delivered TEXT NOT NULL DEFAULT '[]',
      next_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      closed_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS agent_leads_open ON agent_leads(closed_at, next_at)`,
    `CREATE INDEX IF NOT EXISTS agent_leads_by_thread ON agent_leads(mailbox_id, thread_id)`,
  ]),
];
