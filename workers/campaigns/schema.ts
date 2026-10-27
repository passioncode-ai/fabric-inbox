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
  // B-181 step 2: sending. Each recipient keeps the conversation its first message started (thread and Message-ID,
  // so follow-ups answer in it); every send is a row (the rolling daily cap per account, the report); each account
  // keeps when it may send next and when it first sent (the ramp-up).
  statements("2_sending", [
    `ALTER TABLE recipients ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE recipients ADD COLUMN rfc_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE recipients ADD COLUMN subject TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS recipients_due ON recipients(status, next_at)`,
    `ALTER TABLE campaigns ADD COLUMN reason TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE campaigns ADD COLUMN launched_at INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS sends (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, email TEXT NOT NULL, step INTEGER NOT NULL,
       sender TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX IF NOT EXISTS sends_sender ON sends(sender, at)`,
    `CREATE INDEX IF NOT EXISTS sends_campaign ON sends(campaign_id, at)`,
    `CREATE TABLE IF NOT EXISTS senders (sender TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL DEFAULT 0)`,
  ]),
];
