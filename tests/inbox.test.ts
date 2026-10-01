import test from 'node:test';
import assert from 'node:assert/strict';
import { readInbox, inboxRouter } from '../workers/routes/inbox';
import { inboxPage, inboxIdentity, type InboxMessage, type InboxAccount, type InboxReadOptions } from '../shared/mail/inbox';
const accounts: InboxAccount[] = [
  { id: 'cloudflare:me@example.invalid', provider: 'cloudflare', email: 'me@example.invalid', name: 'Me', status: 'connected' },
  { id: 'gmail:a', provider: 'gmail', email: 'a@example.invalid', name: 'A', status: 'connected' },
  { id: 'gmail:b', provider: 'gmail', email: 'b@example.invalid', name: 'B', status: 'connected' },
];
function message(account: InboxAccount, id: string, timestamp: number): InboxMessage {
  return { id: inboxIdentity(account.id, id), accountId: account.id, provider: account.provider,
    providerMessageId: id, subject: 'Fixture', sender: 'sender@example.invalid', recipient: account.email,
    date: new Date(timestamp).toISOString(), timestamp, read: false, starred: false, snippet: '' };
}
function sources(rows: InboxMessage[]) {
  return { cloudflareAccounts: async () => structuredClone(accounts.slice(0, 1)), gmailAccounts: async () => structuredClone(accounts.slice(1)),
    messages: async (a: InboxAccount, o: InboxReadOptions) => inboxPage(rows.filter(m => m.accountId === a.id), o) };
}
test('merge has collision-free identities and keyset pages with ties, no repeats or omissions', async () => {
  const rows = accounts.flatMap(a => [message(a, 'same', 3000), message(a, 'older', 1000)]);
  const seen: InboxMessage[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) });
    const page = await readInbox(params, sources(rows));
    seen.push(...page.messages); cursor = page.cursor;
    assert.equal(page.hasMore, !!cursor);
  } while (cursor);
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen.map(m => m.id)).size, 6);
  assert.deepEqual(seen.map(m => m.timestamp), [3000, 3000, 3000, 1000, 1000, 1000]);
});
test('one-account filter limits reads but retains full selector; cursor cannot cross filters', async () => {
  const rows = accounts.flatMap(a => [message(a, 'new', 3000), message(a, 'old', 1000)]);
  const s = sources(rows), called: string[] = [];
  const read = s.messages;
  s.messages = async (a, o) => { called.push(a.id); return read(a, o); };
  const page = await readInbox(new URLSearchParams({ account: 'gmail:a', limit: '1' }), s);
  assert.equal(page.accounts.length, 3); assert.deepEqual(called, ['gmail:a']);
  await assert.rejects(readInbox(new URLSearchParams({ cursor: page.cursor!, account: 'gmail:b' }), s), /invalid_cursor/);
  await assert.rejects(readInbox(new URLSearchParams({ account: 'gmail:unknown' }), s), /account_not_found/);
});
test('failed account is explicit, safe, and does not block another account', async () => {
  const s = sources([message(accounts[0], 'one', 1)]);
  s.messages = async (a, o) => { if (a.provider === 'gmail') throw new Error('private upstream response'); return inboxPage([message(a, 'one', 1)], o); };
  const result = await readInbox(new URLSearchParams(), s);
  assert.equal(result.messages.length, 1); assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every(i => i.error === 'account_unavailable'));
  assert.ok(!JSON.stringify(result).includes('private'));
  s.gmailAccounts = async () => { throw new Error('provider down'); };
  const filtered = await readInbox(new URLSearchParams({ account: 'gmail:a' }), s);
  assert.equal(filtered.messages.length, 0); assert.equal(filtered.issues[0].provider, 'gmail');
});
test('new rows preceding cursor do not shift later pages', async () => {
  const rows = [message(accounts[0], 'new', 3000), message(accounts[0], 'old', 1000)];
  const first = await readInbox(new URLSearchParams({ limit: '1' }), sources(rows));
  rows.push(message(accounts[0], 'arrived', 5000));
  const second = await readInbox(new URLSearchParams({ limit: '1', cursor: first.cursor! }), sources(rows));
  assert.equal(second.messages[0].providerMessageId, 'old'); assert.equal(second.hasMore, false);
});
test('route rejects invalid filters and emits no-store', async () => {
  for (const query of ['folder=unknown', 'limit=101', 'limit=NaN', 'cursor=not-a-cursor']) {
    const result = await inboxRouter.request('https://mail.example.invalid/api/inbox?' + query, {}, {} as never);
    assert.equal(result.status, 400); assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});

test('the same email in two inboxes is one row naming both; one inbox shown alone keeps its own copy (audit F4)', async () => {
  const a = message(accounts[0], 'x1', 5000), b = message(accounts[1], 'x2', 5000), c = message(accounts[2], 'other', 4000);
  a.rfcMessageId = b.rfcMessageId = 'abc@mail.invalid';
  const all = await readInbox(new URLSearchParams(), sources([a, b, c]));
  assert.equal(all.messages.length, 2);
  const row = all.messages.find(m => m.rfcMessageId === 'abc@mail.invalid')!;
  assert.deepEqual([row.accountId, row.alsoIn], ['cloudflare:me@example.invalid', ['gmail:a']]);
  const one = await readInbox(new URLSearchParams({ account: 'gmail:a' }), sources([a, b, c]));
  assert.equal(one.messages[0].alsoIn, undefined);
});

test('a domain is its Cloudflare addresses; unread is counted for every inbox; a failed inbox keeps Load older (audit F15-F17)', async () => {
  const rows = accounts.map(a => message(a, 'm-' + a.id, 1000));
  const s: any = { ...sources(rows), unreadCount: async (a: InboxAccount) => a.id.length };
  const domain = await readInbox(new URLSearchParams({ domain: 'example.invalid' }), s);
  assert.deepEqual(domain.messages.map(m => m.accountId), ['cloudflare:me@example.invalid'], 'a Gmail account on the same domain is not in its group');
  assert.ok(domain.accounts.every(a => typeof a.unread === 'number'), 'every inbox gets its count, not only the ones read');
  const flaky: any = { ...sources(rows), messages: async (a: InboxAccount, o: InboxReadOptions) => { if (a.id === 'gmail:b') throw new Error('rate_limited'); return sources(rows).messages(a, o); } };
  const partial = await readInbox(new URLSearchParams({ limit: '5' }), flaky);
  assert.equal(partial.hasMore, true, 'the failed inbox may hold older mail');
  assert.equal(partial.issues.filter(i => i.accountId === 'gmail:b').length, 1, 'an inbox is reported once');
});

test('own domains reach triage through the read options (audit F13)', async () => {
  let seen: string[] | undefined;
  const s: any = { ...sources([]), messages: async (_a: InboxAccount, o: InboxReadOptions) => { seen = o.ownDomains; return []; } };
  await readInbox(new URLSearchParams(), s, { ownDomains: ['owner.invalid'] });
  assert.deepEqual(seen, ['owner.invalid']);
});

test('a hidden address is out of All inboxes, its domain and its counts, but opens alone; counts carry totals, stuck events and catch-alls (sidebar filter, audit H2)', async () => {
  const rows = accounts.flatMap(a => [message(a, 'm1', 3000)]);
  const s: any = { ...sources(rows), counts: async (a: InboxAccount) => ({ unread: 1, total: a.id === 'gmail:b' ? 0 : 4,
    stuck: a.id === 'cloudflare:me@example.invalid' ? { dead: 2, retrying: 0, lastError: 'categories refused it' } : { dead: 0, retrying: 0, lastError: null } }) };
  const hidden = new Set(['gmail:a']);
  const all = await readInbox(new URLSearchParams(), s, { hidden, catchAlls: new Set(['me@example.invalid']) });
  assert.deepEqual(all.messages.map(m => m.accountId).sort(), ['cloudflare:me@example.invalid', 'gmail:b'], 'the hidden inbox is not read');
  const a = all.accounts.find(x => x.id === 'gmail:a')!;
  assert.equal(a.hidden, true, 'it is still listed, marked hidden, for the Hidden list');
  const me = all.accounts.find(x => x.id === 'cloudflare:me@example.invalid')!;
  assert.deepEqual([me.total, me.catchAll, me.stuck?.dead], [4, true, 2]);
  assert.equal(all.accounts.find(x => x.id === 'gmail:b')!.stuck, undefined, 'no stuck events, no field');
  const alone = await readInbox(new URLSearchParams({ account: 'gmail:a' }), s, { hidden });
  assert.deepEqual(alone.messages.map(m => m.accountId), ['gmail:a'], 'opened on its own it is read');
});

test('a copy merged into a row on one page is not shown again on the next (2026-10-01 review)', async () => {
  // limit 2: page 1 is a2 and g1, with g2 (the same email, older) merged into g1; page 2 must not show g2.
  const a2 = message(accounts[0], 'a2', 9000), g1 = message(accounts[1], 'g1', 8000), g2 = message(accounts[2], 'g2', 7000), a1 = message(accounts[0], 'a1', 6000);
  g1.rfcMessageId = g2.rfcMessageId = 'shared@mail.invalid';
  const first = await readInbox(new URLSearchParams({ limit: '2' }), sources([a2, g1, g2, a1]));
  assert.deepEqual(first.messages.map((m) => m.providerMessageId), ['a2', 'g1']);
  assert.deepEqual(first.messages[1].alsoIn, ['gmail:b']);
  const second = await readInbox(new URLSearchParams({ limit: '2', cursor: first.cursor! }), sources([a2, g1, g2, a1]));
  assert.deepEqual(second.messages.map((m) => m.providerMessageId), ['a1'], 'the merged copy is not repeated');
});
