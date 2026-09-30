import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Real workerd Durable Object SQL/R2 and production HTTP handlers. Only the
// external mail transport is synthetic; no Cloudflare account or mail is used.
const bundle = await build({ stdin: { contents: `
  import { MailboxDO } from './workers/durableObject/index';
  import { DurableObject } from 'cloudflare:workers';
  import { handleSendEmail, handleReplyEmail, handleForwardEmail } from './workers/routes/reply-forward';
  import { Hono } from 'hono';
  import { receiveEmail } from './workers/index';
  import { toolSendEmail, toolSendReply } from './workers/lib/tools';
  export class TestMailbox extends MailboxDO {
    constructor(state, env) {
      const stats = { sends: 0, mode: 'accept' };
      super(state, { ...env, BUCKET: { put: (...args) => { if (stats.mode === 'projection-fail') throw new Error('R2 unavailable'); return env.BUCKET.put(...args); } }, EMAIL: { send: async message => {
        stats.sends++;
        if (stats.mode === 'reject') throw Object.assign(new Error('private detail'), {code:'E_SENDER_NOT_VERIFIED'});
        if (stats.mode === 'timeout') throw new Error('timeout');
        return { messageId: '<receipt-' + stats.sends + '@cloudflare.invalid>' };
      } } });
      this.stats = stats;
    }
    setMode(mode) { this.stats.mode = mode; }
    count() { return this.stats.sends; }
    runAlarm() { return this.alarm(); }
  }
  export class TestAutomation extends DurableObject {
    async ingest(mailboxId, event) {
      await this.ctx.storage.put('calls', (await this.ctx.storage.get('calls') || 0) + 1);
      await this.ctx.storage.put('event/' + event.id, event);
      if (await this.ctx.storage.get('fail')) {
        await this.ctx.storage.delete('fail');
        throw new Error('lost acknowledgement');
      }
      return {accepted: true};
    }
    async failNext() { await this.ctx.storage.put('fail', true); }
    async calls() { return await this.ctx.storage.get('calls') || 0; }
    async events() { return [...(await this.ctx.storage.list({prefix:'event/'})).values()]; }
  }
  const app = new Hono();
  app.use('*', async (c,next) => { c.set('mailboxStub', c.env.MAILBOX.get(c.env.MAILBOX.idFromName(decodeURIComponent(c.req.path.split('/')[2])))); await next(); });
  app.post('/mailboxes/:mailboxId/tool-send', async c => c.json(await toolSendEmail(c.env,c.req.param('mailboxId'),await c.req.json())));
  app.post('/mailboxes/:mailboxId/tool-reply', async c => c.json(await toolSendReply(c.env,c.req.param('mailboxId'),await c.req.json())));
  app.post('/mailboxes/:mailboxId/emails', c => handleSendEmail(c));
  app.post('/mailboxes/:mailboxId/emails/:id/reply', handleReplyEmail);
  app.post('/mailboxes/:mailboxId/emails/:id/forward', handleForwardEmail);
  app.post('/mailboxes/:mailboxId/alarm', async c => { await c.var.mailboxStub.runAlarm(); return c.json({}); });
  app.get('/mailboxes/:mailboxId/event-calls', async c => c.json(await c.env.AUTOMATIONS.getByName(c.req.param('mailboxId')).calls()));
  app.post('/mailboxes/:mailboxId/control', async c => { await c.var.mailboxStub.setMode((await c.req.json()).mode); return c.json({}); });
  app.get('/mailboxes/:mailboxId/state', async c => c.json({ sends: await c.var.mailboxStub.count(), sent: await c.var.mailboxStub.getEmails({folder:'sent'}), outbox: await c.var.mailboxStub.listOutbox(c.req.param('mailboxId')) }));
  app.post('/mailboxes/:mailboxId/fail-ingest', async c => { await c.env.AUTOMATIONS.getByName(c.req.param('mailboxId')).failNext(); return c.json({}); });
  app.get('/mailboxes/:mailboxId/events', async c => c.json(await c.env.AUTOMATIONS.getByName(c.req.param('mailboxId')).events()));
  app.get('/mailboxes/:mailboxId/full/:id', async c => c.json(await c.var.mailboxStub.getEmail(c.req.param('id'))));
  app.post('/mailboxes/:mailboxId/receive', async c => {
    const input = await c.req.json();
    const mailbox = c.req.param('mailboxId');
    await c.env.BUCKET.put('mailboxes/' + mailbox + '.json', '{}');
    const bytes = new TextEncoder().encode(input.raw);
    const event = { to: mailbox, from: 'sender@example.invalid', rawSize: bytes.length, raw: new Response(bytes).body };
    await receiveEmail(event, { ...c.env, EMAIL_ADDRESSES: [mailbox], EMAIL_AGENT: { idFromName: n => n, get: () => ({ fetch: async () => new Response('ok') }) } }, c.executionCtx);
    return c.json({ emails: await c.var.mailboxStub.getEmails({folder:'inbox'}) });
  });
  export default app;
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], target: 'es2022' });

async function fixture() {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { MAILBOX: { className: 'TestMailbox', useSQLite: true }, AUTOMATIONS: { className: 'TestAutomation', useSQLite: true } }, r2Buckets: ['BUCKET'] });
  async function request(path: string, body?: unknown, key = 'key') {
    return mf.dispatchFetch('http://localhost/mailboxes/me@example.invalid/' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body ? JSON.stringify(body) : undefined });
  }
  return { mf, request };
}
const mail = { from: 'me@example.invalid', to: 'you@example.invalid', subject: 'Test', text: 'Hello' };
test('HTTP send integrates with real DO persistence and returns actual receipt', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.request('emails', mail)));
    assert.ok(responses.every(r => r.status === 200));
    const items = await Promise.all(responses.map(r => r.json())) as any[];
    assert.ok(items.every(r => r.status === 'accepted' && r.id === items[0].id));
    const state = await (await f.request('state')).json() as any;
    assert.equal(state.sends, 1); assert.equal(state.sent.length, 1);
    const full = await (await f.request('full/' + items[0].id)).json() as any;
    assert.equal(full.message_id, 'receipt-1@cloudflare.invalid');
    assert.ok(full.raw_headers.includes('<receipt-1@cloudflare.invalid>'));
    assert.equal((await f.request('emails', { ...mail, text: 'changed' })).status, 409);
    const reply = await f.request('emails/' + items[0].id + '/reply', { ...mail, subject: 'Re: Test' }, 'reply');
    assert.equal(reply.status, 200);
    const replyId = (await reply.json() as any).id;
    const replyFull = await (await f.request('full/' + replyId)).json() as any;
    assert.equal(replyFull.in_reply_to, full.message_id);
    assert.equal(replyFull.thread_id, full.thread_id);
    assert.equal((await f.request('emails/' + items[0].id + '/forward', mail, 'forward')).status, 200);
  } finally { await f.mf.dispose(); }
});
test('HTTP definite failure and unknown outcome never return success or enter Sent', async () => {
  const f = await fixture();
  try {
    await f.request('control', { mode: 'reject' });
    assert.equal((await f.request('emails', mail)).status, 502);
    await f.request('control', { mode: 'timeout' });
    assert.equal((await f.request('emails', mail, 'unknown')).status, 409);
    assert.equal((await f.request('emails', mail, 'unknown')).status, 409);
    const state = await (await f.request('state')).json() as any;
    assert.equal(state.sends, 2); assert.equal(state.sent.length, 0);
    assert.deepEqual(state.outbox.map((a: any) => a.status).sort(), ['failed', 'unknown']);
  } finally { await f.mf.dispose(); }
});

const incoming = 'From: sender@example.invalid\r\nTo: me@example.invalid\r\nSubject: Original\r\nMessage-ID: <original@example.invalid>\r\n\r\nIncoming body';
test('receipt deduplicates exact delivery and uses envelope recipient for BCC', async () => {
  const f = await fixture();
  try {
    const first = await f.request('receive', { raw: incoming });
    assert.equal(first.status, 200);
    await first.body?.cancel();
    const second = await f.request('receive', { raw: incoming });
    assert.equal((await second.json() as any).emails.length, 1);
    const bcc = incoming.replace('To: me@example.invalid\r\n', '').replace('Original', 'BCC original');
    const third = await f.request('receive', { raw: bcc });
    assert.equal(third.status, 200);
    assert.equal((await third.json() as any).emails.length, 2);
    const reusedId = await f.request('receive', { raw: incoming.replace('Incoming body', 'Different content') });
    assert.equal((await reusedId.json() as any).emails.length, 3);
  } finally { await f.mf.dispose(); }
});

test('incoming replay repairs lost automation acknowledgement without a second event', async () => {
  const f = await fixture();
  try {
    await f.request('fail-ingest', {});
    const receipt = await f.request('receive', {raw:incoming});
    assert.equal(receipt.status, 200);
    await receipt.body?.cancel();
    assert.equal((await (await f.request('events')).json() as any[]).length, 1);
    const replay = await f.request('receive', {raw:incoming});
    assert.equal(replay.status, 200);
    // Read the body before the next dispatch: an unread Miniflare response body
    // could be reported as already consumed under load (2 of 10 full runs).
    const replayBody = await replay.json() as any;
    assert.equal((await (await f.request('events')).json() as any[]).length, 1);
    assert.equal(replayBody.emails.length, 1);
    assert.equal(await (await f.request('event-calls')).json(), 2);
    await f.request('receive', {raw:incoming});
    assert.equal(await (await f.request('event-calls')).json(), 2);
  } finally { await f.mf.dispose(); }
});

test('alarm repairs accepted Sent attachment projection without repeating transport', async () => {
  const f = await fixture();
  try {
    await f.request('control', {mode:'projection-fail'});
    const result = await (await f.request('emails', {...mail, attachments:[{filename:'hello.txt', content:'aGVsbG8=', type:'text/plain', disposition:'attachment'}]})).json() as any;
    assert.equal(result.status, 'accepted');
    assert.equal(result.projectionStatus, 'pending');
    let state = await (await f.request('state')).json() as any;
    assert.equal(state.sent.length, 0);
    await f.request('control', {mode:'accept'});
    await f.request('alarm', {});
    state = await (await f.request('state')).json() as any;
    assert.equal(state.sends, 1);
    assert.equal(state.sent.length, 1);
    assert.equal(state.outbox[0].projectionStatus, 'complete');
    const full = await (await f.request('full/' + result.id)).json() as any;
    assert.equal(full.attachments.length, 1);
  } finally { await f.mf.dispose(); }
});
test('inbound reply joins the Sent conversation by real RFC Message-ID', async () => {
  const f = await fixture();
  try {
    const sent = await (await f.request('emails', mail)).json() as any;
    const reply = incoming.replace('Subject: Original', 'Subject: Re: Test\r\nIn-Reply-To: <receipt-1@cloudflare.invalid>\r\nReferences: <receipt-1@cloudflare.invalid>');
    const received = await (await f.request('receive', {raw:reply})).json() as any;
    assert.equal(received.emails[0].thread_id, sent.id);
  } finally { await f.mf.dispose(); }
});

test('MCP send and reply helpers share durable idempotency and truthful failures', async () => {
  const f = await fixture();
  try {
    const params = {to:mail.to,subject:mail.subject,bodyHtml:'<p>Hello</p>',idempotencyKey:'mcp-send'};
    const first = await (await f.request('tool-send',params)).json() as any;
    assert.equal(first.status,'accepted');
    const again = await (await f.request('tool-send',params)).json() as any;
    assert.equal(first.id,again.id);
    const replyParams = {...params,originalEmailId:first.id,idempotencyKey:'mcp-reply'};
    assert.equal((await (await f.request('tool-reply',replyParams)).json() as any).status,'accepted');
    assert.equal((await (await f.request('tool-reply',replyParams)).json() as any).status,'accepted');
    assert.equal((await (await f.request('state')).json() as any).sends,2);
    await f.request('control',{mode:'timeout'});
    const failed = await (await f.request('tool-send',{...params,idempotencyKey:'mcp-unknown'})).json() as any;
    assert.equal(failed.status,'unknown');
    assert.ok(failed.error);
  } finally { await f.mf.dispose(); }
});
test('mailbox sender enforcement rejects mismatched From before transport', async () => {
  const f = await fixture();
  try {
    const response = await f.request('emails',{...mail,from:'another@example.invalid'});
    assert.equal(response.status,400);
    const state = await (await f.request('state')).json() as any;
    assert.equal(state.sends,0);
    assert.equal(state.sent.length,0);
  } finally { await f.mf.dispose(); }
});

test('Cloudflare rejects malformed attachment batches before reserving or sending', async () => {
  const f = await fixture();
  try {
    const file = { filename: 'file.bin', type: 'application/octet-stream', disposition: 'attachment', content: 'AAE=' };
    for (const attachments of [[file, { ...file, content: 'Zh==' }], [{ ...file, filename: 'bad\r\nheader' }], Array(11).fill(file)]) {
      assert.equal((await f.request('emails', { ...mail, attachments })).status, 400);
    }
    const state = await (await f.request('state')).json() as any;
    assert.equal(state.sends, 0);
    assert.equal(state.outbox.length, 0);
  } finally { await f.mf.dispose(); }
});

test('Cloudflare 5 MiB attachment fits real SQL chunks and R2, replays once and conflicts on changed file', async () => {
  const f = await fixture();
  try {
    const attachments = [{ filename: 'large.bin', type: 'application/octet-stream', disposition: 'attachment', content: Buffer.alloc(5 * 1024 * 1024, 123).toString('base64') }];
    const request = { ...mail, attachments };
    const response = await f.request('emails', request);
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal((await f.request('emails', request)).status, 200);
    assert.equal((await f.request('emails', { ...mail, attachments: [{ ...attachments[0], content: 'AA==' }] })).status, 409);
    const full = await (await f.request('full/' + result.id)).json() as any;
    assert.equal(full.attachments[0].size, 5 * 1024 * 1024);
    const bucket = await f.mf.getR2Bucket('BUCKET');
    const stored = await bucket.get(`attachments/${result.id}/${full.attachments[0].id}/large.bin`);
    assert.deepEqual(Buffer.from(await stored!.arrayBuffer()), Buffer.alloc(5 * 1024 * 1024, 123));
    const state = await (await f.request('state')).json() as any;
    assert.equal(state.sends, 1);
    // Forward currently sends only explicitly supplied attachments, never copies the original.
    const forwarded = await (await f.request('emails/' + result.id + '/forward', mail, 'forward-no-files')).json() as any;
    const forwardFull = await (await f.request('full/' + forwarded.id)).json() as any;
    assert.equal(forwardFull.attachments.length, 0);
  } finally { await f.mf.dispose(); }
});

test('Cloudflare refuses injected send and reply headers before transport or durable reservation', async () => {
  const f = await fixture();
  try {
    for (const patch of [{ subject: 'Hello\r\nBcc: bad@example.invalid' }, { from: { email: 'me@example.invalid', name: 'Me\nInjected' } }, { in_reply_to: '<ok@local>\r\nX: bad' }, { references: ['<ok@local>\0'] }]) {
      assert.equal((await f.request('emails', { ...mail, ...patch })).status, 400);
    }
    const state = await (await f.request('state')).json() as any;
    assert.equal(state.sends, 0); assert.equal(state.outbox.length, 0);
  } finally { await f.mf.dispose(); }
});
