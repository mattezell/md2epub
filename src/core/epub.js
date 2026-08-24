// EPUB 3 (OCF) packaging: package document, navigation, NCX fallback and zip.

import { zipSync } from 'fflate';
import { escapeXml, escapeAttr } from './xml.js';

const ROOT = 'EPUB';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const OPS_NS = 'http://www.idpf.org/2007/ops';

const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text);

export function xhtmlDocument({ title, language, body, bodyAttrs = '', extraHead = '' }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="${OPS_NS}" lang="${escapeAttr(language)}" xml:lang="${escapeAttr(language)}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css" />${extraHead}
  </head>
  <body${bodyAttrs}>
${body}
  </body>
</html>
`;
}

function containerXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${ROOT}/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`;
}

function packageOpf(book) {
  const { metadata, chapters, images, cover, modified } = book;
  const meta = [];
  meta.push(`    <dc:identifier id="pub-id">${escapeXml(metadata.identifier)}</dc:identifier>`);
  meta.push(`    <dc:title>${escapeXml(metadata.title)}</dc:title>`);
  meta.push(`    <dc:language>${escapeXml(metadata.language)}</dc:language>`);
  metadata.authors.forEach((author, index) => {
    const id = `creator-${index + 1}`;
    meta.push(`    <dc:creator id="${id}">${escapeXml(author)}</dc:creator>`);
    meta.push(`    <meta refines="#${id}" property="role" scheme="marc:relators">aut</meta>`);
    meta.push(`    <meta refines="#${id}" property="display-seq">${index + 1}</meta>`);
  });
  if (metadata.publisher) meta.push(`    <dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>`);
  if (metadata.description) meta.push(`    <dc:description>${escapeXml(metadata.description)}</dc:description>`);
  if (metadata.rights) meta.push(`    <dc:rights>${escapeXml(metadata.rights)}</dc:rights>`);
  if (metadata.date) meta.push(`    <dc:date>${escapeXml(metadata.date)}</dc:date>`);
  for (const subject of metadata.subjects || []) meta.push(`    <dc:subject>${escapeXml(subject)}</dc:subject>`);
  meta.push(`    <meta property="dcterms:modified">${escapeXml(modified)}</meta>`);
  if (cover) meta.push('    <meta name="cover" content="cover-image" />');

  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
    '    <item id="css" href="style.css" media-type="text/css" />',
  ];
  const spine = [];
  if (cover) {
    manifest.push(`    <item id="cover-image" href="${escapeAttr(cover.path)}" media-type="${escapeAttr(cover.mediaType)}" properties="cover-image" />`);
    manifest.push('    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml" />');
    spine.push('    <itemref idref="cover-page" />');
  }
  for (const chapter of chapters) {
    manifest.push(`    <item id="${escapeAttr(chapter.id)}" href="${escapeAttr(chapter.filename)}" media-type="application/xhtml+xml" />`);
    spine.push(`    <itemref idref="${escapeAttr(chapter.id)}" />`);
  }
  images.forEach((image, index) => {
    manifest.push(`    <item id="img-${index + 1}" href="${escapeAttr(image.path)}" media-type="${escapeAttr(image.mediaType)}" />`);
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeAttr(metadata.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta.join('\n')}
  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.join('\n')}
  </spine>
</package>
`;
}

// Flat [{level, text, href}] -> nested <ol>. Levels that jump (h1 then h3) are
// tolerated by treating the jump as a single step down.
function tocList(entries, indent) {
  if (!entries.length) return '';
  const pad = ' '.repeat(indent);
  let out = `${pad}<ol>\n`;
  let i = 0;
  const baseLevel = entries[0].level;
  while (i < entries.length) {
    const entry = entries[i];
    const children = [];
    let j = i + 1;
    while (j < entries.length && entries[j].level > entry.level) {
      children.push(entries[j]);
      j += 1;
    }
    const label = escapeXml(entry.text || 'Untitled');
    if (children.length) {
      out += `${pad}  <li>\n${pad}    <a href="${escapeAttr(entry.href)}">${label}</a>\n`;
      out += tocList(children, indent + 4);
      out += `${pad}  </li>\n`;
    } else {
      out += `${pad}  <li><a href="${escapeAttr(entry.href)}">${label}</a></li>\n`;
    }
    i = j;
    if (entry.level < baseLevel) break;
  }
  out += `${pad}</ol>\n`;
  return out;
}

function navDocument(book) {
  const { metadata, tocEntries, chapters, cover } = book;
  const entries = tocEntries.length
    ? tocEntries
    : chapters.map((chapter, index) => ({ level: 1, text: chapter.title || `Section ${index + 1}`, href: chapter.filename }));

  const landmarks = [];
  if (cover) landmarks.push(`      <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>`);
  if (chapters.length) landmarks.push(`      <li><a epub:type="bodymatter" href="${escapeAttr(chapters[0].filename)}">Start of content</a></li>`);

  const body = `    <nav epub:type="toc" id="toc" role="doc-toc">
      <h1>Contents</h1>
${tocList(entries, 6)}    </nav>
    <nav epub:type="landmarks" id="landmarks" hidden="hidden">
      <h2>Guide</h2>
      <ol>
${landmarks.join('\n')}
      </ol>
    </nav>`;

  return xhtmlDocument({ title: `${metadata.title}: Contents`, language: metadata.language, body });
}

function ncxDocument(book) {
  const { metadata, tocEntries, chapters } = book;
  const entries = tocEntries.length
    ? tocEntries
    : chapters.map((chapter, index) => ({ level: 1, text: chapter.title || `Section ${index + 1}`, href: chapter.filename }));

  const points = entries
    .map((entry, index) => `    <navPoint id="navpoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(entry.text || 'Untitled')}</text></navLabel>
      <content src="${escapeAttr(entry.href)}" />
    </navPoint>`)
    .join('\n');

  const depth = entries.reduce((max, entry) => Math.max(max, entry.level), 1);

  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeAttr(metadata.language)}">
  <head>
    <meta name="dtb:uid" content="${escapeAttr(metadata.identifier)}" />
    <meta name="dtb:depth" content="${depth}" />
    <meta name="dtb:totalPageCount" content="0" />
    <meta name="dtb:maxPageNumber" content="0" />
  </head>
  <docTitle><text>${escapeXml(metadata.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

function coverDocument(book) {
  const { metadata, cover } = book;
  const body = `    <section epub:type="cover" class="md2epub-cover">
      <img src="${escapeAttr(cover.path)}" alt="${escapeAttr(`Cover for ${metadata.title}`)}" />
    </section>`;
  return xhtmlDocument({ title: 'Cover', language: metadata.language, body });
}

/**
 * Assemble the OCF zip.
 * `mimetype` must be the first entry and stored uncompressed; everything else
 * is deflated.
 * @returns {Uint8Array}
 */
export function packEpub(book) {
  const files = {};
  const mtime = book.modifiedDate || new Date('2001-01-01T00:00:00Z');

  files.mimetype = [bytes('application/epub+zip'), { level: 0, mtime }];
  files['META-INF/container.xml'] = [bytes(containerXml()), { mtime }];
  files[`${ROOT}/package.opf`] = [bytes(packageOpf(book)), { mtime }];
  files[`${ROOT}/nav.xhtml`] = [bytes(navDocument(book)), { mtime }];
  files[`${ROOT}/toc.ncx`] = [bytes(ncxDocument(book)), { mtime }];
  files[`${ROOT}/style.css`] = [bytes(book.css), { mtime }];
  if (book.cover) {
    files[`${ROOT}/cover.xhtml`] = [bytes(coverDocument(book)), { mtime }];
    files[`${ROOT}/${book.cover.path}`] = [book.cover.bytes, { level: 0, mtime }];
  }
  for (const chapter of book.chapters) {
    files[`${ROOT}/${chapter.filename}`] = [bytes(chapter.xhtml), { mtime }];
  }
  for (const image of book.images) {
    files[`${ROOT}/${image.path}`] = [image.bytes, { level: 0, mtime }];
  }

  return zipSync(files, { level: 9, mtime });
}

export const _internals = { packageOpf, navDocument, ncxDocument, containerXml, tocList };
