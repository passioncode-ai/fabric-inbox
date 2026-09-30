import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { addColumn, checkSteps, migrateSchema, statements, type SchemaStep } from '../workers/lib/do-schema';
import { AGENT_REGISTRY_STEPS } from '../workers/agents/schema';
import { KNOWLEDGE_STEPS } from '../workers/knowledge/schema';
import { CATEGORIES_STEPS } from '../workers/categories/schema';

/** node:sqlite shaped like a Durable Object's storage: one statement per exec, JS transactions. */
function storage() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...args: unknown[]) { return db.prepare(query).all(...(args as never[])) as Record<string, unknown>[]; } };
  return {
    db, sql,
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN');
      try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
const quiet = <T>(fn: () => T): T => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { [console.log, console.warn, console.error] = saved; }
};
const steps = (s: ReturnType<typeof storage>) => s.db.prepare('SELECT name FROM schema_steps ORDER BY name').all().map((r) => r.name);

for (const [label, list] of [['AgentRegistryDO', AGENT_REGISTRY_STEPS], ['KnowledgeDO', KNOWLEDGE_STEPS], ['CategoriesDO', CATEGORIES_STEPS]] as const) {
  test(`${label}: a new object runs every step once, and a restart runs none`, () => {
    const s = storage();
    assert.deepEqual(quiet(() => migrateSchema(s, list, label)).applied, list.map((x) => x.name));
    assert.deepEqual(quiet(() => migrateSchema(s, list, label)), { applied: [], unknown: [] });
    assert.deepEqual(steps(s), list.map((x) => x.name).sort());
  });

  test(`${label}: an object deployed before versioning keeps its data and records step 1 without change`, () => {
    const s = storage();
    // The release before B-32 ran the same CREATE statements on every start.
    list[0].run(s.sql);
    const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const first = tables.find((t) => !String(t).includes('fts'))!;
    const before = s.db.prepare(`SELECT COUNT(*) AS n FROM ${first}`).get()!.n;
    quiet(() => migrateSchema(s, list, label));
    assert.deepEqual(s.db.prepare(`SELECT COUNT(*) AS n FROM ${first}`).get()!.n, before);
    assert.deepEqual(steps(s), list.map((x) => x.name).sort());
  });
}

test('AgentRegistryDO: queue rows from before next_at existed get it, with their data', () => {
  const s = storage();
  AGENT_REGISTRY_STEPS[0].run(s.sql);
  s.db.prepare('INSERT INTO agent_queue (mailbox_id, email_id, enqueued_at) VALUES (?, ?, ?)').run('a@x.invalid', 'm1', 5);
  quiet(() => migrateSchema(s, AGENT_REGISTRY_STEPS, 'AgentRegistryDO'));
  assert.deepEqual({ ...s.db.prepare('SELECT email_id, enqueued_at, next_at FROM agent_queue').get() }, { email_id: 'm1', enqueued_at: 5, next_at: 0 });
});

test('AgentRegistryDO: an object that added next_at itself in 0.6.1 upgrades without an error', () => {
  const s = storage();
  AGENT_REGISTRY_STEPS[0].run(s.sql);
  s.db.exec('ALTER TABLE agent_queue ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0');
  assert.deepEqual(quiet(() => migrateSchema(s, AGENT_REGISTRY_STEPS, 'AgentRegistryDO')).applied, ['1_initial', '2_agent_queue_next_at']);
});

test('a step that fails leaves nothing behind, is not recorded, and runs again on the next start', () => {
  const s = storage();
  let broken = true;
  const list: SchemaStep[] = [
    statements('1_initial', ['CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)']),
    { name: '2_half', run: (sql) => { sql.exec('CREATE TABLE half (id TEXT)'); if (broken) throw new Error('cut off'); } },
  ];
  assert.throws(() => quiet(() => migrateSchema(s, list, 'T')), /cut off/);
  assert.deepEqual(steps(s), ['1_initial']);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half'").get()!.n, 0);
  broken = false;
  assert.deepEqual(quiet(() => migrateSchema(s, list, 'T')).applied, ['2_half']);
});

test('steps recorded by a newer release are reported, not run and not an error', () => {
  const s = storage();
  const newer = [...AGENT_REGISTRY_STEPS, statements('3_future', ['CREATE TABLE future (id TEXT)'])];
  quiet(() => migrateSchema(s, newer, 'AgentRegistryDO'));
  assert.deepEqual(quiet(() => migrateSchema(s, AGENT_REGISTRY_STEPS, 'AgentRegistryDO')), { applied: [], unknown: ['3_future'] });
});

test('a step list must be numbered from 1 without gaps', () => {
  assert.throws(() => checkSteps([statements('2_x', [])]), /expected "1_<what>"/);
  assert.throws(() => checkSteps([statements('1_a', []), statements('1_b', [])]), /expected "2_<what>"/);
  assert.throws(() => checkSteps([statements('1_Bad-Name', [])]), /expected/);
  for (const list of [AGENT_REGISTRY_STEPS, KNOWLEDGE_STEPS, CATEGORIES_STEPS]) checkSteps(list);
});

test('addColumn adds a missing column once', () => {
  const s = storage();
  s.db.exec('CREATE TABLE t (id TEXT)');
  addColumn(s.sql, 't', 'x', 'INTEGER NOT NULL DEFAULT 7');
  addColumn(s.sql, 't', 'x', 'INTEGER NOT NULL DEFAULT 7');
  assert.deepEqual(s.db.prepare('PRAGMA table_info(t)').all().map((c) => c.name), ['id', 'x']);
});
