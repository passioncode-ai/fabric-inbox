import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlOutboxStore, OUTBOX_SCHEMA } from '../workers/actions/outbox-store';
import { OutboxCoordinator, IdempotencyConflict } from '../workers/actions/outbox';

const payload = { to: 'recipient@example.invalid', body: 'private mail content' };
function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  const sql = { exec(query: string, ...args: any[]) {
    if (!args.length && query.includes(';')) { db.exec(query); return []; }
    return db.prepare(query).all(...args);
  } };
  db.exec(OUTBOX_SCHEMA);
  const store = new SqlOutboxStore(sql, fn => {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  });
  return { db, store };
}
function fixture(options: { transport?: any; project?: any; store?: any } = {}) {
  const { store, db } = options.store ? { store: options.store, db: null } : database();
  let sends = 0, projections = 0;
  const coordinator = new OutboxCoordinator(store, {
    transport: async (...args: any[]) => { sends++; return options.transport ? options.transport(...args) : { messageId: '<actual@cloudflare.invalid>' }; },
    project: async (...args: any[]) => { projections++; if (options.project) await options.project(...args); },
    beforeEffect: async () => {},
  });
  return { coordinator, store, db, counts: () => ({ sends, projections }) };
}

test('definite rejection never creates Sent projection', async () => {
  const f = fixture({ transport: () => { throw Object.assign(new Error('private provider text'), { code: 'E_SENDER_NOT_VERIFIED' }); } });
  const result = await f.coordinator.submit('a', 'key', payload);
  assert.equal(result.status, 'failed');
  assert.deepEqual(f.counts(), { sends: 1, projections: 0 });
  assert.equal(result.errorCode, 'E_SENDER_NOT_VERIFIED');
});
test('same key replays receipt and different payload conflicts', async () => {
  const f = fixture();
  const first = await f.coordinator.submit('a', 'key', payload);
  assert.deepEqual(await f.coordinator.submit('a', 'key', payload), first);
  await assert.rejects(f.coordinator.submit('a', 'key', { ...payload, to: 'other@example.invalid' }), IdempotencyConflict);
  assert.equal(f.counts().sends, 1);
});
test('concurrent callers have one effect', async () => {
  const f = fixture({ transport: async () => { await new Promise(r => setTimeout(r, 20)); return { messageId: 'accepted@cloudflare.invalid' }; } });
  const results = await Promise.all(Array.from({ length: 12 }, () => f.coordinator.submit('a', 'key', payload)));
  assert.equal(f.counts().sends, 1);
  assert.ok(results.every(r => r.id === results[0].id && r.status === 'accepted'));
});
test('interrupted sending survives database reopen as unknown, never resend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  try {
    const path = join(dir, 'outbox.sqlite');
    const first = database(path);
    const item = first.store.reserve('a', 'key', 'hash', payload);
    first.store.claim(item.id);
    first.db.close();
    const next = database(path);
    next.store.recoverInterrupted();
    const f = fixture({ store: next.store });
    const result = await f.coordinator.process(item.id);
    assert.equal(result.status, 'unknown');
    assert.equal(f.counts().sends, 0);
    next.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('acceptance persists before projection failure; retry only repairs projection', async () => {
  let fail = true;
  const f = fixture({ project: () => { if (fail) throw new Error('storage unavailable'); } });
  const first = await f.coordinator.submit('a', 'key', payload);
  assert.equal(first.status, 'accepted');
  assert.equal(first.projectionStatus, 'pending');
  assert.equal(first.providerMessageId, '<actual@cloudflare.invalid>');
  fail = false;
  const second = await f.coordinator.submit('a', 'key', payload);
  assert.equal(second.projectionStatus, 'complete');
  assert.deepEqual(f.counts(), { sends: 1, projections: 2 });
});
test('mailboxes isolate identical idempotency keys', async () => {
  const f = fixture();
  const a = await f.coordinator.submit('a', 'key', payload);
  const b = await f.coordinator.submit('b', 'key', payload);
  assert.notEqual(a.id, b.id);
  assert.equal(f.counts().sends, 2);
  assert.equal(f.store.list('a').length, 1);
});
test('ambiguous delivery and missing receipt become unknown without resend', async () => {
  for (const transport of [() => { throw new Error('timeout'); }, () => { throw Object.assign(new Error('partial delivery'), { code: 'E_DELIVERY_FAILED' }); }, () => ({})]) {
    const f = fixture({ transport });
    assert.equal((await f.coordinator.submit('a', 'key', payload)).status, 'unknown');
    assert.equal((await f.coordinator.submit('a', 'key', payload)).status, 'unknown');
    assert.equal(f.counts().sends, 1);
  }
});
test('journal contains no body or arbitrary provider error text', async () => {
  const f = fixture({ transport: () => { throw new Error('private provider text'); } });
  await f.coordinator.submit('a', 'secret-key-value', payload);
  const journal = JSON.stringify(f.store.list('a'));
  for (const secret of ['private mail content', 'private provider text', 'secret-key-value', 'recipient@example.invalid']) assert.ok(!journal.includes(secret));
});
test('durable pending payload can recover; payload chunks handle large attachment content', async () => {
  const f = fixture();
  const item = f.store.reserve('a', 'key', 'hash', { data: 'a'.repeat(3 * 1024 * 1024) });
  assert.equal(f.store.payload(item.id).data.length, 3 * 1024 * 1024);
  assert.equal((await f.coordinator.process(item.id)).status, 'accepted');
});
test('atomic send cap counts attempted effects, including unknown outcomes', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 21 }, (_, n) => f.coordinator.submit('a', `key-${n}`, payload)));
  assert.equal(results.filter(r => r.status === 'accepted').length, 20);
  assert.equal(results.filter(r => r.errorCode === 'RATE_LIMIT').length, 1);
  assert.equal(f.counts().sends, 20);
});

test('two coordinators sharing SQLite cannot claim the same effect', async () => {
  const db = database();
  const a = fixture({ store: db.store, transport: async () => { await new Promise(r => setTimeout(r, 10)); return { messageId: 'receipt@cloudflare.invalid' }; } });
  const b = fixture({ store: db.store });
  await Promise.all([a.coordinator.submit('a', 'key', payload), b.coordinator.submit('a', 'key', payload)]);
  assert.equal(a.counts().sends + b.counts().sends, 1);
});

test('recovered old pending items count against the current send cap', async () => {
  const db = database();
  const f = fixture({ store: db.store });
  const items = Array.from({ length: 21 }, (_, n) => db.store.reserve('a', 'old-' + n, 'hash', payload));
  db.db.prepare('UPDATE outbox SET created_at = ?').run(Date.now() - 2 * 86400000);
  const results = await Promise.all(items.map(item => f.coordinator.process(item.id)));
  assert.equal(results.filter(r => r.status === 'accepted').length, 20);
});

test('receipt persistence failure cannot turn accepted transport into a second send', async () => {
  const db = database();
  const original = db.store.finish.bind(db.store);
  db.store.finish = (id, state, receipt, code) => {
    if (state === 'accepted') throw new Error('receipt disk error');
    return original(id, state, receipt, code);
  };
  const f = fixture({store: db.store});
  const first = await f.coordinator.submit('a', 'key', payload);
  assert.equal(first.status, 'unknown');
  assert.equal(first.errorCode, 'RECEIPT_PERSISTENCE_FAILED');
  assert.equal((await f.coordinator.submit('a', 'key', payload)).status, 'unknown');
  assert.equal(f.counts().sends, 1);
});
