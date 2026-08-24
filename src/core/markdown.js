// Markdown -> chapter HTML, heading ids and a table of contents.

import MarkdownIt from 'markdown-it';
import { makeSlugger } from './slug.js';
import { hashSource, altTextFor, findPreMermaid } from './diagrams.js';
import { escapeXml, escapeAttr } from './xml.js';

export function createRenderer({ typographer = true, linkify = true, breaks = false } = {}) {
  const md = new MarkdownIt({
    html: true,       // raw HTML survives here and is sanitised later by htmlToXhtml
    xhtmlOut: true,
    linkify,
    typographer,
    breaks,
  });

  // A diagram fence becomes an image when env.diagrams carries a rendered file
  // for it, and stays a code block otherwise, which is also the failure path.
  const fence = md.renderer.rules.fence.bind(md.renderer.rules);
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const language = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
    const rendered = env && env.diagrams && env.diagrams.get(hashSource(`${language}:${token.content}`));
    if (!rendered) return fence(tokens, index, options, env, self);
    return `<figure class="md2epub-diagram"><img src="${escapeAttr(rendered)}" alt="${escapeAttr(altTextFor(token.content, language))}" /></figure>\n`;
  };

  // The same substitution for the raw HTML form.
  const htmlBlock = md.renderer.rules.html_block
    ? md.renderer.rules.html_block.bind(md.renderer.rules)
    : (tokens, index) => tokens[index].content;
  md.renderer.rules.html_block = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (!env || !env.diagrams || !token.content.includes('mermaid')) {
      return htmlBlock(tokens, index, options, env, self);
    }
    let content = token.content;
    for (const { source, block } of findPreMermaid(token.content)) {
      const rendered = env.diagrams.get(hashSource(`mermaid:${source}`));
      if (!rendered) continue;
      content = content.replace(block, `<figure class="md2epub-diagram"><img src="${escapeAttr(rendered)}" alt="${escapeAttr(altTextFor(source, 'mermaid'))}" /></figure>`);
    }
    return content;
  };

  return md;
}

function plainText(inlineToken) {
  if (!inlineToken) return '';
  if (!inlineToken.children || !inlineToken.children.length) return inlineToken.content || '';
  let out = '';
  for (const child of inlineToken.children) {
    if (child.type === 'text' || child.type === 'code_inline') out += child.content;
    else if (child.type === 'image') out += plainText({ children: child.children, content: child.content });
    else if (child.type === 'softbreak' || child.type === 'hardbreak') out += ' ';
  }
  return out.trim() || (inlineToken.content || '').trim();
}

/**
 * Parse a Markdown body into chapters.
 *
 * Splitting happens at top level headings of `splitLevel` or above, so a
 * document with `# Chapter` headings becomes one XHTML file per chapter and a
 * document with none becomes a single file. Every heading gets a stable id so
 * in document links ([back to intro](#intro)) keep working across the split.
 *
 * @returns {{ chapters: Array, toc: Array, anchors: Map<string, number>, docTitle: string|undefined }}
 */
export function splitDocument(body, { splitLevel = 1, tocDepth = 3, renderer, slugger: sharedSlugger, diagrams } = {}) {
  const md = renderer || createRenderer();
  const env = { diagrams };
  const tokens = md.parse(body, env);
  // A bundle shares one slugger across every document, so heading ids stay
  // unique book-wide and a cross document link can find its target.
  const slugger = sharedSlugger || makeSlugger();

  // Pass 1: give every heading an id and remember its position.
  const headings = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const level = Number(token.tag.slice(1));
    const text = plainText(tokens[i + 1]);
    const existing = token.attrGet('id');
    const slug = existing ? slugger(existing) : slugger(text || `section-${headings.length + 1}`);
    token.attrSet('id', slug);
    headings.push({ index: i, level, text, slug, topLevel: token.level === 0 });
  }

  // Pass 2: choose the split points.
  const starts = headings
    .filter((h) => h.topLevel && h.level <= splitLevel)
    .map((h) => h.index);
  const bounds = [];
  if (!starts.length || starts[0] > 0) bounds.push(0);
  bounds.push(...starts.filter((s) => s > 0 || !bounds.length));
  const uniqueBounds = [...new Set(bounds)].sort((a, b) => a - b);

  const chapters = [];
  for (let c = 0; c < uniqueBounds.length; c += 1) {
    const from = uniqueBounds[c];
    const to = c + 1 < uniqueBounds.length ? uniqueBounds[c + 1] : tokens.length;
    const slice = tokens.slice(from, to);
    const html = md.renderer.render(slice, md.options, env);
    if (!html.trim()) continue;
    const own = headings.filter((h) => h.index >= from && h.index < to);
    const heading = own.find((h) => h.level <= splitLevel) || own[0];
    chapters.push({
      title: heading ? heading.text : '',
      html,
      headings: own,
      firstHeadingLevel: heading ? heading.level : null,
    });
  }

  // Pass 3: table of contents plus an anchor -> chapter index map for links.
  const chapterOf = new Map();
  chapters.forEach((chapter, index) => {
    for (const h of chapter.headings) chapterOf.set(h.slug, index);
  });
  const toc = [];
  chapters.forEach((chapter, index) => {
    for (const h of chapter.headings) {
      if (h.level <= tocDepth) toc.push({ level: h.level, text: h.text, slug: h.slug, chapterIndex: index });
    }
  });

  const firstH1 = headings.find((h) => h.level === 1);
  return { chapters, toc, anchors: chapterOf, docTitle: firstH1 ? firstH1.text : undefined };
}
