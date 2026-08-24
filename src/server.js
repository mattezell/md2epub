#!/usr/bin/env node
// Node entry point: static portal + API on one port.

import { serve } from '@hono/node-server';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createSmtpMailer } from './mail/smtp.js';
import { createLogMailer } from './mail/log.js';
import { createImageFetcher } from './net.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const publicDir = join(projectRoot, 'public');

// Node's own .env reader: no dotenv dependency.
const envFile = process.env.MD2EPUB_ENV_FILE || join(projectRoot, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

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

export function buildMailer(env = process.env, log = console.log) {
  const transport = (env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (transport === 'log' || transport === 'dry-run') {
    return createLogMailer({ dir: env.MAIL_OUTBOX || join(projectRoot, '.mail-outbox'), log });
  }
  if (transport === 'none') return null;
  return createSmtpMailer(env);
}

export function createServerApp({ env = process.env, mailer } = {}) {
  const resolvedMailer = mailer === undefined ? buildMailer(env) : mailer;
  const allowedRecipients = (env.MAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const app = createApp({
    mailer: resolvedMailer,
    config: {
      allowedRecipients,
      emailsPerHour: Number(env.MAIL_RATE_PER_HOUR || 20),
      maxMarkdownBytes: Number(env.MAX_MARKDOWN_BYTES || 8 * 1024 * 1024),
      maxCoverBytes: Number(env.MAX_COVER_BYTES || 12 * 1024 * 1024),
      embedRemoteImages: /^(1|true|yes|on)$/i.test(env.EMBED_REMOTE_IMAGES || ''),
      emailHelp: 'Set SMTP_HOST and MAIL_FROM in .env, then restart.',
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
      'Cache-Control': dev ? 'no-store' : 'public, max-age=300',
    });
  });

  return { app, mailer: resolvedMailer };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { app, mailer } = createServerApp();
  const port = Number(process.env.PORT || 8787);
  const hostname = process.env.HOST || '127.0.0.1';

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`[md2epub] listening on http://${hostname}:${info.port}`);
    console.log(`[md2epub] email: ${mailer ? `${mailer.kind}, ${mailer.describe()}` : 'not configured (download only)'}`);
    if (dev) console.log('[md2epub] dev mode: static files are re-read on every request');
  });
}
