// HTTP API, shared by the Node server and the Cloudflare Worker.
// Hono runs on both, and everything platform specific (mailer, static files,
// outbound image fetch) is injected, so this file has no runtime imports.

import { Hono } from 'hono';
import { markdownToEpub, MAX_MARKDOWN_BYTES } from './core/index.js';
import { composeBookEmail } from './mail/message.js';
import { articleToDocument } from './article.js';

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

const DEFAULTS = {
  maxMarkdownBytes: MAX_MARKDOWN_BYTES,
  maxCoverBytes: 12 * 1024 * 1024,
  // Deny by default. An unconfigured instance that mails anywhere is a relay,
  // and this one has no authentication of its own.
  allowedRecipients: [],
  allowAnyRecipient: false,
  // Where a request that names no recipient goes. Empty means such a request
  // is refused; set it (KINDLE_ADDRESS) so "send this to my Kindle" needs no
  // address on the calling side.
  kindleAddress: '',
  emailsPerHour: 20,
  conversionsPerHour: 120,
  embedRemoteImages: false,
  renderDiagrams: false,
  diagramsUnavailable: 'this server has no diagram renderer',
  // Web input, injected by the runtime that can reach the network safely.
  fetchArticle: null,
  karakeep: null,
  maxUrls: 20,
  // How to switch email on, in the words of whichever runtime is hosting this.
  emailHelp: '',
};

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const int = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

function clientKey(c) {
  return (
    c.req.header('cf-connecting-ip') ||
    (c.req.header('x-forwarded-for') || '').split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    'local'
  );
}

// Fixed window counter. Good enough to stop a runaway script or a stranger
// using the box as a mail relay; it is not a defence against a determined
// attacker, which is what MAIL_ALLOWED_RECIPIENTS is for.
function createRateLimiter(limit, windowMs = 3600_000) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    if (limit <= 0) return { allowed: true, remaining: Infinity };
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      }
      return { allowed: true, remaining: limit - 1 };
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), retryAfter: Math.ceil((entry.start + windowMs - now) / 1000) };
  };
}

async function readForm(c, config) {
  const contentType = c.req.header('content-type') || '';
  let fields = {};
  let markdown;
  let cover = null;
  let sourceName = '';

  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => {
      throw new RequestError('The request body was not valid JSON.');
    });
    fields = body || {};
    markdown = typeof body.markdown === 'string' ? body.markdown : undefined;
  } else {
    // all: true so several files can be uploaded under one field name and
    // become one book, a folder of project docs being the case that matters.
    const body = await c.req.parseBody({ all: true }).catch(() => {
      throw new RequestError('The form data could not be read.');
    });
    fields = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));

    const uploads = [body.file].flat().filter((file) => file && typeof file === 'object' && typeof file.text === 'function' && file.size > 0);
    const total = uploads.reduce((sum, file) => sum + file.size, 0);
    if (total > config.maxMarkdownBytes) {
      throw new RequestError(`That is larger than the ${Math.round(config.maxMarkdownBytes / 1048576)} MB limit.`, 413);
    }
    if (uploads.length) {
      markdown = [];
      for (const file of uploads) markdown.push({ path: file.name || 'document.md', markdown: await file.text() });
      sourceName = uploads.length === 1 ? uploads[0].name || '' : `${uploads.length} files`;
    } else if (typeof fields.markdown === 'string' && fields.markdown.trim()) {
      markdown = fields.markdown;
    }
    const coverFile = Array.isArray(body.cover) ? body.cover[0] : body.cover;
    if (coverFile && typeof coverFile === 'object' && typeof coverFile.arrayBuffer === 'function' && coverFile.size > 0) {
      if (coverFile.size > config.maxCoverBytes) {
        throw new RequestError(`The cover image is larger than the ${Math.round(config.maxCoverBytes / 1048576)} MB limit.`, 413);
      }
      cover = { bytes: new Uint8Array(await coverFile.arrayBuffer()), mediaType: coverFile.type || undefined };
    }
  }

  // Web input: a list of URLs, or the read-later queue.
  const urlList = String(fields.urls || '').split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
  if (urlList.length && markdown === undefined) {
    if (!config.fetchArticle) throw new RequestError('This server cannot fetch web pages.', 503);
    if (urlList.length > config.maxUrls) throw new RequestError(`That is more than ${config.maxUrls} URLs.`);
    const bad = urlList.find((u) => !/^https?:\/\//i.test(u));
    if (bad) throw new RequestError(`${bad} is not an http or https URL.`);
    markdown = [];
    for (const [index, url] of urlList.entries()) {
      try {
        const article = await config.fetchArticle(url);
        markdown.push(articleToDocument(article, { url: article.url, path: `${String(index + 1).padStart(3, '0')}-article.md` }));
      } catch (err) {
        throw new RequestError(`${url} could not be read: ${err.message}`);
      }
    }
  } else if (bool(fields.karakeep, false) && markdown === undefined) {
    if (!config.karakeep) throw new RequestError('This server has no Karakeep connection.', 503);
    markdown = await config.karakeep.documents({ limit: int(fields.karakeepLimit, 10) });
    if (!markdown.length) throw new RequestError('No bookmarks matched, or none has been crawled yet.');
  }

  const empty = markdown === undefined
    || (typeof markdown === 'string' && !markdown.trim())
    || (Array.isArray(markdown) && !markdown.some((doc) => doc.markdown.trim()));
  if (empty) throw new RequestError('Paste some Markdown or choose a .md file first.');

  if (typeof markdown === 'string' && new TextEncoder().encode(markdown).length > config.maxMarkdownBytes) {
    throw new RequestError(`That document is larger than the ${Math.round(config.maxMarkdownBytes / 1048576)} MB limit.`, 413);
  }

  return { fields, markdown, cover, sourceName };
}

// Converts, and makes sure a request the server could not honour is reported
// rather than quietly dropped.
async function convert(markdown, fields, cover, config) {
  const wantsDiagrams = bool(fields.renderDiagrams, config.renderDiagrams);
  const result = await markdownToEpub(markdown, conversionOptions(fields, cover, config));
  if (wantsDiagrams && !config.renderDiagram) {
    result.warnings.unshift(`Diagrams were requested but not rendered: ${config.diagramsUnavailable}. The diagram source is shown as a code block.`);
  }
  return result;
}

function conversionOptions(fields, cover, config) {
  const title = String(fields.title || '').trim();
  return {
    title: title || undefined,
    author: String(fields.author || '').trim() || undefined,
    language: String(fields.language || '').trim() || undefined,
    publisher: String(fields.publisher || '').trim() || undefined,
    description: String(fields.description || '').trim() || undefined,
    rights: String(fields.rights || '').trim() || undefined,
    subjects: String(fields.subjects || '').trim() || undefined,
    splitLevel: int(fields.splitLevel, 1),
    tocDepth: int(fields.tocDepth, 3),
    typographer: bool(fields.typographer, true),
    generateCover: bool(fields.generateCover, true),
    embedRemoteImages: (bool(fields.embedRemoteImages, config.embedRemoteImages) || bool(fields.fromWeb, false)) && Boolean(config.fetchImage),
    fetchImage: config.fetchImage,
    renderDiagram: bool(fields.renderDiagrams, config.renderDiagrams) ? config.renderDiagram : undefined,
    rasterizeSvg: config.rasterizeSvg,
    cover,
  };
}

function warningsHeader(warnings) {
  if (!warnings.length) return undefined;
  const encoded = encodeURIComponent(JSON.stringify(warnings));
  return encoded.length > 6000 ? encodeURIComponent(JSON.stringify(warnings.slice(0, 5).concat(['(further warnings omitted)']))) : encoded;
}

const asciiFallback = (name) => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

/**
 * @param {object} deps
 * @param {{send: Function, describe: Function, kind: string}|null} [deps.mailer]
 * @param {object} [deps.config]
 * @returns {import('hono').Hono}
 */
export function createApp({ mailer = null, config: overrides = {} } = {}) {
  const config = { ...DEFAULTS, ...overrides };
  const limitEmail = createRateLimiter(config.emailsPerHour);
  // Converting is the expensive path: it parses untrusted input, may fetch
  // remote pages and images, and with diagrams enabled starts a browser per
  // request. Without a cap that is a denial of service with one curl loop.
  const limitConvert = createRateLimiter(config.conversionsPerHour);
  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      email: mailer
        ? { configured: true, transport: mailer.kind, describe: mailer.describe(), kindleDefault: Boolean(config.kindleAddress) }
        : { configured: false },
      limits: {
        maxMarkdownBytes: config.maxMarkdownBytes,
        maxCoverBytes: config.maxCoverBytes,
        emailsPerHour: config.emailsPerHour,
        conversionsPerHour: config.conversionsPerHour,
      },
      remoteImages: Boolean(config.fetchImage),
      urls: Boolean(config.fetchArticle),
      karakeep: Boolean(config.karakeep),
      diagrams: Boolean(config.renderDiagram),
      diagramsUnavailable: config.renderDiagram ? null : config.diagramsUnavailable,
    }));

  app.post('/api/convert', async (c) => {
    const gate = limitConvert(clientKey(c));
    if (!gate.allowed) {
      throw new RequestError(`Too many conversions from here. Try again in ${Math.ceil((gate.retryAfter || 3600) / 60)} minutes.`, 429);
    }
    const { fields, markdown, cover } = await readForm(c, config);
    const result = await convert(markdown, fields, cover, config);
    const headers = {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${asciiFallback(result.filename)}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      'Content-Length': String(result.bytes.length),
      'Cache-Control': 'no-store',
      'X-Md2Epub-Title': encodeURIComponent(result.metadata.title),
      'X-Md2Epub-Chapters': String(result.chapterCount),
      'X-Md2Epub-Documents': String(result.documentCount),
      'X-Md2Epub-Diagrams': String(result.diagramCount || 0),
    };
    const warnings = warningsHeader(result.warnings);
    if (warnings) headers['X-Md2Epub-Warnings'] = warnings;
    return c.body(result.bytes, 200, headers);
  });

  app.post('/api/email', async (c) => {
    if (!mailer) {
      const help = config.emailHelp ? ` ${config.emailHelp}` : '';
      throw new RequestError(`Email delivery is not configured on this server.${help}`, 503);
    }
    const { fields, markdown, cover } = await readForm(c, config);
    // No address means the configured Kindle, so a caller never has to carry
    // the address itself. The allowlist below still applies to the default.
    const requested = String(fields.email || fields.to || '').trim();
    const to = requested || config.kindleAddress;
    if (!to) {
      throw new RequestError('No recipient. Pass an email address, or set KINDLE_ADDRESS on the server so a request without one goes to that Kindle.');
    }
    if (!EMAIL_RE.test(to)) throw new RequestError('That does not look like an email address.');
    if (config.allowedRecipients.length) {
      const allowed = config.allowedRecipients.some((rule) =>
        rule.startsWith('@') ? to.toLowerCase().endsWith(rule.toLowerCase()) : to.toLowerCase() === rule.toLowerCase());
      if (!allowed) throw new RequestError('This server only sends to approved addresses.', 403);
    } else if (!config.allowAnyRecipient) {
      throw new RequestError(
        'This server has not been told who it may send to. Set MAIL_ALLOWED_RECIPIENTS (a comma separated list of addresses or @domains), or MAIL_ALLOW_ANY_RECIPIENT=true to allow anyone. Leaving it open lets whoever can reach this server send mail as you.',
        403,
      );
    }

    const convertGate = limitConvert(clientKey(c));
    if (!convertGate.allowed) {
      throw new RequestError(`Too many conversions from here. Try again in ${Math.ceil((convertGate.retryAfter || 3600) / 60)} minutes.`, 429);
    }
    const gate = limitEmail(clientKey(c));
    if (!gate.allowed) {
      throw new RequestError(`Too many emails from here. Try again in ${Math.ceil((gate.retryAfter || 3600) / 60)} minutes.`, 429);
    }

    const result = await convert(markdown, fields, cover, config);
    const message = composeBookEmail(result, { note: fields.note, subject: fields.subject });

    try {
      const info = await mailer.send({ to, ...message });
      return c.json({
        ok: true,
        to,
        filename: result.filename,
        size: result.bytes.length,
        chapters: result.chapterCount,
        warnings: result.warnings,
        messageId: info.messageId,
        dryRun: mailer.kind === 'log',
      });
    } catch (err) {
      throw new RequestError(`The server could not send the email: ${err.message}`, 502);
    }
  });

  app.onError((err, c) => {
    const status = err instanceof RequestError ? err.status : 500;
    if (status >= 500) console.error('[md2epub]', err);
    return c.json({ ok: false, error: err.message || 'Something went wrong.' }, status);
  });

  app.notFound((c) => (c.req.path.startsWith('/api/')
    ? c.json({ ok: false, error: 'No such endpoint.' }, 404)
    : c.text('Not found', 404)));

  return app;
}

export { RequestError };
