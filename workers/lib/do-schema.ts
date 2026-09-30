/**
 * Schema versions for the SQLite Durable Objects other than the mailbox (B-32).
 *
 * Each object keeps the names of the steps it has run in `schema_steps`. A step runs once, inside
 * one storage transaction together with its record, so a step that fails leaves nothing behind
 * and is tried again on the next start. Steps are only ever appended: a released step is never
 * renamed, reordered or edited, because deployed objects have already recorded it.
 *
 * Step 1 of every list is the schema as it stood before versioning, written with
 * `IF NOT EXISTS`, so an object deployed earlier records it without change.
 */

/** The part of `SqlStorage` this module uses; `node:sqlite` stands in for it in tests. */
export interface SchemaSql {
  exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
}

export interface SchemaStorage {
  sql: SchemaSql;
  transactionSync<T>(closure: () => T): T;
}

export interface SchemaStep {
  /** `<n>_<what>`, numbered from 1 without gaps. */
  name: string;
  run(sql: SchemaSql): void;
}

export interface SchemaResult {
  applied: string[];
  /** Steps recorded by a newer release that this code does not know (a downgrade). */
  unknown: string[];
}

/** A step made of single SQL statements, run in order. */
export function statements(name: string, list: readonly string[]): SchemaStep {
  return { name, run: (sql) => { for (const statement of list) sql.exec(statement); } };
}

/** Adds a column unless it is already there (an object that added it before versioning). */
export function addColumn(sql: SchemaSql, table: string, column: string, definition: string): void {
  const columns = [...sql.exec(`PRAGMA table_info(${table})`)].map((c) => String(c.name));
  if (!columns.includes(column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Checks a step list is well formed; a malformed list is a programming error, caught by tests. */
export function checkSteps(steps: readonly SchemaStep[]): void {
  steps.forEach((step, i) => {
    const match = /^(\d+)_[a-z0-9_]+$/.exec(step.name);
    if (!match || Number(match[1]) !== i + 1) throw new Error(`schema step ${i + 1} is named "${step.name}"; expected "${i + 1}_<what>"`);
  });
}

/** Runs every step this object has not run yet, each in its own transaction. */
export function migrateSchema(storage: SchemaStorage, steps: readonly SchemaStep[], label: string): SchemaResult {
  checkSteps(steps);
  const { sql } = storage;
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_steps (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const done = new Set([...sql.exec(`SELECT name FROM schema_steps`)].map((r) => String(r.name)));
  const applied: string[] = [];
  for (const step of steps) {
    if (done.has(step.name)) continue;
    try {
      storage.transactionSync(() => {
        step.run(sql);
        sql.exec(`INSERT INTO schema_steps (name, applied_at) VALUES (?, ?)`, step.name, Date.now());
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "schema.step_failed", object: label, step: step.name, error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
    applied.push(step.name);
  }
  const known = new Set(steps.map((s) => s.name));
  const unknown = [...done].filter((name) => !known.has(name)).sort();
  if (applied.length) console.log(JSON.stringify({ event: "schema.applied", object: label, steps: applied }));
  if (unknown.length) console.warn(JSON.stringify({ event: "schema.newer_than_code", object: label, steps: unknown }));
  return { applied, unknown };
}
