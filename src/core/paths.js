// Tiny POSIX-ish path helpers. The core cannot import node:path, and bundling a
// folder of documents needs to resolve "./other-doc.md" against the document
// that links to it.

export function normalisePath(path) {
  const parts = String(path).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function dirnameOf(path) {
  const clean = normalisePath(path);
  const index = clean.lastIndexOf('/');
  return index === -1 ? '' : clean.slice(0, index);
}

export function basenameOf(path) {
  const clean = normalisePath(path);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

/** Resolve a reference found inside `fromPath` (a document key). */
export function resolveFrom(fromPath, reference) {
  const ref = String(reference).replace(/^\.\//, '');
  if (ref.startsWith('/')) return normalisePath(ref);
  const dir = dirnameOf(fromPath);
  return normalisePath(dir ? `${dir}/${ref}` : ref);
}

const WORD_BREAKS = /[-_\s]+/;

/** "01-getting-started.md" -> "Getting Started", for a document with no title. */
export function titleFromFilename(path) {
  const base = basenameOf(path).replace(/\.(md|markdown|mdown|mkd|mdx|txt)$/i, '');
  const words = base
    .replace(/^\d+[-_.\s]+/, '')
    .split(WORD_BREAKS)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
  return words.join(' ').trim();
}
