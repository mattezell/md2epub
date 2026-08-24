// Finding and driving the locally installed Chrome.
//
// Two things here need a browser: mermaid, which measures text to lay diagrams
// out, and turning the generated SVG cover into a PNG. Kindle's KFX conversion
// does not render an SVG cover, so a book with one gets the generic grey
// placeholder on the shelf: rasterising is the difference between a cover and
// no cover. This is a plain --screenshot invocation, no npm packages involved.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { hashSource } from './core/diagrams.js';

const run = promisify(execFile);

// Ordered by how likely each is to be the browser someone actually has.
export const CHROME_CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export function findChrome(env = process.env) {
  const declared = (env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (declared) return existsSync(declared) ? declared : null;
  return CHROME_CANDIDATES.find((path) => existsSync(path)) || null;
}

/** Screenshot a self contained HTML string at an exact pixel size. */
export async function screenshotHtml(html, { chrome, width, height, timeoutMs = 30000 }) {
  const work = await mkdtemp(join(tmpdir(), 'md2epub-shot-'));
  try {
    const page = join(work, 'page.html');
    const shot = join(work, 'shot.png');
    await writeFile(page, html);
    await run(chrome, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${Math.round(width)},${Math.round(height)}`,
      `--screenshot=${shot}`,
      `file://${page}`,
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return new Uint8Array(await readFile(shot));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Turn SVG bytes into PNG bytes with the local Chrome.
 * @returns {((svg: Uint8Array, size: {width: number, height: number}) => Promise<{bytes: Uint8Array, mediaType: string}>) | null}
 *   null when no browser is available
 */
export function createSvgRasterizer(options = {}) {
  const env = options.env || process.env;
  const chrome = options.chrome || findChrome(env);
  if (!chrome) return null;

  const cacheDir = options.cacheDir === ''
    ? ''
    : options.cacheDir || join(env.MD2EPUB_CACHE_DIR || join(homedir(), '.cache', 'md2epub'), 'covers');

  return async function rasterizeSvg(svg, size = {}) {
    const source = new TextDecoder().decode(svg);
    const width = size.width || 1600;
    const height = size.height || 2560;
    const cacheFile = cacheDir ? join(cacheDir, `${hashSource(`${width}x${height}:${source}`)}.png`) : '';

    if (cacheFile) {
      try {
        await access(cacheFile);
        return { bytes: new Uint8Array(await readFile(cacheFile)), mediaType: 'image/png', cached: true };
      } catch {
        // Not cached yet.
      }
    }

    // The SVG goes inline rather than in an <img>, so the page is one file with
    // nothing to load and no chance of screenshotting an empty box.
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden}svg{display:block}</style></head><body>${source.replace(/^<\?xml[^>]*\?>\s*/, '')}</body></html>`;
    const bytes = await screenshotHtml(html, { chrome, width, height, timeoutMs: options.timeoutMs });
    if (!bytes.length || bytes[0] !== 0x89) throw new Error('the browser did not return a PNG');

    if (cacheFile) {
      await mkdir(dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, bytes);
    }
    return { bytes, mediaType: 'image/png', cached: false };
  };
}
