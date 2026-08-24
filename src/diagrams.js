// Node side diagram rendering: mermaid-cli driving a local headless Chrome.
//
// mermaid needs a real browser because it measures text to lay diagrams out, so
// this cannot live in the runtime agnostic core and cannot run in a Worker.
// mermaid-cli (mmdc) is the official wrapper around that browser, and it is
// what crops the PNG to the diagram rather than to the viewport.
//
// It is not a dependency of this project: the mermaid toolchain is around half
// a gigabyte on disk, which is not something every install should pay for.
// `npm run diagrams:install` adds it, and until then a diagram fence stays an
// ordinary code block.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Ordered by how likely each is to be the browser someone actually has.
const CHROME_CANDIDATES = [
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

export function findMermaidCli(env = process.env) {
  const declared = (env.MD2EPUB_MMDC || '').trim();
  if (declared) return existsSync(declared) ? declared : null;
  // tools/ first: that is where the installer puts it, kept out of the
  // project's own node_modules so an ordinary npm install stays small.
  const candidates = [
    join(projectRoot, 'tools', 'mermaid', 'node_modules', '.bin', 'mmdc'),
    join(projectRoot, 'node_modules', '.bin', 'mmdc'),
  ];
  return candidates.find((path) => existsSync(path)) || null;
}

/** What the caller needs to hear when diagrams cannot be rendered here. */
export function diagramSupport(env = process.env) {
  const mmdc = findMermaidCli(env);
  const chrome = findChrome(env);
  if (mmdc && chrome) return { available: true, mmdc, chrome };
  const missing = [];
  if (!mmdc) missing.push('mermaid-cli is not installed (run: npm run diagrams:install)');
  if (!chrome) missing.push('no Chrome or Chromium was found (set CHROME_PATH)');
  return { available: false, mmdc, chrome, reason: missing.join('; ') };
}

const DEFAULTS = {
  format: 'png',
  // Grayscale and high contrast. The default mermaid palette turns to mud on a
  // 16 level e-ink screen.
  theme: 'neutral',
  background: 'white',
  // A Kindle page is around 1072 device pixels wide; 2x keeps text crisp when
  // the reader scales the image down.
  width: 1072,
  scale: 2,
  timeoutMs: 60000,
};

const MEDIA_TYPES = { png: 'image/png', svg: 'image/svg+xml' };

/**
 * Build the renderDiagram hook the core expects.
 *
 * Rendered images are cached on disk by content, so re-converting a folder of
 * documents re-renders nothing: browser startup dominates the cost, and the
 * same diagram often appears in several documents.
 *
 * @param {object} [options]
 * @param {'png'|'svg'} [options.format] png by default; Kindle's converter is
 *   unreliable with SVG, and a diagram is not worth the risk
 * @param {string} [options.theme] mermaid theme, default "neutral"
 * @param {string} [options.background] default "white"
 * @param {number} [options.width] render width in pixels
 * @param {number} [options.scale] device pixel ratio
 * @param {string} [options.cacheDir] set to '' to disable caching
 * @returns {((source: string, info: object) => Promise<{bytes: Uint8Array, mediaType: string}>) | null}
 *   null when the toolchain is not available here
 */
export function createMermaidRenderer(options = {}) {
  const env = options.env || process.env;
  const support = diagramSupport(env);
  if (!support.available) {
    if (options.required) throw new Error(support.reason);
    return null;
  }

  // Spreading options directly would let an explicit `undefined` from a caller
  // (an unset CLI flag) overwrite a default with nothing.
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const config = { ...DEFAULTS, ...given };
  const format = config.format === 'svg' ? 'svg' : 'png';
  const cacheDir = config.cacheDir === ''
    ? ''
    : config.cacheDir || join(env.MD2EPUB_CACHE_DIR || join(homedir(), '.cache', 'md2epub'), 'diagrams');

  // Anything that changes the pixels has to change the cache key.
  const variant = `${format}-${config.theme}-${config.background}-${config.width}-${config.scale}`;

  return async function renderDiagram(source, info) {
    const cacheFile = cacheDir ? join(cacheDir, `${info.hash}-${variant}.${format}`) : '';
    if (cacheFile) {
      try {
        await access(cacheFile);
        return { bytes: new Uint8Array(await readFile(cacheFile)), mediaType: MEDIA_TYPES[format], cached: true };
      } catch {
        // Not cached yet, render it.
      }
    }

    const work = await mkdtemp(join(tmpdir(), 'md2epub-diagram-'));
    try {
      const input = join(work, `diagram.${info.language || 'mmd'}`);
      const output = join(work, `diagram.${format}`);
      const puppeteerConfig = join(work, 'puppeteer.json');
      const mermaidConfig = join(work, 'mermaid.json');

      await writeFile(input, source);
      await writeFile(puppeteerConfig, JSON.stringify({
        executablePath: support.chrome,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      }));
      await writeFile(mermaidConfig, JSON.stringify({
        theme: config.theme,
        // Labels default to <foreignObject>, which is embedded XHTML that most
        // e-readers, Kindle included, refuse to render: the shapes arrive with
        // no text in them. This is the setting that matters most here.
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: false },
        sequence: { useMaxWidth: false },
      }));

      const args = [
        '--input', input,
        '--output', output,
        '--puppeteerConfigFile', puppeteerConfig,
        '--configFile', mermaidConfig,
        '--backgroundColor', config.background,
        '--width', String(config.width),
        '--scale', String(config.scale),
        '--quiet',
      ];

      try {
        await run(support.mmdc, args, { timeout: config.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      } catch (err) {
        const detail = `${err.stderr || ''}${err.stdout || ''}`.trim().split('\n').slice(-2).join(' ');
        throw new Error(detail || err.message || 'mermaid-cli failed');
      }

      const bytes = new Uint8Array(await readFile(output));
      if (cacheFile) {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, bytes);
      }
      return { bytes, mediaType: MEDIA_TYPES[format], cached: false };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
