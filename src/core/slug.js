import { safeId } from './xml.js';

// GitHub flavoured heading slugs, then forced into a legal XML id.
export function slugify(text) {
  const base = String(text)
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safeId(base || 'section');
}

export function makeSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

// File name for the downloaded epub.
export function filenameFor(title) {
  const base = String(title || 'book')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${base || 'book'}.epub`;
}
