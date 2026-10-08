import { INCOMING_SCHEMA } from "../actions/incoming";
import { OUTBOX_SCHEMA } from "../actions/outbox-store";
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Migration {
	name: string;
	/** Static SQL; or, for a change that depends on what is there, `run` (one transaction, like `sql`). */
	sql: string;
	run?: (sql: SqlStorage) => void;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			if (migration.run) migration.run(sql);
			else sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{ name: "9_durable_outbox", sql: OUTBOX_SCHEMA },
  { name: "10_incoming_receipts", sql: INCOMING_SCHEMA },
	{
		// SP-1: why a message is in Spam (a rule, the model, or the operator); NULL elsewhere.
		name: "11_spam_reason",
		sql: txn(`ALTER TABLE emails ADD COLUMN spam_reason TEXT;`),
	},
	{
		// SP-5: when a message entered Spam; its 30 days count from here, not from its arrival.
		// Mail already in Spam (moved there by hand before 0.6) starts its 30 days now.
		name: "12_spam_at",
		sql: txn(`ALTER TABLE emails ADD COLUMN spam_at TEXT;
            UPDATE emails SET spam_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE folder_id = 'spam';`),
	},
	{
		// A body larger than a row can hold lives in R2 under this key; the row keeps its start.
		name: "13_body_key",
		sql: txn(`ALTER TABLE emails ADD COLUMN body_key TEXT;`),
	},
	{
		// Each journal event waits for its own next attempt, and gives up after a bound, so one
		// that always fails no longer holds back every event behind it (reliability audit H2).
		name: "14_incoming_backoff",
		sql: txn(`ALTER TABLE incoming_receipts ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE incoming_receipts ADD COLUMN last_error TEXT;`),
	},
	{
		// 'owed' until the forwarding copy of a delivery was attempted, so a delivery cut off
		// after storing still sends its copy when Cloudflare retries it (reliability audit M1).
		name: "15_forward_status",
		sql: txn(`ALTER TABLE incoming_receipts ADD COLUMN forward_status TEXT;`),
	},
	{
		// B-52: a draft is changed in place; each save raises its revision, so a save that read an
		// older one is refused instead of overwriting another window's or an agent's change. NULL
		// (drafts saved before) reads as revision 1.
		name: "16_draft_revision",
		sql: txn(`ALTER TABLE emails ADD COLUMN draft_revision INTEGER;`),
	},
	{
		// Discarded (operator, 2026-10-06): mail thrown away on purpose, kept apart from Trash and Spam
		// for 30 days, with why (the person, or a discard rule on arrival) and since when. A folder the
		// person had already named "Discarded" keeps its mail under a new name, so the two never mix.
		name: "17_discarded",
		sql: txn(`UPDATE folders SET name = 'Discarded (your folder)' WHERE name = 'Discarded' AND id <> 'discarded';
            INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('discarded', 'Discarded', 0);
            ALTER TABLE emails ADD COLUMN discard_reason TEXT;
            ALTER TABLE emails ADD COLUMN discarded_at TEXT;`),
	},
	{
		// 17 missed the folder a person made before 0.12 by the name "Discarded" (or "discarded!" —
		// any name the folder API turned into the id 'discarded'): it kept the id, stayed deletable,
		// and their mail read as discarded. Their folder moves to its own id with their mail; the id
		// becomes the system folder again. A system folder deleted meanwhile is made again.
		name: "18_discarded_system_folder",
		sql: "",
		run: repairDiscardedFolder,
	},
	{
		// The name a message gave its sender, kept beside the address (shared/mail/sender.ts).
		name: "19_sender_name",
		sql: txn(`ALTER TABLE emails ADD COLUMN sender_name TEXT;`),
	},
];

/** The id and name a person's own folder gets when it held the id 'discarded' (migration 18). */
export const OWN_DISCARDED_FOLDER = { id: "discarded-yours", name: "Discarded (your folder)" };

function repairDiscardedFolder(sql: SqlStorage) {
	const folders = [...sql.exec<{ id: string; name: string; is_deletable: number }>("SELECT id, name, is_deletable FROM folders")];
	const ids = new Set(folders.map((f) => f.id));
	const names = new Set(folders.map((f) => f.name));
	const free = (base: string, taken: Set<string>, join: (n: number) => string) => {
		if (!taken.has(base)) return base;
		for (let n = 2; ; n++) if (!taken.has(join(n))) return join(n);
	};
	const held = folders.find((f) => f.id === "discarded");
	if (held && held.is_deletable !== 0) {
		const id = free(OWN_DISCARDED_FOLDER.id, ids, (n) => `${OWN_DISCARDED_FOLDER.id}-${n}`);
		// The name they gave it stays theirs, unless it is the system folder's own.
		names.delete(held.name);
		const name = held.name === "Discarded" ? free(OWN_DISCARDED_FOLDER.name, names, (n) => `Discarded (your folder ${n})`) : held.name;
		sql.exec("UPDATE folders SET name = ? WHERE id = 'discarded'", "\u0001discarded-repair");
		sql.exec("INSERT INTO folders (id, name, is_deletable) VALUES (?, ?, 1)", id, name);
		names.add(name);
		// Their mail never had a discard date (the column came with 17); what a discard put there since has one.
		sql.exec("UPDATE emails SET folder_id = ? WHERE folder_id = 'discarded' AND discarded_at IS NULL", id);
	}
	// Another folder renamed to "Discarded" since 17 keeps its mail under a free name.
	for (const f of folders) {
		if (f.id === "discarded" || f.name !== "Discarded") continue;
		names.delete(f.name);
		const name = free(OWN_DISCARDED_FOLDER.name, names, (n) => `Discarded (your folder ${n})`);
		sql.exec("UPDATE folders SET name = ? WHERE id = ?", name, f.id);
		names.add(name);
	}
	if (held) sql.exec("UPDATE folders SET name = 'Discarded', is_deletable = 0 WHERE id = 'discarded'");
	else sql.exec("INSERT INTO folders (id, name, is_deletable) VALUES ('discarded', 'Discarded', 0)");
}
