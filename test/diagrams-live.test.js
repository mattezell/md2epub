// The real renderer, driving a real browser. Skipped unless the toolchain is
// installed (npm run diagrams:install), so a plain checkout still runs green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createMermaidRenderer, diagramSupport, findChrome } from '../src/diagrams.js';
import { markdownToEpub } from '../src/core/index.js';

const support = diagramSupport();
const skip = support.available ? false : `diagram toolchain not installed here: ${support.reason}`;

test('chrome is found in the usual places, or where CHROME_PATH says', () => {
  const found = findChrome({ CHROME_PATH: '/definitely/not/here' });
  assert.equal(found, null, 'a declared path that does not exist is not silently replaced');
});

test('the renderer is null rather than broken when the toolchain is missing', () => {
  const renderer = createMermaidRenderer({ env: { MD2EPUB_MMDC: '/nope/mmdc', CHROME_PATH: '/nope/chrome' } });
  assert.equal(renderer, null);
  assert.throws(
    () => createMermaidRenderer({ env: { MD2EPUB_MMDC: '/nope/mmdc', CHROME_PATH: '/nope/chrome' }, required: true }),
    /mermaid-cli is not installed/,
  );
});

test('renders a mermaid diagram to a real PNG', { skip }, async () => {
  const render = createMermaidRenderer({ cacheDir: '' });
  const result = await render('graph TD\n  A[Start] --> B[End]', { language: 'mermaid', hash: 'live-png' });
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.bytes[0], 0x89, 'PNG signature');
  assert.equal(String.fromCharCode(...result.bytes.slice(1, 4)), 'PNG');
  assert.ok(result.bytes.length > 2000, `got ${result.bytes.length} bytes`);
});

test('renders SVG without foreignObject, which e-readers cannot display', { skip }, async () => {
  const render = createMermaidRenderer({ format: 'svg', cacheDir: '' });
  const result = await render('graph TD\n  A[Start] --> B[End]', { language: 'mermaid', hash: 'live-svg' });
  const svg = new TextDecoder().decode(result.bytes);
  assert.equal(svg.includes('foreignObject'), false, 'htmlLabels must stay off');
  assert.match(svg, /<text/, 'labels are real text nodes');
});

test('the second render of the same diagram comes from the cache', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'md2epub-cache-test-'));
  try {
    const render = createMermaidRenderer({ cacheDir: dir });
    const first = await render('graph TD\n  X --> Y', { language: 'mermaid', hash: 'cache-me' });
    assert.equal(first.cached, false);
    const second = await render('graph TD\n  X --> Y', { language: 'mermaid', hash: 'cache-me' });
    assert.equal(second.cached, true);
    assert.deepEqual([...second.bytes], [...first.bytes]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a broken diagram degrades to a code block rather than failing the book', { skip }, async () => {
  const result = await markdownToEpub('# T\n\n```mermaid\nthis is not valid mermaid at all {{{\n```\n', {
    renderDiagram: createMermaidRenderer({ cacheDir: '' }),
  });
  assert.equal(result.diagramCount, 0);
  assert.match(result.warnings[0], /could not be rendered/);
});

test('a real book with a real diagram packages it', { skip }, async () => {
  const result = await markdownToEpub('# Notes\n\n```mermaid\ngraph LR\n  A --> B\n```\n', {
    renderDiagram: createMermaidRenderer({ cacheDir: '' }),
  });
  assert.equal(result.diagramCount, 1);
  const files = unzipSync(result.bytes);
  const diagram = Object.keys(files).find((name) => name.startsWith('EPUB/diagrams/'));
  assert.ok(diagram, 'the diagram is in the package');
  assert.equal(files[diagram][0], 0x89, 'and it is a real PNG');
});
