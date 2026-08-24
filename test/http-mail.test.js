import test from 'node:test';
import assert from 'node:assert/strict';
import { createResendMailer, _internals } from '../src/mail/http.js';

test('resend mailer: not created without a key and a from address', () => {
  assert.equal(createResendMailer({}), null);
  assert.equal(createResendMailer({ RESEND_API_KEY: 'k' }), null);
  assert.equal(createResendMailer({ MAIL_FROM: 'a@b.com' }), null);
  assert.ok(createResendMailer({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.com' }));
});

test('resend mailer: posts the documented request shape', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const mailer = createResendMailer({ RESEND_API_KEY: 're_test', MAIL_FROM: 'md2epub <bot@example.com>' }, fetchImpl);
  const result = await mailer.send({
    to: 'reader@example.com',
    subject: 'EPUB: Book',
    text: 'here it is',
    attachments: [{ filename: 'book.epub', content: new Uint8Array([80, 75, 3, 4]), contentType: 'application/epub+zip' }],
  });

  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer re_test');
  assert.equal(seen.body.from, 'md2epub <bot@example.com>');
  assert.equal(seen.body.to, 'reader@example.com');
  assert.equal(seen.body.attachments[0].filename, 'book.epub');
  assert.equal(seen.body.attachments[0].content, 'UEsDBA==');
  assert.equal(seen.body.attachments[0].content_type, 'application/epub+zip');
  assert.equal(result.messageId, 'msg_123');
});

test('resend mailer: an API error becomes a readable exception', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'domain is not verified' }), { status: 403 });
  const mailer = createResendMailer({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.com' }, fetchImpl);
  await assert.rejects(() => mailer.send({ to: 'x@y.com', subject: 's', text: 't', attachments: [] }), /domain is not verified/);
});

test('base64: chunking handles payloads past the argument limit', () => {
  const big = new Uint8Array(200000).fill(65);
  assert.equal(_internals.toBase64(big).length, Math.ceil(200000 / 3) * 4);
});
