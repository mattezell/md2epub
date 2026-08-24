import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToEpub } from '../src/core/index.js';
import { htmlToXhtml } from '../src/core/html.js';
import { parseFrontmatter, metadataFromFrontmatter } from '../src/core/frontmatter.js';
import { splitDocument } from '../src/core/markdown.js';
import { slugify, filenameFor } from '../src/core/slug.js';
import { decodeDataUri, sniffImage } from '../src/core/images.js';

const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVR42u3NMQEAAAgDoC252Bwe1gAKZKr8vAUCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAsE1BwUABGXvT8UAAAAASUVORK5CYII=';

const entries = (bytes) => unzipSync(bytes);
const text = (bytes, path) => strFromU8(entries(bytes)[path]);

test('frontmatter: parsed, mapped and separated from the body', () => {
  const { data, body } = parseFrontmatter('---\ntitle: T\nauthor: [A, B]\n---\n# H\n');
  assert.equal(body, '# H\n');
  const meta = metadataFromFrontmatter(data);
  assert.equal(meta.title, 'T');
  assert.deepEqual(meta.authors, ['A', 'B']);
});

test('frontmatter: broken YAML is kept as body instead of thrown away', () => {
  const { data, body, warnings } = parseFrontmatter('---\n: [broken\n---\nreal body');
  assert.deepEqual(data, {});
  assert.match(body, /^---/);
  assert.equal(warnings.length, 1);
});

test('splitting: one file per level 1 heading, headings get stable ids', () => {
  const { chapters, toc, docTitle } = splitDocument('# One\n\na\n\n## Sub\n\nb\n\n# Two\n\nc');
  assert.equal(chapters.length, 2);
  assert.equal(docTitle, 'One');
  assert.deepEqual(toc.map((t) => t.slug), ['one', 'sub', 'two']);
  assert.match(chapters[0].html, /<h1 id="one">/);
});

test('splitting: duplicate headings get distinct ids', () => {
  const { toc } = splitDocument('# Notes\n\na\n\n# Notes\n\nb');
  assert.deepEqual(toc.map((t) => t.slug), ['notes', 'notes-1']);
});

test('splitting: a document with no headings is a single chapter', () => {
  const { chapters } = splitDocument('just a paragraph');
  assert.equal(chapters.length, 1);
});

test('slugs: headings and file names', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('1. Intro'), 'id-1-intro');
  assert.equal(filenameFor('My Book: Vol 2'), 'my-book-vol-2.epub');
  assert.equal(filenameFor(''), 'book.epub');
});

test('sanitiser: scripts, handlers and javascript: URLs do not survive', () => {
  const out = htmlToXhtml('<script>bad()</script><p onclick="bad()">ok</p><a href="javascript:bad()">x</a>');
  assert.equal(out.includes('script'), false);
  assert.equal(out.includes('onclick'), false);
  assert.equal(out.includes('javascript:'), false);
  assert.match(out, /<p>ok<\/p>/);
});

test('sanitiser: output is well formed XML', () => {
  assert.equal(htmlToXhtml('<p>a <br> b <img src="x.png" alt="i"></p>'), '<p>a <br /> b <img src="x.png" alt="i" /></p>');
  assert.equal(htmlToXhtml('<p>unclosed <b>bold'), '<p>unclosed <b>bold</b></p>');
  assert.equal(htmlToXhtml('stray </div> close'), 'stray  close');
  assert.equal(htmlToXhtml('a < b & c'), 'a &lt; b &amp; c');
});

test('sanitiser: named entities become characters XML understands', () => {
  // XML knows only five entities, so named ones must be resolved to characters.
  assert.equal(htmlToXhtml('<p>&copy; &nbsp; &mdash;</p>'), '<p>© \u00a0 —</p>');
  // An escaped ampersand stays escaped rather than becoming a stray & in the XML.
  assert.equal(htmlToXhtml('<p>&amp;notanentity;</p>'), '<p>&amp;notanentity;</p>');
});

test('sanitiser: apostrophes and quotes stay readable in text', () => {
  // &apos; is not an HTML entity, so it must never reach a text node.
  const out = htmlToXhtml('<p>it\'s "quoted"</p>');
  assert.equal(out, '<p>it\'s "quoted"</p>');
});

test('sanitiser: inline styles are kept only when they are real CSS', () => {
  assert.match(htmlToXhtml('<p style="color: red; margin: 0">x</p>'), /style="color: red; margin: 0"/);
  // MDX/JSX: style={{position: 'relative'}} parses out as `{{position:`, which
  // EPUB rejects as CSS (CSS-008) and invalidates the whole book.
  assert.equal(htmlToXhtml('<div style="{{position:">x</div>'), '<div>x</div>');
  assert.equal(htmlToXhtml('<p style="background: url(http://evil/x.png)">x</p>'), '<p>x</p>');
  assert.match(htmlToXhtml('<p style="color: red; background: url(x)">y</p>'), /style="color: red"/);
});

test('sanitiser: ids that XML rejects are repaired', () => {
  assert.match(htmlToXhtml('<div id="9lives">x</div>'), /id="id-9lives"/);
});

test('images: data URIs are decoded and sniffed', () => {
  const decoded = decodeDataUri(PNG_DATA_URI);
  assert.ok(decoded.bytes.length > 0);
  assert.deepEqual(sniffImage(decoded.bytes), { mediaType: 'image/png', ext: 'png' });
});

test('conversion: produces a well formed OCF container', async () => {
  const result = await markdownToEpub('# Title\n\nBody text.');
  const files = entries(result.bytes);
  assert.ok(files.mimetype);
  assert.equal(strFromU8(files.mimetype), 'application/epub+zip');
  assert.ok(files['META-INF/container.xml']);
  assert.ok(files['EPUB/package.opf']);
  assert.ok(files['EPUB/nav.xhtml']);
  assert.ok(files['EPUB/toc.ncx']);
  assert.ok(files['EPUB/ch-001.xhtml']);
});

test('conversion: mimetype is the first entry and is stored uncompressed', async () => {
  const { bytes } = await markdownToEpub('# T\n\nx');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, 'first local header signature');
  assert.equal(view.getUint16(8, true), 0, 'compression method STORE');
  const nameLength = view.getUint16(26, true);
  assert.equal(strFromU8(bytes.slice(30, 30 + nameLength)), 'mimetype');
});

test('conversion: metadata comes from options, then frontmatter, then the first heading', async () => {
  const md = '---\ntitle: From Frontmatter\nauthor: FM Author\n---\n\n# From Heading\n\nx';
  const fromFm = await markdownToEpub(md);
  assert.equal(fromFm.metadata.title, 'From Frontmatter');
  assert.deepEqual(fromFm.metadata.authors, ['FM Author']);

  const override = await markdownToEpub(md, { title: 'From Options', author: 'A, B' });
  assert.equal(override.metadata.title, 'From Options');
  assert.deepEqual(override.metadata.authors, ['A', 'B']);

  const fromHeading = await markdownToEpub('# From Heading\n\nx');
  assert.equal(fromHeading.metadata.title, 'From Heading');
  assert.equal(fromHeading.filename, 'from-heading.epub');
});

test('conversion: metadata is escaped, not injected, into the package document', async () => {
  const { bytes } = await markdownToEpub('# x', { title: 'A & B <evil>' });
  const opf = text(bytes, 'EPUB/package.opf');
  assert.match(opf, /<dc:title>A &amp; B &lt;evil&gt;<\/dc:title>/);
});

test('conversion: identifier is a fresh urn:uuid unless one is supplied', async () => {
  const a = await markdownToEpub('# x');
  const b = await markdownToEpub('# x');
  assert.match(a.metadata.identifier, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.notEqual(a.metadata.identifier, b.metadata.identifier);
  const fixed = await markdownToEpub('# x', { identifier: 'urn:isbn:1234567890' });
  assert.equal(fixed.metadata.identifier, 'urn:isbn:1234567890');
});

test('conversion: cross chapter fragment links are rewritten to their file', async () => {
  const { bytes } = await markdownToEpub('# One\n\n[go](#two)\n\n# Two\n\nx');
  assert.match(text(bytes, 'EPUB/ch-001.xhtml'), /href="ch-002\.xhtml#two"/);
});

test('conversion: links to headings that do not exist are unwrapped and reported', async () => {
  const result = await markdownToEpub('# One\n\n[nowhere](#nope)');
  assert.match(text(result.bytes, 'EPUB/ch-001.xhtml'), /<a>nowhere<\/a>/);
  assert.equal(result.warnings.some((w) => w.includes('#nope')), true);
});

test('conversion: links to paths outside the book become plain text', async () => {
  // Documentation written for a docs site is full of these, and EPUB rejects
  // them (RSC-026), so the whole book would be invalid.
  const result = await markdownToEpub('# Notes\n\n[a](/user-guide/x) [b](./other.md) [c](https://ok.example) [d](#notes)');
  const chapter = text(result.bytes, 'EPUB/ch-001.xhtml');
  assert.match(chapter, /<a>a<\/a>/);
  assert.match(chapter, /<a>b<\/a>/);
  assert.match(chapter, /<a href="https:\/\/ok\.example">c<\/a>/, 'external links survive');
  assert.match(chapter, /<a href="#notes">d<\/a>/, 'in-book anchors survive');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /2 links point outside the book/);
});

test('conversion: data URI images are packaged and referenced by path', async () => {
  const result = await markdownToEpub(`# P\n\n![sq](${PNG_DATA_URI})`);
  assert.equal(result.imageCount, 1);
  const files = entries(result.bytes);
  assert.ok(files['EPUB/images/img-001.png']);
  assert.match(text(result.bytes, 'EPUB/ch-001.xhtml'), /<img src="images\/img-001\.png"/);
  assert.match(text(result.bytes, 'EPUB/package.opf'), /media-type="image\/png"/);
});

test('conversion: an image that cannot be packaged degrades to its alt text', async () => {
  const result = await markdownToEpub('# P\n\n![the alt text](./missing.png)');
  const chapter = text(result.bytes, 'EPUB/ch-001.xhtml');
  assert.equal(chapter.includes('<img'), false);
  assert.match(chapter, /the alt text/);
  assert.equal(result.warnings.length, 1);
});

test('conversion: remote images are not referenced unless embedding is on', async () => {
  const result = await markdownToEpub('# P\n\n![r](https://example.com/x.png)');
  assert.equal(text(result.bytes, 'EPUB/ch-001.xhtml').includes('https://example.com/x.png'), false);
  assert.match(result.warnings[0], /Remote image/);
});

test('conversion: remote images are fetched when the caller allows it', async () => {
  const decoded = decodeDataUri(PNG_DATA_URI);
  let asked = '';
  const result = await markdownToEpub('# P\n\n![r](https://example.com/x.png)', {
    embedRemoteImages: true,
    fetchImage: async (url) => {
      asked = url;
      return { bytes: decoded.bytes, declaredType: 'image/png' };
    },
  });
  assert.equal(asked, 'https://example.com/x.png');
  assert.equal(result.imageCount, 1);
  assert.deepEqual(result.warnings, []);
});

test('conversion: a cover image becomes a cover page and manifest entry', async () => {
  const decoded = decodeDataUri(PNG_DATA_URI);
  const result = await markdownToEpub('# P\n\nx', { cover: { bytes: decoded.bytes } });
  const files = entries(result.bytes);
  assert.ok(files['EPUB/cover.xhtml']);
  assert.ok(files['EPUB/images/cover.png']);
  const opf = text(result.bytes, 'EPUB/package.opf');
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, /<itemref idref="cover-page" \/>/);
  // Declaring one file in two manifest items is an EPUB error (OPF-074).
  assert.equal(opf.match(/href="images\/cover\.png"/g).length, 1);
  assert.equal(result.imageCount, 1);
});

test('conversion: splitLevel 0 keeps everything in one file', async () => {
  const result = await markdownToEpub('# A\n\nx\n\n# B\n\ny', { splitLevel: 0 });
  assert.equal(result.chapterCount, 1);
});

test('conversion: the contents lists headings down to tocDepth only', async () => {
  const shallow = await markdownToEpub('# A\n\n## B\n\n### C\n', { tocDepth: 1 });
  const nav = text(shallow.bytes, 'EPUB/nav.xhtml');
  assert.match(nav, /#a"/);
  assert.equal(nav.includes('#b"'), false);
});

test('conversion: typographer can be turned off', async () => {
  const on = await markdownToEpub('# T\n\n"quoted"');
  const off = await markdownToEpub('# T\n\n"quoted"', { typographer: false });
  assert.match(text(on.bytes, 'EPUB/ch-001.xhtml'), /“quoted”/);
  assert.match(text(off.bytes, 'EPUB/ch-001.xhtml'), /<p>"quoted"<\/p>/);
});

test('conversion: language falls back to en when the tag is nonsense', async () => {
  const result = await markdownToEpub('# T\n\nx', { language: 'not a language' });
  assert.equal(result.metadata.language, 'en');
});

test('conversion: empty or whitespace input is rejected', async () => {
  await assert.rejects(() => markdownToEpub('   \n\n  '), /empty/i);
  await assert.rejects(() => markdownToEpub(null), TypeError);
});

test('conversion: CRLF input and a BOM are handled', async () => {
  const result = await markdownToEpub('﻿# Title\r\n\r\nBody\r\n');
  assert.equal(result.metadata.title, 'Title');
  assert.equal(text(result.bytes, 'EPUB/ch-001.xhtml').includes('\r'), false);
});

test('conversion: non-ASCII content survives the round trip', async () => {
  const result = await markdownToEpub('# 日本語\n\nإلعربية and éèê');
  const chapter = text(result.bytes, 'EPUB/ch-001.xhtml');
  assert.match(chapter, /日本語/);
  assert.match(chapter, /إلعربية/);
});
