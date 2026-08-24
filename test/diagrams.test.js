// Diagram fences becoming images. The renderer is stubbed here: the real one
// drives a browser and is covered by test/diagrams-live.test.js when the
// toolchain is installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToEpub } from '../src/core/index.js';
import { hashSource, altTextFor, findDiagrams } from '../src/core/diagrams.js';
import { createRenderer } from '../src/core/markdown.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const entries = (bytes) => unzipSync(bytes);
const text = (bytes, path) => strFromU8(entries(bytes)[path]);
const stub = () => async () => ({ bytes: PNG, mediaType: 'image/png' });

const MD = ['# Doc', '', '```mermaid', 'graph TD', '  A --> B', '```', '', '```js', 'const x = 1;', '```', ''].join('\n');

test('detection: only diagram fences are picked up', () => {
  const md = createRenderer();
  const tokens = md.parse(MD, {});
  const found = findDiagrams(tokens);
  assert.equal(found.length, 1);
  assert.equal(found[0].language, 'mermaid');
  assert.match(found[0].source, /graph TD/);
});

test('detection: the hash is stable for the same source and differs otherwise', () => {
  assert.equal(hashSource('mermaid:graph TD'), hashSource('mermaid:graph TD'));
  assert.notEqual(hashSource('mermaid:graph TD'), hashSource('mermaid:graph LR'));
});

test('alt text: taken from the diagram title, a comment, or the diagram type', () => {
  assert.equal(altTextFor('---\ntitle: Request path\n---\ngraph LR\n A-->B', 'mermaid'), 'Request path');
  assert.equal(altTextFor('%% How auth works\ngraph LR\n A-->B', 'mermaid'), 'How auth works');
  assert.equal(altTextFor('sequenceDiagram\n A->>B: hi', 'mermaid'), 'sequenceDiagram diagram');
});

test('conversion: a diagram fence becomes a packaged image', async () => {
  const result = await markdownToEpub(MD, { renderDiagram: stub() });
  assert.equal(result.diagramCount, 1);
  const chapter = text(result.bytes, 'EPUB/ch-001.xhtml');
  assert.match(chapter, /<figure class="md2epub-diagram"><img src="diagrams\/[0-9a-f]+\.png" alt="graph diagram" \/><\/figure>/);
  assert.match(chapter, /<pre><code class="language-js">/, 'other fences are left alone');
  const files = entries(result.bytes);
  assert.ok(Object.keys(files).some((name) => /^EPUB\/diagrams\/[0-9a-f]+\.png$/.test(name)));
  assert.match(text(result.bytes, 'EPUB/package.opf'), /href="diagrams\/[0-9a-f]+\.png" media-type="image\/png"/);
});

test('conversion: without a renderer the fence stays a code block', async () => {
  const result = await markdownToEpub(MD);
  assert.equal(result.diagramCount, 0);
  assert.match(text(result.bytes, 'EPUB/ch-001.xhtml'), /<pre><code class="language-mermaid">/);
  assert.deepEqual(result.warnings, []);
});

test('conversion: a renderer failure degrades to a code block and says so', async () => {
  const result = await markdownToEpub(MD, {
    renderDiagram: async () => { throw new Error('chrome is not installed'); },
  });
  assert.equal(result.diagramCount, 0);
  assert.match(text(result.bytes, 'EPUB/ch-001.xhtml'), /<pre><code class="language-mermaid">/);
  assert.match(result.warnings[0], /could not be rendered \(chrome is not installed\)/);
});

test('conversion: a renderer returning something that is not an image is refused', async () => {
  const result = await markdownToEpub(MD, {
    renderDiagram: async () => ({ bytes: new TextEncoder().encode('not an image at all'), mediaType: 'image/png' }),
  });
  assert.equal(result.diagramCount, 0);
  assert.match(result.warnings[0], /did not return an image/);
});

test('conversion: an identical diagram is rendered once and shared', async () => {
  let calls = 0;
  const repeated = `${MD}\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n`;
  const result = await markdownToEpub(repeated, {
    renderDiagram: async () => { calls += 1; return { bytes: PNG, mediaType: 'image/png' }; },
  });
  assert.equal(calls, 1, 'rendered once');
  assert.equal(result.diagramCount, 1, 'packaged once');
  const chapter = text(result.bytes, 'EPUB/ch-001.xhtml');
  assert.equal((chapter.match(/md2epub-diagram/g) || []).length, 2, 'referenced twice');
});

test('conversion: the same diagram in two documents is rendered once', async () => {
  let calls = 0;
  const result = await markdownToEpub([
    { path: 'a.md', markdown: MD },
    { path: 'b.md', markdown: MD },
  ], { renderDiagram: async () => { calls += 1; return { bytes: PNG, mediaType: 'image/png' }; } });
  assert.equal(calls, 1);
  assert.equal(result.diagramCount, 1);
  assert.match(text(result.bytes, 'EPUB/ch-002.xhtml'), /diagrams\//);
});

test('conversion: diagrams do not disturb ordinary images', async () => {
  const withImage = `${MD}\n![a picture](pic.png)\n`;
  const result = await markdownToEpub(withImage, {
    renderDiagram: stub(),
    resolveLocal: async () => ({ bytes: PNG }),
  });
  assert.equal(result.diagramCount, 1);
  const chapter = text(result.bytes, 'EPUB/ch-001.xhtml');
  assert.match(chapter, /diagrams\//);
  assert.match(chapter, /images\/img-001\.png/);
});
