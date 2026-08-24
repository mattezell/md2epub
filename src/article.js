// Web pages as input.
//
// A saved page is mostly navigation, so a raw page is run through Readability
// first to get the article out of it. Content that has already been extracted
// (Karakeep stores exactly that) skips straight to the conversion.
//
// The result is Markdown, deliberately: everything the converter already does
// well (chapter splitting, headings and anchors, image embedding, the table of
// contents) works on Markdown, so an article joins the same pipeline a document
// does rather than needing a second one.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { createGuardedFetcher } from './net.js';

const MAX_PAGE_BYTES = 8 * 1024 * 1024;

function createTurndown() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    linkStyle: 'inlined',
  });

  // Whatever survived extraction that is still page furniture rather than prose.
  turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'svg']);

  // Turndown drops figcaption text into the paragraph flow; keeping it as an
  // emphasised line under the image reads correctly on a device.
  turndown.addRule('figure', {
    filter: 'figure',
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });
  turndown.addRule('figcaption', {
    filter: 'figcaption',
    replacement: (content) => (content.trim() ? `\n\n*${content.trim()}*\n\n` : ''),
  });

  return turndown;
}

// Relative URLs are meaningless once the page is inside a book, so they are
// resolved against the page they came from while the DOM is still available.
function absolutise(document, baseUrl) {
  if (!baseUrl) return;
  for (const [selector, attribute] of [['a[href]', 'href'], ['img[src]', 'src'], ['source[src]', 'src']]) {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (!value || /^(data:|https?:|mailto:|tel:|#)/i.test(value)) continue;
      try {
        element.setAttribute(attribute, new URL(value, baseUrl).toString());
      } catch {
        element.removeAttribute(attribute);
      }
    }
  }
  // Lazy loaded images keep the real source in a data attribute.
  for (const image of document.querySelectorAll('img[data-src], img[data-original]')) {
    const lazy = image.getAttribute('data-src') || image.getAttribute('data-original');
    if (!lazy) continue;
    try {
      image.setAttribute('src', new URL(lazy, baseUrl).toString());
    } catch {
      // Leave whatever src it already had.
    }
  }
}

/**
 * Turn a page (or an already extracted fragment) into a Markdown document.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.url] the page's own URL, for resolving relative links
 * @param {boolean} [options.extract] run Readability first, default true
 * @param {string} [options.title] a title to prefer over the page's own
 * @returns {{markdown: string, title: string, byline: string, siteName: string, publishedTime: string, excerpt: string}}
 */
export function articleFromHtml(html, options = {}) {
  const url = options.url || 'https://example.invalid/';
  const dom = new JSDOM(html, { url });
  const { document } = dom.window;

  let title = options.title || '';
  let byline = '';
  let siteName = '';
  let publishedTime = '';
  let excerpt = '';
  let contentHtml = null;

  if (options.extract !== false) {
    try {
      // Readability mutates the document, so it gets a clone and the original
      // stays available as the fallback.
      const article = new Readability(document.cloneNode(true)).parse();
      if (article && article.content) {
        contentHtml = article.content;
        title = title || (article.title || '').trim();
        byline = (article.byline || '').trim();
        siteName = (article.siteName || '').trim();
        publishedTime = (article.publishedTime || '').trim();
        excerpt = (article.excerpt || '').trim();
      }
    } catch {
      // Fall through to the whole document.
    }
  }

  // Either extraction was skipped, or it found nothing usable.
  const source = contentHtml === null ? document.body.innerHTML : contentHtml;
  const holder = new JSDOM(`<body>${source}</body>`, { url });
  absolutise(holder.window.document, url);

  // A page title is usually "Site name | The actual title". When the document
  // has an h1 that the title merely wraps, the h1 is the better book title.
  const pageHeading = (document.querySelector('h1')?.textContent || '').trim();
  if (!title) title = (document.title || pageHeading || '').trim();
  if (pageHeading && title !== pageHeading && /[|\u2013\u2014:-]/.test(title)) {
    const parts = title.split(/\s+[|\u2013\u2014:-]\s+/).map((part) => part.trim());
    if (parts.some((part) => part === pageHeading)) title = pageHeading;
  }

  const markdown = createTurndown()
    .turndown(holder.window.document.body.innerHTML)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown, title: title.trim(), byline, siteName, publishedTime, excerpt };
}

/** Build the frontmatter-carrying document the converter takes. */
export function articleToDocument(article, { url, path } = {}) {
  const front = ['---'];
  front.push(`title: ${JSON.stringify(article.title || 'Untitled')}`);
  if (article.byline) front.push(`author: ${JSON.stringify(article.byline)}`);
  if (article.publishedTime) front.push(`date: ${JSON.stringify(article.publishedTime.slice(0, 10))}`);
  if (article.siteName) front.push(`publisher: ${JSON.stringify(article.siteName)}`);
  if (article.excerpt) front.push(`description: ${JSON.stringify(article.excerpt.slice(0, 400))}`);
  front.push('---', '');

  const body = [`# ${article.title || 'Untitled'}`, ''];
  // The source belongs in the book: a saved article with no provenance is
  // worth much less later.
  if (url) body.push(`*[${new URL(url).hostname}](${url})*`, '');
  body.push(article.markdown);

  return { path: path || 'article.md', markdown: `${front.join('\n')}${body.join('\n')}\n` };
}

/**
 * Fetch a URL and convert it. Uses the same guarded fetcher as image
 * embedding, so a pasted URL cannot be used to probe the private network.
 */
export function createArticleFetcher(options = {}) {
  const fetchGuarded = createGuardedFetcher({
    accept: 'text/html,application/xhtml+xml',
    maxBytes: options.maxBytes || MAX_PAGE_BYTES,
    timeoutMs: options.timeoutMs || 20000,
    fetchImpl: options.fetchImpl,
  });

  return async function fetchArticle(url) {
    const response = await fetchGuarded(url);
    const type = response.contentType || '';
    if (type && !/html|xml|text\/plain/.test(type)) {
      throw new Error(`that URL is ${type}, not a web page`);
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(response.bytes);
    const article = articleFromHtml(html, { url: response.url });
    if (!article.markdown.trim()) throw new Error('no readable article could be extracted');
    return { ...article, url: response.url };
  };
}
