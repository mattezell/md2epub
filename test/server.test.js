import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../src/app.js';

const post = (app, path, body, headers = {}) => app.fetch(new Request(`http://localhost${path}`, { method: 'POST', body, headers }));

function form(fields = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function fakeMailer() {
  const sent = [];
  return {
    kind: 'test',
    describe: () => 'test mailer',
    sent,
    async send(message) {
      sent.push(message);
      return { messageId: `test-${sent.length}` };
    },
  };
}

test('health: reports that email is off when no mailer is wired up', async () => {
  const app = createApp({});
  const body = await (await app.fetch(new Request('http://localhost/api/health'))).json();
  assert.equal(body.ok, true);
  assert.equal(body.email.configured, false);
});

test('health: reports the transport when a mailer is wired up', async () => {
  const app = createApp({ mailer: fakeMailer() });
  const body = await (await app.fetch(new Request('http://localhost/api/health'))).json();
  assert.equal(body.email.configured, true);
  assert.equal(body.email.transport, 'test');
});

test('convert: pasted Markdown comes back as an epub attachment', async () => {
  const app = createApp({});
  const response = await post(app, '/api/convert', form({ markdown: '# Pasted Book\n\nHello.' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/epub+zip');
  assert.match(response.headers.get('content-disposition'), /filename="pasted-book\.epub"/);
  assert.equal(response.headers.get('x-md2epub-chapters'), '1');

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(strFromU8(bytes.slice(0, 2)), 'PK');
  const files = unzipSync(bytes);
  assert.equal(strFromU8(files.mimetype), 'application/epub+zip');
});

test('convert: an uploaded file is used, and metadata fields override frontmatter', async () => {
  const app = createApp({});
  const data = new FormData();
  data.append('file', new File(['---\ntitle: In File\n---\n\n# Heading\n\nx'], 'book.md', { type: 'text/markdown' }));
  data.append('title', 'From The Form');
  data.append('author', 'Someone');
  const response = await post(app, '/api/convert', data);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /from-the-form\.epub/);
  const opf = strFromU8(unzipSync(new Uint8Array(await response.arrayBuffer()))['EPUB/package.opf']);
  assert.match(opf, /<dc:creator id="creator-1">Someone<\/dc:creator>/);
});

test('convert: a JSON body works as well as a form', async () => {
  const app = createApp({});
  const response = await post(app, '/api/convert', JSON.stringify({ markdown: '# JSON Book\n\nx', author: 'API' }), {
    'content-type': 'application/json',
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /json-book\.epub/);
});

test('convert: conversion notes ride along in a header', async () => {
  const app = createApp({});
  const response = await post(app, '/api/convert', form({ markdown: '# T\n\n![alt](./nope.png)' }));
  const warnings = JSON.parse(decodeURIComponent(response.headers.get('x-md2epub-warnings')));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /nope\.png/);
});

test('convert: an empty request is a 400 with a readable message', async () => {
  const app = createApp({});
  const response = await post(app, '/api/convert', form({ markdown: '   ' }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Paste some Markdown/);
});

test('convert: oversized input is refused with 413', async () => {
  const app = createApp({ config: { maxMarkdownBytes: 100 } });
  const response = await post(app, '/api/convert', form({ markdown: `# T\n\n${'x'.repeat(200)}` }));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /larger than/);
});

test('convert: malformed JSON is a 400, not a crash', async () => {
  const app = createApp({});
  const response = await post(app, '/api/convert', '{not json', { 'content-type': 'application/json' });
  assert.equal(response.status, 400);
});

test('email: refused with 503 when the server has no mailer', async () => {
  const app = createApp({});
  const response = await post(app, '/api/email', form({ markdown: '# T\n\nx', email: 'a@example.com' }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});

test('email: the 503 explains how this particular runtime turns email on', async () => {
  const app = createApp({ config: { emailHelp: 'Set SMTP_HOST and MAIL_FROM in .env, then restart.' } });
  const response = await post(app, '/api/email', form({ markdown: '# T\n\nx', email: 'a@example.com' }));
  assert.match((await response.json()).error, /Set SMTP_HOST and MAIL_FROM in \.env/);
});

test('email: sends the epub as an attachment', async () => {
  const mailer = fakeMailer();
  const app = createApp({ mailer });
  const response = await post(app, '/api/email', form({ markdown: '# Mailed Book\n\nx', email: 'reader@example.com', note: 'enjoy' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.to, 'reader@example.com');
  assert.equal(body.filename, 'mailed-book.epub');

  assert.equal(mailer.sent.length, 1);
  const message = mailer.sent[0];
  assert.equal(message.to, 'reader@example.com');
  assert.match(message.subject, /Mailed Book/);
  assert.match(message.text, /enjoy/);
  assert.equal(message.attachments[0].filename, 'mailed-book.epub');
  assert.equal(message.attachments[0].contentType, 'application/epub+zip');
  assert.equal(strFromU8(unzipSync(message.attachments[0].content).mimetype), 'application/epub+zip');
});

test('email: a bad address is rejected before any conversion work', async () => {
  const mailer = fakeMailer();
  const app = createApp({ mailer });
  for (const address of ['not-an-address', 'a@b', '', 'a@b.c,d@e.f']) {
    const response = await post(app, '/api/email', form({ markdown: '# T\n\nx', email: address }));
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(address)}`);
  }
  assert.equal(mailer.sent.length, 0);
});

test('email: the recipient allowlist is enforced', async () => {
  const mailer = fakeMailer();
  const app = createApp({ mailer, config: { allowedRecipients: ['me@example.com', '@kindle.com'] } });
  const allowed = await post(app, '/api/email', form({ markdown: '# T\n\nx', email: 'ME@example.com' }));
  assert.equal(allowed.status, 200);
  const kindle = await post(app, '/api/email', form({ markdown: '# T\n\nx', email: 'someone@kindle.com' }));
  assert.equal(kindle.status, 200);
  const blocked = await post(app, '/api/email', form({ markdown: '# T\n\nx', email: 'stranger@example.org' }));
  assert.equal(blocked.status, 403);
  assert.equal(mailer.sent.length, 2);
});

test('email: the hourly rate limit returns 429 rather than sending', async () => {
  const mailer = fakeMailer();
  const app = createApp({ mailer, config: { emailsPerHour: 2 } });
  const send = () => post(app, '/api/email', form({ markdown: '# T\n\nx', email: 'a@example.com' }));
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const third = await send();
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /Too many/);
  assert.equal(mailer.sent.length, 2);
});

test('email: a transport failure is reported as 502, not swallowed', async () => {
  const app = createApp({
    mailer: { kind: 'broken', describe: () => 'broken', send: async () => { throw new Error('connection refused'); } },
  });
  const response = await post(app, '/api/email', form({ markdown: '# T\n\nx', email: 'a@example.com' }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /connection refused/);
});

test('unknown api routes answer with json', async () => {
  const app = createApp({});
  const response = await app.fetch(new Request('http://localhost/api/nope'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).ok, false);
});

test('convert: several uploaded files become one book', async () => {
  const app = createApp({});
  const data = new FormData();
  data.append('file', new File(['# Intro\n\nSee [setup](./setup.md).'], 'README.md', { type: 'text/markdown' }));
  data.append('file', new File(['# Setup\n\nsteps'], 'setup.md', { type: 'text/markdown' }));
  data.append('title', 'Project Docs');
  const response = await post(app, '/api/convert', data);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-md2epub-documents'), '2');
  assert.equal(response.headers.get('x-md2epub-chapters'), '2');
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.match(strFromU8(files['EPUB/ch-001.xhtml']), /href="ch-002\.xhtml"/, 'cross document links are rewritten');
});

test('convert: the total size of several uploads is what counts against the limit', async () => {
  const app = createApp({ config: { maxMarkdownBytes: 200 } });
  const data = new FormData();
  data.append('file', new File([`# A\n\n${'x'.repeat(150)}`], 'a.md', { type: 'text/markdown' }));
  data.append('file', new File([`# B\n\n${'y'.repeat(150)}`], 'b.md', { type: 'text/markdown' }));
  const response = await post(app, '/api/convert', data);
  assert.equal(response.status, 413);
});

test('convert: a single upload takes its title from the file name', async () => {
  const app = createApp({});
  const data = new FormData();
  data.append('file', new File(['## No H1 here\n\ntext'], '01-design-notes.md', { type: 'text/markdown' }));
  const response = await post(app, '/api/convert', data);
  assert.match(response.headers.get('content-disposition'), /design-notes\.epub/);
});

test('convert: the generated cover can be turned off from the form', async () => {
  const app = createApp({});
  const on = await post(app, '/api/convert', form({ markdown: '# T\n\nx' }));
  assert.ok(unzipSync(new Uint8Array(await on.arrayBuffer()))['EPUB/cover.xhtml']);
  const off = await post(app, '/api/convert', form({ markdown: '# T\n\nx', generateCover: 'false' }));
  assert.equal(unzipSync(new Uint8Array(await off.arrayBuffer()))['EPUB/cover.xhtml'], undefined);
});
