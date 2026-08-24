#!/usr/bin/env node
// Convert every fixture and run the real EPUBCheck over the results.
// This is the only check that proves the output is a valid EPUB, so it is the
// one that gates a release. Exits non-zero on any fatal, error or warning.

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { markdownToEpub } from '../src/core/index.js';
import { createMermaidRenderer, diagramSupport } from '../src/diagrams.js';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'test', 'fixtures');
const outDir = join(root, '.validate-out');

export function findEpubcheck() {
  if (process.env.EPUBCHECK_JAR && existsSync(process.env.EPUBCHECK_JAR)) return process.env.EPUBCHECK_JAR;
  const toolsDir = join(root, 'tools');
  if (!existsSync(toolsDir)) return null;
  for (const entry of ['epubcheck-5.3.0', 'epubcheck']) {
    const candidate = join(toolsDir, entry, 'epubcheck.jar');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const localResolver = (dir) => async (reference) => {
  const clean = reference.split('#')[0].split('?')[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) return null;
  const path = join(dir, clean);
  if (!path.startsWith(dir)) return null;
  return { bytes: new Uint8Array(await readFile(path)) };
};

const jar = findEpubcheck();
if (!jar) {
  console.error('EPUBCheck not found. Run `npm run epubcheck:install`, or set EPUBCHECK_JAR.');
  process.exit(2);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const fixtures = (await readdir(fixturesDir)).filter((name) => name.endsWith('.md')).sort();
// The same fixtures again with a cover image, since a cover adds a page, a
// manifest entry and a spine entry that nothing else exercises.
const cases = [
  ...fixtures.map((name) => ({ name, cover: false })),
  { name: 'kitchen-sink.md', cover: true },
  // Every fixture as one bundled book: exercises cross document links, shared
  // heading ids and the nested table of contents.
  { name: fixtures, cover: false, label: 'all-as-one-bundle' },
];
const coverBytes = new Uint8Array(await readFile(join(fixturesDir, 'local-image.png')));

// Diagram rendering needs a browser, so it is exercised only where the
// toolchain is installed. Silence here would read as coverage that does not
// exist, so say which it was.
const diagrams = diagramSupport();
const renderDiagram = diagrams.available ? createMermaidRenderer() : undefined;
console.log(diagrams.available
  ? `Diagrams   : rendering with ${diagrams.chrome}`
  : `Diagrams   : NOT rendered (${diagrams.reason}); mermaid fences stay code blocks`);
console.log('');

let failures = 0;

for (const testCase of cases) {
  const bundle = Array.isArray(testCase.name);
  const markdown = bundle
    ? await Promise.all(testCase.name.map(async (name) => ({ path: name, markdown: await readFile(join(fixturesDir, name), 'utf8') })))
    : await readFile(join(fixturesDir, testCase.name), 'utf8');
  const label = testCase.label || basename(testCase.name, '.md') + (testCase.cover ? '-with-cover' : '');
  let epubPath;
  try {
    const result = await markdownToEpub(markdown, {
      cover: testCase.cover ? { bytes: coverBytes } : undefined,
      renderDiagram,
      resolveLocal: localResolver(fixturesDir),
      now: new Date('2026-08-24T12:00:00Z'),
      identifier: `urn:uuid:00000000-0000-4000-8000-${createHash('sha1').update(label).digest('hex').slice(0, 12)}`,
    });
    epubPath = join(outDir, `${label}.epub`);
    await writeFile(epubPath, result.bytes);
    process.stdout.write(`${label.padEnd(24)} ${String(result.documentCount).padStart(2)} doc ${String(result.chapterCount).padStart(2)} ch ${String(result.diagramCount).padStart(2)} dia ${String(Math.round(result.bytes.length / 1024)).padStart(4)} KB  `);
  } catch (err) {
    console.log(`${label.padEnd(16)} CONVERSION FAILED: ${err.message}`);
    failures += 1;
    continue;
  }

  try {
    const { stdout, stderr } = await run('java', ['-jar', jar, '--quiet', epubPath], { maxBuffer: 8 * 1024 * 1024 });
    const output = `${stdout}${stderr}`.trim();
    if (output) {
      console.log('EPUBCheck output:');
      console.log(output);
      failures += 1;
    } else {
      console.log('valid');
    }
  } catch (err) {
    console.log('INVALID');
    console.log(`${err.stdout || ''}${err.stderr || ''}`.trim());
    failures += 1;
  }
}

console.log('');
if (failures) {
  console.log(`${failures} of ${cases.length} cases failed. EPUBs kept in ${outDir}`);
  process.exit(1);
}
console.log(`All ${cases.length} cases converted and passed EPUBCheck ${basename(dirname(jar))}.`);
