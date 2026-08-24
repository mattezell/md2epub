// The generated cover, and turning it into something a Kindle will display.

import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToEpub } from '../src/core/index.js';
import { generateCover } from '../src/core/cover.js';
import { createSvgRasterizer, findChrome } from '../src/chrome.js';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const fakePng = () => new Uint8Array([...PNG_HEADER, 0, 0, 0, 13, 0, 0, 0, 0]);
const entries = (bytes) => unzipSync(bytes);

const chrome = findChrome();
const skip = chrome ? false : 'no Chrome or Chromium on this machine';

test('the drawn cover reports the size it should be rasterised at', () => {
  const drawn = generateCover({ title: 'A Book', authors: ['Someone'], date: '2026-08-24' });
  assert.equal(drawn.mediaType, 'image/svg+xml');
  assert.equal(drawn.width, 1600);
  assert.equal(drawn.height, 2560);
  // 1600x2560 is 1.6, the aspect ratio e-reader shelves expect.
  assert.equal(drawn.width / drawn.height, 0.625);
});

test('without a rasteriser the cover stays SVG, and that is not a per book warning', async () => {
  const result = await markdownToEpub('# Book\n\nx');
  assert.ok(entries(result.bytes)['EPUB/images/cover.svg']);
  assert.deepEqual(result.warnings, []);
});

test('with a rasteriser the cover is packaged as PNG', async () => {
  let asked = null;
  const result = await markdownToEpub('# Book\n\nx', {
    rasterizeSvg: async (svg, size) => {
      asked = { svg: new TextDecoder().decode(svg), size };
      return { bytes: fakePng(), mediaType: 'image/png' };
    },
  });
  const files = entries(result.bytes);
  assert.ok(files['EPUB/images/cover.png']);
  assert.equal(files['EPUB/images/cover.svg'], undefined);
  assert.deepEqual(asked.size, { width: 1600, height: 2560 });
  assert.match(asked.svg, /<svg/);
  assert.match(strFromU8(files['EPUB/package.opf']), /href="images\/cover\.png" media-type="image\/png" properties="cover-image"/);
});

test('an uploaded SVG cover is rasterised too', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  const result = await markdownToEpub('# Book\n\nx', {
    cover: { bytes: svg, mediaType: 'image/svg+xml' },
    rasterizeSvg: async () => ({ bytes: fakePng(), mediaType: 'image/png' }),
  });
  assert.ok(entries(result.bytes)['EPUB/images/cover.png']);
});

test('an uploaded raster cover is left alone', async () => {
  let called = false;
  const result = await markdownToEpub('# Book\n\nx', {
    cover: { bytes: fakePng() },
    rasterizeSvg: async () => { called = true; return { bytes: fakePng(), mediaType: 'image/png' }; },
  });
  assert.equal(called, false, 'a PNG does not need converting');
  assert.ok(entries(result.bytes)['EPUB/images/cover.png']);
});

test('a rasteriser failure falls back to the SVG rather than losing the cover', async () => {
  const result = await markdownToEpub('# Book\n\nx', {
    rasterizeSvg: async () => { throw new Error('chrome crashed'); },
  });
  assert.ok(entries(result.bytes)['EPUB/images/cover.svg'], 'the cover survives');
  assert.match(result.warnings[0], /could not be converted from SVG to PNG \(chrome crashed\)/);
});

test('a rasteriser returning something that is not an image is refused', async () => {
  const result = await markdownToEpub('# Book\n\nx', {
    rasterizeSvg: async () => ({ bytes: new TextEncoder().encode('nope'), mediaType: 'image/png' }),
  });
  assert.ok(entries(result.bytes)['EPUB/images/cover.svg']);
  assert.match(result.warnings[0], /was not an image/);
});

test('no rasteriser is built when there is no browser', () => {
  assert.equal(createSvgRasterizer({ env: { CHROME_PATH: '/nowhere/chrome' } }), null);
});

test('rasterises a real cover with the local browser', { skip }, async () => {
  const rasterize = createSvgRasterizer({ cacheDir: '' });
  const drawn = generateCover({ title: 'Real Cover', authors: ['Matt Ezell'], date: '2026-08-24' });
  const png = await rasterize(drawn.bytes, { width: drawn.width, height: drawn.height });
  assert.equal(png.mediaType, 'image/png');
  assert.deepEqual([...png.bytes.slice(0, 8)], PNG_HEADER);
  // Width and height live big-endian at offset 16 of the IHDR chunk.
  const view = new DataView(png.bytes.buffer, png.bytes.byteOffset, png.bytes.byteLength);
  assert.equal(view.getUint32(16), 1600);
  assert.equal(view.getUint32(20), 2560);
});

test('a real book gets a real PNG cover', { skip }, async () => {
  const result = await markdownToEpub('# Poolside Reading\n\nx', {
    author: 'Matt Ezell',
    rasterizeSvg: createSvgRasterizer({ cacheDir: '' }),
  });
  const cover = entries(result.bytes)['EPUB/images/cover.png'];
  assert.ok(cover, 'packaged as PNG');
  assert.ok(cover.length > 10000, `got ${cover.length} bytes`);
  assert.deepEqual(result.warnings, []);
});
