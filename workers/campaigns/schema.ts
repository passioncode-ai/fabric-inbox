// Schema versions of CampaignsDO (B-181). Append only; see workers/lib/do-schema.ts.
import { statements, type SchemaStep } from "../lib/do-schema";

export const CAMPAIGNS_STEPS: readonly SchemaStep[] = [
  statements("1_initial", [
    `CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    // One row per campaign and address: its fields, where it stands (queued, then sent per step, replied, stopped...)
    // and when its next step is due (step 2 of the plan sends from here).
    `CREATE TABLE IF NOT EXISTS recipients (campaign_id TEXT NOT NULL, email TEXT NOT NULL, fields TEXT NOT NULL, status TEXT NOT NULL,
       step INTEGER NOT NULL DEFAULT 0, next_at INTEGER, added_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '',
       PRIMARY KEY (campaign_id, email))`,
    `CREATE INDEX IF NOT EXISTS recipients_status ON recipients(campaign_id, status, added_at)`,
    // The workspace's do-not-write list: an address, or a domain (and every domain under it).
    `CREATE TABLE IF NOT EXISTS suppression (value TEXT PRIMARY KEY, reason TEXT NOT NULL, added_at INTEGER NOT NULL)`,
  ]),
];
