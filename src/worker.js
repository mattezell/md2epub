// Cloudflare Worker entry point.
//
// The API is the same Hono app the Node server runs; only the two things a
// Worker cannot do natively differ. Static files come from the [assets] binding
// rather than the filesystem, and mail goes out over HTTP (Resend) because
// Workers have no outbound SMTP.

import { createApp } from './app.js';
import { createResendMailer } from './mail/http.js';

let cached = null;

function build(env) {
  const allowedRecipients = (env.MAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return createApp({
    mailer: createResendMailer(env),
    config: {
      allowedRecipients,
      emailsPerHour: Number(env.MAIL_RATE_PER_HOUR || 20),
      maxMarkdownBytes: Number(env.MAX_MARKDOWN_BYTES || 4 * 1024 * 1024),
      maxCoverBytes: Number(env.MAX_COVER_BYTES || 8 * 1024 * 1024),
      embedRemoteImages: /^(1|true|yes|on)$/i.test(env.EMBED_REMOTE_IMAGES || ''),
      emailHelp: 'Set the RESEND_API_KEY and MAIL_FROM secrets, then redeploy.',
      // The Workers runtime already refuses to connect to private address
      // space, so the fetch needs size and redirect limits only.
      fetchImage: async (url) => {
        const response = await fetch(url, { redirect: 'follow', headers: { accept: 'image/*' } });
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        const buffer = await response.arrayBuffer();
        const maxBytes = Number(env.MAX_IMAGE_BYTES || 8 * 1024 * 1024);
        if (buffer.byteLength > maxBytes) throw new Error('the image is too large');
        return {
          bytes: new Uint8Array(buffer),
          declaredType: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || undefined,
        };
      },
    },
  });
}

export default {
  fetch(request, env, ctx) {
    // Rate limit state lives in module scope, so it is per isolate rather than
    // global. It slows a runaway client down; it is not a global quota.
    if (!cached) cached = build(env);
    return cached.fetch(request, env, ctx);
  },
};
