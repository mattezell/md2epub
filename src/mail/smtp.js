// SMTP delivery via nodemailer. Node only: the Worker build must not import this.

import nodemailer from 'nodemailer';

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());

/**
 * Build a mailer from environment variables, or return null when SMTP is not
 * configured. Returning null (rather than throwing) lets the portal come up in
 * download-only mode with the email controls disabled.
 */
export function createSmtpMailer(env = process.env) {
  const host = (env.SMTP_HOST || '').trim();
  const from = (env.MAIL_FROM || env.SMTP_USER || '').trim();
  if (!host || !from) return null;

  const port = Number(env.SMTP_PORT || 587);
  const secure = env.SMTP_SECURE === undefined ? port === 465 : truthy(env.SMTP_SECURE);
  const auth = env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth,
    requireTLS: !secure && !truthy(env.SMTP_ALLOW_PLAINTEXT),
    connectionTimeout: Number(env.SMTP_TIMEOUT_MS || 20000),
    greetingTimeout: Number(env.SMTP_TIMEOUT_MS || 20000),
    socketTimeout: Number(env.SMTP_TIMEOUT_MS || 30000),
  });

  return {
    kind: 'smtp',
    describe: () => `${host}:${port}${secure ? ' (TLS)' : ''} as ${from}`,
    verify: () => transport.verify(),
    async send({ to, subject, text, html, attachments }) {
      const info = await transport.sendMail({
        from,
        to,
        replyTo: (env.MAIL_REPLY_TO || '').trim() || undefined,
        subject,
        text,
        html,
        attachments: (attachments || []).map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
      });
      return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
    },
  };
}
