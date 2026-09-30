import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPath, mailImagePolicy } from '../app/lib/mail-image-policy';
test('trusted inline files load without enabling arbitrary remote images', () => {
  const policy = mailImagePolicy(false, 'https://inbox.example', { mailboxId:'hello@example.com',emailId:'m1',attachmentIds:['image1'] });
  assert.ok(policy.includes('https://inbox.example/api/v1/mailboxes/hello%40example.com/emails/m1/attachments/image1'));
  assert.ok(!policy.includes(' https:;'));
  assert.ok(!policy.includes("'self'"));
  assert.ok(policy.includes("form-action 'none'"));
});
test('untrusted IDs cannot expand the CSP or escape the attachment route', () => {
  const path = attachmentPath('a/b', 'm\"; img-src https:', "id'?#");
  assert.equal(path, '/api/v1/mailboxes/a%2Fb/emails/m%22%3B%20img-src%20https%3A/attachments/id%27%3F%23');
  const policy = mailImagePolicy(false, 'https://inbox.example', {mailboxId:'a/b',emailId:'m1',attachmentIds:["id'?#"]});
  assert.ok(!policy.includes("id'?#"));
  assert.throws(()=>mailImagePolicy(false,'https://inbox.example/path'));
});
test('explicit external permission only adds HTTPS and a new message starts blocked', () => {
  assert.ok(mailImagePolicy(true,'https://inbox.example').includes('img-src data: cid: https:;'));
  assert.ok(mailImagePolicy(false,'https://inbox.example').includes('img-src data: cid:;'));
  assert.ok(!mailImagePolicy(false,'http://127.0.0.1:5174').includes(' https:;'));
});
