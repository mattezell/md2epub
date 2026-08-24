// Guarded outbound image fetch for the Node server.
//
// The converter will happily embed images referenced by http(s) URLs, but the
// URLs come from whatever the visitor pasted. Left unguarded that turns the
// server into an SSRF proxy for anything it can reach: link local metadata
// endpoints, other services on the tailnet, localhost admin ports. Every hop
// (including redirects, which is why redirects are followed by hand) has its
// resolved address checked before a connection is made.

import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivateAddress(address) {
  if (!address) return true;
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT, includes tailnet 100.x
    if (a >= 224) return true;                            // multicast and reserved
    return false;
  }
  if (family === 6) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('ff')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

async function assertPublicHost(rawHostname) {
  // URL.hostname keeps the brackets on an IPv6 literal, and net.isIP does not
  // accept them, so they have to come off before the address check.
  const hostname = rawHostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('that address is not reachable from this server');
    return;
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error('the host name did not resolve');
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error('the host name resolves to a private address');
  }
}

/**
 * Fetch a URL with size, time and destination limits, following redirects by
 * hand so every hop is checked.
 * @returns {(url: string) => Promise<{bytes: Uint8Array, contentType?: string, url: string}>}
 */
export function createGuardedFetcher({ maxBytes = 12 * 1024 * 1024, timeoutMs = 10000, maxRedirects = 3, accept = '*/*', fetchImpl = fetch } = {}) {
  return async function guardedFetch(rawUrl) {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https images can be fetched');
      await assertPublicHost(url.hostname);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept, 'user-agent': 'md2epub/0.1 (+https://github.com/)' },
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        url = new URL(response.headers.get('location'), url);
        continue;
      }
      if (!response.ok) throw new Error(`the server answered ${response.status}`);

      const declared = Number(response.headers.get('content-length') || 0);
      if (declared && declared > maxBytes) throw new Error('the response is too large');

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) throw new Error('the response is too large');
      return {
        bytes: new Uint8Array(buffer),
        contentType: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || undefined,
        // The URL after redirects, which is what relative links resolve against.
        url: url.toString(),
      };
    }
    throw new Error('too many redirects');
  };
}

/**
 * The image flavour of the same thing, kept as its own name because the
 * converter's hook expects `declaredType`.
 * @returns {(url: string) => Promise<{bytes: Uint8Array, declaredType?: string}>}
 */
export function createImageFetcher(options = {}) {
  const fetchGuarded = createGuardedFetcher({ accept: 'image/*', ...options });
  return async function fetchImage(url) {
    const result = await fetchGuarded(url);
    if (result.bytes.length > (options.maxBytes || 12 * 1024 * 1024)) throw new Error('the image is too large');
    return { bytes: result.bytes, declaredType: result.contentType };
  };
}

export const _internals = { assertPublicHost };
