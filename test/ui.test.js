// Front end tests. jsdom does not run <script type="module">, and public/app.js
// has no imports, so the script is evaluated in the window by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = await readFile(join(publicDir, 'index.html'), 'utf8');
const script = await readFile(join(publicDir, 'app.js'), 'utf8');

const EPUB_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

// jsdom implements neither fetch nor Response, so Node's own are used.
function epubResponse(win, { warnings } = {}) {
  const headers = {
    'content-type': 'application/epub+zip',
    'content-disposition': `attachment; filename="book.epub"; filename*=UTF-8''book.epub`,
    'x-md2epub-chapters': '3',
  };
  if (warnings) headers['x-md2epub-warnings'] = encodeURIComponent(JSON.stringify(warnings));
  return new Response(EPUB_BYTES, { status: 200, headers });
}

/** Boot the page with a scripted fetch, and wait for its startup health call. */
async function boot({ health = { ok: true, email: { configured: true, transport: 'smtp', describe: 'mail.example.com' }, remoteImages: true }, routes = {} } = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'http://localhost:8787/', runScripts: 'dangerously', virtualConsole });
  const win = dom.window;
  const calls = [];

  win.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/health') return new Response(JSON.stringify(health), { status: 200, headers: { 'content-type': 'application/json' } });
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch to ${url}`);
    return handler(win, init);
  };
  win.Element.prototype.scrollIntoView = () => {};
  win.URL.createObjectURL = () => 'blob:fake';
  win.URL.revokeObjectURL = () => {};
  // jsdom has no DataTransfer, which the page uses to seed the file input.
  win.DataTransfer = class {
    constructor() { this.items = { add: (file) => this.files.push(file) }; this.files = []; }
  };
  const clicked = [];
  win.HTMLAnchorElement.prototype.click = function click() { clicked.push({ href: this.href, download: this.download }); };

  win.eval(script);
  await new Promise((r) => setTimeout(r, 0));
  return { win, doc: win.document, calls, clicked, downloads: clicked };
}

const $ = (doc, id) => doc.getElementById(id);
const settle = () => new Promise((r) => setTimeout(r, 5));

test('page: startup reports a configured mail server and enables the controls', async () => {
  const { doc, calls } = await boot();
  assert.equal(calls[0].url, '/api/health');
  assert.match($(doc, 'email-status').textContent, /Email is configured: mail\.example\.com/);
  assert.equal($(doc, 'email-btn').disabled, false);
});

test('page: with no mail server the email controls are disabled, downloads are not', async () => {
  const { doc } = await boot({ health: { ok: true, email: { configured: false }, remoteImages: false } });
  assert.equal($(doc, 'email-btn').disabled, true);
  assert.equal($(doc, 'email').disabled, true);
  assert.equal($(doc, 'download-btn').disabled, false);
  assert.match($(doc, 'email-status').textContent, /no SMTP configured/);
  assert.equal($(doc, 'remote-images-row').hidden, true, 'the remote image option is hidden when the server cannot fetch');
});

test('page: word and heading counts track what is typed', async () => {
  const { doc, win } = await boot();
  const textarea = $(doc, 'markdown');
  textarea.value = '# One\n\nsome words here\n\n# Two\n\nmore';
  textarea.dispatchEvent(new win.Event('input'));
  assert.match($(doc, 'paste-stats').textContent, /8 words, 2 level 1 headings/);
});

test('page: converting pasted Markdown posts it and triggers a download', async () => {
  let sent = null;
  const { doc, win, calls, downloads } = await boot({
    routes: { '/api/convert': (w, init) => { sent = init.body; return epubResponse(w); } },
  });
  $(doc, 'markdown').value = '# Book\n\ntext';
  $(doc, 'title').value = 'Typed Title';
  $(doc, 'convert-form').dispatchEvent(new win.Event('submit'));
  await settle();

  const convert = calls.find((c) => c.url === '/api/convert');
  assert.ok(convert, 'the page posted to /api/convert');
  assert.equal(convert.init.method, 'POST');
  assert.equal(sent.get('markdown'), '# Book\n\ntext');
  assert.equal(sent.get('title'), 'Typed Title');
  assert.equal(sent.has('file'), false, 'an unused file field is not sent');
  assert.equal(sent.has('email'), false, 'an empty email field is not sent');

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].download, 'book.epub');
  assert.equal($(doc, 'result').hidden, false);
  assert.match($(doc, 'result-title').textContent, /EPUB ready/);
  assert.match($(doc, 'result-body').textContent, /3 chapters/);
});

test('page: conversion notes from the server are listed', async () => {
  const { doc, win } = await boot({
    routes: { '/api/convert': (w) => epubResponse(w, { warnings: ['first note', 'second note'] }) },
  });
  $(doc, 'markdown').value = '# B\n\nx';
  $(doc, 'convert-form').dispatchEvent(new win.Event('submit'));
  await settle();
  const items = [...$(doc, 'result-warnings').querySelectorAll('li')].map((li) => li.textContent);
  assert.deepEqual(items, ['first note', 'second note']);
});

test('page: a server error is shown instead of a silent failure', async () => {
  const { doc, win } = await boot({
    routes: {
      '/api/convert': () => new Response(JSON.stringify({ ok: false, error: 'That document is larger than the 8 MB limit.' }), {
        status: 413, headers: { 'content-type': 'application/json' },
      }),
    },
  });
  $(doc, 'markdown').value = '# B\n\nx';
  $(doc, 'convert-form').dispatchEvent(new win.Event('submit'));
  await settle();
  assert.equal($(doc, 'result').classList.contains('is-error'), true);
  assert.match($(doc, 'result-body').textContent, /larger than the 8 MB limit/);
  assert.equal($(doc, 'download-btn').disabled, false, 'the button is usable again after a failure');
});

test('page: converting with nothing entered does not hit the network', async () => {
  const { doc, win, calls } = await boot();
  $(doc, 'convert-form').dispatchEvent(new win.Event('submit'));
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/convert').length, 0);
  assert.match($(doc, 'result-title').textContent, /Nothing to convert/);
});

test('page: emailing posts the address and reports what the server said', async () => {
  let sent = null;
  const { doc, win } = await boot({
    routes: {
      '/api/email': (w, init) => {
        sent = init.body;
        return new Response(JSON.stringify({ ok: true, to: 'reader@example.com', filename: 'book.epub', size: 4096, warnings: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  $(doc, 'markdown').value = '# Book\n\ntext';
  $(doc, 'email').value = ' reader@example.com ';
  $(doc, 'email-btn').dispatchEvent(new win.Event('click'));
  await settle();
  assert.equal(sent.get('email'), 'reader@example.com', 'the address is trimmed');
  assert.match($(doc, 'result-title').textContent, /^Sent$/);
  assert.match($(doc, 'result-body').textContent, /reader@example\.com/);
});

test('page: a dry run send says so rather than claiming delivery', async () => {
  const { doc, win } = await boot({
    routes: {
      '/api/email': () => new Response(JSON.stringify({ ok: true, to: 'a@b.com', filename: 'book.epub', size: 100, dryRun: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    },
  });
  $(doc, 'markdown').value = '# B\n\nx';
  $(doc, 'email').value = 'a@b.com';
  $(doc, 'email-btn').dispatchEvent(new win.Event('click'));
  await settle();
  assert.match($(doc, 'result-title').textContent, /Dry run/);
});

test('page: emailing without an address asks for one before posting', async () => {
  const { doc, win, calls } = await boot();
  $(doc, 'markdown').value = '# B\n\nx';
  $(doc, 'email-btn').dispatchEvent(new win.Event('click'));
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/email').length, 0);
  assert.match($(doc, 'result-title').textContent, /No address/);
});

test('page: the tabs decide which source the form sends', async () => {
  let sent = null;
  const { doc, win, calls } = await boot({
    routes: { '/api/convert': (w, init) => { sent = init.body; return epubResponse(w); } },
  });
  $(doc, 'markdown').value = '# Pasted\n\nx';

  // Switching to the upload tab drops the pasted text, so a stale textarea
  // cannot win over the file the visitor chose. With no file chosen there is
  // nothing left to send, and the page says so instead of posting.
  const uploadTab = [...doc.querySelectorAll('.tab')].find((tab) => tab.dataset.pane === 'upload');
  uploadTab.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal($(doc, 'pane-upload').classList.contains('is-active'), true);
  assert.equal(uploadTab.getAttribute('aria-selected'), 'true');
  $(doc, 'convert-form').dispatchEvent(new win.Event('submit'));
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/convert').length, 0);
  assert.match($(doc, 'result-title').textContent, /Nothing to convert/);

  // Switching back sends the text again.
  const pasteTab = [...doc.querySelectorAll('.tab')].find((tab) => tab.dataset.pane === 'paste');
  pasteTab.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  $(doc, 'convert-form').dispatchEvent(new win.Event('submit'));
  await settle();
  assert.equal(sent.get('markdown'), '# Pasted\n\nx');
  assert.equal(sent.has('file'), false);
});
