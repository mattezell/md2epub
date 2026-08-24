#!/usr/bin/env node
// Command line front end.
//
// This is the front end that knows where the Markdown lives, so it is the one
// that can resolve relative images, bundle a folder of documents into one book,
// and hand the result straight to the mailer without a browser in the loop.

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join, basename, sep } from 'node:path';
import { markdownToEpub, titleFromFilename } from './core/index.js';
import { createImageFetcher } from './net.js';
import { createMermaidRenderer, diagramSupport } from './diagrams.js';
import { buildMailer, loadEnv, EMAIL_SETUP_HINT } from './mail/factory.js';
import { composeBookEmail } from './mail/message.js';

const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdown|mkd|mdx)$/i;

const USAGE = `md2epub: convert Markdown to EPUB 3

Usage:
  md2epub <file.md | directory> [more files or directories] [options]
  cat book.md | md2epub - [options]

Delivery:
  -o, --out <file>       write the epub here (default: derived from the title)
      --email <address>  send the epub to this address instead of writing it
      --kindle           send to KINDLE_ADDRESS from .env
      --subject <text>   override the email subject
      --note <text>      add a line to the email body

Book:
      --title <text>
      --author <text>    repeatable, or comma separated
      --language <tag>   BCP 47, default en
      --publisher <text>
      --description <text>
      --rights <text>
      --subjects <list>  comma separated
      --cover <file>     cover image (png, jpg, gif, webp, svg)
      --no-cover         do not draw a cover when none is given

Conversion:
      --split <n>        heading level that starts a new chapter, 0 to disable (default 1)
      --toc-depth <n>    deepest heading in the contents (default 3)
      --no-typographer   keep straight quotes and plain dashes
      --embed-remote     download http(s) images into the book
      --diagrams         render \`\`\`mermaid fences to images (needs npm run diagrams:install)
      --diagram-theme <name>   mermaid theme, default neutral (best on e-ink)
      --diagram-format <fmt>   png (default) or svg
      --diagram-scale <n>      device pixel ratio, default 2
  -r, --recursive        include Markdown in subdirectories of a given directory
  -h, --help

Examples:
  md2epub HANDOFF.md --kindle
  md2epub ./docs --title "Project Docs" --kindle
  md2epub notes.md -o notes.epub
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
      case '--email': case '--to': opts.email = next(); break;
      case '--kindle': opts.kindle = true; break;
      case '--subject': opts.subject = next(); break;
      case '--note': opts.note = next(); break;
      case '--title': opts.title = next(); break;
      case '--author': opts.authors.push(next()); break;
      case '--language': case '--lang': opts.language = next(); break;
      case '--publisher': opts.publisher = next(); break;
      case '--description': opts.description = next(); break;
      case '--rights': opts.rights = next(); break;
      case '--subjects': opts.subjects.push(next()); break;
      case '--cover': opts.cover = next(); break;
      case '--no-cover': opts.generateCover = false; break;
      case '--split': opts.splitLevel = Number(next()); break;
      case '--toc-depth': opts.tocDepth = Number(next()); break;
      case '--no-typographer': opts.typographer = false; break;
      case '--embed-remote': opts.embedRemoteImages = true; break;
      case '--diagrams': opts.diagrams = true; break;
      case '--diagram-theme': opts.diagramTheme = next(); break;
      case '--diagram-format': opts.diagramFormat = next(); break;
      case '--diagram-scale': opts.diagramScale = Number(next()); break;
      case '-r': case '--recursive': opts.recursive = true; break;
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

async function listMarkdown(dir, recursive) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) found.push(...(await listMarkdown(full, true)));
    } else if (MARKDOWN_EXTENSIONS.test(entry.name)) {
      found.push(full);
    }
  }
  // A README leads; everything else is alphabetical, which is why numeric
  // prefixes (01-intro.md) work the way people expect.
  return found.sort((a, b) => {
    const readme = (p) => (/^readme\./i.test(basename(p)) ? 0 : 1);
    return readme(a) - readme(b) || a.localeCompare(b);
  });
}

/** Expand the positional arguments into documents, keyed relative to a shared root. */
async function collectDocuments(positional, opts) {
  if (!positional.length || (positional.length === 1 && positional[0] === '-')) {
    // Unnamed on purpose: piped input has no file name to fall back to.
    return { documents: [await readStdin()], root: process.cwd(), label: '' };
  }

  const files = [];
  let onlyDirectory = null;
  let directoryLabel = '';
  for (const target of positional) {
    const full = resolve(target);
    const info = await stat(full);
    if (info.isDirectory()) {
      const inside = await listMarkdown(full, opts.recursive);
      if (!inside.length) throw new Error(`no Markdown files in ${target}`);
      files.push(...inside);
      onlyDirectory = positional.length === 1 ? full : null;
      directoryLabel = onlyDirectory ? labelForDirectory(full) : '';
    } else {
      files.push(full);
    }
  }

  // Keys are relative to the deepest shared directory, so links between
  // documents ("./other.md", "../api/ref.md") resolve the way they do on disk.
  const root = onlyDirectory || commonRoot(files);
  const documents = [];
  for (const file of files) {
    documents.push({ path: relative(root, file).split(sep).join('/'), markdown: await readFile(file, 'utf8') });
  }
  return { documents, root, label: directoryLabel };
}

// "docs" is a poor book title, so a generic folder name borrows its parent:
// ~/w/neon-exile/docs becomes "Neon Exile Docs".
const GENERIC_DIRS = new Set(['docs', 'doc', 'documentation', 'notes', 'wiki', 'md', 'markdown', 'content']);

function labelForDirectory(dir) {
  const name = basename(dir);
  if (!GENERIC_DIRS.has(name.toLowerCase())) return name;
  const parent = basename(dirname(dir));
  return parent && parent !== sep ? `${parent} ${name}` : name;
}

function commonRoot(files) {
  if (files.length === 1) return dirname(files[0]);
  const split = files.map((file) => dirname(file).split(sep));
  const shared = [];
  for (let i = 0; i < split[0].length; i += 1) {
    const part = split[0][i];
    if (split.every((parts) => parts[i] === part)) shared.push(part);
    else break;
  }
  return shared.join(sep) || sep;
}

// Only files under the document root are readable, so a document cannot walk
// out to /etc/passwd through an image reference.
function createLocalResolver(root) {
  return async function resolveLocal(reference, from) {
    const clean = reference.split('#')[0].split('?')[0];
    if (!clean || isAbsolute(clean) || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
    const base = from ? join(root, dirname(from)) : root;
    const target = resolve(base, decodeURIComponent(clean));
    if (relative(root, target).startsWith('..')) throw new Error('the path leaves the document directory');
    return { bytes: new Uint8Array(await readFile(target)) };
  };
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || (!positional.length && process.stdin.isTTY)) {
    process.stdout.write(USAGE);
    return;
  }

  const env = loadEnv();
  const { documents, root, label } = await collectDocuments(positional, opts);

  const recipient = opts.kindle ? (env.KINDLE_ADDRESS || '').trim() : (opts.email || '').trim();
  if (opts.kindle && !recipient) {
    throw new Error('--kindle needs KINDLE_ADDRESS in .env (your @kindle.com Send to Kindle address)');
  }

  const cover = opts.cover ? { bytes: new Uint8Array(await readFile(opts.cover)) } : undefined;

  // Asked for explicitly, so a missing toolchain is an error rather than a
  // quiet fallback to code blocks.
  let renderDiagram;
  if (opts.diagrams) {
    const support = diagramSupport(env);
    if (!support.available) throw new Error(`--diagrams cannot run here: ${support.reason}`);
    renderDiagram = createMermaidRenderer({
      env,
      theme: opts.diagramTheme,
      format: opts.diagramFormat,
      scale: Number.isFinite(opts.diagramScale) ? opts.diagramScale : undefined,
    });
  }

  const result = await markdownToEpub(documents, {
    title: opts.title || (label ? titleFromFilename(label) : undefined),
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
    generateCover: opts.generateCover,
    embedRemoteImages: opts.embedRemoteImages,
    fetchImage: opts.embedRemoteImages ? createImageFetcher() : undefined,
    renderDiagram,
    resolveLocal: createLocalResolver(root),
    ...(documents.length === 1 && documents[0].path !== 'stdin.md' ? { name: documents[0].path } : {}),
  });

  const summary = [
    `${result.metadata.title}`,
    `${result.documentCount} document(s)`,
    `${result.chapterCount} chapter(s)`,
    `${result.imageCount} image(s)`,
    ...(result.diagramCount ? [`${result.diagramCount} diagram(s)`] : []),
    `${(result.bytes.length / 1024).toFixed(1)} KB`,
  ].join(', ');

  if (recipient) {
    const mailer = buildMailer(env);
    if (!mailer) throw new Error(`email is not configured. ${EMAIL_SETUP_HINT}`);
    const message = composeBookEmail(result, { note: opts.note, subject: opts.subject });
    const info = await mailer.send({ to: recipient, ...message });
    process.stdout.write(`${summary}\n${mailer.kind === 'log' ? 'dry run' : 'sent'} to ${recipient} (${info.messageId})\n`);
  } else {
    const outPath = opts.out || result.filename;
    await writeFile(outPath, result.bytes);
    process.stdout.write(`${outPath}: ${summary}\n`);
  }

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
}

main().catch((err) => {
  process.stderr.write(`md2epub: ${err.message}\n`);
  process.exitCode = 1;
});
