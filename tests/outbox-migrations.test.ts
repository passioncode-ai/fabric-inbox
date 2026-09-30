import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, mailboxMigrations } from '../workers/durableObject/migrations';

test('mailbox migration rollback is atomic and successful migrations are repeatable', () => {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...args: any[]) {
    if (!args.length && query.includes(';')) { db.exec(query); return []; }
    return db.prepare(query).all(...args);
  } };
  const storage = { transactionSync<T>(fn: () => T): T {
    db.exec('BEGIN');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  const run = (migrations: any[]) => applyMigrations(sql as any, migrations, storage);
  assert.throws(() => run([{name:'broken', sql:'CREATE TABLE should_rollback (id TEXT); INVALID SQL;'}]));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").all().length, 0);
  assert.equal(db.prepare("SELECT name FROM d1_migrations WHERE name='broken'").all().length, 0);
  run(mailboxMigrations);
  run(mailboxMigrations);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get()?.n, mailboxMigrations.length);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='incoming_receipts'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='outbox'").get());
  db.close();
});

test('upgrading a mailbox with mail already in Spam starts its 30 days at the upgrade, not at its arrival (12_spam_at)', () => {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...args: any[]) {
    if (!args.length && query.includes(';')) { db.exec(query); return []; }
    return db.prepare(query).all(...args);
  } };
  const storage = { transactionSync<T>(fn: () => T): T {
    db.exec('BEGIN');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  const upTo = mailboxMigrations.findIndex((m) => m.name === '12_spam_at');
  assert.ok(upTo > 0);
  applyMigrations(sql as any, mailboxMigrations.slice(0, upTo), storage);
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  db.prepare("INSERT INTO emails (id, folder_id, subject, date) VALUES ('a', 'spam', 'moved by hand in 0.5', ?), ('b', 'inbox', 'kept', ?)").run(old, old);
  applyMigrations(sql as any, mailboxMigrations, storage);
  const rows = db.prepare('SELECT id, spam_at FROM emails ORDER BY id').all() as { id: string; spam_at: string | null }[];
  assert.ok(Date.now() - Date.parse(rows[0].spam_at!) < 60_000, 'its clock starts now');
  assert.equal(rows[1].spam_at, null);
  db.close();
});
