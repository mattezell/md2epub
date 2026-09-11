#!/usr/bin/env node
// Node entry point: static portal + API on one port.

import { serve } from '@hono/node-server';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { buildMailer, loadEnv, EMAIL_SETUP_HINT } from './mail/factory.js';
import { createImageFetcher } from './net.js';
import { createMermaidRenderer, diagramSupport } from './diagrams.js';
import { createSvgRasterizer, findChrome } from './chrome.js';
import { createArticleFetcher } from './article.js';
import { createKarakeepClient, bookmarkToDocument } from './karakeep.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const publicDir = join(projectRoot, 'public');

loadEnv();

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const dev = /^(1|true|yes)$/i.test(process.env.MD2EPUB_DEV || '');
const cache = new Map();

async function readAsset(name) {
  if (!dev && cache.has(name)) return cache.get(name);
  const path = join(publicDir, name);
  if (!path.startsWith(publicDir)) return null;
  try {
    await stat(path);
  } catch {
    return null;
  }
  const body = await readFile(path);
  if (!dev) cache.set(name, body);
  return body;
}

export function createServerApp({ env = process.env, mailer } = {}) {
  const resolvedMailer = mailer === undefined ? buildMailer(env) : mailer;
  // Installing the toolchain is itself the opt in: it is half a gigabyte and
  // deliberately not a dependency, so nobody has it by accident. Requiring a
  // second switch on top of that only produced silent no-ops.
  // RENDER_DIAGRAMS=false turns it off where spawning a browser per conversion
  // is not wanted, which is worth thinking about on an exposed portal.
  const diagrams = diagramSupport(env);
  const diagramsDisabled = /^(0|false|no|off)$/i.test(env.RENDER_DIAGRAMS || '');
  const renderDiagram = !diagramsDisabled && diagrams.available ? createMermaidRenderer({ env }) : null;
  const diagramsUnavailable = diagramsDisabled ? 'diagram rendering is switched off on this server (RENDER_DIAGRAMS=false)' : diagrams.reason;
  // Off only if explicitly disabled: without it a generated cover does not
  // show up on a Kindle at all.
  const rasterizeSvg = /^(0|false|no|off)$/i.test(env.RASTERIZE_COVER || '') ? null : createSvgRasterizer({ env });

  // Web input. The article fetcher uses the same guarded fetch as image
  // embedding, so a pasted URL cannot probe the private network.
  const fetchArticle = createArticleFetcher();
  const karakeepClient = createKarakeepClient({ env });
  const karakeep = karakeepClient && {
    describe: () => karakeepClient.describe(),
    async documents({ limit = 10 } = {}) {
      // Over-fetch: many saved links cannot be crawled, and the limit should
      // mean readable articles rather than attempts.
      const candidates = await karakeepClient.list({
        limit: Math.min(limit * 4 + 5, 200),
        skipTag: env.KARAKEEP_SKIP_TAG || 'epubbed',
      });
      const documents = [];
      for (const bookmark of candidates) {
        if (documents.length >= limit) break;
        try {
          documents.push(await bookmarkToDocument(karakeepClient, bookmark, documents.length));
        } catch {
          // A bookmark Karakeep has not crawled yet is skipped, not fatal.
        }
      }
      return documents;
    },
  };
  const allowedRecipients = (env.MAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const app = createApp({
    mailer: resolvedMailer,
    config: {
      allowedRecipients,
      allowAnyRecipient: /^(1|true|yes|on)$/i.test(env.MAIL_ALLOW_ANY_RECIPIENT || ''),
      kindleAddress: (env.KINDLE_ADDRESS || '').trim(),
      emailsPerHour: Number(env.MAIL_RATE_PER_HOUR || 20),
      conversionsPerHour: Number(env.CONVERT_RATE_PER_HOUR || 120),
      maxMarkdownBytes: Number(env.MAX_MARKDOWN_BYTES || 8 * 1024 * 1024),
      maxCoverBytes: Number(env.MAX_COVER_BYTES || 12 * 1024 * 1024),
      embedRemoteImages: /^(1|true|yes|on)$/i.test(env.EMBED_REMOTE_IMAGES || ''),
      emailHelp: EMAIL_SETUP_HINT,
      renderDiagram,
      renderDiagrams: Boolean(renderDiagram),
      diagramsUnavailable,
      rasterizeSvg,
      fetchArticle,
      karakeep,
      fetchImage: createImageFetcher({ maxBytes: Number(env.MAX_IMAGE_BYTES || 12 * 1024 * 1024) }),
    },
  });

  app.get('/*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    const name = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '');
    if (name.includes('..')) return next();
    const body = await readAsset(name);
    if (!body) return next();
    const ext = name.slice(name.lastIndexOf('.'));
    return c.body(body, 200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      // Revalidate every time. The portal is a handful of small files on a
      // tailnet, so the bytes are worth nothing, while a cached page after a
      // restart looks exactly like a feature that failed to turn on.
      'Cache-Control': dev ? 'no-store' : 'no-cache',
    });
  });

  return { app, mailer: resolvedMailer, renderDiagram, rasterizeSvg, diagramsUnavailable, fetchArticle, karakeep };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { app, mailer, renderDiagram, rasterizeSvg, diagramsUnavailable, karakeep } = createServerApp();
  const port = Number(process.env.PORT || 8787);
  const hostname = process.env.HOST || '127.0.0.1';

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`[md2epub] listening on http://${hostname}:${info.port}`);
    console.log(`[md2epub] email: ${mailer ? `${mailer.kind}, ${mailer.describe()}` : 'not configured (download only)'}`);
    console.log(`[md2epub] covers: ${rasterizeSvg ? `drawn and rasterised via ${findChrome()}` : 'drawn as SVG (no browser found; Kindle will not show them)'}`);
    // Always said, not only when switched on: a silent absence is what made
    // this hard to work out from the outside.
    console.log(`[md2epub] diagrams: ${renderDiagram ? `on, via ${findChrome()}` : `off, ${diagramsUnavailable}`}`);
    console.log(`[md2epub] web: urls on${karakeep ? `, karakeep ${karakeep.describe()}` : ', karakeep not configured'}`);
    if (dev) console.log('[md2epub] dev mode: static files are re-read on every request');
  });
}
