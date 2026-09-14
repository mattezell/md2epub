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
import { createSvgRasterizer } from './chrome.js';
import { createArticleFetcher, articleToDocument } from './article.js';
import { createKarakeepClient, bookmarkToDocument } from './karakeep.js';
import { buildMailer, loadEnv, EMAIL_SETUP_HINT } from './mail/factory.js';
import { composeBookEmail } from './mail/message.js';

const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdown|mkd|mdx)$/i;

const USAGE = `md2epub: convert Markdown to EPUB 3

Usage:
  md2epub <file.md | directory> [more files or directories] [options]
  md2epub <https://...> [more urls] [options]
  md2epub --karakeep [--limit 10] [options]
  cat book.md | md2epub - [options]

Delivery:
  -o, --out <file>       write the epub here (default: derived from the title)
      --email <address>  send the epub to this address instead of writing it
      --kindle           send to KINDLE_ADDRESS from .env
      --subject <text>   override the email subject
      --note <text>      add a line to the email body

Web pages and read-later:
      --karakeep         build from the Karakeep queue (KARAKEEP_URL, KARAKEEP_API_KEY)
      --limit <n>        how many bookmarks to take (default 10)
      --require-tag <t>  only bookmarks carrying this tag
      --skip-tag <t>     skip bookmarks carrying this tag (default: epubbed)
      --mark <tag>       tag each bookmark after a successful send (default: epubbed)
      --no-mark          do not tag anything
      --no-images        do not download images from pages

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
  md2epub MAINTAINING.md --kindle
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
      case '--karakeep': opts.karakeep = true; break;
      case '--limit': opts.limit = Number(next()); break;
      case '--require-tag': opts.requireTag = next(); break;
      case '--skip-tag': opts.skipTag = next(); break;
      case '--mark': opts.mark = next(); break;
      case '--no-mark': opts.mark = false; break;
      case '--no-images': opts.noImages = true; break;
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

const isUrl = (value) => /^https?:\/\//i.test(value);

const DEFAULT_MARK_TAG = 'epubbed';

/** Fetch each URL as an article and convert it to a document. */
async function collectUrls(urls) {
  const fetchArticle = createArticleFetcher();
  const documents = [];
  for (const [index, url] of urls.entries()) {
    const article = await fetchArticle(url);
    documents.push(articleToDocument(article, { url: article.url, path: `${String(index + 1).padStart(3, '0')}-article.md` }));
    process.stderr.write(`fetched: ${article.title || url}\n`);
  }
  return documents;
}

/** Drain the read-later queue into documents, newest first. */
async function collectKarakeep(opts, env) {
  const client = createKarakeepClient({ env });
  if (!client) throw new Error('--karakeep needs KARAKEEP_URL and KARAKEEP_API_KEY (see .env.example)');
  const skipTag = opts.skipTag === undefined ? DEFAULT_MARK_TAG : opts.skipTag;
  const want = Number.isFinite(opts.limit) ? opts.limit : 10;
  // Ask for more candidates than are wanted: plenty of saved links are things
  // Karakeep cannot crawl (X posts, paywalls), and --limit should mean "this
  // many readable articles", not "this many attempts".
  const candidates = await client.list({
    limit: Math.min(want * 4 + 5, 200),
    skipTag: skipTag || undefined,
    requireTag: opts.requireTag,
  });
  if (!candidates.length) throw new Error('no bookmarks matched (everything may already be tagged)');

  const documents = [];
  const used = [];
  let skipped = 0;
  for (const bookmark of candidates) {
    if (documents.length >= want) break;
    try {
      documents.push(await bookmarkToDocument(client, bookmark, documents.length));
      used.push(bookmark);
      process.stderr.write(`queued: ${(bookmark.title || (bookmark.content || {}).title || bookmark.id).slice(0, 70)}\n`);
    } catch {
      skipped += 1;
    }
  }
  if (skipped) process.stderr.write(`note: skipped ${skipped} bookmark(s) with no crawled article (X posts and paywalled pages usually)\n`);
  if (!documents.length) {
    throw new Error(`none of the ${candidates.length} matching bookmarks had a crawled article yet`);
  }
  return { documents, client, bookmarks: used };
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

  // Three input shapes: the read-later queue, a list of URLs, or files.
  const urls = positional.filter(isUrl);
  if (urls.length && urls.length !== positional.length) {
    throw new Error('mixing URLs and file paths in one book is not supported');
  }

  let documents;
  let root = process.cwd();
  let label = '';
  let karakeep = null;
  let fromWeb = false;

  if (opts.karakeep) {
    if (positional.length) throw new Error('--karakeep takes no file arguments');
    const pulled = await collectKarakeep(opts, env);
    documents = pulled.documents;
    karakeep = pulled;
    label = 'Read Later';
    fromWeb = true;
  } else if (urls.length) {
    documents = await collectUrls(urls);
    label = urls.length > 1 ? 'Saved Articles' : '';
    fromWeb = true;
  } else {
    ({ documents, root, label } = await collectDocuments(positional, opts));
  }

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
    // Pages are worth little without their images, so web input embeds them by
    // default; a document from disk still has to ask.
    embedRemoteImages: (opts.embedRemoteImages || fromWeb) && !opts.noImages,
    fetchImage: createImageFetcher(),
    renderDiagram,
    // Costs a fraction of a second and is the difference between a cover and
    // the generic placeholder on a Kindle shelf, so it is not behind a flag.
    rasterizeSvg: createSvgRasterizer({ env }),
    // Nothing on disk to resolve against when the input came off the web.
    resolveLocal: fromWeb ? undefined : createLocalResolver(root),
  });

  const summary = [
    `${result.metadata.title}`,
    `${result.documentCount} document(s)`,
    `${result.chapterCount} chapter(s)`,
    `${result.imageCount} image(s)`,
    ...(result.diagramCount ? [`${result.diagramCount} diagram(s)`] : []),
    `${(result.bytes.length / 1024).toFixed(1)} KB`,
  ].join(', ');

  const megabytes = result.bytes.length / 1048576;
  if (recipient && megabytes > 45) {
    throw new Error(`the book is ${megabytes.toFixed(1)} MB and the Send to Kindle limit is 50 MB. Use --no-images, or a smaller --limit.`);
  }

  if (recipient) {
    const mailer = buildMailer(env);
    if (!mailer) throw new Error(`email is not configured. ${EMAIL_SETUP_HINT}`);
    const message = composeBookEmail(result, { note: opts.note, subject: opts.subject });
    const info = await mailer.send({ to: recipient, ...message });
    process.stdout.write(`${summary}\n${mailer.kind === 'log' ? 'dry run' : 'sent'} to ${recipient} (${info.messageId})\n`);

    // Only after a successful send, so a failure leaves the queue intact.
    if (karakeep && opts.mark !== false) {
      const tag = opts.mark || DEFAULT_MARK_TAG;
      let tagged = 0;
      for (const bookmark of karakeep.bookmarks) {
        try {
          await karakeep.client.tag(bookmark, tag);
          tagged += 1;
        } catch (err) {
          process.stderr.write(`warning: could not tag ${bookmark.id} (${err.message})\n`);
        }
      }
      process.stdout.write(`tagged ${tagged}/${karakeep.bookmarks.length} bookmark(s) '${tag}'\n`);
    }
  } else {
    const outPath = opts.out || result.filename;
    await writeFile(outPath, result.bytes);
    process.stdout.write(`${outPath}: ${summary}\n`);
  }

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  // Said once, here rather than as a per book warning: it is a property of this
  // machine, and it is the difference between a cover and a grey placeholder.
  if (!opts.cover && opts.generateCover !== false && !createSvgRasterizer({ env })) {
    process.stderr.write('note: no Chrome found, so the cover is an SVG. Kindle shows a generic cover for those. Set CHROME_PATH, or pass --no-cover.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`md2epub: ${err.message}\n`);
  process.exitCode = 1;
});
