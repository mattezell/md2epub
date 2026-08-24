// md2epub core: Markdown in, EPUB 3 bytes out.
//
// Runtime agnostic on purpose. It touches no filesystem, no process env and no
// Node built-ins, so the same module backs the local server, the CLI and a
// Cloudflare Worker. Anything platform specific (reading files, fetching remote
// images, sending mail) is injected by the caller.

import { parseFrontmatter, metadataFromFrontmatter } from './frontmatter.js';
import { splitDocument, createRenderer } from './markdown.js';
import { htmlToXhtml } from './html.js';
import { resolveImages, sniffImage } from './images.js';
import { packEpub, xhtmlDocument } from './epub.js';
import { DEFAULT_CSS } from './css.js';
import { filenameFor } from './slug.js';
import { escapeXml, escapeAttr } from './xml.js';

export const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;

const DEFAULT_METADATA = {
  title: 'Untitled',
  authors: [],
  language: 'en',
  publisher: '',
  description: '',
  rights: '',
  date: '',
  subjects: [],
};

function newUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for runtimes without randomUUID.
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  rand[6] = (rand[6] & 0x0f) | 0x40;
  rand[8] = (rand[8] & 0x3f) | 0x80;
  const hex = [...rand].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const clean = (value) => (value === undefined || value === null ? undefined : String(value).trim() || undefined);

function normaliseAuthors(value) {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(/\s*(?:,|;| and )\s*/i);
  const authors = list.map((v) => String(v).trim()).filter(Boolean);
  return authors.length ? authors : undefined;
}

function mergeMetadata(frontmatter, options, docTitle) {
  const explicit = {
    title: clean(options.title),
    authors: normaliseAuthors(options.author ?? options.authors),
    language: clean(options.language),
    publisher: clean(options.publisher),
    description: clean(options.description),
    rights: clean(options.rights),
    date: clean(options.date),
    subjects: normaliseAuthors(options.subjects),
    identifier: clean(options.identifier),
  };
  const merged = { ...DEFAULT_METADATA };
  for (const source of [frontmatter, explicit]) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null && !(Array.isArray(value) && !value.length)) merged[key] = value;
    }
  }
  if (!clean(merged.title) || merged.title === DEFAULT_METADATA.title) {
    merged.title = clean(docTitle) || DEFAULT_METADATA.title;
  }
  if (!merged.identifier) merged.identifier = `urn:uuid:${newUuid()}`;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(merged.language)) merged.language = 'en';
  return merged;
}

const chapterFilename = (index) => `ch-${String(index + 1).padStart(3, '0')}.xhtml`;

/**
 * Convert a Markdown document to EPUB 3.
 *
 * @param {string} markdown
 * @param {object} [options]
 * @param {string} [options.title] overrides frontmatter and the first H1
 * @param {string|string[]} [options.author]
 * @param {string} [options.language] BCP 47 tag, defaults to "en"
 * @param {string} [options.publisher]
 * @param {string} [options.description]
 * @param {string} [options.rights]
 * @param {string} [options.date]
 * @param {string|string[]} [options.subjects]
 * @param {string} [options.identifier] defaults to a fresh urn:uuid
 * @param {number} [options.splitLevel] heading level that starts a new file (0 disables splitting)
 * @param {number} [options.tocDepth] deepest heading level listed in the table of contents
 * @param {boolean} [options.typographer] smart quotes and dashes, default true
 * @param {{bytes: Uint8Array, mediaType?: string}} [options.cover]
 * @param {boolean} [options.embedRemoteImages] fetch http(s) images into the book
 * @param {(url: string) => Promise<{bytes: Uint8Array, declaredType?: string}|null>} [options.fetchImage]
 * @param {(path: string) => Promise<{bytes: Uint8Array, declaredType?: string}|null>} [options.resolveLocal]
 * @param {string} [options.css] replaces the default stylesheet
 * @param {Date} [options.now]
 * @returns {Promise<{bytes: Uint8Array, filename: string, metadata: object, warnings: string[], chapterCount: number, imageCount: number}>}
 */
export async function markdownToEpub(markdown, options = {}) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const source = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error('The Markdown document is empty.');

  const warnings = [];
  const { data, body, warnings: fmWarnings } = parseFrontmatter(source);
  warnings.push(...fmWarnings);

  const splitLevel = Number.isFinite(options.splitLevel) ? Number(options.splitLevel) : 1;
  const tocDepth = Number.isFinite(options.tocDepth) ? Number(options.tocDepth) : 3;
  const renderer = createRenderer({ typographer: options.typographer !== false });
  const { chapters: parsed, toc, anchors, docTitle } = splitDocument(body, {
    splitLevel: splitLevel > 0 ? splitLevel : 0,
    tocDepth,
    renderer,
  });

  if (!parsed.length) throw new Error('The Markdown document produced no content.');

  const metadata = mergeMetadata(metadataFromFrontmatter(data), options, docTitle);

  // Pass 1: find every image the document references.
  const imageSources = [];
  for (const chapter of parsed) {
    htmlToXhtml(chapter.html, {
      rewriteUrl: (tag, attr, value) => {
        if (tag === 'img' && attr === 'src' && !imageSources.includes(value)) imageSources.push(value);
        return value;
      },
    });
  }

  const resolved = await resolveImages(imageSources, {
    embedRemoteImages: Boolean(options.embedRemoteImages),
    fetchImage: options.fetchImage,
    resolveLocal: options.resolveLocal,
    maxImageBytes: options.maxImageBytes,
    maxTotalImageBytes: options.maxTotalImageBytes,
  });
  warnings.push(...resolved.warnings);
  const images = [...resolved.files];

  let cover = null;
  if (options.cover && options.cover.bytes && options.cover.bytes.length) {
    const kind = sniffImage(options.cover.bytes, options.cover.mediaType);
    if (kind) {
      // Kept out of `images`: packEpub writes it and the package document
      // declares it separately, and declaring one file twice is an EPUB error.
      cover = { path: `images/cover.${kind.ext}`, mediaType: kind.mediaType, bytes: options.cover.bytes };
    } else {
      warnings.push('The cover image was not a PNG, JPEG, GIF, WebP or SVG file and has been left out.');
    }
  }

  // Pass 2: rewrite links and images, then wrap each chapter in an XHTML document.
  const danglingLinks = new Set();
  const chapters = parsed.map((chapter, index) => {
    const filename = chapterFilename(index);
    const bodyXhtml = htmlToXhtml(chapter.html, {
      rewriteUrl: (tag, attr, value) => {
        if (tag === 'img' && attr === 'src') return resolved.map.get(value) || null;
        if (attr === 'href' && value.startsWith('#')) {
          const target = anchors.get(value.slice(1));
          // A link to a heading that does not exist is an EPUB error, so the
          // link is unwrapped to plain text rather than left dangling.
          if (target === undefined) {
            danglingLinks.add(value);
            return null;
          }
          return target === index ? value : `${chapterFilename(target)}${value}`;
        }
        return value;
      },
      replaceTag: (tag, attrs) => {
        if (tag !== 'img') return null;
        const src = (attrs.find(([name]) => name === 'src') || [])[1];
        if (src && resolved.map.has(src.trim())) return null;
        const alt = (attrs.find(([name]) => name === 'alt') || [])[1] || '';
        return alt ? `<span class="md2epub-missing-image">${escapeXml(alt)}</span>` : '';
      },
    });

    const title = chapter.title || metadata.title;
    const type = index === 0 && !chapter.title ? 'frontmatter' : 'chapter';
    const xhtml = xhtmlDocument({
      title,
      language: metadata.language,
      body: `    <section epub:type="${escapeAttr(type)}" id="${escapeAttr(filename.replace('.xhtml', ''))}">
${bodyXhtml}
    </section>`,
    });
    return { id: filename.replace('.xhtml', ''), filename, title, xhtml };
  });

  for (const link of danglingLinks) {
    warnings.push(`The link to ${link} points at a heading that is not in the document, so it is shown as plain text.`);
  }

  const tocEntries = toc.map((entry) => ({
    level: entry.level,
    text: entry.text,
    href: `${chapterFilename(entry.chapterIndex)}#${entry.slug}`,
  }));

  const now = options.now instanceof Date ? options.now : new Date();
  const modified = `${now.toISOString().split('.')[0]}Z`;

  const bytes = packEpub({
    metadata,
    chapters,
    images,
    cover,
    tocEntries,
    css: options.css || DEFAULT_CSS,
    modified,
    modifiedDate: now,
  });

  return {
    bytes,
    filename: filenameFor(metadata.title),
    metadata,
    warnings,
    chapterCount: chapters.length,
    imageCount: images.length + (cover ? 1 : 0),
  };
}

export { DEFAULT_CSS } from './css.js';
export { htmlToXhtml } from './html.js';
export { parseFrontmatter } from './frontmatter.js';
