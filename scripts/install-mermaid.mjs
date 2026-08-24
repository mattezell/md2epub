#!/usr/bin/env node
// Install the mermaid toolchain into tools/mermaid, so diagram rendering is
// available without every plain `npm install` pulling half a gigabyte.
//
// Chromium is not downloaded: mermaid-cli is pointed at the Chrome already on
// the machine.

import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, diagramSupport } from '../src/diagrams.js';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'tools', 'mermaid');

const chrome = findChrome();
if (!chrome) {
  console.error('No Chrome or Chromium found. Install one, or set CHROME_PATH to it.');
  console.error('Looked in the usual places for google-chrome, chromium and the macOS app bundles.');
  process.exit(1);
}
console.log(`Chrome     : ${chrome}`);
console.log(`Installing : @mermaid-js/mermaid-cli and puppeteer into tools/mermaid`);
console.log('This is around 500 MB on disk. Chromium itself is not downloaded.');

await mkdir(target, { recursive: true });
await writeFile(join(target, 'package.json'), `${JSON.stringify({
  name: 'md2epub-mermaid-toolchain',
  private: true,
  description: 'Installed by npm run diagrams:install. Not part of the project dependencies.',
}, null, 2)}\n`);

try {
  const { stdout, stderr } = await run(
    'npm',
    ['install', '--no-fund', '--no-audit', '--loglevel', 'error', '@mermaid-js/mermaid-cli', 'puppeteer'],
    {
      cwd: target,
      // Chromium would be a second browser on disk for no reason.
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    },
  );
  const output = `${stdout}${stderr}`.trim();
  if (output) console.log(output.split('\n').slice(-3).join('\n'));
} catch (err) {
  console.error('The install failed.');
  console.error(`${err.stderr || err.message}`.split('\n').slice(-5).join('\n'));
  process.exit(1);
}

const support = diagramSupport();
if (!support.available) {
  console.error(`Installed, but the toolchain still is not usable: ${support.reason}`);
  process.exit(1);
}
console.log(`mermaid-cli: ${support.mmdc}`);
console.log('\nDiagram rendering is ready. Use it with:');
console.log('  md2epub notes.md --diagrams');
