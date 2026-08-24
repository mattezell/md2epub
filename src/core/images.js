// Turn image references found in the Markdown into files inside the EPUB.
//
// Three kinds of source get handled: data: URIs (decoded inline), remote
// http(s) URLs (fetched, when the caller allows it) and relative paths
// (resolved by the caller, which is how the CLI picks up images next to the
// Markdown file). Anything that cannot be packaged degrades to its alt text so
// the book stays valid: EPUB forbids remote image references.

const MAGIC = [
  { type: 'image/png', ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    type: 'image/webp',
    ext: 'webp',
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

const SVG_HINT = /^\s*(<\?xml|<svg)/i;

/** Identify an image by its bytes, falling back to a declared media type. */
export function sniffImage(bytes, declaredType) {
  for (const entry of MAGIC) {
    if (bytes.length >= 12 && entry.test(bytes)) return { mediaType: entry.type, ext: entry.ext };
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 200));
  if (SVG_HINT.test(head)) return { mediaType: 'image/svg+xml', ext: 'svg' };
  if (declaredType === 'image/png') return { mediaType: 'image/png', ext: 'png' };
  if (declaredType === 'image/jpeg' || declaredType === 'image/jpg') return { mediaType: 'image/jpeg', ext: 'jpg' };
  if (declaredType === 'image/gif') return { mediaType: 'image/gif', ext: 'gif' };
  if (declaredType === 'image/webp') return { mediaType: 'image/webp', ext: 'webp' };
  if (declaredType === 'image/svg+xml') return { mediaType: 'image/svg+xml', ext: 'svg' };
  return null;
}

export function decodeDataUri(uri) {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(uri.trim());
  if (!match) return null;
  const [, mediaType, isBase64, payload] = match;
  let bytes;
  if (isBase64) {
    const binary = atob(payload.replace(/\s+/g, ''));
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return { bytes, declaredType: mediaType.toLowerCase() };
}

const DEFAULTS = {
  maxImageBytes: 12 * 1024 * 1024,
  maxTotalImageBytes: 48 * 1024 * 1024,
  fetchTimeoutMs: 10000,
};

/**
 * @param {Array<{id: string, src: string, from?: string}>} references unique image
 *   references. `from` is the key of the document that carries the reference, so
 *   a bundle can resolve two documents' "./diagram.png" to different files.
 * @param {object} opts
 * @param {boolean} opts.embedRemoteImages fetch http(s) images
 * @param {(url: string) => Promise<{bytes: Uint8Array, declaredType?: string}|null>} [opts.fetchImage]
 * @param {(path: string, from?: string) => Promise<{bytes: Uint8Array, declaredType?: string}|null>} [opts.resolveLocal]
 * @returns {Promise<{ files: Array, map: Map<string, string>, warnings: string[] }>} map is keyed by reference id
 */
export async function resolveImages(references, opts = {}) {
  const config = { ...DEFAULTS, ...opts };
  const files = [];
  const map = new Map();
  const warnings = [];
  let total = 0;
  let counter = 0;

  const accept = (id, payload, label) => {
    if (!payload || !payload.bytes || !payload.bytes.length) {
      warnings.push(`Image ${label} was empty and has been replaced by its alt text.`);
      return;
    }
    const kind = sniffImage(payload.bytes, payload.declaredType);
    if (!kind) {
      warnings.push(`Image ${label} is not a format EPUB readers support and has been replaced by its alt text.`);
      return;
    }
    if (payload.bytes.length > config.maxImageBytes) {
      warnings.push(`Image ${label} is larger than the ${Math.round(config.maxImageBytes / 1048576)} MB limit and has been replaced by its alt text.`);
      return;
    }
    if (total + payload.bytes.length > config.maxTotalImageBytes) {
      warnings.push(`Image ${label} was skipped: the book is already at the total image size limit.`);
      return;
    }
    total += payload.bytes.length;
    counter += 1;
    const path = `images/img-${String(counter).padStart(3, '0')}.${kind.ext}`;
    files.push({ path, mediaType: kind.mediaType, bytes: payload.bytes });
    map.set(id, path);
  };

  for (const reference of references) {
    const { id, src, from } = reference;
    const trimmed = src.trim();
    try {
      if (/^data:/i.test(trimmed)) {
        accept(id, decodeDataUri(trimmed), 'embedded as a data URI');
      } else if (/^https?:/i.test(trimmed)) {
        if (!config.embedRemoteImages || !config.fetchImage) {
          warnings.push(`Remote image ${trimmed} was replaced by its alt text (EPUB cannot reference images over the network).`);
          continue;
        }
        accept(id, await config.fetchImage(trimmed), trimmed);
      } else if (config.resolveLocal) {
        accept(id, await config.resolveLocal(trimmed, from), trimmed);
      } else {
        warnings.push(`Image ${trimmed} points at a local file that was not uploaded, so its alt text is shown instead.`);
      }
    } catch (err) {
      warnings.push(`Image ${trimmed} could not be included (${err.message}); its alt text is shown instead.`);
    }
  }

  return { files, map, warnings };
}
