import test from 'node:test';
import assert from 'node:assert/strict';
import PostalMime from 'postal-mime';
import { makeMime } from '../workers/providers/gmail-client';

const binary = Buffer.from(Array.from({ length: 256 }, (_, n) => n));
const attachment = { content: binary.toString('base64'), filename: 'Отчёт 📨.bin', type: 'application/octet-stream', disposition: 'attachment' as const };
const mail = { to: ['to@example.invalid'], cc: ['cc@example.invalid'], bcc: ['bcc@example.invalid'], subject: 'Привет', text: 'Plain body', html: '<p>HTML body</p>', inReplyTo: '<parent@example.invalid>', references: '<root@example.invalid> <parent@example.invalid>', attachments: [attachment] };
test('Gmail attachment MIME roundtrips binary, UTF-8 filename, alternatives and thread headers', async () => {
  const parsed = await PostalMime.parse(Buffer.from(makeMime('from@example.invalid', mail), 'base64url'));
  assert.equal(parsed.from?.address, 'from@example.invalid');
  assert.equal(parsed.to?.[0].address, 'to@example.invalid');
  assert.equal(parsed.cc?.[0].address, 'cc@example.invalid');
  assert.equal(parsed.bcc?.[0].address, 'bcc@example.invalid');
  assert.equal(parsed.subject, mail.subject);
  assert.equal(parsed.text?.trim(), mail.text);
  assert.equal(parsed.html?.trim(), mail.html);
  assert.equal(parsed.inReplyTo, mail.inReplyTo);
  assert.equal(parsed.references, mail.references);
  assert.equal(parsed.attachments[0].filename, attachment.filename);
  assert.deepEqual(Buffer.from(parsed.attachments[0].content), binary);
});

import { validateAttachments, AttachmentValidationError, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../shared/mail/attachments';
test('attachment validation rejects malformed base64, metadata injection and noncanonical padding', () => {
  for (const content of ['Zg', 'Zg===', 'Zg=\n', 'Zh==', 'Zm9=', '!!!!', 'AAAA====', '-_8=', '=AAA']) {
    assert.throws(() => validateAttachments([{ ...attachment, content }]), AttachmentValidationError, content);
  }
  for (const patch of [
    { filename: 'x\r\nBcc: bad@example.invalid' }, { filename: '\0' }, { filename: '../x' },
    { filename: '' }, { filename: 'Ж'.repeat(128) }, { filename: '\ud800' },
    { type: 'text/plain\r\nX: evil' }, { type: 'text/plain; charset=utf-8' },
    { contentId: 'x>\r\nBcc: evil' }, { disposition: undefined }, { disposition: 'form-data' },
  ]) assert.throws(() => validateAttachments([{ ...attachment, ...patch }]), AttachmentValidationError);
  for (const value of [null, {}, [null], ['x']]) assert.throws(() => validateAttachments(value), AttachmentValidationError);
  assert.deepEqual(validateAttachments(undefined), []);
  assert.equal(validateAttachments([{ ...attachment, content: '', type: 'APPLICATION/OCTET-STREAM' }])[0].type, attachment.type);
});
test('decoded aggregate accepts exactly 5 MiB and ten files, refuses one byte/file beyond', () => {
  const content = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64');
  assert.equal(validateAttachments([{ ...attachment, content }]).length, 1);
  for (const entries of [
    [{ ...attachment, content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }],
    [{ ...attachment, content }, { ...attachment, content: 'AA==' }],
    Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ ...attachment, content: '' })),
  ]) assert.throws(() => validateAttachments(entries), (e: AttachmentValidationError) => e.status === 413);
  assert.equal(validateAttachments(Array.from({ length: MAX_ATTACHMENTS }, () => ({ ...attachment, content: '' }))).length, MAX_ATTACHMENTS);
});
test('inline attachment roundtrips quoted UTF-8 filename and Content-ID with plain-only body', async () => {
  const file = { ...attachment, filename: 'A "quoted" Отчёт 📨.bin', disposition: 'inline' as const, contentId: 'image@example.invalid' };
  const parsed = await PostalMime.parse(Buffer.from(makeMime('from@example.invalid', { ...mail, html: undefined, attachments: [file] }), 'base64url'));
  assert.equal(parsed.text?.trim(), mail.text);
  assert.equal(parsed.attachments[0].filename, file.filename);
  assert.equal(parsed.attachments[0].disposition, 'inline');
  assert.equal(parsed.attachments[0].contentId, '<image@example.invalid>');
});

test('full-limit Gmail MIME is built inside workerd with bounded string conversion', async () => {
  const { build } = await import('esbuild');
  const { Miniflare } = await import('miniflare');
  const bundle = await build({ stdin: { contents: `
    import { makeMime } from './workers/providers/gmail-client';
    export default { async fetch(request) {
      const raw = makeMime('from@example.invalid', await request.json());
      return new Response(JSON.stringify({ bytes: raw.length }));
    } };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01' });
  try {
    const response = await mf.dispatchFetch('http://localhost/', { method: 'POST', body: JSON.stringify({ ...mail, attachments: [{ ...attachment, content: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64') }] }) });
    assert.equal(response.status, 200);
    assert.ok((await response.json() as { bytes: number }).bytes > MAX_ATTACHMENT_BYTES);
  } finally { await mf.dispose(); }
});
