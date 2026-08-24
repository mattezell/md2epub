// Bundling several documents into one book, plus the shelf identity features.

import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToEpub } from '../src/core/index.js';
import { resolveFrom, titleFromFilename, normalisePath } from '../src/core/paths.js';
import { generateCover } from '../src/core/cover.js';

const entries = (bytes) => unzipSync(bytes);
const text = (bytes, path) => strFromU8(entries(bytes)[path]);

const DOCS = [
  { path: 'README.md', markdown: '# Overview\n\nSee the [setup guide](./setup.md) and the [api](api/reference.md#endpoints).' },
  { path: 'setup.md', markdown: '# Setup\n\nBack to the [overview](README.md).' },
  { path: 'api/reference.md', markdown: '# API Reference\n\n## Endpoints\n\nUp to [setup](../setup.md).' },
];

test('paths: references resolve relative to the document that carries them', () => {
  assert.equal(resolveFrom('docs/guide/intro.md', './setup.md'), 'docs/guide/setup.md');
  assert.equal(resolveFrom('docs/guide/intro.md', '../api/ref.md'), 'docs/api/ref.md');
  assert.equal(resolveFrom('a.md', 'b.md'), 'b.md');
  assert.equal(normalisePath('a/./b/../c.md'), 'a/c.md');
});

test('paths: a file name becomes a readable title', () => {
  assert.equal(titleFromFilename('01-getting-started.md'), 'Getting Started');
  assert.equal(titleFromFilename('deep/dir/some_notes.md'), 'Some Notes');
  assert.equal(titleFromFilename('HANDOFF.md'), 'HANDOFF');
});

test('bundle: every document becomes a chapter, in the order given', async () => {
  const result = await markdownToEpub(DOCS, { title: 'Project Docs' });
  assert.equal(result.documentCount, 3);
  assert.equal(result.chapterCount, 3);
  assert.equal(result.metadata.title, 'Project Docs');
  assert.match(text(result.bytes, 'EPUB/ch-001.xhtml'), /Overview/);
  assert.match(text(result.bytes, 'EPUB/ch-002.xhtml'), /Setup/);
  assert.match(text(result.bytes, 'EPUB/ch-003.xhtml'), /API Reference/);
});

test('bundle: links between documents become links between chapters', async () => {
  const result = await markdownToEpub(DOCS, { title: 'Project Docs' });
  const readme = text(result.bytes, 'EPUB/ch-001.xhtml');
  assert.match(readme, /href="ch-002\.xhtml"[^>]*>setup guide/);
  assert.match(readme, /href="ch-003\.xhtml#endpoints"[^>]*>api/, 'a fragment in another document keeps its anchor');
  assert.match(text(result.bytes, 'EPUB/ch-003.xhtml'), /href="ch-002\.xhtml"[^>]*>setup/, 'a ../ link resolves');
  assert.deepEqual(result.warnings, []);
});

test('bundle: a link to a document that is not in the bundle degrades', async () => {
  const result = await markdownToEpub([
    { path: 'a.md', markdown: '# A\n\n[gone](./missing.md)' },
    { path: 'b.md', markdown: '# B\n\ntext' },
  ]);
  assert.match(text(result.bytes, 'EPUB/ch-001.xhtml'), /<a>gone<\/a>/);
  assert.match(result.warnings.join(' '), /1 link points outside the book/);
});

test('bundle: heading ids stay unique across documents', async () => {
  const result = await markdownToEpub([
    { path: 'a.md', markdown: '# Notes\n\n## Detail\n\nx' },
    { path: 'b.md', markdown: '# Notes\n\n## Detail\n\ny' },
  ]);
  const nav = text(result.bytes, 'EPUB/nav.xhtml');
  assert.match(nav, /#notes"/);
  assert.match(nav, /#notes-1"/);
  assert.match(nav, /#detail-1"/);
});

test('bundle: two documents can reference different images by the same name', async () => {
  const seen = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const result = await markdownToEpub([
    { path: 'one/a.md', markdown: '# A\n\n![x](diagram.png)' },
    { path: 'two/b.md', markdown: '# B\n\n![x](diagram.png)' },
  ], {
    resolveLocal: async (src, from) => {
      seen.push(`${from} -> ${src}`);
      return { bytes: png };
    },
  });
  assert.deepEqual(seen, ['one/a.md -> diagram.png', 'two/b.md -> diagram.png']);
  const files = entries(result.bytes);
  assert.ok(files['EPUB/images/img-001.png'], 'first document image');
  assert.ok(files['EPUB/images/img-002.png'], 'second document image, not deduplicated by name');
});

test('bundle: the contents nests each document under its own entry', async () => {
  const result = await markdownToEpub([
    { path: 'guide.md', markdown: '## Only a subheading\n\nx' },
    { path: 'other.md', markdown: '## Another\n\ny' },
  ], { title: 'Two Docs' });
  const nav = text(result.bytes, 'EPUB/nav.xhtml');
  assert.match(nav, /Guide/, 'a document with no H1 is listed by its file name');
  assert.match(nav, /Other/);
  assert.match(nav, /Only a subheading/);
});

test('bundle: an empty document is skipped rather than failing the book', async () => {
  const result = await markdownToEpub([
    { path: 'good.md', markdown: '# Good\n\ntext' },
    { path: 'empty.md', markdown: '   \n\n' },
  ]);
  assert.equal(result.documentCount, 1);
  assert.match(result.warnings.join(' '), /empty\.md is empty/);
});

test('title: a single named document falls back to its file name', async () => {
  const named = await markdownToEpub([{ path: 'docs/01-design-notes.md', markdown: '## Just notes\n\nx' }]);
  assert.equal(named.metadata.title, 'Design Notes');
  assert.equal(named.filename, 'design-notes.epub');

  const unnamed = await markdownToEpub('## Just notes\n\nx');
  assert.equal(unnamed.metadata.title, 'Untitled', 'pasted text has no file name to borrow');
});

test('title: frontmatter and headings still win over the file name', async () => {
  const heading = await markdownToEpub([{ path: 'file-name.md', markdown: '# Real Title\n\nx' }]);
  assert.equal(heading.metadata.title, 'Real Title');
  const frontmatter = await markdownToEpub([{ path: 'file-name.md', markdown: '---\ntitle: From Frontmatter\n---\n\n# Heading\n\nx' }]);
  assert.equal(frontmatter.metadata.title, 'From Frontmatter');
});

test('cover: one is drawn when none is supplied', async () => {
  const result = await markdownToEpub('# A Book\n\nx', { author: 'Someone' });
  const files = entries(result.bytes);
  assert.ok(files['EPUB/images/cover.svg']);
  assert.ok(files['EPUB/cover.xhtml']);
  const svg = strFromU8(files['EPUB/images/cover.svg']);
  assert.match(svg, /A Book/);
  assert.match(svg, /Someone/);
  const opf = text(result.bytes, 'EPUB/package.opf');
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, /media-type="image\/svg\+xml"/);
});

test('cover: an uploaded cover wins, and generation can be turned off', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const uploaded = await markdownToEpub('# B\n\nx', { cover: { bytes: png } });
  assert.ok(entries(uploaded.bytes)['EPUB/images/cover.png']);
  assert.equal(entries(uploaded.bytes)['EPUB/images/cover.svg'], undefined);

  const none = await markdownToEpub('# B\n\nx', { generateCover: false });
  assert.equal(entries(none.bytes)['EPUB/cover.xhtml'], undefined);
});

test('cover: titles that would overflow are wrapped and escaped', () => {
  const long = generateCover({ title: 'A '.repeat(60) + '& <ending>', authors: ['X'], date: '2026-08-24' });
  const svg = new TextDecoder().decode(long.bytes);
  assert.equal(svg.includes('& <ending>'), false, 'the title is escaped');
  assert.match(svg, /&amp; &lt;ending&gt;/);
  const lines = (svg.match(/<tspan/g) || []).length;
  assert.ok(lines > 1 && lines <= 6, `wrapped into ${lines} lines`);
});
