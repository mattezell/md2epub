// HTML -> XHTML normaliser.
//
// markdown-it already emits well formed markup, but pasted Markdown routinely
// carries raw HTML with it: unclosed <br>, <img> without a slash, &nbsp;,
// <script>, ids that start with a digit. EPUB content documents are parsed as
// XML, so any of those turn into an epubcheck error. Everything the converter
// produces goes through this function, so the packaged XHTML is well formed and
// script free by construction rather than by hope.

import { decodeHTML } from 'entities';
import { escapeXml, escapeAttr, safeId, stripIllegalXmlChars } from './xml.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Tags kept in the output. Anything outside this list is either dropped whole
// (DROP_SUBTREE) or unwrapped, keeping its text.
const ALLOWED = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

const DROP_SUBTREE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'option',
  'textarea', 'svg', 'math', 'template', 'noscript', 'canvas', 'applet', 'link', 'meta', 'base',
  'frame', 'frameset', 'marquee', 'dialog', 'audio', 'video', 'head', 'title',
]);

const GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir', 'style']);

const TAG_ATTRS = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  col: ['span'],
  colgroup: ['span'],
  time: ['datetime'],
  q: ['cite'],
  blockquote: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  details: ['open'],
  data: ['value'],
  bdo: ['dir'],
};

const SAFE_SCHEMES = /^(https?:|mailto:|tel:|urn:|ftp:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isSafeUrl(value, { allowData = false } = {}) {
  const url = value.trim();
  if (!url) return false;
  if (url.startsWith('#') || url.startsWith('/') || url.startsWith('.')) return true;
  if (url.startsWith('data:')) return allowData && /^data:image\//i.test(url);
  if (SAFE_SCHEMES.test(url)) return true;
  // No scheme at all means a relative path, which is fine. A scheme we do not
  // recognise (javascript:, vbscript:, file:) is not.
  return !ANY_SCHEME.test(url);
}

// Parse one tag starting at html[start] === '<'. Returns null when the '<' is
// literal text rather than the start of a tag.
function parseTag(html, start) {
  const rest = html.slice(start);
  if (rest.startsWith('<!--')) {
    const end = html.indexOf('-->', start + 4);
    return { kind: 'comment', end: end === -1 ? html.length : end + 3 };
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = html.indexOf(']]>', start + 9);
    return { kind: 'cdata', text: html.slice(start + 9, end === -1 ? html.length : end), end: end === -1 ? html.length : end + 3 };
  }
  if (rest.startsWith('<!') || rest.startsWith('<?')) {
    const end = html.indexOf('>', start);
    return { kind: 'comment', end: end === -1 ? html.length : end + 1 };
  }

  const closing = rest.startsWith('</');
  let i = start + (closing ? 2 : 1);
  const nameStart = i;
  while (i < html.length && /[A-Za-z0-9:_-]/.test(html[i])) i += 1;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();

  if (closing) {
    const end = html.indexOf('>', i);
    return { kind: 'close', name, end: end === -1 ? html.length : end + 1 };
  }

  const attrs = [];
  let selfClose = false;
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (i >= html.length) break;
    if (html[i] === '>') { i += 1; break; }
    if (html[i] === '/' && html[i + 1] === '>') { selfClose = true; i += 2; break; }
    if (html[i] === '/') { i += 1; continue; }

    const attrStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) i += 1;
    const attrName = html.slice(attrStart, i).toLowerCase();
    let value = '';
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (html[i] === '=') {
      i += 1;
      while (i < html.length && /\s/.test(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        value = html.slice(i + 1, end === -1 ? html.length : end);
        i = end === -1 ? html.length : end + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !/[\s>]/.test(html[i])) i += 1;
        value = html.slice(valueStart, i);
      }
    } else {
      value = attrName; // boolean attribute; XML needs name="name"
    }
    if (attrName) attrs.push([attrName, value]);
  }
  return { kind: 'open', name, attrs, selfClose, end: i };
}

function renderText(raw) {
  return escapeXml(decodeHTML(raw));
}

function renderAttrs(name, attrs, opts) {
  const allowed = TAG_ATTRS[name] || [];
  const out = [];
  const seen = new Set();
  for (const [attr, rawValue] of attrs) {
    if (attr.startsWith('on') || attr.startsWith('xmlns') || attr.startsWith('data-')) continue;
    if (!GLOBAL_ATTRS.has(attr) && !allowed.includes(attr)) continue;
    if (seen.has(attr)) continue;

    let value = stripIllegalXmlChars(decodeHTML(rawValue));
    if (attr === 'style' && /url\s*\(|expression|javascript:/i.test(value)) continue;
    if (attr === 'id') value = safeId(value);
    if ((attr === 'width' || attr === 'height') && !/^\d+$/.test(value.trim())) continue;

    if (attr === 'href' || attr === 'src' || attr === 'cite') {
      const allowData = name === 'img' && attr === 'src';
      if (!isSafeUrl(value, { allowData })) continue;
      if (attr === 'href' && value.startsWith('#')) {
        value = `#${safeId(value.slice(1))}`;
      }
      if (opts.rewriteUrl) {
        const rewritten = opts.rewriteUrl(name, attr, value);
        if (rewritten === null || rewritten === undefined) continue;
        value = rewritten;
      }
    }
    seen.add(attr);
    out.push(`${attr}="${escapeAttr(value)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/**
 * Normalise an HTML fragment into a well formed, script free XHTML fragment.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {(tag: string, attr: string, value: string) => string|null} [opts.rewriteUrl]
 *   Rewrite or drop (return null) href/src/cite values. Used to point image
 *   sources at packaged files and cross document links at their chapter.
 * @param {(tag: string, attrs: Array<[string, string]>) => void} [opts.onTag]
 *   Called for every opening tag that survives filtering, before rendering.
 * @param {(tag: string, attrs: Array<[string, string]>) => string|null} [opts.replaceTag]
 *   Return already escaped XHTML to emit in place of the tag. Used to swap an
 *   image that cannot be packaged for its alt text, since an <img> with no src
 *   is invalid.
 * @returns {string}
 */
export function htmlToXhtml(html, opts = {}) {
  const out = [];
  const stack = []; // { name, emitted }
  let i = 0;
  let textStart = 0;

  const flushText = (until) => {
    if (until > textStart) out.push(renderText(html.slice(textStart, until)));
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const tag = parseTag(html, lt);
    if (!tag) { i = lt + 1; continue; }

    flushText(lt);

    if (tag.kind === 'comment') {
      // Comments are legal XML but carry no reading value; drop them.
    } else if (tag.kind === 'cdata') {
      out.push(escapeXml(tag.text));
    } else if (tag.kind === 'open') {
      const { name, attrs, selfClose } = tag;
      if (DROP_SUBTREE.has(name)) {
        if (!selfClose && !VOID.has(name)) {
          const close = html.toLowerCase().indexOf(`</${name}`, tag.end);
          if (close !== -1) {
            const closeEnd = html.indexOf('>', close);
            tag.end = closeEnd === -1 ? html.length : closeEnd + 1;
          }
        }
      } else if (!ALLOWED.has(name)) {
        // Unknown tag: keep the children, drop the wrapper.
        if (!selfClose && !VOID.has(name)) stack.push({ name, emitted: false });
      } else {
        if (opts.onTag) opts.onTag(name, attrs);
        const replacement = opts.replaceTag ? opts.replaceTag(name, attrs) : null;
        if (replacement !== null && replacement !== undefined) {
          out.push(replacement);
          if (!selfClose && !VOID.has(name)) stack.push({ name, emitted: false });
          i = tag.end;
          textStart = i;
          continue;
        }
        const rendered = renderAttrs(name, attrs, opts);
        if (VOID.has(name) || selfClose) {
          out.push(`<${name}${rendered} />`);
        } else {
          out.push(`<${name}${rendered}>`);
          stack.push({ name, emitted: true });
        }
      }
    } else if (tag.kind === 'close') {
      const depth = stack.map((e) => e.name).lastIndexOf(tag.name);
      if (depth !== -1) {
        for (let d = stack.length - 1; d >= depth; d -= 1) {
          if (stack[d].emitted) out.push(`</${stack[d].name}>`);
        }
        stack.length = depth;
      }
      // A close tag with no matching open is dropped.
    }

    i = tag.end;
    textStart = i;
  }

  flushText(html.length);
  for (let d = stack.length - 1; d >= 0; d -= 1) {
    if (stack[d].emitted) out.push(`</${stack[d].name}>`);
  }
  return out.join('');
}

export const _internals = { parseTag, isSafeUrl };
