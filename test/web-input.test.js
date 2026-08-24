// Web pages and the read-later queue as input. The network is stubbed
// throughout: these run offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { articleFromHtml, articleToDocument, createArticleFetcher } from '../src/article.js';
import { createKarakeepClient, bookmarkToDocument } from '../src/karakeep.js';
import { markdownToEpub } from '../src/core/index.js';
import { createApp } from '../src/app.js';

const PAGE = (body, head = '') => `<!doctype html><html><head><title>Site | Real Title</title>${head}</head><body>
  <nav><a href="/home">Home</a></nav>
  <article><h1>Real Title</h1>${body}</article>
  <footer>Boilerplate footer</footer></body></html>`;

const PROSE = `<p>${'Sentences that give the extractor enough text to score this as the article body. '.repeat(6)}</p>`;

test('extraction: keeps the article, drops the furniture', () => {
  const article = articleFromHtml(PAGE(PROSE), { url: 'https://example.com/post' });
  assert.match(article.markdown, /Sentences that give the extractor/);
  assert.equal(article.markdown.includes('Boilerplate footer'), false);
  assert.equal(article.markdown.includes('](https://example.com/home)'), false);
});

test('extraction: a site-prefixed page title yields the real title', () => {
  assert.equal(articleFromHtml(PAGE(PROSE), { url: 'https://example.com/p' }).title, 'Real Title');
});

test('extraction: relative links and images become absolute', () => {
  const article = articleFromHtml(
    PAGE(`${PROSE}<p><a href="/other">link</a></p><p><img src="../img/a.png" alt="pic"></p>`),
    { url: 'https://example.com/posts/one' },
  );
  assert.match(article.markdown, /\]\(https:\/\/example\.com\/other\)/);
  assert.match(article.markdown, /!\[pic\]\(https:\/\/example\.com\/img\/a\.png\)/);
});

test('extraction: lazy loaded images use their real source', () => {
  const article = articleFromHtml(
    PAGE(`${PROSE}<p><img src="/spacer.gif" data-src="/real/photo.jpg" alt="photo"></p>`),
    { url: 'https://example.com/p' },
  );
  assert.match(article.markdown, /photo\.jpg/);
});

test('extraction: already extracted content skips Readability', () => {
  // What Karakeep stores: a bare fragment with no page furniture at all.
  const fragment = '<div id="readability-page-1"><h2>Section</h2><p>Short.</p></div>';
  const article = articleFromHtml(fragment, { url: 'https://example.com/p', extract: false, title: 'Given Title' });
  assert.equal(article.title, 'Given Title');
  assert.match(article.markdown, /## Section/);
  assert.match(article.markdown, /Short\./);
});

test('document: metadata becomes frontmatter and the source is recorded', () => {
  const doc = articleToDocument(
    { markdown: 'Body text.', title: 'A Piece', byline: 'Ada', siteName: 'Example', publishedTime: '2026-08-24T10:00:00Z', excerpt: 'A summary.' },
    { url: 'https://example.com/a-piece', path: '001-article.md' },
  );
  assert.match(doc.markdown, /title: "A Piece"/);
  assert.match(doc.markdown, /author: "Ada"/);
  assert.match(doc.markdown, /date: "2026-08-24"/);
  assert.match(doc.markdown, /publisher: "Example"/);
  assert.match(doc.markdown, /\[example\.com\]\(https:\/\/example\.com\/a-piece\)/);
});

test('fetching: a page becomes a document, and the redirect target is the base', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/start')) {
      return new Response(null, { status: 302, headers: { location: 'https://example.com/final/post' } });
    }
    return new Response(PAGE(`${PROSE}<p><img src="pic.png" alt="p"></p>`), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const article = await createArticleFetcher({ fetchImpl })('https://example.com/start');
  assert.equal(article.url, 'https://example.com/final/post');
  assert.match(article.markdown, /https:\/\/example\.com\/final\/pic\.png/, 'images resolve against the final URL');
});

test('fetching: a non-page content type is refused', async () => {
  const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });
  await assert.rejects(() => createArticleFetcher({ fetchImpl })('https://example.com/a.pdf'), /not a web page/);
});

test('fetching: a page with nothing readable is refused rather than shipped empty', async () => {
  const fetchImpl = async () => new Response('<html><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => createArticleFetcher({ fetchImpl })('https://example.com/empty'), /no readable article/);
});

// A bookmark shaped like the ones the live instance returns.
const BOOKMARK = {
  id: 'bk1',
  title: 'Saved Piece',
  archived: false,
  tags: [{ name: 'reading' }],
  assets: [{ assetType: 'linkHtmlContent', id: 'asset1' }],
  content: { type: 'link', url: 'https://example.com/saved', author: 'Grace', publisher: 'Example', datePublished: '2026-08-01', htmlContent: null },
};

function karakeepStub({ bookmarks = [BOOKMARK], article = '<div><p>The saved article body.</p></div>' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).includes('/api/v1/bookmarks?')) {
      return new Response(JSON.stringify({ bookmarks, nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('/api/v1/assets/')) return new Response(article, { status: 200 });
    if (/\/tags$/.test(String(url))) return new Response('{}', { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const client = createKarakeepClient({ url: 'https://karakeep.test', key: 'k', fetchImpl });
  return { client, calls };
}

test('karakeep: not created without a URL and a key', () => {
  assert.equal(createKarakeepClient({ env: {} }), null);
  assert.equal(createKarakeepClient({ env: { KARAKEEP_URL: 'https://x' } }), null);
  assert.ok(createKarakeepClient({ env: { KARAKEEP_URL: 'https://x', KARAKEEP_API_KEY: 'k' } }));
});

test('karakeep: the queue is filtered by tag and by archived state', async () => {
  const bookmarks = [
    { ...BOOKMARK, id: 'a', tags: [{ name: 'epubbed' }] },
    { ...BOOKMARK, id: 'b', tags: [] },
    { ...BOOKMARK, id: 'c', archived: true, tags: [] },
    { ...BOOKMARK, id: 'd', tags: [{ name: 'work' }] },
  ];
  const { client } = karakeepStub({ bookmarks });
  assert.deepEqual((await client.list({ skipTag: 'epubbed' })).map((b) => b.id), ['b', 'd']);
  assert.deepEqual((await client.list({ requireTag: 'work' })).map((b) => b.id), ['d']);
  assert.deepEqual((await client.list({ includeArchived: true, skipTag: 'epubbed' })).map((b) => b.id), ['b', 'c', 'd']);
});

test('karakeep: the article comes from the asset, not the empty inline field', async () => {
  const { client, calls } = karakeepStub();
  const doc = await bookmarkToDocument(client, BOOKMARK, 0);
  assert.ok(calls.some((c) => c.url.includes('/api/v1/assets/asset1')), 'the asset was fetched');
  assert.match(doc.markdown, /The saved article body/);
  assert.match(doc.markdown, /title: "Saved Piece"/);
  assert.match(doc.markdown, /author: "Grace"/);
  assert.equal(doc.path, '001-bookmark.md');
});

test('karakeep: a bookmark with no crawled article is an error, not an empty chapter', async () => {
  const { client } = karakeepStub();
  await assert.rejects(
    () => bookmarkToDocument(client, { ...BOOKMARK, assets: [], content: { ...BOOKMARK.content, htmlContent: null } }, 0),
    /not crawled/,
  );
});

test('karakeep: tagging posts the tag the caller asked for', async () => {
  const { client, calls } = karakeepStub();
  await client.tag(BOOKMARK, 'epubbed');
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'a POST was made');
  assert.match(post.url, /\/api\/v1\/bookmarks\/bk1\/tags$/);
});

test('a queue of bookmarks becomes one book', async () => {
  const { client } = karakeepStub({ bookmarks: [{ ...BOOKMARK, id: 'a' }, { ...BOOKMARK, id: 'b', title: 'Second Piece' }] });
  const bookmarks = await client.list({});
  const docs = [];
  for (const [i, b] of bookmarks.entries()) docs.push(await bookmarkToDocument(client, b, i));
  const result = await markdownToEpub(docs, { title: 'Read Later', generateCover: false });
  assert.equal(result.documentCount, 2);
  const nav = strFromU8(unzipSync(result.bytes)['EPUB/nav.xhtml']);
  assert.match(nav, /Saved Piece/);
  assert.match(nav, /Second Piece/);
});

test('api: URLs are converted, and a bad one is reported clearly', async () => {
  const app = createApp({
    config: {
      fetchArticle: async (url) => {
        if (url.includes('bad')) throw new Error('the server answered 404');
        return { markdown: 'Body.', title: 'Fetched', url, byline: '', siteName: '', publishedTime: '', excerpt: '' };
      },
    },
  });
  const form = new FormData();
  form.append('urls', 'https://example.com/one\nhttps://example.com/two');
  const ok = await app.fetch(new Request('http://x/api/convert', { method: 'POST', body: form }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-md2epub-documents'), '2');

  const badForm = new FormData();
  badForm.append('urls', 'https://example.com/bad');
  const bad = await app.fetch(new Request('http://x/api/convert', { method: 'POST', body: badForm }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /could not be read: the server answered 404/);
});

test('api: non-http input and too many URLs are refused', async () => {
  const app = createApp({ config: { fetchArticle: async () => ({ markdown: 'x', title: 't' }), maxUrls: 2 } });
  const bad = new FormData();
  bad.append('urls', 'file:///etc/passwd');
  assert.equal((await app.fetch(new Request('http://x/api/convert', { method: 'POST', body: bad }))).status, 400);

  const many = new FormData();
  many.append('urls', 'https://a.test/1 https://a.test/2 https://a.test/3');
  const response = await app.fetch(new Request('http://x/api/convert', { method: 'POST', body: many }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /more than 2 URLs/);
});

test('api: a server without web input says so instead of ignoring the request', async () => {
  const app = createApp({});
  const form = new FormData();
  form.append('urls', 'https://example.com/one');
  const response = await app.fetch(new Request('http://x/api/convert', { method: 'POST', body: form }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /cannot fetch web pages/);
});
