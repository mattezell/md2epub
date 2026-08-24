// Karakeep as an input: turn the read-later queue into a book.
//
// Shapes verified against the running instance 2026-08-24. A bookmark's crawled
// article is NOT inline on the listing: `content.htmlContent` comes back empty
// and the real text lives in a `linkHtmlContent` asset, fetched separately.
// What that asset holds is already Readability-extracted, so it skips straight
// to the Markdown conversion.

import { articleFromHtml, articleToDocument } from './article.js';

const DEFAULTS = {
  limit: 10,
  pageSize: 50,
  maxPages: 40,
  timeoutMs: 20000,
};

const bearer = (key) => ({ Authorization: `Bearer ${key}` });

/**
 * @param {object} [config]
 * @param {string} [config.url] Karakeep base URL, default KARAKEEP_URL
 * @param {string} [config.key] API key, default KARAKEEP_API_KEY or KARAKEEP_KEY
 * @returns {object|null} null when it is not configured
 */
export function createKarakeepClient(config = {}) {
  const env = config.env || process.env;
  const base = (config.url || env.KARAKEEP_URL || '').trim().replace(/\/+$/, '');
  const key = (config.key || env.KARAKEEP_API_KEY || env.KARAKEEP_KEY || '').trim();
  if (!base || !key) return null;

  const fetchImpl = config.fetchImpl || fetch;
  const settings = { ...DEFAULTS, ...config };

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...bearer(key), ...(init.headers || {}) },
      });
      if (!response.ok) throw new Error(`Karakeep answered ${response.status} for ${path}`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    describe: () => `${base}`,

    /**
     * Newest first, skipping anything already carrying `skipTag`. Mirrors how
     * the brief pipeline drains the same queue, so the two can share a tag or
     * deliberately not.
     */
    async list({ limit = settings.limit, skipTag, requireTag, includeArchived = false } = {}) {
      const wanted = [];
      let cursor = null;
      for (let page = 0; page < settings.maxPages && wanted.length < limit; page += 1) {
        const query = new URLSearchParams({ limit: String(settings.pageSize) });
        if (cursor) query.set('cursor', String(cursor));
        const body = await (await request(`/api/v1/bookmarks?${query}`)).json();
        for (const bookmark of body.bookmarks || []) {
          const tags = new Set((bookmark.tags || []).map((t) => t && t.name).filter(Boolean));
          if (skipTag && tags.has(skipTag)) continue;
          if (requireTag && !tags.has(requireTag)) continue;
          if (!includeArchived && bookmark.archived) continue;
          if ((bookmark.content || {}).type !== 'link') continue;
          wanted.push(bookmark);
          if (wanted.length >= limit) break;
        }
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      return wanted;
    },

    /** The crawled article for a bookmark, as HTML, or null if it has none. */
    async articleHtml(bookmark) {
      const inline = (bookmark.content || {}).htmlContent;
      if (inline && inline.trim()) return inline;
      const asset = (bookmark.assets || []).find((a) => a.assetType === 'linkHtmlContent');
      if (!asset) return null;
      return (await request(`/api/v1/assets/${asset.id}`)).text();
    },

    /** Tag a bookmark, which is how a queue avoids repeating itself. */
    async tag(bookmark, tagName) {
      await request(`/api/v1/bookmarks/${bookmark.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: [{ tagName }] }),
      });
    },
  };
}

/** Convert one bookmark into a document for the converter. */
export async function bookmarkToDocument(client, bookmark, index = 0) {
  const content = bookmark.content || {};
  const url = content.url || '';
  const html = await client.articleHtml(bookmark);
  if (!html || !html.trim()) throw new Error('Karakeep has not crawled this bookmark yet');

  // Already extracted by Karakeep's own crawler, so no second extraction pass.
  const article = articleFromHtml(html, {
    url,
    extract: false,
    title: (bookmark.title || content.title || '').trim(),
  });
  if (!article.markdown.trim()) throw new Error('the crawled article was empty');

  article.byline = article.byline || (content.author || '').trim();
  article.siteName = article.siteName || (content.publisher || '').trim();
  article.publishedTime = article.publishedTime || (content.datePublished || '').trim();
  article.excerpt = article.excerpt || (bookmark.summary || content.description || '').trim();

  return articleToDocument(article, { url, path: `${String(index + 1).padStart(3, '0')}-bookmark.md` });
}
