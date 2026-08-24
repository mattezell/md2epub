// Node side mail wiring: read .env, pick a transport. Not importable from a
// Worker (nodemailer and node:fs are Node only).

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSmtpMailer } from './smtp.js';
import { createLogMailer } from './log.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Node's own .env reader: no dotenv dependency. Safe to call more than once. */
export function loadEnv(env = process.env) {
  const file = env.MD2EPUB_ENV_FILE || join(projectRoot, '.env');
  if (existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
  return env;
}

/**
 * SMTP when configured, a dry run writer when MAIL_TRANSPORT=log, otherwise
 * null so the caller can run in download only mode.
 */
export function buildMailer(env = process.env, log = console.log) {
  const transport = (env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (transport === 'log' || transport === 'dry-run') {
    return createLogMailer({ dir: env.MAIL_OUTBOX || join(projectRoot, '.mail-outbox'), log });
  }
  if (transport === 'none') return null;
  return createSmtpMailer(env);
}

export const EMAIL_SETUP_HINT = 'Set SMTP_HOST and MAIL_FROM in .env, then restart.';
