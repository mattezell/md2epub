// md2epub core: Markdown in, EPUB 3 bytes out.
//
// Runtime agnostic on purpose. It touches no filesystem, no process env and no
// Node built-ins, so the same module backs the local server, the CLI and a
// Cloudflare Worker. Anything platform specific (reading files, fetching remote
// images, sending mail) is injected by the caller.
//
// One document or many: pass a string for a single document, or a list of
// {path, markdown} for a folder of documents that becomes one book, with each
// document a chapter and links between them rewritten to chapter links.

import { parseFrontmatter, metadataFromFrontmatter } from './frontmatter.js';
import { splitDocument, createRenderer } from './markdown.js';
import { htmlToXhtml } from './html.js';
import { resolveImages, sniffImage } from './images.js';
import { packEpub, xhtmlDocument } from './epub.js';
import { generateCover } from './cover.js';
import { DEFAULT_CSS } from './css.js';
import { filenameFor, makeSlugger } from './slug.js';
import { resolveFrom, normalisePath, titleFromFilename, basenameOf } from './paths.js';
import { findDiagrams, diagramPath } from './diagrams.js';
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

function mergeMetadata(frontmatter, options, titleFallbacks) {
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
    merged.title = titleFallbacks.map(clean).find(Boolean) || DEFAULT_METADATA.title;
  }
  if (!merged.identifier) merged.identifier = `urn:uuid:${newUuid()}`;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(merged.language)) merged.language = 'en';
  return merged;
}

// Joins a document key to an image src to make a lookup key. A NUL cannot
// appear in either, written as an escape so it stays visible in the source.
const IMAGE_KEY_SEPARATOR = '\u0000';

const chapterFilename = (index) => `ch-${String(index + 1).padStart(3, '0')}.xhtml`;

const DOC_EXTENSIONS = ['', '.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt', '/index.md', '/README.md'];

/** Accept a string, a list of strings, or a list of {path, markdown} documents. */
function normaliseDocuments(input) {
  const list = Array.isArray(input) ? input : [input];
  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      return { key: normalisePath(`document-${index + 1}.md`), markdown: entry, named: false };
    }
    if (!entry || typeof entry.markdown !== 'string') {
      throw new TypeError('each document needs a markdown string');
    }
    const key = normalisePath(entry.path || entry.name || `document-${index + 1}.md`);
    return { key, markdown: entry.markdown, title: clean(entry.title), named: Boolean(entry.path || entry.name) };
  });
}

/**
 * Convert one or more Markdown documents to a single EPUB 3.
 *
 * @param {string|Array<string|{path?: string, name?: string, markdown: string, title?: string}>} input
 * @param {object} [options]
 * @param {string} [options.title] overrides frontmatter, the first H1 and the file name
 * @param {string|string[]} [options.author]
 * @param {string} [options.language] BCP 47 tag, defaults to "en"
 * @param {string} [options.publisher]
 * @param {string} [options.description]
 * @param {string} [options.rights]
 * @param {string} [options.date]
 * @param {string|string[]} [options.subjects]
 * @param {string} [options.identifier] defaults to a fresh urn:uuid
 * @param {number} [options.splitLevel] heading level that starts a new file (0 disables splitting within a document)
 * @param {number} [options.tocDepth] deepest heading level listed in the table of contents
 * @param {boolean} [options.typographer] smart quotes and dashes, default true
 * @param {{bytes: Uint8Array, mediaType?: string}} [options.cover] an image to use as the cover
 * @param {boolean} [options.generateCover] draw a cover when none is supplied, default true
 * @param {(svg: Uint8Array, size: {width: number, height: number}) => Promise<{bytes: Uint8Array, mediaType: string}|null>} [options.rasterizeSvg]
 *   Turns an SVG cover into a raster one. Kindle shows a generic placeholder
 *   for an SVG cover, so without this a generated cover does not appear there.
 * @param {boolean} [options.embedRemoteImages] fetch http(s) images into the book
 * @param {(url: string) => Promise<{bytes: Uint8Array, declaredType?: string}|null>} [options.fetchImage]
 * @param {(path: string, from?: string) => Promise<{bytes: Uint8Array, declaredType?: string}|null>} [options.resolveLocal]
 * @param {(source: string, info: {language: string, hash: string}) => Promise<{bytes: Uint8Array, mediaType: string}|null>} [options.renderDiagram]
 *   Renders a ```mermaid fence to an image. Without it, and on any failure, the
 *   fence stays an ordinary code block.
 * @param {string[]} [options.diagramLanguages] fence languages to render, default ["mermaid"]
 * @param {string} [options.css] replaces the default stylesheet
 * @param {Date} [options.now]
 * @returns {Promise<{bytes: Uint8Array, filename: string, metadata: object, warnings: string[], chapterCount: number, imageCount: number, documentCount: number, diagramCount: number}>}
 */
export async function markdownToEpub(input, options = {}) {
  if (typeof input !== 'string' && !Array.isArray(input)) {
    throw new TypeError('markdown must be a string or a list of documents');
  }
  const documents = normaliseDocuments(input);
  if (!documents.length) throw new Error('There are no documents to convert.');

  const warnings = [];
  const splitLevel = Number.isFinite(options.splitLevel) ? Number(options.splitLevel) : 1;
  const tocDepth = Number.isFinite(options.tocDepth) ? Number(options.tocDepth) : 3;
  const renderer = createRenderer({ typographer: options.typographer !== false });
  const slugger = makeSlugger();

  // Pass 0: read the frontmatter off every document, so diagrams can all be
  // rendered before any chapter HTML is produced.
  const prepared = [];
  for (const document of documents) {
    const source = document.markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!source.trim()) {
      if (documents.length === 1) throw new Error('The Markdown document is empty.');
      warnings.push(`${basenameOf(document.key)} is empty and was left out.`);
      continue;
    }
    const { data, body, warnings: frontmatterWarnings } = parseFrontmatter(source);
    for (const warning of frontmatterWarnings) {
      warnings.push(documents.length > 1 ? `${basenameOf(document.key)}: ${warning}` : warning);
    }
    prepared.push({ ...document, data, body });
  }
  if (!prepared.length) throw new Error('The Markdown produced no content.');

  // Diagrams are rendered once per unique source, so the same diagram repeated
  // across a folder of documents costs one browser render, not one per copy.
  const diagrams = new Map();
  const diagramFiles = [];
  if (options.renderDiagram) {
    const unique = new Map();
    for (const document of prepared) {
      for (const diagram of findDiagrams(renderer.parse(document.body, {}), options.diagramLanguages)) {
        if (!unique.has(diagram.hash)) unique.set(diagram.hash, diagram);
      }
    }
    for (const diagram of unique.values()) {
      try {
        const image = await options.renderDiagram(diagram.source, { language: diagram.language, hash: diagram.hash });
        if (!image || !image.bytes || !image.bytes.length) throw new Error('the renderer returned nothing');
        // Deliberately not passing the declared media type: these bytes come
        // from a renderer we invoked, so they are checked against the actual
        // file signature. A truncated render or an error page should become a
        // code block, not a corrupt image inside the book.
        const kind = sniffImage(image.bytes);
        if (!kind) throw new Error('the renderer did not return an image');
        const path = diagramPath(diagram.hash, kind.ext);
        diagrams.set(diagram.hash, path);
        diagramFiles.push({ path, mediaType: kind.mediaType, bytes: image.bytes });
      } catch (err) {
        warnings.push(`A ${diagram.language} diagram could not be rendered (${err.message}); it is shown as a code block instead.`);
      }
    }
  }

  // Pass 1: parse each document into chapters, sharing one slugger so heading
  // ids are unique across the whole book.
  const parsed = [];
  for (const document of prepared) {
    const { data, body } = document;
    const meta = metadataFromFrontmatter(data);
    const split = splitDocument(body, { splitLevel: splitLevel > 0 ? splitLevel : 0, tocDepth, renderer, slugger, diagrams });
    if (!split.chapters.length) {
      warnings.push(`${basenameOf(document.key)} produced no content and was left out.`);
      continue;
    }
    parsed.push({
      ...document,
      meta,
      title: document.title || meta.title || split.docTitle || (document.named ? titleFromFilename(document.key) : ''),
      ...split,
    });
  }

  if (!parsed.length) throw new Error('The Markdown produced no content.');

  const multi = parsed.length > 1;
  // For a bundle the book title comes from the caller or the folder name; a
  // single document can also fall back to its own heading or file name.
  const bookFrontmatter = multi ? { ...parsed[0].meta, title: undefined } : parsed[0].meta;
  const sharedDirectory = multi ? parsed[0].key.split('/').slice(0, -1).join('/') : '';
  const metadata = mergeMetadata(bookFrontmatter, options, multi
    ? [sharedDirectory ? titleFromFilename(sharedDirectory) : undefined, parsed[0].title, `${parsed.length} documents`]
    : [parsed[0].title]);

  // Flatten to chapters, remembering which document each came from.
  const chapters = [];
  const documentFirstChapter = new Map();
  parsed.forEach((document, documentIndex) => {
    document.chapters.forEach((chapter, indexInDocument) => {
      if (indexInDocument === 0) documentFirstChapter.set(documentIndex, chapters.length);
      chapters.push({
        documentIndex,
        documentKey: document.key,
        title: chapter.title || (indexInDocument === 0 ? document.title : '') || metadata.title,
        html: chapter.html,
        headings: chapter.headings,
      });
    });
  });

  // Where each heading lives, and where each document starts, so links can be
  // rewritten to point at the right file.
  const anchors = new Map();
  chapters.forEach((chapter, index) => {
    for (const heading of chapter.headings) anchors.set(heading.slug, index);
  });
  const documentTargets = new Map();
  parsed.forEach((document, documentIndex) => {
    const chapterIndex = documentFirstChapter.get(documentIndex);
    for (const extension of DOC_EXTENSIONS) {
      const key = normalisePath(document.key.replace(/\.(md|markdown|mdown|mkd|mdx|txt)$/i, '') + extension);
      if (!documentTargets.has(key)) documentTargets.set(key, chapterIndex);
    }
    documentTargets.set(normalisePath(document.key), chapterIndex);
  });

  // Pass 2: collect every image reference, keyed per document so that two
  // documents referencing "./diagram.png" resolve independently.
  const packagedDiagrams = new Set(diagramFiles.map((file) => file.path));
  const imageReferences = [];
  const seenImages = new Set();
  chapters.forEach((chapter) => {
    htmlToXhtml(chapter.html, {
      rewriteUrl: (tag, attr, value) => {
        if (tag === 'img' && attr === 'src' && !packagedDiagrams.has(value)) {
          const id = `${chapter.documentKey}${IMAGE_KEY_SEPARATOR}${value}`;
          if (!seenImages.has(id)) {
            seenImages.add(id);
            imageReferences.push({ id, src: value, from: chapter.documentKey });
          }
        }
        return value;
      },
    });
  });

  const resolved = await resolveImages(imageReferences, {
    embedRemoteImages: Boolean(options.embedRemoteImages),
    fetchImage: options.fetchImage,
    resolveLocal: options.resolveLocal,
    maxImageBytes: options.maxImageBytes,
    maxTotalImageBytes: options.maxTotalImageBytes,
  });
  warnings.push(...resolved.warnings);
  const images = [...diagramFiles, ...resolved.files];

  // An SVG cover is valid EPUB, and Kindle still shows the generic grey
  // placeholder instead of it, so it is rasterised when a browser is available.
  const toRaster = async (image, size) => {
    if (image.mediaType !== 'image/svg+xml') return image;
    // No rasteriser configured is a fact about the environment, not about this
    // document, so it is the front end's job to mention it, not a per book
    // warning on every conversion.
    if (!options.rasterizeSvg) return image;
    try {
      const raster = await options.rasterizeSvg(image.bytes, size);
      if (!raster || !raster.bytes || !raster.bytes.length) throw new Error('nothing came back');
      const kind = sniffImage(raster.bytes);
      if (!kind) throw new Error('the result was not an image');
      return { bytes: raster.bytes, mediaType: kind.mediaType, ext: kind.ext };
    } catch (err) {
      warnings.push(`The cover could not be converted from SVG to PNG (${err.message}); it is left as an SVG, which some readers will not show.`);
      return image;
    }
  };

  let cover = null;
  if (options.cover && options.cover.bytes && options.cover.bytes.length) {
    const kind = sniffImage(options.cover.bytes, options.cover.mediaType);
    if (kind) {
      const image = await toRaster({ bytes: options.cover.bytes, mediaType: kind.mediaType, ext: kind.ext }, {});
      // Kept out of `images`: packEpub writes it and the package document
      // declares it separately, and declaring one file twice is an EPUB error.
      cover = { path: `images/cover.${image.ext}`, mediaType: image.mediaType, bytes: image.bytes };
    } else {
      warnings.push('The cover image was not a PNG, JPEG, GIF, WebP or SVG file and has been left out.');
    }
  } else if (options.generateCover !== false) {
    const drawn = generateCover({
      title: metadata.title,
      authors: metadata.authors,
      date: metadata.date || (options.now instanceof Date ? options.now : new Date()).toISOString().slice(0, 10),
      subtitle: multi ? `${parsed.length} documents` : '',
    });
    const image = await toRaster(drawn, { width: drawn.width, height: drawn.height });
    cover = { path: `images/cover.${image.ext}`, mediaType: image.mediaType, bytes: image.bytes };
  }

  // Pass 3: rewrite links and images, then wrap each chapter in an XHTML document.
  const danglingLinks = new Set();
  const externalPaths = new Set();
  const packedChapters = chapters.map((chapter, index) => {
    const filename = chapterFilename(index);
    const bodyXhtml = htmlToXhtml(chapter.html, {
      rewriteUrl: (tag, attr, value) => {
        if (tag === 'img' && attr === 'src') {
          if (packagedDiagrams.has(value)) return value;
          return resolved.map.get(`${chapter.documentKey}${IMAGE_KEY_SEPARATOR}${value}`) || null;
        }

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

        if ((attr === 'href' || attr === 'cite') && !/^(https?:|mailto:|tel:|urn:|ftp:)/i.test(value)) {
          // A link to another document in the same bundle becomes a link to
          // that chapter. Anything else points outside the container, which
          // EPUB forbids (RSC-026): documentation written for a docs site is
          // full of them, so they become plain text.
          const [path, fragment] = value.split('#');
          const target = documentTargets.get(resolveFrom(chapter.documentKey, path));
          if (target !== undefined) {
            const anchored = fragment && anchors.has(fragment) ? anchors.get(fragment) : target;
            return `${chapterFilename(anchored)}${fragment && anchors.has(fragment) ? `#${fragment}` : ''}`;
          }
          externalPaths.add(value);
          return null;
        }
        return value;
      },
      replaceTag: (tag, attrs) => {
        if (tag !== 'img') return null;
        const src = (attrs.find(([name]) => name === 'src') || [])[1];
        if (src && packagedDiagrams.has(src.trim())) return null;
        if (src && resolved.map.has(`${chapter.documentKey}${IMAGE_KEY_SEPARATOR}${src.trim()}`)) return null;
        const alt = (attrs.find(([name]) => name === 'alt') || [])[1] || '';
        return alt ? `<span class="md2epub-missing-image">${escapeXml(alt)}</span>` : '';
      },
    });

    const type = index === 0 && !chapter.headings.length ? 'frontmatter' : 'chapter';
    const xhtml = xhtmlDocument({
      title: chapter.title,
      language: metadata.language,
      body: `    <section epub:type="${escapeAttr(type)}" id="${escapeAttr(filename.replace('.xhtml', ''))}">
${bodyXhtml}
    </section>`,
    });
    return { id: filename.replace('.xhtml', ''), filename, title: chapter.title, xhtml };
  });

  if (externalPaths.size) {
    const shown = [...externalPaths].slice(0, 3).join(', ');
    const rest = externalPaths.size > 3 ? `, and ${externalPaths.size - 3} more` : '';
    const one = externalPaths.size === 1;
    warnings.push(`${externalPaths.size} link${one ? '' : 's'} ${one ? 'points' : 'point'} outside the book (${shown}${rest}) and ${one ? 'is' : 'are'} shown as plain text. EPUB cannot link to files that are not in it.`);
  }
  for (const link of danglingLinks) {
    warnings.push(`The link to ${link} points at a heading that is not in the document, so it is shown as plain text.`);
  }

  // Contents: for a bundle every document gets a top level entry, with its own
  // headings nested underneath, so the Kindle table of contents mirrors the
  // folder rather than running the documents together.
  const tocEntries = [];
  parsed.forEach((document, documentIndex) => {
    const firstChapter = documentFirstChapter.get(documentIndex);
    const ownEntries = [];
    document.chapters.forEach((chapter, indexInDocument) => {
      const chapterIndex = firstChapter + indexInDocument;
      for (const heading of chapter.headings) {
        if (heading.level <= tocDepth) {
          ownEntries.push({ level: heading.level, text: heading.text, href: `${chapterFilename(chapterIndex)}#${heading.slug}` });
        }
      }
    });
    const startsWithOwnTitle = ownEntries.length && ownEntries[0].level === 1 && ownEntries[0].text === document.title;
    if (multi && !startsWithOwnTitle) {
      tocEntries.push({ level: 1, text: document.title || basenameOf(document.key), href: chapterFilename(firstChapter) });
      for (const entry of ownEntries) tocEntries.push({ ...entry, level: Math.max(2, entry.level) });
    } else {
      tocEntries.push(...ownEntries);
    }
  });

  const now = options.now instanceof Date ? options.now : new Date();
  const modified = `${now.toISOString().split('.')[0]}Z`;

  const bytes = packEpub({
    metadata,
    chapters: packedChapters,
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
    chapterCount: packedChapters.length,
    imageCount: images.length + (cover ? 1 : 0),
    diagramCount: diagramFiles.length,
    documentCount: parsed.length,
  };
}

export { DEFAULT_CSS } from './css.js';
export { htmlToXhtml } from './html.js';
export { parseFrontmatter } from './frontmatter.js';
export { titleFromFilename } from './paths.js';
