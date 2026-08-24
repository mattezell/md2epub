#!/usr/bin/env node
// Command line front end. Also the only caller that can resolve images by
// relative path, since it is the only one with the Markdown file's directory.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { markdownToEpub } from './core/index.js';
import { createImageFetcher } from './net.js';

const USAGE = `md2epub: convert Markdown to EPUB 3

Usage:
  node src/cli.js <input.md> [options]
  cat book.md | node src/cli.js - [options]

Options:
  -o, --out <file>       output path (default: derived from the title)
      --title <text>
      --author <text>    repeatable, or comma separated
      --language <tag>   BCP 47, default en
      --publisher <text>
      --description <text>
      --rights <text>
      --subjects <list>  comma separated
      --cover <file>     cover image (png, jpg, gif, webp, svg)
      --split <n>        heading level that starts a new chapter, 0 to disable (default 1)
      --toc-depth <n>    deepest heading in the contents (default 3)
      --no-typographer   keep straight quotes and plain dashes
      --embed-remote     download http(s) images into the book
  -h, --help
`;

function parseArgs(argv) {
  const opts = { authors: [], subjects: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '-o': case '--out': opts.out = next(); break;
      case '--title': opts.title = next(); break;
      case '--author': opts.authors.push(next()); break;
      case '--language': case '--lang': opts.language = next(); break;
      case '--publisher': opts.publisher = next(); break;
      case '--description': opts.description = next(); break;
      case '--rights': opts.rights = next(); break;
      case '--subjects': opts.subjects.push(next()); break;
      case '--cover': opts.cover = next(); break;
      case '--split': opts.splitLevel = Number(next()); break;
      case '--toc-depth': opts.tocDepth = Number(next()); break;
      case '--no-typographer': opts.typographer = false; break;
      case '--embed-remote': opts.embedRemoteImages = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  return { opts, positional };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Only files under the Markdown file's own directory are readable, so a
// document cannot walk out to /etc/passwd through an image reference.
function createLocalResolver(baseDir) {
  return async function resolveLocal(reference) {
    const clean = reference.split('#')[0].split('?')[0];
    if (!clean || isAbsolute(clean) || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
    const target = resolve(baseDir, decodeURIComponent(clean));
    const rel = relative(baseDir, target);
    if (rel.startsWith('..')) throw new Error('the path leaves the document directory');
    const bytes = await readFile(target);
    return { bytes: new Uint8Array(bytes) };
  };
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || (!positional.length && process.stdin.isTTY)) {
    process.stdout.write(USAGE);
    return;
  }

  const input = positional[0] || '-';
  const markdown = input === '-' ? await readStdin() : await readFile(input, 'utf8');
  const baseDir = input === '-' ? process.cwd() : dirname(resolve(input));

  const cover = opts.cover ? { bytes: new Uint8Array(await readFile(opts.cover)) } : undefined;

  const result = await markdownToEpub(markdown, {
    title: opts.title,
    author: opts.authors.length ? opts.authors : undefined,
    language: opts.language,
    publisher: opts.publisher,
    description: opts.description,
    rights: opts.rights,
    subjects: opts.subjects.length ? opts.subjects.join(',') : undefined,
    splitLevel: opts.splitLevel,
    tocDepth: opts.tocDepth,
    typographer: opts.typographer,
    cover,
    embedRemoteImages: opts.embedRemoteImages,
    fetchImage: opts.embedRemoteImages ? createImageFetcher() : undefined,
    resolveLocal: createLocalResolver(baseDir),
  });

  const outPath = opts.out || result.filename;
  await writeFile(outPath, result.bytes);
  process.stdout.write(`${outPath}: ${result.chapterCount} chapter(s), ${result.imageCount} image(s), ${(result.bytes.length / 1024).toFixed(1)} KB\n`);
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
}

main().catch((err) => {
  process.stderr.write(`md2epub: ${err.message}\n`);
  process.exitCode = 1;
});
