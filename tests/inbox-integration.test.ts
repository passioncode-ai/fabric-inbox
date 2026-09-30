import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
const bundle = await build({ stdin: { contents: `
  import { Hono } from 'hono';
  import { inboxRouter } from './workers/routes/inbox';
  export { MailboxDO } from './workers/durableObject/index';
  const app = new Hono();
  app.post('/seed', async c => {
    const input = await c.req.json();
    await c.env.BUCKET.put('mailboxes/' + input.account + '.json', '{}');
    const mailbox = c.env.MAILBOX.getByName(input.account);
    for (const row of input.messages) await mailbox.createEmail(row.folder, row, []);
    return c.json({ok:true});
  });
  app.route('/', inboxRouter);
  export default app;
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], target: 'es2022' });
test('HTTP unified inbox uses real R2 account discovery and DO SQL date, folder, search, keyset filters', async () => {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { MAILBOX: { className: 'MailboxDO', useSQLite: true } }, r2Buckets: ['BUCKET'] });
  try {
    for (const account of ['a@example.invalid', 'b@example.invalid']) {
      const messages = [
        { id: 'same', folder: 'inbox', date: '2026-01-03T00:00:00.123Z', subject: 'Needle', starred: true },
        { id: 'older', folder: 'inbox', date: '2026-01-01T00:00:00.000Z', subject: 'Other' },
        { id: 'trash', folder: 'trash', date: '2026-01-05T00:00:00.000Z', subject: 'Trash', starred: true },
      ].map(row => ({ ...row, sender: 'sender@example.invalid', recipient: account, body: 'Fixture' }));
      const seeded = await mf.dispatchFetch('http://localhost/seed', { method: 'POST', body: JSON.stringify({ account, messages }) });
      assert.equal(seeded.status, 200);
    }
    const get = async (params: Record<string, string>) => {
      const response = await mf.dispatchFetch('http://localhost/api/inbox?' + new URLSearchParams(params));
      assert.equal(response.status, 200); return response.json() as Promise<any>;
    };
    const first = await get({ limit: '1' });
    assert.equal(first.accounts.length, 2); assert.equal(first.issues.length, 0);
    assert.equal(first.messages[0].accountId, 'cloudflare:a@example.invalid');
    assert.equal(first.messages[0].timestamp, Date.parse('2026-01-03T00:00:00.123Z'));
    const second = await get({ limit: '1', cursor: first.cursor });
    assert.equal(second.messages[0].accountId, 'cloudflare:b@example.invalid');
    const third = await get({ limit: '1', cursor: second.cursor });
    assert.equal(third.messages[0].providerMessageId, 'older');
    const filtered = await get({ account: 'cloudflare:b@example.invalid', query: 'needle' });
    assert.equal(filtered.messages.length, 1); assert.equal(filtered.messages[0].subject, 'Needle');
    assert.equal((await get({ folder: 'starred' })).messages.length, 2);
    assert.equal((await get({ folder: 'trash' })).messages.length, 2);
    assert.equal((await get({ query: "' OR 1=1 --" })).messages.length, 0);
    const missing = await mf.dispatchFetch('http://localhost/api/inbox?account=cloudflare:unknown@example.invalid');
    assert.equal(missing.status, 404);
  } finally { await mf.dispose(); }
});

test('REQ-T1: DO rows carry triage from stored headers, a text snippet, and the unread filter pages completely', async () => {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { MAILBOX: { className: 'MailboxDO', useSQLite: true } }, r2Buckets: ['BUCKET'] });
  try {
    const account = 'me@example.invalid';
    const messages = [
      { id: 'person', folder: 'inbox', date: '2026-01-04T00:00:00.000Z', subject: 'Lunch?', sender: 'ann@friend.invalid', body: '<p>Are you <b>free</b>&nbsp;today?</p><style>p{}</style>' },
      { id: 'news', folder: 'inbox', date: '2026-01-03T00:00:00.000Z', subject: 'Weekly digest', sender: 'digest@news.invalid', body: 'News',
        raw_headers: JSON.stringify([{ key: 'list-unsubscribe', value: '<mailto:u@news.invalid>' }]) },
      { id: 'read', folder: 'inbox', date: '2026-01-02T00:00:00.000Z', subject: 'Seen', sender: 'bob@friend.invalid', body: 'Old', read: true },
      { id: 'person2', folder: 'inbox', date: '2026-01-01T00:00:00.000Z', subject: 'Question', sender: 'cy@friend.invalid', body: 'Hi' },
    ].map(row => ({ ...row, recipient: account }));
    await mf.dispatchFetch('http://localhost/seed', { method: 'POST', body: JSON.stringify({ account, messages }) });
    const get = async (params: Record<string, string>) => (await mf.dispatchFetch('http://localhost/api/inbox?' + new URLSearchParams(params))).json() as Promise<any>;
    const all = await get({});
    const byId = Object.fromEntries(all.messages.map((m: any) => [m.providerMessageId, m]));
    assert.deepEqual([byId.person.triage.group, byId.person.triage.importance], ['people', 'important']);
    assert.deepEqual([byId.news.triage.group, byId.news.triage.importance], ['newsletters', 'low']);
    assert.deepEqual([byId.read.triage.group, byId.read.triage.importance], ['people', 'normal']);
    assert.equal(byId.person.snippet, 'Are you free today?', 'snippets are text, not HTML');
    assert.equal('raw_headers' in byId.news, false, 'raw headers never reach the client');
    const unread1 = await get({ unread: '1', limit: '2' });
    assert.deepEqual(unread1.messages.map((m: any) => m.providerMessageId), ['person', 'news']);
    const unread2 = await get({ unread: '1', limit: '2', cursor: unread1.cursor });
    assert.deepEqual(unread2.messages.map((m: any) => m.providerMessageId), ['person2']);
    const crossScope = await mf.dispatchFetch('http://localhost/api/inbox?' + new URLSearchParams({ cursor: unread1.cursor }));
    assert.equal(crossScope.status, 400, 'an unread cursor cannot page the full list');
  } finally { await mf.dispose(); }
});

test('CF-1: each account carries its unread count on the first page, and a domain selects all its addresses', async () => {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { MAILBOX: { className: 'MailboxDO', useSQLite: true } }, r2Buckets: ['BUCKET'] });
  try {
    const seed = async (account: string, rows: { id: string; read?: boolean }[]) =>
      mf.dispatchFetch('http://localhost/seed', { method: 'POST', body: JSON.stringify({ account, messages: rows.map((r, i) => ({ ...r, folder: 'inbox', date: `2026-01-0${i + 1}T00:00:00.000Z`, subject: r.id, sender: 'a@x.invalid', recipient: account, body: 'b' })) }) });
    await seed('support@one.invalid', [{ id: 's1' }, { id: 's2' }, { id: 's3', read: true }]);
    await seed('sales@one.invalid', [{ id: 'l1', read: true }]);
    await seed('hi@two.invalid', [{ id: 't1' }]);
    const get = async (params: Record<string, string>) => (await mf.dispatchFetch('http://localhost/api/inbox?' + new URLSearchParams(params))).json() as Promise<any>;
    const all = await get({ limit: '2' });
    const unread = Object.fromEntries(all.accounts.map((a: any) => [a.email, a.unread]));
    assert.deepEqual(unread, { 'support@one.invalid': 2, 'sales@one.invalid': 0, 'hi@two.invalid': 1 });
    const page2 = await get({ limit: '2', cursor: all.cursor });
    assert.ok(page2.accounts.every((a: any) => a.unread === undefined), 'later pages skip the counts');
    const one = await get({ domain: 'one.invalid' });
    assert.deepEqual([...new Set(one.messages.map((m: any) => m.accountId))].sort(), ['cloudflare:sales@one.invalid', 'cloudflare:support@one.invalid']);
    const bad = await mf.dispatchFetch('http://localhost/api/inbox?domain=' + encodeURIComponent('not a domain'));
    assert.equal(bad.status, 400);
    const mixed = await mf.dispatchFetch('http://localhost/api/inbox?' + new URLSearchParams({ domain: 'two.invalid', cursor: all.cursor }));
    assert.equal(mixed.status, 400, 'a cursor from another scope is refused');
  } finally { await mf.dispose(); }
});
