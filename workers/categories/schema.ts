// Schema versions of CategoriesDO. Append only; see workers/lib/do-schema.ts.
import { statements, type SchemaStep } from "../lib/do-schema";

/** The schema as released before versioning (B-32); frozen. */
const INITIAL = [
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL,
     seen_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS verdicts (category_id TEXT NOT NULL, version INTEGER NOT NULL, account_id TEXT NOT NULL,
     message_id TEXT NOT NULL, matched INTEGER NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL, timestamp INTEGER NOT NULL,
     subject TEXT NOT NULL, sender TEXT NOT NULL, classified_at INTEGER NOT NULL,
     PRIMARY KEY (category_id, account_id, message_id))`,
  `CREATE INDEX IF NOT EXISTS verdicts_page ON verdicts(category_id, matched, timestamp DESC, account_id, message_id)`,
  `CREATE INDEX IF NOT EXISTS verdicts_by_message ON verdicts(account_id, message_id)`,
  // One row per message and target: '*' = every screened category (new mail), or one
  // category id (its first classification). next_at is when it may run again.
  `CREATE TABLE IF NOT EXISTS queue (account_id TEXT NOT NULL, message_id TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL,
     enqueued_at INTEGER NOT NULL, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
     PRIMARY KEY (account_id, message_id, target))`,
  `CREATE INDEX IF NOT EXISTS queue_due ON queue(next_at)`,
  `CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)`,
  // SP-2: one spam answer per message, and its own daily budget.
  `CREATE TABLE IF NOT EXISTS spam_checks (account_id TEXT NOT NULL, message_id TEXT NOT NULL, verdict TEXT NOT NULL,
     reason TEXT NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (account_id, message_id))`,
  `CREATE TABLE IF NOT EXISTS spam_budget (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS backfills (category_id TEXT PRIMARY KEY, version INTEGER NOT NULL, total INTEGER NOT NULL,
     done INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];

export const CATEGORIES_STEPS: readonly SchemaStep[] = [
  statements("1_initial", INITIAL),
];
